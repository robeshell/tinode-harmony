import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IM_CHANNEL_NEW, IM_TOPIC_GRP_PREFIX, IM_TOPIC_ME, IM_TOPIC_NEW, IM_TOPIC_SYS, IM_TOPIC_USR_PREFIX,
  canApproveMembers, canDeleteGroupMessages, canEditGroup, canInviteMembers, groupInfoFromMeta,
  groupPermissionsOf, isChannelTopic, isGroupTopic, isNewTopic, isP2PTopic, memberFromSub, memberOf,
  membersFromMeta, mergeMembers, newChannelTopicName, newGroupTopicName, sortMembers, topicKindOf,
  uniqueTopicSuffix
} from '../src/TinodeGroup.ts';
import {
  buildDelSubscription, buildGetMetaSub, buildSetDefacs, buildSetSubMode, buildSubCreate
} from '../src/TinodeWire.ts';
import { updateAccessMode } from '../src/TinodeAcs.ts';

// P7 批次一：群组（纯逻辑）。事实来源是 Apache-2.0 的 vendored 官方 Java SDK：
// 建群见 Topic.java:96,925-928；成员权限见 Topic.java:1308-1391；移出群见 Tinode.java:1752；
// 权限字母见 AcsHelper:15-22 与 AcsHelper.update:222-260。这些用例钉住报文形状与判定口径。

// ── 1. 话题分类 ────────────────────────────────────────────────────────────

test('topicKindOf：grp/new → grp；chn/nch → chn；usr → p2p；保留话题原样', () => {
  assert.equal(topicKindOf('grpAbCd12'), 'grp');
  assert.equal(topicKindOf('newAbCd12'), 'grp', 'new… 是"还没同步的群"，上游也归 GRP（Topic.java:163-167）');
  assert.equal(topicKindOf('chnAbCd12'), 'chn', '上游把 chn 也归 GRP，本端分出来更精确');
  assert.equal(topicKindOf('nchAbCd12'), 'chn');
  assert.equal(topicKindOf('usrAbCd12'), 'p2p');
  assert.equal(topicKindOf(IM_TOPIC_ME), 'me');
  assert.equal(topicKindOf('fnd'), 'fnd');
  assert.equal(topicKindOf(IM_TOPIC_SYS), 'sys');
  assert.equal(topicKindOf('whatever'), 'unknown');
  assert.equal(topicKindOf(''), 'unknown');
  assert.equal(topicKindOf(null), 'unknown');
  assert.equal(topicKindOf(undefined), 'unknown');
  assert.equal(topicKindOf('  grpAbC  '), 'grp', '两侧空白先 trim');
});

test('isGroupTopic：群与频道都算"群类"，单聊/保留话题不算', () => {
  assert.equal(isGroupTopic('grpA'), true);
  assert.equal(isGroupTopic('newA'), true);
  assert.equal(isGroupTopic('chnA'), true);
  assert.equal(isGroupTopic('nchA'), true);
  assert.equal(isGroupTopic('usrA'), false);
  assert.equal(isGroupTopic('me'), false);
  assert.equal(isGroupTopic(null), false);
  assert.equal(isP2PTopic('usrA'), true);
  assert.equal(isP2PTopic('grpA'), false);
  assert.equal(isChannelTopic('chnA'), true);
  assert.equal(isChannelTopic('nchA'), true);
  assert.equal(isChannelTopic('grpA'), false);
});

test('isNewTopic：只认 new/nch 前缀（与上游 startsWith 同口径）', () => {
  assert.equal(isNewTopic('newAbC'), true);
  assert.equal(isNewTopic('nchAbC'), true);
  assert.equal(isNewTopic('grpAbC'), false);
  assert.equal(isNewTopic('new'), true, '只有前缀本身也算（上游 name.startsWith(TOPIC_NEW)）');
  assert.equal(isNewTopic(null), false);
  assert.equal(isNewTopic(undefined), false);
  // 上游是纯前缀判断，所以以 new 开头的普通名字同样命中；这里如实钉住，不假装更聪明。
  assert.equal(isNewTopic('newsstand'), true, '上游同口径：new 开头的名字都当"新话题"');
});

// ── 2. 新话题命名 ──────────────────────────────────────────────────────────

