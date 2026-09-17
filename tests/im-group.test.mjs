import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IM_CODE_BAD_REQUEST, IM_CODE_FORBIDDEN, IM_CODE_OK,
  ctrlAccepted,
  ImSession, MemoryTinodeStorage, Tinode, TinodeTopics, defaultSessionConfig, updateAccessMode
} from '../src/Index.ts';

// P7 批次二：群组的**会话/门面接线**（建群改名、成员、权限、应答归因、断线不挂死）。
// 事实来源：上游 `Topic.java:96,880-935,952-958,1298-1391`、`Tinode.java:1752`。
// 全部用假传输，不碰网络。

/** 假传输（会话级）：`open` 只挂回调，由测试自己 `fireOpen`，这样才能控制重连时机。 */
class FakeTransport {
  constructor(clock) {
    this.clock = clock;
    this.sent = [];
    this.handlers = null;
  }
  open(handlers) { this.handlers = handlers; }
  send(text) { this.sent.push(text); }
  close() { this.handlers = null; }
  fireOpen(nowMs = this.clock()) { if (this.handlers) this.handlers.onOpen(nowMs); }
  fireMessage(obj, nowMs = this.clock()) {
    if (this.handlers) this.handlers.onMessage(JSON.stringify(obj), nowMs);
  }
  fireClose(nowMs = this.clock()) { if (this.handlers) this.handlers.onClose(nowMs); }
}

function harness(configPatch = {}) {
  let now = 0;
  const failures = [];
  const states = [];
  const topicStates = [];
  const transport = new FakeTransport(() => now);
  const config = defaultSessionConfig('wss://im.example.com:6061', 'tok-1', 'T/1.0.0', 'dev-1');
  config.random = () => 0;
  const patched = Object.assign(config, configPatch);
  const session = new ImSession(transport, patched, {
    onState: (state) => { states.push(state); },
    onData: () => {}, onInfo: () => {}, onPres: () => {}, onMeta: () => {}, onNote: () => {},
    onCtrl: () => {},
    onFailure: (text) => { failures.push(text); },
    onServerVersion: () => {},
    onTopicState: (state) => { topicStates.push(state.topic); }
  });
  return {
    transport, session, failures, states, topicStates,
    start(ms = 0) { now = ms; session.start(ms); },
    tick(ms) { now = ms; session.tick(ms); },
    login(uid = 'usrMe', ms = 10) {
      transport.fireOpen(ms);
      // id 从报文里读，别硬编码：建群等请求会先占掉 id，硬编码会在重连时错位。
      const hi = JSON.parse(transport.sent[transport.sent.length - 1]);
      transport.fireMessage({ ctrl: { id: hi.hi.id, code: IM_CODE_OK, params: { ver: '0.25' } } }, ms + 1);
      const login = JSON.parse(transport.sent[transport.sent.length - 1]);
      transport.fireMessage({ ctrl: { id: login.login.id, code: IM_CODE_OK, params: { user: uid } } }, ms + 2);
    },
    frames() { return transport.sent.map((f) => JSON.parse(f)); },
    lastFrame() { return JSON.parse(transport.sent[transport.sent.length - 1]); }
  };
}

/** 假传输（门面级）：`open` 立即回调 onOpen，测试只管 feed 服务端报文。 */
function facadeTransport() {
  const sent = [];
  let handlers = null;
  return {
    sent,
    open(next) { handlers = next; next.onOpen(1000); },
    send(text) { sent.push(text); },
    close() {},
    feed(obj) { handlers.onMessage(JSON.stringify(obj), 1000); },
    lastFrame() { return JSON.parse(sent[sent.length - 1]); }
  };
}

function facadeHarness(hooks = {}) {
  const transport = facadeTransport();
  const storage = new MemoryTinodeStorage();
  const failures = [];
  const facade = new Tinode({
    transport, storage,
    config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' },
    hooks: Object.assign({ onFailure: (text) => { failures.push(text); } }, hooks)
  });
  facade.start(1000);
  transport.feed({ ctrl: { id: '0', code: IM_CODE_OK, params: { ver: '0.25' } } });
  const loginId = JSON.parse(transport.sent[transport.sent.length - 1]).login.id;
  transport.feed({ ctrl: { id: loginId, code: IM_CODE_OK, params: { user: 'usrMe' } } });
  return { transport, storage, facade, failures };
}

