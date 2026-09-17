import test from 'node:test';
import assert from 'node:assert/strict';
import { TinodeTopics } from '../src/TinodeTopics.ts';

// P1：主题登记（订阅意图 + 位点 + 缺口），纯逻辑
const topics = () => new TinodeTopics();

test('登记订阅意图：首次登记 / 更新 prefs 不动位点', () => {
  const t = topics();
  t.remember('usrA', true, true, 24, 100);
  t.observeData('usrA', 7, 110);
  t.remember('usrA', true, false, 50, 120);
  const s = t.stateOf('usrA');
  assert.equal(s.topic, 'usrA');
  assert.equal(s.prefs.withSub, false);
  assert.equal(s.prefs.limit, 50);
  assert.equal(s.lastSeq, 7, '更新 prefs 不应清位点');
  assert.equal(s.subscribed, false, '登记不等于订阅成功');
  assert.equal(t.stateOf('nope'), null);
  t.remember('   ', true, true, 24, 1);
  assert.equal(t.size(), 1, '空 topic 不登记');
});

test('位点推进：data.seq 取最大、note read/recv 各自推进', () => {
  const t = topics();
  t.remember('usrA', true, true, 24, 0);
  assert.equal(t.observeData('usrA', 5, 1), true);
  assert.equal(t.observeData('usrA', 3, 2), false, '回退的 seq 不覆盖');
  assert.equal(t.observeData('usrA', 9, 3), true);
  assert.equal(t.observeData('unknown', 9, 3), false, '没登记的主题不记');
  assert.equal(t.observeNote('read', 'usrA', 4, 4), true);
  assert.equal(t.observeNote('recv', 'usrA', 6, 5), true);
  assert.equal(t.observeNote('kp', 'usrA', 6, 6), false, 'kp 不推进位点');
  assert.equal(t.observeNote('read', 'usrA', 4, 7), false, '重复位点不算变化');
  const s = t.stateOf('usrA');
  assert.deepEqual([s.lastSeq, s.read, s.recv], [9, 4, 6]);
  t.markRead('usrA', 8, 8);
  assert.equal(t.stateOf('usrA').read, 8, '本端 markRead 与 note 同口径');
});

test('重连恢复：needingSubscribe 只列没订阅成功的，gaps 从 lastSeq+1 起', () => {
  const t = topics();
  t.remember('usrA', true, true, 24, 0);
  t.remember('usrB', true, true, 24, 0);
  t.observeData('usrA', 12, 0);
  t.markSubscribed('usrA', true, 0);
  assert.deepEqual(t.needingSubscribe().map((s) => s.topic), ['usrB']);
  assert.deepEqual(t.gaps(), [{ topic: 'usrA', since: 13 }], '只有见过消息的主题需要补历史');
  t.markSubscribed('usrB', true, 0);
  assert.equal(t.needingSubscribe().length, 0);
});

test('forget 之后不再自动重订阅', () => {
  const t = topics();
  t.remember('usrA', true, true, 24, 0);
  t.forget('usrA');
  assert.equal(t.size(), 0);
  assert.deepEqual(t.needingSubscribe(), []);
  assert.deepEqual(t.gaps(), []);
});

test('known 按最近活动倒序，快照是拷贝（改不到内部状态）', () => {
  const t = topics();
  t.remember('usrA', true, true, 24, 10);
  t.remember('usrB', true, true, 24, 20);
  assert.deepEqual(t.known().map((s) => s.topic), ['usrB', 'usrA']);
  const snap = t.stateOf('usrA');
  snap.lastSeq = 999;
  assert.equal(t.stateOf('usrA').lastSeq, 0, '快照改动不影响内部');
});

test('resetSubscriptions：断线清"已订阅"标记但保留意图与位点', () => {
  const t = topics();
  t.remember('usrA', true, true, 24, 0);
  t.markSubscribed('usrA', true, 0);
  t.observeData('usrA', 9, 0);
  assert.equal(t.needingSubscribe().length, 0);
  t.resetSubscriptions();
  assert.equal(t.stateOf('usrA').subscribed, false, '已订阅标记清零');
  assert.equal(t.stateOf('usrA').lastSeq, 9, '位点保留');
  assert.deepEqual(t.needingSubscribe().map((s) => s.topic), ['usrA']);
  assert.deepEqual(t.gaps(), [{ topic: 'usrA', since: 10 }]);
});