test('uniqueTopicSuffix：确定、可复现，且只用 32 进制字符', () => {
  const first = uniqueTopicSuffix(1758000000000, 1, 0.5);
  assert.equal(first, uniqueTopicSuffix(1758000000000, 1, 0.5), '同输入必须同输出（纯函数）');
  assert.match(first, /^[0-9a-v]+$/);
  assert.equal(uniqueTopicSuffix(1758000000000, 2, 0.5) === first, false, '同一毫秒靠 counter 区分');
  assert.equal(uniqueTopicSuffix(1758000000000, 1, 0.25) === first, false, '同一 counter 靠随机段区分');
});

test('newGroupTopicName / newChannelTopicName：前缀正确、长度远低于任何上限', () => {
  const group = newGroupTopicName(1758000000000, 3, 0.125);
  const channel = newChannelTopicName(1758000000000, 3, 0.125);
  assert.equal(group.startsWith(IM_TOPIC_NEW), true);
  assert.equal(channel.startsWith(IM_CHANNEL_NEW), true);
  assert.equal(isNewTopic(group), true);
  assert.equal(isNewTopic(channel), true);
  assert.equal(topicKindOf(group), 'grp');
  assert.equal(topicKindOf(channel), 'chn');
  assert.match(group, /^new[0-9a-v]+$/);
  assert.match(channel, /^nch[0-9a-v]+$/);
  assert.ok(group.length <= 64, `群名太长：${group}`);
  assert.ok(channel.length <= 64, `频道名太长：${channel}`);
});

test('newGroupTopicName：脏输入不抛异常，仍给出可用名字', () => {
  const cases = [
    newGroupTopicName(0, 0, 0),
    newGroupTopicName(Number.NaN, Number.NaN, Number.NaN),
    newGroupTopicName(-5, -1, -1),
    newGroupTopicName(1758000000000, 1, 1.5),
    newGroupTopicName(1758000000000, 1, 0.9999999)
  ];
  for (let i = 0; i < cases.length; i++) {
    assert.match(cases[i], /^new[0-9a-v]+$/, `第 ${i} 个输入产出了非法名字：${cases[i]}`);
  }
  // 超范围随机数要夹到 [0,1)：1.5 与 0.9999999 都不能溢出到 4 位随机段。
  assert.equal(newGroupTopicName(1758000000000, 1, 1.5),
    newGroupTopicName(1758000000000, 1, 0.999999), '越界随机数夹取到上界');
});

test('话题前缀常量与上游一致', () => {
  assert.equal(IM_TOPIC_ME, 'me');
  assert.equal(IM_TOPIC_SYS, 'sys');
  assert.equal(IM_TOPIC_NEW, 'new');
  assert.equal(IM_CHANNEL_NEW, 'nch');
  assert.equal(IM_TOPIC_GRP_PREFIX, 'grp');
  assert.equal(IM_TOPIC_USR_PREFIX, 'usr');
});

// ── 3. 成员解析 ────────────────────────────────────────────────────────────

const memberSub = (extra = {}) => ({
  topic: 'grpA', user: 'usrB', seq: 9, read: 8, recv: 9, touched: '2026-09-17T00:00:00Z',
  online: true, pub: { fn: '张三', photo: { ref: 'photo/1' } },
  acs: { given: 'JRWPA', want: 'JRWPA', mode: 'jrwpa' }, ...extra
});

test('memberFromSub：权限/名片/在线/时间都取到，mode 归一化', () => {
  const member = memberFromSub(memberSub());
  assert.equal(member.user, 'usrB');
  assert.equal(member.topic, 'grpA');
  assert.equal(member.mode, 'JRWPA', 'parseAcs 归一化大小写');
  assert.equal(member.want, 'JRWPA');
  assert.equal(member.given, 'JRWPA');
  assert.equal(member.online, true);
  assert.equal(member.name, '张三');
  assert.equal(member.photo, 'photo/1', 'photo 是 {ref} 形态也认');
  assert.ok(member.touchedAtMs > 0, 'touched 解析成毫秒');
});

test('memberFromSub：没有 user 的行不是成员（单聊 sub 才只有 topic）', () => {
  assert.equal(memberFromSub({ topic: 'usrA' }), null);
  assert.equal(memberFromSub({ user: '   ' }), null);
  assert.equal(memberFromSub({ user: '', topic: 'grpA' }), null);
});