// ── 1. 建群改名（TinodeTopics.rename） ─────────────────────────────────────

test('TinodeTopics.rename：登记状态搬到新名下（意图与位点都保留）', () => {
  const topics = new TinodeTopics();
  topics.remember('newAbC', true, false, 0, 100);
  topics.markSubscribed('newAbC', true, 110);
  topics.observeData('newAbC', 7, 120);
  topics.observeNote('read', 'newAbC', 5, 130);

  assert.equal(topics.rename('newAbC', 'grpReal'), true);
  assert.equal(topics.stateOf('newAbC'), null, '占位名必须消失');
  const moved = topics.stateOf('grpReal');
  assert.equal(moved.subscribed, true);
  assert.equal(moved.lastSeq, 7);
  assert.equal(moved.read, 5);
  assert.equal(moved.prefs.withDesc, true);
  assert.equal(moved.prefs.withSub, false);
  assert.deepEqual(topics.needingSubscribe(), [], '已订阅的不会被重订');
  assert.deepEqual(topics.gaps(), [{ topic: 'grpReal', since: 8 }], '补历史用新名字');
});

test('TinodeTopics.rename：目标名已登记时合并（位点取最大、subscribed 取或）', () => {
  const topics = new TinodeTopics();
  topics.remember('newAbC', true, false, 0, 100);
  topics.observeData('newAbC', 9, 100);
  topics.remember('grpReal', true, true, 50, 200);
  topics.observeData('grpReal', 4, 200);
  assert.equal(topics.rename('newAbC', 'grpReal'), true);
  const merged = topics.stateOf('grpReal');
  assert.equal(merged.lastSeq, 9, '位点取最大，不能倒退');
  assert.equal(merged.prefs.limit, 50, '目标名自己的订阅意图优先（后登记的那份）');
  assert.equal(topics.stateOf('newAbC'), null);
});

test('TinodeTopics.rename：未登记/同名/空串都是 no-op', () => {
  const topics = new TinodeTopics();
  assert.equal(topics.rename('newAbC', 'grpReal'), false, '未登记');
  topics.remember('grpReal', true, false, 0, 1);
  assert.equal(topics.rename('grpReal', 'grpReal'), false, '同名');
  assert.equal(topics.rename('', 'grpReal'), false);
  assert.equal(topics.rename('grpReal', '   '), false);
  assert.equal(topics.stateOf('grpReal') === null, false, 'no-op 不该误删');
});

// ── 2. 会话：建群（sub 带 set，用应答改名） ────────────────────────────────

test('ImSession.createTopic：未就绪返回空串；就绪后发 sub{topic:"new…", set{desc,tags}}', () => {
  const h = harness();
  assert.equal(h.session.createTopic('newAbC', { name: '群' }), '', '未就绪不发帧');
  h.start(0);
  h.login();
  assert.equal(h.session.state(), 'ready');

  const id = h.session.createTopic('newAbC', { name: ' 项目群 ', tags: ['team'] });
  assert.ok(id.length > 0);
  assert.deepEqual(h.lastFrame(), {
    sub: { id: id, topic: 'newAbC', set: { desc: { public: { fn: '项目群' } }, tags: ['team'] } }
  });
  assert.equal(h.session.topicState('newAbC').subscribed, false, '应答之前不算订阅成功');
  assert.equal(h.session.createTopic('   ', {}), '', '空话题名不发帧');
});

test('ImSession.createTopic：2xx 应答里服务端改名 → 登记状态跟着改名（占位名消失）', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.createTopic('newAbC', { name: '项目群' });
  h.transport.fireMessage({ ctrl: { id: id, code: IM_CODE_OK, topic: 'grpReal' } }, 30);

  assert.equal(h.session.topicState('newAbC'), null, '占位名不该留在登记表里（重连会订到不存在的会话）');
  const state = h.session.topicState('grpReal');
  assert.equal(state.subscribed, true);
  assert.equal(h.topicStates.indexOf('grpReal') >= 0, true, '宿主应收到新名字的 onTopicState');
  assert.deepEqual(h.session.knownTopics().map((s) => s.topic), ['grpReal']);
});

