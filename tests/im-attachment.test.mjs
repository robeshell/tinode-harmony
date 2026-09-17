import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ATTACHMENT_CHUNK_BYTES, attachmentDrafty, attachmentKindOf, attachmentOfDrafty, cacheBytesOf,
  cacheKeyOf, draftyEntityTypeOf, initialProgress, isUploadComplete, mergeChunkProgress, planChunks,
  planEviction, progressPercent, uploadedBytesOf, validateAttachment
} from '../src/ImAttachment.ts';

// P2：附件模块纯逻辑（校验 / 分块 / 进度 / 缓存 / Drafty 互转）
test('MIME 归类与 Drafty 实体类型', () => {
  assert.equal(attachmentKindOf('image/png'), 'image');
  assert.equal(attachmentKindOf('audio/mp4'), 'audio');
  assert.equal(attachmentKindOf('video/mp4'), 'video');
  assert.equal(attachmentKindOf('application/pdf'), 'file');
  assert.deepEqual(
    ['image/png', 'audio/aac', 'video/mp4', 'application/zip'].map(draftyEntityTypeOf),
    ['IM', 'AU', 'VD', 'EX']
  );
});

test('validateAttachment：大小/类型/文件名', () => {
  assert.equal(validateAttachment({ name: 'a.png', mime: 'image/png', size: 100 }).ok, true);
  assert.equal(validateAttachment({ name: '', mime: 'image/png', size: 100 }).reason, '文件名为空');
  assert.equal(validateAttachment({ name: 'a.png', mime: '', size: 100 }).reason, '文件类型未知');
  assert.equal(validateAttachment({ name: 'a.png', mime: 'image/png', size: 0 }).reason, '文件内容为空');
  const big = validateAttachment({ name: 'a.zip', mime: 'application/zip', size: 5 * 1024 * 1024 }, { maxBytes: 1024 * 1024 });
  assert.equal(big.ok, false);
  assert.match(big.reason, /上限/);
  const mime = validateAttachment({ name: 'a.zip', mime: 'application/zip', size: 10 }, { allowedMimes: ['image/png'] });
  assert.equal(mime.ok, false);
  assert.match(mime.reason, /不支持的格式/);
});

test('planChunks：整除 / 余数 / 边界', () => {
  assert.equal(planChunks(0).length, 0);
  assert.equal(planChunks(-5).length, 0);
  assert.deepEqual(planChunks(100, 40), [
    { index: 0, offset: 0, length: 40 },
    { index: 1, offset: 40, length: 40 },
    { index: 2, offset: 80, length: 20 }
  ]);
  const one = planChunks(10);
  assert.deepEqual(one, [{ index: 0, offset: 0, length: 10 }]);
  assert.equal(planChunks(DEFAULT_ATTACHMENT_CHUNK_BYTES * 2, DEFAULT_ATTACHMENT_CHUNK_BYTES).length, 2);
});

test('进度合并：取最大值、可乱序、百分比与完成判定', () => {
  let list = initialProgress(planChunks(100, 40));
  assert.equal(uploadedBytesOf(list), 0);
  list = mergeChunkProgress(list, 0, 40);
  list = mergeChunkProgress(list, 1, 10);
  assert.equal(uploadedBytesOf(list), 50);
  assert.equal(progressPercent(uploadedBytesOf(list), 100), 50);
  list = mergeChunkProgress(list, 1, 5);        // 乱序回退 → 不覆盖
  assert.equal(uploadedBytesOf(list), 50);
  list = mergeChunkProgress(list, 1, 999);      // 超报 → 截到块长
  assert.equal(list[1].length, 40);
  assert.equal(list[1].loaded, 40);
  assert.equal(isUploadComplete(list), false);
  list = mergeChunkProgress(list, 2, 20);
  assert.equal(isUploadComplete(list), true);
  assert.equal(progressPercent(0, 0), 0);
  assert.equal(progressPercent(200, 100), 100);
  assert.equal(isUploadComplete([]), false);
});

test('attachmentDrafty ↔ attachmentOfDrafty 往返', () => {
  const meta = { name: '语音.m4a', mime: 'audio/mp4', size: 1234, duration: 3000 };
  const drafty = attachmentDrafty(meta, { ref: 'ref/abc', url: 'https://files.example.com/a' });
  assert.equal(drafty.txt, '语音.m4a');
  assert.equal(drafty.ent[0].tp, 'AU');
  assert.equal(drafty.ent[0].data.ref, 'ref/abc');
  assert.equal(drafty.ent[0].data.size, 1234);
  const back = attachmentOfDrafty(drafty);
  assert.equal(back.name, '语音.m4a');
  assert.equal(back.mime, 'audio/mp4');
  assert.equal(back.size, 1234);
  assert.equal(back.duration, 3000);
  assert.equal(attachmentOfDrafty({ txt: '纯文本' }), null);
  assert.equal(attachmentOfDrafty({ txt: '带链接', ent: [{ tp: 'LN', data: { url: 'x' } }] }), null);
});

test('缓存键与 LRU 淘汰规划', () => {
  assert.equal(cacheKeyOf('ref/abc'), 'ref_abc');
  assert.notEqual(cacheKeyOf('ref/abc', 'image/png'), cacheKeyOf('ref/abc', 'video/mp4'));
  const entries = [
    { key: 'a', bytes: 60, lastUsedAtMs: 3 },
    { key: 'b', bytes: 60, lastUsedAtMs: 1 },
    { key: 'c', bytes: 60, lastUsedAtMs: 2 }
  ];
  assert.equal(cacheBytesOf(entries), 180);
  assert.deepEqual(planEviction(entries, 200), [], '没超预算不淘汰');
  assert.deepEqual(planEviction(entries, 150), ['b'], '最久未用的先删');
  assert.deepEqual(planEviction(entries, 70), ['b', 'c'], '删到预算内为止');
  assert.deepEqual(planEviction([], 100), []);
});