test('memberFromSub：acs 缺失 → 权限空串；mode=N（封禁）保留为 N', () => {
  const plain = memberFromSub({ user: 'usrB', topic: 'grpA' });
  assert.equal(plain.mode, '');
  assert.equal(plain.want, '');
  assert.equal(plain.given, '');
  assert.equal(plain.online, false);
  assert.equal(plain.name, '');
  assert.equal(plain.touchedAtMs, 0);
  const banned = memberFromSub({ user: 'usrB', topic: 'grpA', acs: { mode: 'N' } });
  assert.equal(banned.mode, 'N', 'N 是有效值（封禁/无权限），不能当成"空"');
});

test('memberFromSub：sub 没带 topic 时用所在群兜底', () => {
  assert.equal(memberFromSub({ user: 'usrB' }, 'grpA').topic, 'grpA');
  assert.equal(memberFromSub({ user: 'usrB' }, '  grpA  ').topic, 'grpA');
  assert.equal(memberFromSub({ user: 'usrB', topic: 'grpZ' }, 'grpA').topic, 'grpZ', '自带 topic 优先');
});

test('membersFromMeta：逐条转换 + 丢弃无 user 的行 + meta.topic 兜底', () => {
  const meta = {
    topic: 'grpA',
    sub: [
      { user: 'usrB', acs: { mode: 'JRWPA' } },
      { topic: 'usrC' },
      { user: 'usrD', acs: { mode: 'R' } }
    ]
  };
  const members = membersFromMeta(meta);
  assert.deepEqual(members.map((m) => m.user), ['usrB', 'usrD']);
  assert.deepEqual(members.map((m) => m.topic), ['grpA', 'grpA']);
  assert.deepEqual(membersFromMeta(null), []);
  assert.deepEqual(membersFromMeta(undefined), []);
  assert.deepEqual(membersFromMeta({ topic: 'grpA' }), []);
  assert.deepEqual(membersFromMeta(meta, 'grpFallback').map((m) => m.topic), ['grpA', 'grpA'],
    'meta.topic 优先于 fallback');
});

// ── 4. 成员合并与查找 ──────────────────────────────────────────────────────

test('mergeMembers：非空优先、增量不清空、位点取最新', () => {
  const known = [
    memberFromSub(memberSub()),
    memberFromSub({ user: 'usrE', topic: 'grpA', pub: { fn: '李四' }, acs: { mode: 'R' } })
  ];
  const incoming = [
    memberFromSub({ user: 'usrB', topic: 'grpA', online: false, touched: '2026-09-18T00:00:00Z' })
  ];
  const merged = mergeMembers(known, incoming);
  assert.equal(merged.length, 2, 'incoming 没提到的成员要保留');
  const b = memberOf(merged, 'usrB');
  assert.equal(b.name, '张三', 'incoming 没带名片 → 保留旧名字');
  assert.equal(b.photo, 'photo/1', '头像同样保留');
  assert.equal(b.mode, 'JRWPA', 'incoming 没带权限 → 保留旧权限');
  assert.ok(b.touchedAtMs >= messageMs('2026-09-18T00:00:00Z'), 'touched 取最新');
  assert.equal(b.online, true, 'online 只增不减（服务端不给"离线"信号时不误判）');
});

test('mergeMembers：权限 "N" 是有效值，必须能覆盖旧的 "RW"', () => {
  const known = [memberFromSub({ user: 'usrB', topic: 'grpA', acs: { mode: 'RW' } })];
  const incoming = [memberFromSub({ user: 'usrB', topic: 'grpA', acs: { mode: 'N' } })];
  assert.equal(memberOf(mergeMembers(known, incoming), 'usrB').mode, 'N', '封禁要生效（判空而不是判真假）');
  const emptyIncoming = [memberFromSub({ user: 'usrB', topic: 'grpA' })];
  assert.equal(memberOf(mergeMembers(known, emptyIncoming), 'usrB').mode, 'RW', '空权限不覆盖旧值');
});