test('ImSession.createTopic：4xx 忘掉占位名（上游 4xx 也是 stopTrackingTopic + expunge）', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.createTopic('newAbC', { name: '项目群' });
  h.transport.fireMessage({ ctrl: { id: id, code: IM_CODE_FORBIDDEN, text: 'forbidden' } }, 30);

  assert.equal(h.session.topicState('newAbC'), null, '失败的建群请求不该留下会重订阅的登记');
  assert.equal(h.session.knownTopics().length, 0);
  assert.equal(h.failures.length, 1, '失败要走 onFailure');
  assert.equal(h.failures[0], '没有权限访问该会话');
});

test('ImSession.createTopic：3xx（已订阅）不清理也不改名', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.createTopic('newAbC', {});
  h.transport.fireMessage({ ctrl: { id: id, code: 303, topic: 'grpReal' } }, 30);
  assert.equal(h.session.topicState('newAbC') === null, false, '占位名保留');
  assert.equal(h.session.topicState('grpReal'), null, '3xx 不换名（上游口径）');
});

test('建群改名后重连：自动重订阅用的是**真正的名字**（回归）', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.createTopic('newAbC', { name: '项目群' });
  h.transport.fireMessage({ ctrl: { id: id, code: IM_CODE_OK, topic: 'grpReal' } }, 30);
  h.transport.fireMessage({ data: { topic: 'grpReal', seq: 3 } }, 40);

  h.transport.fireClose(1000);
  h.tick(2500);
  h.login('usrMe', 3000);   // 重连：hi/login 的 id 从报文里读（建群已经占掉前面的 id）

  // 只挑"真订阅"帧（`buildSub` 一定带 `get`）；建群帧带的是 `set`，别把它算进来。
  const subs = h.frames().filter((f) => f.sub !== undefined && f.sub.get !== undefined);
  assert.equal(subs.some((f) => f.sub.topic === 'newAbC'), false, '绝不能对占位名重订阅');
  assert.deepEqual(subs.map((f) => f.sub.topic), ['grpReal'],
    '建群用的是 set（不是 get），所以这里只有重连重订阅这一条，且必须是真名');
  const sync = h.frames().filter((f) => f.get !== undefined && f.get.data !== undefined
    && f.get.data.since !== undefined);
  assert.deepEqual(sync.map((f) => [f.get.topic, f.get.data.since]), [['grpReal', 4]], '补历史也用真名');
});

// ── 3. 会话：成员与权限报文 ────────────────────────────────────────────────

test('ImSession.inviteMember：发整串 mode；非法权限/未就绪不发脏帧', () => {
  const h = harness();
  assert.equal(h.session.inviteMember('grpA', 'usrB', 'JRWPA'), '', '未就绪');
  h.start(0);
  h.login();
  const id = h.session.inviteMember('grpA', 'usrB', 'jrwpa');
  assert.deepEqual(h.lastFrame(), {
    set: { id: id, topic: 'grpA', sub: { user: 'usrB', mode: 'JRWPA' } }
  });
  assert.equal(h.session.inviteMember('grpA', 'usrB', 'X'), '', '非法权限不发帧');
  assert.equal(h.session.inviteMember('grpA', 'usrB', ''), '', '空权限不发帧');
});

test('ImSession.removeMember：del{what:"sub",user}；空 user 不发（服务端会拒）', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.removeMember('grpA', ' usrB ');
  assert.deepEqual(h.lastFrame(), {
    del: { id: id, topic: 'grpA', what: 'sub', user: 'usrB' }
  });
  assert.equal(h.session.removeMember('grpA', ''), '');
});

