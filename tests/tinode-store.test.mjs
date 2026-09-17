import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationSummaryOf, conversationSummariesOf, draftPreviewOf, isUnreadMessage, lastMessageOf,
  mergeMessages, messageKeyOf, planMessageEviction, previewOf, unreadOf
} from '../src/TinodeStore.ts';

// P4：存储与缓存策略（纯逻辑）
const msg = (seq, extra = {}) => ({
  id: `usrA-${seq}`, topic: 'usrA', seq, from: 'usrB', isMine: false, ts: 1000 + seq,
  content: { txt: `m${seq}` }, head: null, ...extra
});

test('messageKeyOf 与 mergeMessages：同 seq 覆盖、升序、丢非法 seq', () => {
  assert.equal(messageKeyOf('usrA', 7), 'usrA-7');
  const merged = mergeMessages(
    [msg(2), msg(1), msg(0), msg(-3)],
    [msg(2, { content: { txt: '服务端版本' } }), msg(3)]
  );
  assert.deepEqual(merged.map((m) => m.seq), [1, 2, 3]);
  assert.equal(merged[1].content.txt, '服务端版本', '同 seq 用 incoming 覆盖');
  assert.deepEqual(mergeMessages([], []), []);
});

test('未读：自己发的不算、按已读位点算', () => {
  const list = [msg(1), msg(2, { isMine: true }), msg(3), msg(4)];
  assert.equal(unreadOf(list, 0), 3, '没读过时对方 3 条未读（自己的不算）');
  assert.equal(unreadOf(list, 2), 2);
  assert.equal(unreadOf(list, 4), 0);
  assert.equal(isUnreadMessage(msg(5, { isMine: true }), 0), false);
  assert.equal(isUnreadMessage(msg(5), 4), true);
});

test('lastMessageOf / previewOf：取最大 seq、空白折叠、截断', () => {
  assert.equal(lastMessageOf([]), null);
  assert.equal(lastMessageOf([msg(3), msg(9), msg(5)]).seq, 9);
  assert.equal(previewOf(null), '');
  assert.equal(previewOf(msg(1, { content: { txt: '  a\n b  ' } })), 'a b');
  const long = previewOf(msg(1, { content: { txt: 'x'.repeat(50) } }), 10);
  assert.equal(long, `${'x'.repeat(10)}…`);
});

test('会话摘要：最后一条/未读/排序时间', () => {
  const topic = { topic: 'usrA', name: '张三', peerUid: 'usrA', seq: 4, read: 2, recv: 4, online: true, touchedAt: 500, lastPreview: '' };
  const summary = conversationSummaryOf(topic, [msg(1), msg(3), msg(4)]);
  assert.equal(summary.unread, 2, 'read=2 → seq 3、4 未读');
  assert.equal(summary.preview, 'm4');
  assert.equal(summary.sortAtMs, 1004, '用最后一条消息的时间排序');
  assert.equal(summary.lastSeq, 4);
  const empty = conversationSummaryOf(topic, []);
  assert.equal(empty.sortAtMs, 500, '没有消息时退回会话 touchedAt');
  assert.equal(empty.preview, '');
  const sorted = conversationSummariesOf([summary, { ...summary, topic: 'usrB', sortAtMs: 9999 }]);
  assert.deepEqual(sorted.map((s) => s.topic), ['usrB', 'usrA']);
});

test('planMessageEviction：每会话保留最近 N 条', () => {
  const byTopic = new Map([
    ['usrA', [msg(1), msg(2), msg(3), msg(4), msg(5)]],
    ['usrB', [msg(1), msg(2)]]
  ]);
  assert.deepEqual(planMessageEviction(byTopic, 3), [
    { topic: 'usrA', seq: 1 }, { topic: 'usrA', seq: 2 }
  ]);
  assert.deepEqual(planMessageEviction(byTopic, 5), []);
  assert.deepEqual(planMessageEviction(new Map(), 3), []);
});

test('draftPreviewOf：空草稿/截断', () => {
  assert.equal(draftPreviewOf(null), '');
  assert.equal(draftPreviewOf({ topic: 'usrA', text: '   ' }), '');
  assert.equal(draftPreviewOf({ topic: 'usrA', text: '半句话' }), '半句话');
  assert.equal(draftPreviewOf({ topic: 'usrA', text: 'y'.repeat(30) }, 5), 'yyyyy…');
});