test('memberOf：按 uid 精确查找', () => {
  const members = membersFromMeta({ topic: 'grpA', sub: [{ user: 'usrB' }, { user: 'usrC' }] });
  assert.equal(memberOf(members, 'usrC').user, 'usrC');
  assert.equal(memberOf(members, ' usrC ').user, 'usrC', '两侧空白容忍');
  assert.equal(memberOf(members, 'usrZ'), null);
  assert.equal(memberOf(members, ''), null);
  assert.equal(memberOf([], 'usrB'), null);
});

function messageMs(iso) {
  return Date.parse(iso);
}

// ── 5. 成员排序 ────────────────────────────────────────────────────────────

test('sortMembers：所有者 → 在线 → 有名字 → uid，且不改原数组', () => {
  const list = [
    memberFromSub({ user: 'usr1', topic: 'g', pub: { fn: 'B' }, online: false, acs: { mode: 'RW' } }),
    memberFromSub({ user: 'usr2', topic: 'g', pub: { fn: 'A' }, online: true, acs: { mode: 'RW' } }),
    memberFromSub({ user: 'usr3', topic: 'g', pub: { fn: 'C' }, online: false, acs: { mode: 'O' } }),
    memberFromSub({ user: 'usr4', topic: 'g', online: false, acs: { mode: 'RW' } })
  ];
  const sorted = sortMembers(list);
  assert.deepEqual(sorted.map((m) => m.user), ['usr3', 'usr2', 'usr1', 'usr4']);
  assert.deepEqual(list.map((m) => m.user), ['usr1', 'usr2', 'usr3', 'usr4'], '原数组顺序不变');
});

// ── 6. 群权限判定 ──────────────────────────────────────────────────────────

test('groupPermissionsOf：O 全权，N 全禁，空权限不误报封禁', () => {
  const owner = groupPermissionsOf('O');
  assert.deepEqual(owner, {
    isOwner: true, canRead: true, canWrite: true, canInvite: true,
    canApprove: true, canDeleteMessages: true, canEdit: true, isBanned: false
  }, 'O 隐含全部能力');
  const banned = groupPermissionsOf('N');
  assert.equal(banned.isBanned, true);
  assert.equal(banned.isOwner, false);
  assert.equal(banned.canRead, false);
  assert.equal(banned.canWrite, false);
  const none = groupPermissionsOf('');
  assert.equal(none.isBanned, false, '空串是"未指定"，不是"被封禁"');
  assert.equal(none.canRead, false);
  assert.equal(groupPermissionsOf(null).isBanned, false);
  assert.equal(groupPermissionsOf(undefined).isBanned, false);
});

test('groupPermissionsOf：普通成员的邀请/审批/删除要按字母分开', () => {
  const member = groupPermissionsOf('JRWPA');
  assert.equal(member.canInvite, false, '没有 S 就不能邀请');
  assert.equal(member.canApprove, true, '有 A 能审批');
  assert.equal(member.canDeleteMessages, false, '没有 D 不能硬删');
  assert.equal(member.canEdit, false, '非所有者不能改群资料');
  const moderator = groupPermissionsOf('JRWPASD');
  assert.equal(moderator.canInvite, true);
  assert.equal(moderator.canDeleteMessages, true);
  assert.equal(moderator.isOwner, false);
  assert.equal(moderator.canEdit, false, 'canEdit 按"需要 O"处理');
});

test('独立的权限判定函数与 groupPermissionsOf 口径一致', () => {
  assert.equal(canInviteMembers('S'), true);
  assert.equal(canInviteMembers('O'), true, 'O 隐含');
  assert.equal(canInviteMembers('JRWPA'), false);
  assert.equal(canApproveMembers('A'), true);
  assert.equal(canApproveMembers('JRWP'), false);
  assert.equal(canDeleteGroupMessages('D'), true);
  assert.equal(canDeleteGroupMessages('O'), true);
  assert.equal(canDeleteGroupMessages('RW'), false);
  assert.equal(canEditGroup('O'), true);
  assert.equal(canEditGroup('JRWPASD'), false);
});

// ── 7. 群资料 ──────────────────────────────────────────────────────────────

const groupMeta = (extra = {}) => ({
  topic: 'grpA',
  desc: {
    public: { fn: '项目群', photo: { ref: 'photo/g' } },
    defacs: { auth: 'JRWPA', anon: 'N' },
    acs: { given: 'JRWPA', want: 'JRWPA', mode: 'jrwp' }
  }, ...extra
});