test('ImSession.setTopicDefacs：只发改动的那一侧；双侧都空不发', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.setTopicDefacs('grpA', 'jrwpa', '');
  assert.deepEqual(h.lastFrame(), {
    set: { id: id, topic: 'grpA', desc: { defacs: { auth: 'JRWPA' } } }
  });
  assert.equal(h.session.setTopicDefacs('grpA', '', ''), '');
});

test('ImSession.loadMembers：get{what:"sub"}，limit<=0 时不带 limit', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.loadMembers('grpA');
  assert.deepEqual(h.lastFrame(), { get: { id: id, topic: 'grpA', what: 'sub', sub: {} } });
  const id2 = h.session.loadMembers('grpA', 30);
  assert.deepEqual(h.lastFrame(), { get: { id: id2, topic: 'grpA', what: 'sub', sub: { limit: 30 } } });
});

// ── 4. 门面：建群 ──────────────────────────────────────────────────────────

test('门面 createGroup：返回真正的 grp 名、renamed 与服务端算出的权限', async () => {
  const h = facadeHarness();
  const promise = h.facade.createGroup(' 项目群 ', {
    photo: 'photo/g', defacs: { auth: 'JRWPA', anon: 'N' }, tags: ['team']
  });
  const frame = h.transport.lastFrame();
  assert.equal(frame.sub.topic.startsWith('new'), true, '占位名必须是 new 前缀');
  assert.deepEqual(frame.sub.set, {
    desc: { public: { fn: '项目群', photo: 'photo/g' }, defacs: { auth: 'JRWPA', anon: 'N' } },
    tags: ['team']
  });

  h.transport.feed({
    ctrl: {
      id: frame.sub.id, code: IM_CODE_OK, topic: 'grpReal',
      params: { acs: { given: 'JRWPA', want: 'JRWPA', mode: 'jrwpa' } }
    }
  });
  const created = await promise;
  assert.equal(created.topic, 'grpReal', '必须用服务端给的名字');
  assert.equal(created.requestedTopic.startsWith('new'), true);
  assert.equal(created.renamed, true);
  assert.equal(created.name, '项目群');
  assert.equal(created.mode, 'JRWPA', 'params.acs.mode 归一化');
  assert.equal(h.facade.topicState('grpReal').subscribed, true, '登记也改名了');
  assert.equal(h.facade.topicState(created.requestedTopic), null);
});

test('门面 createGroup：服务端没给 ctrl.topic 时如实说自己没被改名', async () => {
  const h = facadeHarness();
  const promise = h.facade.createGroup('群');
  const id = h.transport.lastFrame().sub.id;
  h.transport.feed({ ctrl: { id: id, code: IM_CODE_OK } });
  const created = await promise;
  assert.equal(created.renamed, false);
  assert.equal(created.topic, created.requestedTopic);
  assert.equal(created.mode, '', '服务端没下发 acs 就是空串，不编造');
});

test('门面 createGroup：channel=true 用 nch 前缀；未就绪与失败都 reject 可读文案', async () => {
  const h = facadeHarness();
  const promise = h.facade.createGroup('频道', { channel: true });
  assert.equal(h.transport.lastFrame().sub.topic.startsWith('nch'), true);
  const id = h.transport.lastFrame().sub.id;
  h.transport.feed({ ctrl: { id: id, code: 403 } });
  await assert.rejects(promise, (reason) => {
    assert.equal(reason, '没有权限访问该会话');
    return true;
  });

  const cold = facadeTransport();
  const idle = new Tinode({
    transport: cold, config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' }
  });
  await assert.rejects(idle.createGroup('群'), (reason) => {
    assert.equal(reason, '连接尚未就绪，请稍后再试');
    return true;
  });
});

test('门面 createGroup：400 用通用文案，且不会把占位名留在登记表里', async () => {
  const h = facadeHarness();
  const promise = h.facade.createGroup('群');
  const requested = h.transport.lastFrame().sub.topic;
  const id = h.transport.lastFrame().sub.id;
  h.transport.feed({ ctrl: { id: id, code: IM_CODE_BAD_REQUEST } });
  await assert.rejects(promise, (reason) => {
    assert.equal(reason, '消息请求被拒绝');
    return true;
  });
  assert.equal(h.facade.topicState(requested), null);
});

