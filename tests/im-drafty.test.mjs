import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFTY_ENTITY_DATA_KEYS, DRAFTY_ENT_AUDIO, DRAFTY_ENT_CALL, DRAFTY_ENT_FILE, DRAFTY_ENT_HASHTAG, DRAFTY_ENT_HEAD, DRAFTY_ENT_IMAGE, DRAFTY_ENT_LINK, DRAFTY_ENT_MENTION, DRAFTY_ENT_QUOTE, DRAFTY_ENT_VIDEO, DRAFTY_INLINE_STYLES, DRAFTY_MIME_TYPE, DRAFTY_STORAGE_PREVIEW_LENGTH, DRAFTY_VOID_STYLES, draftyEntities, draftyText, encodeDrafty, entityMime, firstEntityOfType, hasEntityMimePrefix, hasEntityType, parseDraftyJson, sanitizeEntityData
} from '../src/Drafty.ts';

// Drafty 子集（vendored SDK `model/Drafty.java`）：本端只做读取侧 —— 实体抽取、纯文本、
// 白名单过滤。样式（fmt）本切片不消费，偏移单位的分歧见契约 openQuestions。

test('Drafty 顶层与标记常量照 SDK 取值', () => {
  assert.equal(DRAFTY_MIME_TYPE, 'text/x-drafty');
  assert.equal(DRAFTY_STORAGE_PREVIEW_LENGTH, 80, 'SDK storage 里最后一条按 80 字截断');
  assert.deepEqual(DRAFTY_ENT_IMAGE, 'IM');
  assert.equal(DRAFTY_ENT_FILE, 'EX');
  assert.equal(DRAFTY_ENT_AUDIO, 'AU');
  assert.equal(DRAFTY_ENT_VIDEO, 'VD');
  assert.equal(DRAFTY_ENT_CALL, 'VC');
  assert.equal(DRAFTY_ENT_QUOTE, 'QQ');
  assert.equal(DRAFTY_ENT_HEAD, 'HD');
  assert.equal(DRAFTY_ENT_LINK, 'LN');
  assert.equal(DRAFTY_ENT_MENTION, 'MN');
  assert.equal(DRAFTY_ENT_HASHTAG, 'HT');
  assert.deepEqual(DRAFTY_INLINE_STYLES, ['ST', 'EM', 'DL', 'CO'], '只有这 4 种行内样式');
  assert.deepEqual(DRAFTY_VOID_STYLES, ['BR', 'EX', 'HD']);
});

test('空安全：null/缺字段一律退化成空值，不抛异常', () => {
  assert.deepEqual(draftyEntities(null), []);
  assert.deepEqual(draftyEntities({ txt: 'hi' }), []);
  assert.equal(draftyText(null), '');
  assert.equal(draftyText({ txt: '你好' }), '你好');
  assert.equal(draftyText({ txt: undefined }), '');
  assert.equal(hasEntityType(null, DRAFTY_ENT_IMAGE), false);
  assert.equal(firstEntityOfType({ txt: 'x' }, DRAFTY_ENT_IMAGE), null);
  assert.equal(entityMime(null), '');
  assert.equal(entityMime({ tp: DRAFTY_ENT_IMAGE }), '');
  assert.equal(entityMime({ tp: DRAFTY_ENT_IMAGE, data: { mime: 'image/png' } }), 'image/png');
});

test('实体抽取：按类型取第一个、按 mime 前缀兜底第三方客户端', () => {
  const drafty = {
    txt: '看图',
    ent: [
      { tp: DRAFTY_ENT_LINK, data: { url: 'https://a.b' } },
      { tp: DRAFTY_ENT_IMAGE, data: { mime: 'image/jpeg', width: 800, height: 600 } },
      { tp: DRAFTY_ENT_FILE, data: { mime: 'application/pdf', name: '报告.pdf', size: 1024 } }
    ]
  };
  assert.ok(hasEntityType(drafty, DRAFTY_ENT_IMAGE));
  assert.ok(hasEntityType(drafty, DRAFTY_ENT_FILE));
  assert.ok(!hasEntityType(drafty, DRAFTY_ENT_AUDIO));
  assert.equal(firstEntityOfType(drafty, DRAFTY_ENT_IMAGE).data.width, 800);
  assert.equal(firstEntityOfType(drafty, DRAFTY_ENT_FILE).data.name, '报告.pdf');
  // 原生实体 + 标准 mime（没有自定义 head 的对端消息）
  assert.ok(hasEntityMimePrefix(drafty, 'image/'));
  assert.ok(!hasEntityMimePrefix(drafty, 'audio/'));
  assert.ok(hasEntityMimePrefix({ txt: '', ent: [{ tp: DRAFTY_ENT_AUDIO, data: { mime: 'audio/aac' } }] }, 'audio/'));
});

