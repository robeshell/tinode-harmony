import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayNameOf, mergeProfiles, profileFromSub, profilesFromMeta, sortTopicsByActivity, topicOfProfile
} from '../src/TinodeMeta.ts';

// P5-min：meta/sub → 会话轮廓（纯逻辑）
const sub = (topic, extra = {}) => ({
  topic, user: topic, seq: 12, read: 10, recv: 11, touched: '2026-09-17T00:00:00Z',
  online: false, pub: { fn: '张三', photo: 'ref/photo1' }, ...extra
});

test('profileFromSub：名片/位点/时间；topic 缺失返回 null', () => {
  const p = profileFromSub(sub('usrA'));
  assert.equal(p.topic, 'usrA');
  assert.equal(p.peerUid, 'usrA');
  assert.equal(p.name, '张三');
  assert.equal(p.photo, 'ref/photo1');
  assert.deepEqual([p.seq, p.read, p.recv], [12, 10, 11]);
  assert.ok(p.touchedAtMs > 0);
  assert.equal(profileFromSub({ seq: 1 }), null, '没有 topic 也没有兜底 → null');
  assert.equal(profileFromSub({ seq: 1 }, 'usrB').topic, 'usrB', '可用兜底 topic');
  const bare = profileFromSub({ topic: 'usrC' });
  assert.deepEqual([bare.name, bare.photo, bare.seq, bare.read, bare.recv, bare.online], ['', '', 0, 0, 0, false]);
  assert.equal(bare.touchedAtMs, 0, '没有 touched → 0');
});

test('profilesFromMeta：逐条转换 + 兜底 topic', () => {
  const list = profilesFromMeta({ topic: 'me', sub: [sub('usrA'), { seq: 3 }] });
  assert.equal(list.length, 2, 'meta.topic 会作为缺 topic 那条的兜底');
  assert.equal(list[1].topic, 'me');
  const withFallback = profilesFromMeta({ topic: 'me', sub: [{ seq: 3 }] });
  assert.equal(withFallback[0].topic, 'me', 'meta.topic 作为兜底');
  assert.deepEqual(profilesFromMeta({ topic: '', sub: [{ seq: 3 }] }), [], '连兜底都没有 → 丢弃');
  assert.deepEqual(profilesFromMeta(null), []);
  assert.deepEqual(profilesFromMeta({ topic: 'me' }), []);
});

test('mergeProfiles：非空字段优先、位点取最大、时间取最新、不丢旧项', () => {
  const known = [profileFromSub(sub('usrA')), profileFromSub(sub('usrB'))];
  const incoming = [
    profileFromSub({ topic: 'usrA', seq: 20, read: 5, pub: { fn: '' }, touched: '2026-09-18T00:00:00Z' }),
    profileFromSub(sub('usrC', { pub: { fn: '李四' } }))
  ];
  const merged = mergeProfiles(known, incoming);
  const a = merged.find((p) => p.topic === 'usrA');
  assert.equal(a.seq, 20, 'seq 取最大');
  assert.equal(a.read, 10, 'read 不被更小的值覆盖');
  assert.equal(a.name, '张三', '名字为空时保留旧值');
  assert.ok(a.touchedAtMs > known[0].touchedAtMs);
  assert.equal(merged.length, 3, 'usrB 保留');
  assert.equal(merged.find((p) => p.topic === 'usrC').name, '李四');
});

test('topicOfProfile：轮廓 → TinodeTopic（保留 previous 的 name/preview）', () => {
  const previous = { topic: 'usrA', name: '旧名', peerUid: 'usrA', seq: 3, read: 1, recv: 2, online: false, touchedAt: 100, lastPreview: '上一条' };
  const topic = topicOfProfile(profileFromSub(sub('usrA')), previous);
  assert.equal(topic.name, '张三');
  assert.equal(topic.seq, 12);
  assert.equal(topic.lastPreview, '上一条', '预览由宿主维护，这里不丢');
  const onlySeq = topicOfProfile({ topic: 'usrA', peerUid: 'usrA', name: '', photo: '', seq: 0, read: 0, recv: 0, online: false, touchedAtMs: 0 }, previous);
  assert.deepEqual([onlySeq.name, onlySeq.seq, onlySeq.read, onlySeq.touchedAt, onlySeq.lastPreview], ['旧名', 3, 1, 100, '上一条']);
});

test('displayNameOf 三级兜底与列表排序', () => {
  assert.equal(displayNameOf('usrA', '通讯录名', 'Tinode 名'), '通讯录名');
  assert.equal(displayNameOf('usrA', '  ', 'Tinode 名'), 'Tinode 名');
  assert.equal(displayNameOf('usrA', '', ''), 'usrA');
  const topics = [
    { topic: 'usrB', touchedAt: 100 }, { topic: 'usrA', touchedAt: 300 }, { topic: 'usrC', touchedAt: 300 }
  ];
  assert.deepEqual(sortTopicsByActivity(topics).map((t) => t.topic), ['usrA', 'usrC', 'usrB']);
});

// P5-min：pres 应用（在线 / 最后在线）
test('applyPresence：on 置在线、off/gone 记最后在线、kp 只刷新活动时间', async () => {
  const { applyPresence } = await import('../src/TinodeMeta.ts');
  const base = profileFromSub(sub('usrA'));
  const online = applyPresence(base, 'on', undefined, 1000);
  assert.equal(online.online, true);
  assert.equal(online.lastSeenMs, 0, 'on 不改最后在线');
  const offline = applyPresence(online, 'off', '2026-09-17T02:00:00Z', 2000);
  assert.equal(offline.online, false);
  assert.ok(offline.lastSeenMs > 0, 'off 记录最后在线');
  assert.equal(base.online, false, '不改原对象');
  const later = offline.touchedAtMs + 5000;      // 必须晚于名片里的 touched，否则按"不倒退"语义保持原值
  const typing = applyPresence(offline, 'kp', undefined, later);
  assert.equal(typing.online, false, 'kp 不改在线状态');
  assert.equal(typing.touchedAtMs, later, 'kp 刷新活动时间');
  assert.equal(applyPresence(offline, 'kp', undefined, 10).touchedAtMs, offline.touchedAtMs, '更早的时间不倒退');
  assert.equal(typing.lastSeenMs, offline.lastSeenMs);
});