// ── 5. 门面：成员、群资料、权限 ────────────────────────────────────────────

test('门面 members：meta.sub[] → 成员列表（含权限与名片）', async () => {
  const h = facadeHarness();
  const promise = h.facade.members('grpA', 24);
  const frame = h.transport.lastFrame();
  assert.deepEqual(frame, { get: { id: frame.get.id, topic: 'grpA', what: 'sub', sub: { limit: 24 } } });
  h.transport.feed({
    meta: {
      id: frame.get.id, topic: 'grpA',
      sub: [
        { user: 'usrB', acs: { given: 'JRWPA', want: 'JRWPA', mode: 'jrwpa' }, pub: { fn: '张三' } },
        { user: 'usrC', acs: { mode: 'N' } }
      ]
    }
  });
  const rows = await promise;
  assert.deepEqual(rows.map((m) => m.user), ['usrB', 'usrC']);
  assert.equal(rows[0].mode, 'JRWPA');
  assert.equal(rows[0].name, '张三');
  assert.equal(rows[1].mode, 'N', '封禁成员也是成员（mode=N）');
  await assert.rejects(h.facade.members('  '), (reason) => {
    assert.equal(reason, '话题不能为空');
    return true;
  });
});

test('门面 members：get 失败时服务端回的是 ctrl → 要 reject，不能挂死', async () => {
  const h = facadeHarness();
  const promise = h.facade.members('grpA');
  const id = h.transport.lastFrame().get.id;
  h.transport.feed({ ctrl: { id: id, code: IM_CODE_FORBIDDEN } });
  await assert.rejects(promise, (reason) => {
    assert.equal(reason, '没有权限访问该会话');
    return true;
  });
});

test('门面 groupInfo：群/频道能解析；单聊返回 null（单聊走 profileFromDesc）', async () => {
  const h = facadeHarness();
  const groupPromise = h.facade.groupInfo('grpA');
  const id = h.transport.lastFrame().get.id;
  h.transport.feed({
    meta: {
      id: id, topic: 'grpA',
      desc: {
        public: { fn: '项目群', photo: { ref: 'photo/g' } },
        defacs: { auth: 'JRWPA', anon: 'N' },
        acs: { given: 'JRWPA', want: 'JRWPA', mode: 'O' }
      }
    }
  });
  const info = await groupPromise;
  assert.equal(info.name, '项目群');
  assert.equal(info.photo, 'photo/g');
  assert.equal(info.kind, 'grp');
  assert.deepEqual(info.defacs, { auth: 'JRWPA', anon: 'N' });
  assert.deepEqual(info.acs, { mode: 'O', want: 'JRWPA', given: 'JRWPA' });

  const p2pPromise = h.facade.groupInfo('usrB');
  const p2pId = h.transport.lastFrame().get.id;
  h.transport.feed({ meta: { id: p2pId, topic: 'usrB', desc: { public: { fn: '张三' } } } });
  assert.equal(await p2pPromise, null);
});

test('门面成员/权限写操作：2xx resolve，4xx reject，参数非法直接 reject', async () => {
  const h = facadeHarness();

  const invite = h.facade.inviteMember('grpA', 'usrB', 'JRWPA');
  const inviteId = h.transport.lastFrame().set.id;
  h.transport.feed({ ctrl: { id: inviteId, code: IM_CODE_OK } });
  await invite;

  const mode = h.facade.setMemberMode('grpA', 'usrB', updateAccessMode('JRWPA', '-W'));
  const modeId = h.transport.lastFrame().set.id;
  assert.equal(h.transport.lastFrame().set.sub.mode, 'JRPA', '先算整串再发');
  h.transport.feed({ ctrl: { id: modeId, code: IM_CODE_OK } });
  await mode;

  const defacs = h.facade.updateGroupDefacs('grpA', 'JRWPA', 'N');
  const defacsId = h.transport.lastFrame().set.id;
  h.transport.feed({ ctrl: { id: defacsId, code: IM_CODE_OK } });
  await defacs;

  const remove = h.facade.removeMember('grpA', 'usrB');
  const removeId = h.transport.lastFrame().del.id;
  h.transport.feed({ ctrl: { id: removeId, code: IM_CODE_FORBIDDEN } });
  await assert.rejects(remove, (reason) => {
    assert.equal(reason, '没有权限访问该会话');
    return true;
  });

  await assert.rejects(h.facade.removeMember('grpA', '   '), (reason) => {
    assert.equal(reason, '请求未发出：连接未就绪或参数不合法');
    return true;
  });
});