test('groupInfoFromMeta：群名/头像/默认权限/我的权限', () => {
  const info = groupInfoFromMeta(groupMeta());
  assert.equal(info.topic, 'grpA');
  assert.equal(info.kind, 'grp');
  assert.equal(info.name, '项目群');
  assert.equal(info.photo, 'photo/g');
  assert.deepEqual(info.defacs, { auth: 'JRWPA', anon: 'N' }, 'N 保留（显式无权限）');
  assert.deepEqual(info.acs, { mode: 'JRWP', want: 'JRWPA', given: 'JRWPA' }, 'mode 归一化');
});

test('groupInfoFromMeta：只认群类话题（单聊走 profileFromDesc）', () => {
  assert.equal(groupInfoFromMeta(groupMeta({ topic: 'usrA' })), null);
  assert.equal(groupInfoFromMeta(groupMeta({ topic: 'me' })), null);
  assert.equal(groupInfoFromMeta({ desc: { public: { fn: 'x' } } }), null, '话题缺失');
  assert.equal(groupInfoFromMeta({ topic: '   ' }), null);
  assert.equal(groupInfoFromMeta(null), null);
  assert.equal(groupInfoFromMeta(undefined), null);
});

test('groupInfoFromMeta：新群（new…）可解析；desc 缺失/畸形不抛', () => {
  const fresh = groupInfoFromMeta({ topic: 'newAbC' });
  assert.equal(fresh.kind, 'grp');
  assert.equal(fresh.name, '');
  assert.equal(fresh.photo, '');
  assert.deepEqual(fresh.defacs, { auth: '', anon: '' });
  assert.deepEqual(fresh.acs, { mode: '', want: '', given: '' });
  assert.equal(groupInfoFromMeta({ topic: 'chnA', desc: { public: 'not-an-object' } }).name, '',
    'public 形态不对时名字为空，不抛异常');
  assert.equal(groupInfoFromMeta({ topic: 'grpA', desc: 'nope' }).name, '');
});

// ── 8. 报文构造 ────────────────────────────────────────────────────────────

test('buildSubCreate：sub{topic,set{desc{public,defacs},tags}} 形状与上游一致', () => {
  const frame = JSON.parse(buildSubCreate('7', 'newAbC', {
    name: ' 项目群 ', photo: 'photo/g', defacs: { auth: 'JRWPA', anon: 'N' }, tags: ['team']
  }));
  assert.deepEqual(frame, {
    sub: {
      id: '7', topic: 'newAbC',
      set: {
        desc: { public: { fn: '项目群', photo: 'photo/g' }, defacs: { auth: 'JRWPA', anon: 'N' } },
        tags: ['team']
      }
    }
  });
});

test('buildSubCreate：空资料不发空 desc；空 topic 返回空串', () => {
  assert.deepEqual(JSON.parse(buildSubCreate('1', 'newA', {})), {
    sub: { id: '1', topic: 'newA', set: { desc: {} } }
  }, '没有名字/头像/默认权限时不发 public/defacs，但仍要给 desc');
  assert.deepEqual(JSON.parse(buildSubCreate('1', 'newA', { name: '  ', tags: [] })), {
    sub: { id: '1', topic: 'newA', set: { desc: {} } }
  }, '空白名字与空标签都忽略');
  assert.equal(buildSubCreate('1', '   ', { name: 'x' }), '', 'topic 非法不发帧');
});

test('buildSetSubMode：邀请/改权限发整串 mode，user 空表示自己', () => {
  assert.deepEqual(JSON.parse(buildSetSubMode('2', 'grpA', 'usrB', 'jrwp')), {
    set: { id: '2', topic: 'grpA', sub: { user: 'usrB', mode: 'JRWP' } }
  }, 'mode 归一化并按标准顺序');
  assert.deepEqual(JSON.parse(buildSetSubMode('3', 'grpA', '', 'RW')), {
    set: { id: '3', topic: 'grpA', sub: { mode: 'RW' } }
  }, 'user 为空 = 改我自己的订阅');
  assert.deepEqual(JSON.parse(buildSetSubMode('4', 'grpA', 'usrB', 'N')), {
    set: { id: '4', topic: 'grpA', sub: { user: 'usrB', mode: 'N' } }
  }, 'N = 封禁（保留订阅但不给权限，Topic.java:1422）');
  assert.equal(buildSetSubMode('5', 'grpA', 'usrB', 'X'), '', '非法权限不发脏帧');
  assert.equal(buildSetSubMode('6', 'grpA', 'usrB', ''), '', '空权限不发帧');
});