test('data 白名单：白名单外的键被丢掉（写入实体前必须过滤）', () => {
  assert.ok(DRAFTY_ENTITY_DATA_KEYS.includes('mime'));
  assert.ok(DRAFTY_ENTITY_DATA_KEYS.includes('val'));
  assert.ok(DRAFTY_ENTITY_DATA_KEYS.includes('preref'));
  assert.ok(!DRAFTY_ENTITY_DATA_KEYS.includes('ld_mime'), '自定义 head 键不属于实体 data');
  const dirty = {
    mime: 'image/png', name: 'a.png', size: 12, width: 1, height: 2,
    val: 'data:image/png;base64,AAA', ref: 'https://x/y', preview: 'p', premime: 'image/jpeg',
    preref: 'https://x/p', url: 'https://x', title: 't', duration: 3,
    evil: 'x', ld_extra: 'y'
  };
  const clean = sanitizeEntityData(dirty);
  assert.equal(clean.mime, 'image/png');
  assert.equal(clean.val, 'data:image/png;base64,AAA');
  assert.equal(clean.preref, 'https://x/p');
  assert.equal(clean.duration, 3);
  assert.equal(clean.evil, undefined);
  assert.equal(clean.ld_extra, undefined);
  assert.deepEqual(sanitizeEntityData(null), {});
  // 只保留传进来的键：undefined 的键不出现
  assert.deepEqual(Object.keys(sanitizeEntityData({ mime: 'image/png' })), ['mime']);
});

test('Drafty JSON 往返（审计 P1-1：实现搬进 SDK）', () => {
  assert.deepEqual(parseDraftyJson('{"txt":"你好"}'), { txt: '你好' });
  assert.deepEqual(parseDraftyJson('{"ent":[{"tp":"IM","data":{"ref":"u"}}],"txt":" "}'),
    { ent: [{ tp: 'IM', data: { ref: 'u' } }], txt: ' ' });
  assert.equal(parseDraftyJson(''), null);
  // **行为变更（批次二百零九）**：解析不了的正文按**纯文本**处理，而不是 null ——
  // 真机库里确实存在 `"😎"`（裸字符串）这种行，返回 null 会让气泡变成一条空泡。
  assert.deepEqual(parseDraftyJson('{oops'), { txt: '{oops' });
  assert.equal(parseDraftyJson('[]'), null);
  assert.equal(parseDraftyJson('null'), null);
  assert.equal(parseDraftyJson('42'), null);
  assert.deepEqual(parseDraftyJson('"text"'), { txt: 'text' });
  assert.equal(encodeDrafty(null), '');
  assert.equal(encodeDrafty({ txt: 'a' }), '{"txt":"a"}');
  // 往返稳定
  const wire = { txt: ' ', ent: [{ tp: 'EX', data: { name: 'a.pdf', ref: 'http://x/a.pdf', size: 419 } }] };
  assert.deepEqual(parseDraftyJson(encodeDrafty(wire)), wire);
});

// 裸字符串 / 纯文本正文的兼容（真机库里存在 "😎" 这种行，原来会渲染成空泡）
test('parseDraftyJson 兼容裸字符串与纯文本', () => {
  assert.deepEqual(parseDraftyJson('"😎"'), { txt: '😎' });
  assert.deepEqual(parseDraftyJson('"多个字"'), { txt: '多个字' });
  assert.deepEqual(parseDraftyJson('就是纯文本不是 JSON'), { txt: '就是纯文本不是 JSON' });
  assert.equal(parseDraftyJson('""'), null, '空字符串 → null');
  assert.equal(parseDraftyJson('null'), null);
  assert.equal(parseDraftyJson('[1,2]'), null);
  assert.deepEqual(parseDraftyJson('{"txt":"正常"}'), { txt: '正常' });
});