test('门面：断线时把在途的群组请求全部拒掉（Promise 不悬着）', async () => {
  const h = facadeHarness();
  const pending = [h.facade.members('grpA'), h.facade.createGroup('群')];
  assert.equal(h.facade.topicState !== undefined, true);
  h.facade.stop();
  await assert.rejects(pending[0], (reason) => {
    assert.equal(reason, '连接已断开，请重试');
    return true;
  });
  await assert.rejects(pending[1], (reason) => {
    assert.equal(reason, '连接已断开，请重试');
    return true;
  });
});

// ── 6. 3xx：真实服务端发现的问题（幂等写回 304，建群回 3xx 不可当成功） ──────

test('ctrlAccepted：200..399 都算"服务端接受了"（上游 promise 判定 Tinode.java:713-714）', () => {
  assert.equal(ctrlAccepted(200), true);
  assert.equal(ctrlAccepted(202), true);
  assert.equal(ctrlAccepted(303), true, '303 See Other（已订阅）');
  assert.equal(ctrlAccepted(304), true, '304 Not Modified（值没变）—— 真实服务端重复 set 就是这个码');
  assert.equal(ctrlAccepted(400), false);
  assert.equal(ctrlAccepted(403), false);
  assert.equal(ctrlAccepted(503), false);
});

test('门面幂等写：304 Not Modified 要 resolve（真机上重复发相同 defacs 会拿到 304）', async () => {
  const h = facadeHarness();
  const defacs = h.facade.updateGroupDefacs('grpA', 'JRWPA', 'N');
  const id = h.transport.lastFrame().set.id;
  h.transport.feed({ ctrl: { id: id, code: 304, text: 'not modified' } });
  await defacs;   // 不抛即通过：304 不是失败

  const invite = h.facade.inviteMember('grpA', 'usrB', 'JRWPA');
  const inviteId = h.transport.lastFrame().set.id;
  h.transport.feed({ ctrl: { id: inviteId, code: 303 } });
  await invite;   // 303（已订阅/已是成员）同样算接受
});

test('订阅应答 303（已订阅）要算订阅成功（真实服务端：被邀请进群后再 sub 会回 303）', () => {
  const h = harness();
  h.start(0);
  h.login();
  const id = h.session.subscribeTracked('grpA', true, true, 24);
  h.transport.fireMessage({ ctrl: { id: id, code: 303 } }, 30);
  const state = h.session.topicState('grpA');
  assert.equal(state.subscribed, true,
    '只认 2xx 的话这里会是 false，宿主等 subscribed 的发送队列就永远不补发');
  assert.equal(h.session.knownTopics().length, 1);
  // 对照：真失败（4xx）仍然要标成未订阅
  const id2 = h.session.subscribeTracked('grpB', true, true, 24);
  h.transport.fireMessage({ ctrl: { id: id2, code: IM_CODE_FORBIDDEN } }, 40);
  assert.equal(h.session.topicState('grpB').subscribed, false);
});

test('门面 createGroup：3xx 必须 reject —— 上游这时不换名，占位名不可用', async () => {
  const h = facadeHarness();
  const promise = h.facade.createGroup('群');
  const requested = h.transport.lastFrame().sub.topic;
  const id = h.transport.lastFrame().sub.id;
  h.transport.feed({ ctrl: { id: id, code: 304 } });
  await assert.rejects(promise, (reason) => {
    assert.equal(reason, '服务端没有修改任何内容（3xx）');
    return true;
  });
  assert.equal(h.facade.topicState(requested) !== null, true,
    '3xx 时占位名的登记要保留（与 session 层口径一致：不清理也不改名）');
});