test('buildSetDefacs：改群的默认权限，空侧省略，双侧空不发', () => {
  assert.deepEqual(JSON.parse(buildSetDefacs('8', 'grpA', 'jrwp', 'n')), {
    set: { id: '8', topic: 'grpA', desc: { defacs: { auth: 'JRWP', anon: 'N' } } }
  });
  assert.deepEqual(JSON.parse(buildSetDefacs('9', 'grpA', 'JRWPA', '')), {
    set: { id: '9', topic: 'grpA', desc: { defacs: { auth: 'JRWPA' } } }
  }, '只改 auth 时不要带空的 anon');
  assert.equal(buildSetDefacs('10', 'grpA', '', ''), '', '没有变更不发帧');
});

test('buildDelSubscription：移出群必须带 user（服务端拒绝空 user）', () => {
  assert.deepEqual(JSON.parse(buildDelSubscription('11', 'grpA', ' usrB ')), {
    del: { id: '11', topic: 'grpA', what: 'sub', user: 'usrB' }
  });
  assert.equal(buildDelSubscription('12', 'grpA', ''), '');
  assert.equal(buildDelSubscription('13', 'grpA', '   '), '');
});

test('成员列表复用 buildGetMetaSub（get{what:"sub"}）', () => {
  assert.deepEqual(JSON.parse(buildGetMetaSub('14', 'grpA', 24)), {
    get: { id: '14', topic: 'grpA', what: 'sub', sub: { limit: 24 } }
  });
  assert.deepEqual(JSON.parse(buildGetMetaSub('15', 'grpA', 0)), {
    get: { id: '15', topic: 'grpA', what: 'sub', sub: {} }
  }, 'limit <= 0 时不带 limit（用服务端默认）');
});

// ── 9. 权限增量修改（AcsHelper.update 口径） ───────────────────────────────

test('updateAccessMode：整串替换按标准顺序归一化', () => {
  assert.equal(updateAccessMode('RW', 'JSA'), 'JAS');
  assert.equal(updateAccessMode('RW', 'n'), 'N');
  assert.equal(updateAccessMode('', 'OW'), 'WO', '空旧值当无权限起步');
  assert.equal(updateAccessMode(null, 'rwx'), null,
    '整串替换对未知字母是**严格**的（上游 decode 返回 INVALID → 抛）：这是要发给服务端改别人权限的值，不能猜');
  assert.equal(updateAccessMode(null, 'rw'), 'RW', '大小写不算未知字母');
});

test('updateAccessMode：+/- 增量（上游 "+JS-WR" 语法）', () => {
  assert.equal(updateAccessMode('RW', '+P-S'), 'RWP');
  assert.equal(updateAccessMode('JRW', '-R'), 'JW');
  assert.equal(updateAccessMode('RW', '+P-W-A'), 'RP');
  assert.equal(updateAccessMode('N', '+R'), 'R', '从封禁恢复读权限');
  assert.equal(updateAccessMode('RW', '+N'), 'RW', '增量里的 N 是"无操作"（上游 continue）');
});

test('updateAccessMode：空修改返回当前整串；非法输入返回 null', () => {
  assert.equal(updateAccessMode('rw', ''), 'RW');
  assert.equal(updateAccessMode('RW', null), 'RW');
  assert.equal(updateAccessMode('N', '   '), 'N');
  assert.equal(updateAccessMode('RW', 'R+W'), null, '字母写在增量前 = 非法（上游同样抛）');
  assert.equal(updateAccessMode('RW', '+X'), null, '未知字母');
  assert.equal(updateAccessMode('RW', '+'), null, '操作符后为空');
  assert.equal(updateAccessMode('RW', '-'), null);
  assert.equal(updateAccessMode('RW', '+R-'), null, '尾部悬空操作符');
  assert.equal(updateAccessMode('RW', '@R'), null);
});
