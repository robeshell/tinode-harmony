import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftyAppend, draftyDelete, draftyInsert, draftyLink, draftyMention, draftyPlain, draftySegments,
  draftyImage, draftyTrim, draftyWithEntity, draftyWithStyle, draftyWithoutStyle
} from '../src/Drafty.ts';

// P6：Drafty 写侧与渲染（纯逻辑；偏移统一 UTF-16 code unit）
const styles = (d) => (d.fmt ?? []).map((s) => `${s.tp}@${s.at}+${s.len}`);

test('构造/追加/拷贝：纯函数，不改入参', () => {
  const a = draftyPlain('你好');
  const b = draftyAppend(a, '，世界');
  assert.equal(b.txt, '你好，世界');
  assert.equal(a.txt, '你好', '入参不变');
  const c = draftyWithStyle(b, 0, 2, 'ST');
  assert.deepEqual(styles(c), ['ST@0+2']);
  assert.equal(b.fmt, undefined, '入参不变（fmt）');
  assert.equal(draftyAppend(null, 'x').txt, 'x');
});

test('加样式：越界裁剪 + 同类相邻合并 + 排序', () => {
  const base = draftyPlain('abcdef');
  let d = draftyWithStyle(base, 0, 2, 'ST');
  d = draftyWithStyle(d, 2, 2, 'ST');
  assert.deepEqual(styles(d), ['ST@0+4'], '相邻同类合并');
  d = draftyWithStyle(d, 4, 100, 'EM');
  assert.deepEqual(styles(d), ['ST@0+4', 'EM@4+2'], '越界裁剪到文本长度');
  const empty = draftyWithStyle(base, 99, 3, 'ST');
  assert.deepEqual(styles(empty), [], '完全越界 → 不加');
  assert.deepEqual(styles(draftyWithStyle(base, 0, 0, 'ST')), [], '零长度 → 不加');
});

test('去样式：切出左右残段', () => {
  let d = draftyWithStyle(draftyPlain('abcdefgh'), 0, 8, 'ST');
  d = draftyWithoutStyle(d, 2, 2, 'ST');
  assert.deepEqual(styles(d), ['ST@0+2', 'ST@4+4']);
  d = draftyWithoutStyle(d, 0, 8);
  assert.deepEqual(styles(d), [], '不传 tp 去掉区间内全部样式');
});

test('实体：链接/@提及/图片，data 过白名单', () => {
  const base = draftyPlain('看这个 链接');
  const withLink = draftyLink(base, 3, 2, 'https://example.com');
  assert.equal(withLink.ent.length, 1);
  assert.equal(withLink.ent[0].tp, 'LN');
  assert.equal(withLink.ent[0].data.url, 'https://example.com');
  assert.equal(withLink.ent[0].data.unknownKey, undefined, '未知键被白名单过滤');
  const mentioned = draftyMention(withLink, 0, 1, 'usrBob');
  assert.equal(mentioned.ent.length, 2);
  assert.equal(mentioned.ent[1].tp, 'MN');
  assert.equal(mentioned.ent[1].data.val, 'usrBob');
  const image = draftyImage(draftyPlain('x'), 0, 1, { ref: 'r1', mime: 'image/png', width: 100 });
  assert.equal(image.ent[0].tp, 'IM');
  assert.equal(image.ent[0].data.ref, 'r1');
});

test('插入/删除：偏移自动位移（编辑器语义）', () => {
  const base = draftyWithStyle(draftyPlain('abcdef'), 2, 2, 'ST');   // "cd" 加粗
  const inserted = draftyInsert(base, 0, 'XX');
  assert.equal(inserted.txt, 'XXabcdef');
  assert.deepEqual(styles(inserted), ['ST@4+2'], '样式右移');
  const middle = draftyInsert(base, 3, '中');
  assert.equal(middle.txt, 'abc中def');
  assert.deepEqual(styles(middle), ['ST@2+3'], '插入点在样式内部 → 样式拉长');
  const deletedBefore = draftyDelete(base, 0, 1);
  assert.equal(deletedBefore.txt, 'bcdef');
  assert.deepEqual(styles(deletedBefore), ['ST@1+2'], '删除点在样式左边 → 样式左移');
  const deletedInside = draftyDelete(base, 2, 1);
  assert.equal(deletedInside.txt, 'abdef');
  assert.deepEqual(styles(deletedInside), ['ST@2+1'], '删掉样式内部一段 → 样式缩短');
  const deletedAll = draftyDelete(base, 0, 6);
  assert.equal(deletedAll.txt, '');
  assert.deepEqual(styles(deletedAll), [], '整段删除后样式清空');
});

test('trim：截断并裁掉越界样式', () => {
  let d = draftyWithStyle(draftyPlain('0123456789'), 0, 10, 'ST');
  d = draftyWithStyle(d, 8, 2, 'EM');
  const trimmed = draftyTrim(d, 5);
  assert.equal(trimmed.txt, '01234');
  assert.deepEqual(styles(trimmed), ['ST@0+5'], 'EM 落在截断区外 → 丢掉');
  assert.equal(draftyTrim(draftyPlain('ab'), 10).txt, 'ab', '没超长原样返回');
});

test('draftySegments：按样式/边界切分，供 UI 直接画', () => {
  const text = 'Hello 世界';
  let d = draftyWithStyle(draftyPlain(text), 0, 5, 'ST');        // "Hello"
  d = draftyWithStyle(d, 6, 2, 'EM');                            // "世界"
  const segs = draftySegments(d);
  assert.deepEqual(segs.map((s) => s.text), ['Hello', ' ', '世界']);
  assert.deepEqual(segs[0].styles, ['ST']);
  assert.deepEqual(segs[1].styles, []);
  assert.deepEqual(segs[2].styles, ['EM']);
  assert.equal(segs[0].at, 0);
  assert.equal(segs[2].at, 6);
  assert.deepEqual(draftySegments(draftyPlain('')), []);
  const withImage = draftyWithEntity(draftyPlain('看图'), 0, 2, 'EX', { name: 'a.pdf' });
  assert.equal(draftySegments(withImage)[0].entity.tp, 'EX', '实体挂在片段上');
});

test('emoji（代理对）按 UTF-16 code unit 计数', () => {
  const d = draftyWithStyle(draftyPlain('😀ab'), 0, 2, 'ST');
  assert.deepEqual(styles(d), ['ST@0+2'], 'emoji 占 2 个 code unit');
  const segs = draftySegments(d);
  assert.deepEqual(segs.map((s) => s.text), ['😀', 'ab']);
  assert.deepEqual(segs[0].styles, ['ST']);
});
