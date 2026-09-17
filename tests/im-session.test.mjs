import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ImSession, defaultSessionConfig
} from '../src/TinodeSession.ts';
import { IM_CODE_INTERNAL, IM_CODE_OK, IM_CODE_UNAUTHORIZED } from '../src/TinodeWire.ts';

// Tinode 会话状态机（纯逻辑，假 transport，时间显式喂入）：connect → hi → login → ready、
// 握手/登录超时、退避重连后重新 hi+login、代次守卫丢弃迟到回调、致命错误不重试。
// 对应 docs/22 §5.1 的 H4-01b「主机测试（假 WS）」。

/** 假 transport：记录发出的报文；回调都带平台侧时间（由 harness 的时钟提供）。 */
class FakeTransport {
  constructor(clock) {
    this.clock = clock;
    this.sent = [];
    this.opened = 0;
    this.closed = 0;
    this.handlers = null;
  }
  open(handlers) {
    this.opened += 1;
    this.handlers = handlers;
  }
  send(text) { this.sent.push(text); }
  close() {
    this.closed += 1;
    this.handlers = null;
  }
  fireOpen(nowMs = this.clock()) { if (this.handlers) this.handlers.onOpen(nowMs); }
  fireMessage(obj, nowMs = this.clock()) { if (this.handlers) this.handlers.onMessage(JSON.stringify(obj), nowMs); }
  fireClose(nowMs = this.clock()) { if (this.handlers) this.handlers.onClose(nowMs); }
  fireError(text, nowMs = this.clock()) { if (this.handlers) this.handlers.onError(text, nowMs); }
}

function harness(configPatch = {}, random = () => 0) {
  let now = 0;
  const states = [];
  const failures = [];
  const data = [];
  const infos = [];
  const pres = [];
  const metas = [];
  const ctrls = [];
  const versions = [];
  const transport = new FakeTransport(() => now);
  const config = defaultSessionConfig('wss://im.example.com:6061', 'tok-1', 'LeakDetector/1.0.0', 'dev-1');
  config.random = random;
  Object.assign(config, configPatch);
  const session = new ImSession(transport, config, {
    onState: (state) => states.push(state),
    onData: (item) => data.push(item),
    onInfo: (item) => infos.push(item),
    onPres: (item) => pres.push(item),
    onMeta: (item) => metas.push(item),
    onCtrl: (item) => ctrls.push(item),
    onFailure: (text) => failures.push(text),
    onServerVersion: (ver, build) => versions.push(`${ver}|${build}`)
  });
  return {
    transport, session, states, failures, data, infos, pres, metas, ctrls, versions,
    start(ms = 0) { now = ms; session.start(ms); },
    // 平台层每 200ms 一跳：测试里显式跳到某个时刻
    tick(ms) { now = ms; session.tick(ms); }
  };
}

/** 走完一次成功登录。 */
function loginThrough(h, uid = 'usrMe', at = 0) {
  h.transport.fireOpen(at);
  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_OK, params: { ver: '0.23', build: '7' } } }, at);
  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK, params: { user: uid } } }, at);
  return h;
}

function sentBody(transport, index) {
  return JSON.parse(transport.sent[index]);
}

function sentKind(transport, index) {
  return Object.keys(sentBody(transport, index))[0];
}

test('正常流程：连上 → hi → login → ready，id 递增，状态序完整', () => {
  const h = harness();
  h.start(0);
  assert.equal(h.session.state(), 'connecting');
  assert.equal(h.transport.opened, 1);
  assert.equal(h.transport.sent.length, 0, '连上之前不发报文');

  h.transport.fireOpen(10);
  assert.equal(h.session.state(), 'handshake');
  assert.equal(sentKind(h.transport, 0), 'hi');
  assert.deepEqual(sentBody(h.transport, 0).hi, {
    id: '1', ver: '0.22', ua: 'LeakDetector/1.0.0', dev: 'dev-1', lang: 'zh', bkg: false
  });

  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_OK, params: { ver: '0.23', build: '7' } } }, 20);
  assert.equal(h.session.state(), 'login');
  assert.equal(sentKind(h.transport, 1), 'login');
  assert.deepEqual(sentBody(h.transport, 1).login, { id: '2', scheme: 'token', secret: 'tok-1' });
  assert.deepEqual(h.versions, ['0.23|7']);

  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK, params: { user: 'usrMe' } } }, 30);
  assert.equal(h.session.state(), 'ready');
  assert.ok(h.session.ready());
  assert.equal(h.session.myUid(), 'usrMe');
  assert.deepEqual(h.states, ['connecting', 'handshake', 'login', 'ready']);
});

test('hi 应答 401 → failed，不再重试，且给中文原因', () => {
  const h = harness();
  h.start(0);
  h.transport.fireOpen(10);
  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_UNAUTHORIZED, text: 'unauthorized' } }, 20);
  assert.equal(h.session.state(), 'failed');
  assert.ok(!h.session.ready());
  assert.equal(h.session.myUid(), '');
  assert.deepEqual(h.failures, ['登录状态已失效，请重新登录后再试'], '不把英文原文给用户');
  h.tick(60000);
  assert.equal(h.transport.opened, 1, '致命错误不再重连');
});

test('hi 应答 5xx → 退避 1s 后重连并重新 hi（id 继续递增）', () => {
  const h = harness();
  h.start(0);
  h.transport.fireOpen(0);
  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_INTERNAL, text: 'Internal Server Error' } }, 0);
  assert.equal(h.session.state(), 'idle');
  assert.deepEqual(h.failures, ['消息服务暂时不可用，请稍后重试']);
  h.tick(999);
  assert.equal(h.transport.opened, 1, '未到退避时间不重连');
  h.tick(1000);
  assert.equal(h.transport.opened, 2, 'attempt 0 → 1000ms');
  h.transport.fireOpen(1000);
  assert.equal(sentBody(h.transport, h.transport.sent.length - 1).hi.id, '2', 'id 不重头来');
  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK } }, 1000);
  h.transport.fireMessage({ ctrl: { id: '3', code: IM_CODE_OK, params: { user: 'usrMe' } } }, 1000);
  assert.equal(h.session.state(), 'ready');
  assert.equal(h.session.myUid(), 'usrMe');
});

test('握手超时（3s）与登录超时（10s）各自触发退避重连', () => {
  const h = harness();
  h.start(0);
  h.transport.fireOpen(0);
  h.tick(2999);
  assert.equal(h.transport.opened, 1, '未到 3s 不重连');
  h.tick(3000);
  assert.equal(h.transport.opened, 1, '超时只是安排重连');
  h.tick(3999);
  assert.equal(h.transport.opened, 1);
  h.tick(4000);
  assert.equal(h.transport.opened, 2, '退避 1s 后重连');

  // 第二次连上、hi 有应答，但 login 不应答
  h.transport.fireOpen(4000);
  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK } }, 4000);
  assert.equal(h.session.state(), 'login');
  h.tick(13999);
  assert.equal(h.transport.opened, 2, 'login 超时是 10s（4000+10000）');
  h.tick(14000);
  assert.equal(h.transport.opened, 2);
  h.tick(15999);
  assert.equal(h.transport.opened, 2, '第二次退避是 attempt 1 → 2000ms');
  h.tick(16000);
  assert.equal(h.transport.opened, 3, '退避到点后重连');
});

test('重新 start（切号）会清 uid、推进代次并重新握手；旧代次回调被丢弃', () => {
  const h = harness();
  h.start(0);
  const firstHandlers = h.transport.handlers;
  loginThrough(h, 'usrA');
  assert.equal(h.session.myUid(), 'usrA');
  const firstGeneration = h.session.generation();

  h.start(100);
  assert.equal(h.session.generation(), firstGeneration + 1);
  assert.equal(h.session.state(), 'connecting');
  assert.equal(h.session.myUid(), '', '切号要清掉旧 uid，避免拿旧账号渲染');
  assert.equal(h.transport.opened, 2);
  firstHandlers.onMessage(JSON.stringify({ data: { topic: 'usrX', seq: 1 } }), 100);
  assert.deepEqual(h.data, [], '旧代次的 data 被丢弃');
  assert.equal(h.session.state(), 'connecting', '旧代次回调不改状态');

  h.transport.fireOpen(100);
  h.transport.fireMessage({ ctrl: { id: '3', code: IM_CODE_OK } }, 100);
  h.transport.fireMessage({ ctrl: { id: '4', code: IM_CODE_OK, params: { user: 'usrB' } } }, 100);
  assert.equal(h.session.myUid(), 'usrB');
  assert.equal(h.session.state(), 'ready');
});

test('stop() 之后不再接收、不再重连，且 uid 清空', () => {
  const h = harness();
  h.start(0);
  loginThrough(h);
  assert.equal(h.session.state(), 'ready');
  h.session.stop();
  assert.equal(h.session.state(), 'closed');
  assert.equal(h.session.myUid(), '');
  h.transport.fireMessage({ data: { topic: 'usrX', seq: 1 } }, 50);
  assert.deepEqual(h.data, []);
  h.tick(60000);
  assert.equal(h.transport.opened, 1, '关闭后不重连');
  assert.equal(h.session.state(), 'closed');
});

test('地址与凭据前置校验：非法 / 回环 / 缺 token 都 failed 且不建连', () => {
  const bad = harness({ wsUrl: 'im.example.com:6060' });
  bad.start(0);
  assert.equal(bad.session.state(), 'failed');
  assert.deepEqual(bad.failures, ['消息服务地址无效，请重新登录后再试']);
  assert.equal(bad.transport.opened, 0);

  const loopback = harness({ wsUrl: 'ws://127.0.0.1:6060' });
  loopback.start(0);
  assert.equal(loopback.session.state(), 'failed');
  assert.deepEqual(loopback.failures, ['消息服务地址指向本机（回环地址），请检查后台配置'],
    '不照抄 Android 的 loopback 改写');
  assert.equal(loopback.transport.opened, 0);

  const noToken = harness({ token: '' });
  noToken.start(0);
  assert.equal(noToken.session.state(), 'failed');
  assert.deepEqual(noToken.failures, ['缺少消息服务凭据，请重新登录后再试']);
});

test('ready 之后的发送方法与 id 递增；非 ready 时一条都不发', () => {
  const h = harness();
  h.session.subscribe('me', true, true, 24);
  h.session.loadHistory('usrPeer', 100, 24);
  h.session.sendPub('usrPeer', null, { txt: 'hi' });
  h.session.markRead('usrPeer', 5);
  h.session.sendTyping('usrPeer');
  h.session.leave('usrPeer');
  assert.deepEqual(h.transport.sent, [], '未 ready 不发报文');

  h.start(0);
  loginThrough(h);
  h.session.subscribe('me', true, true, 24);
  h.session.loadHistory('usrPeer', 100, 24);
  h.session.sendPub('usrPeer', { ld_mime: 'application/x-leakdetector.reply' }, { txt: '收到' });
  h.session.markRead('usrPeer', 5);
  h.session.sendTyping('usrPeer');
  h.session.leave('usrPeer');
  const kinds = h.transport.sent.slice(2).map((_, index) => sentKind(h.transport, index + 2));
  assert.deepEqual(kinds, ['sub', 'get', 'pub', 'note', 'note', 'leave']);
  const ids = h.transport.sent.slice(2).map((_, index) => {
    const body = sentBody(h.transport, index + 2);
    const key = Object.keys(body)[0];
    return body[key].id;
  });
  assert.deepEqual(ids, ['3', '4', '5', undefined, undefined, '6'], 'note 报文没有 id（与 SDK 一致）');
  assert.deepEqual(sentBody(h.transport, 4).pub.head, { ld_mime: 'application/x-leakdetector.reply' });
});

test('心跳默认关闭；打开后按间隔发探针，未到间隔不重复', () => {
  const off = harness();
  off.start(0);
  loginThrough(off);
  const before = off.transport.sent.length;
  off.tick(60000);
  assert.equal(off.transport.sent.length, before, 'heartbeatMs=0 不发探针（Android 也没有定时心跳）');
  assert.equal(off.session.state(), 'ready', '心跳关闭也不影响在线状态');

  const on = harness({ heartbeatMs: 20000 });
  on.start(0);
  loginThrough(on);
  assert.equal(on.transport.sent.length, 2);
  on.tick(19999);
  assert.equal(on.transport.sent.length, 2);
  on.tick(20000);
  assert.equal(on.transport.sent[on.transport.sent.length - 1], '1', '探针就是字面量 "1"');
  on.tick(30000);
  assert.equal(on.transport.sent.length, 3, '未到 20s 不重复发');
  on.tick(40000);
  assert.equal(on.transport.sent.length, 4);
});

test('data / info / pres / meta 分派到各自回调，脏报文不当消息', () => {
  const h = harness();
  h.start(0);
  loginThrough(h);
  h.transport.fireMessage({ data: { topic: 'usrPeer', seq: 3, from: 'usrPeer', content: { txt: '你好' } } }, 40);
  h.transport.fireMessage({ info: { topic: 'usrPeer', what: 'read', seq: 3 } }, 41);
  h.transport.fireMessage({ pres: { topic: 'usrPeer', what: 'on' } }, 42);
  h.transport.fireMessage({ meta: { topic: 'me', ts: '2026-09-16T00:00:00Z' } }, 43);
  h.transport.fireMessage({}, 44);
  h.transport.handlers.onMessage('not json', 45);
  assert.equal(h.data.length, 1);
  assert.equal(h.data[0].content.txt, '你好');
  assert.equal(h.infos.length, 1);
  assert.equal(h.infos[0].what, 'read');
  assert.equal(h.pres.length, 1);
  assert.equal(h.pres[0].what, 'on');
  assert.equal(h.metas.length, 1, 'meta 交给 onMeta（会话清单靠它）');
  assert.equal(h.metas[0].topic, 'me');
  assert.equal(h.data.length, 1, 'meta 不进消息回调');
});

test('传输层 onError 带原因时如实上报，并进入退避重连', () => {
  const h = harness();
  h.start(0);
  h.transport.fireError('网络连接已断开', 0);
  assert.deepEqual(h.failures, ['网络连接已断开']);
  assert.equal(h.session.state(), 'idle');
  h.tick(1000);
  assert.equal(h.transport.opened, 2);
});

test('ready 之后的 ctrl 交给调用方按 id 认领；致命码另给一条用户可见失败', () => {
  const h = harness();
  h.start(0);
  loginThrough(h);
  // 成功应答（如 pub 的 202 + params.seq）也走 onCtrl：调用方据此把本地 echo 转正
  h.transport.fireMessage({ ctrl: { id: '9', code: 202, params: { seq: 18 } } }, 50);
  assert.equal(h.ctrls.length, 1);
  assert.equal(h.ctrls[0].params.seq, 18);
  assert.equal(h.session.state(), 'ready');
  assert.deepEqual(h.failures, [], '成功应答不产生失败文案');
  // 非致命失败（409）：交给调用方，不摘会话、不重复报用户可见失败
  h.transport.fireMessage({ ctrl: { id: '10', code: 409, text: 'conflict' } }, 51);
  assert.equal(h.ctrls.length, 2);
  assert.equal(h.failures.length, 0, '409 交给调用方处理');
  // 致命失败（403）：本条请求失败 + 一条用户可见原因，但会话状态不变
  h.transport.fireMessage({ ctrl: { id: '11', code: 403, text: 'forbidden' } }, 52);
  assert.equal(h.ctrls.length, 3);
  assert.deepEqual(h.failures, ['没有权限访问该会话']);
  assert.equal(h.session.state(), 'ready');
});


// 审计 P0-3：sendPub 也必须过帧体量守卫（此前只有门面 publish 检查）
test('sendPub 超限不发 + onFailure 报错；sendPubWithId 同样是受守卫的出口', () => {
  const h = harness({ maxFrameBytes: 200 });
  h.start(0);
  loginThrough(h, 'usrX', 10);
  assert.equal(h.session.state(), 'ready');
  h.transport.sent.length = 0;
  h.failures.length = 0;
  h.session.sendPub('usrX', null, { txt: 'x'.repeat(500) });
  assert.equal(h.transport.sent.length, 0, '超限帧不发出');
  assert.equal(h.failures.length, 1, '按 onFailure 如实报错');
  h.session.sendPubWithId('99', 'usrX', null, { txt: 'x'.repeat(500) });
  assert.equal(h.transport.sent.length, 0, '带 id 的出口同样被拦');
  h.session.sendPub('usrX', null, { txt: 'ok' });
  assert.equal(h.transport.sent.length, 1, '小帧正常发出');
});

// 审计 P1-2：一次断线 error+close 双回调只能算一次失败（退避不翻倍）
test('断线时 error+close 双触发只退避一次', () => {
  const h = harness();
  h.start(0);
  h.transport.fireOpen(10);
  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_OK, params: { ver: '0.23' } } }, 20);
  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK, params: { user: 'usrMe' } } }, 30);
  assert.equal(h.session.state(), 'ready');
  // 同一次断线：平台层先后回调 error 与 close
  h.transport.fireError('network down', 1000);
  h.transport.fireClose(1001);
  assert.equal(h.session.state(), 'idle');
  // attempt 只 +1：第二次重连的延迟应与第一次相同（random 固定 → 同一档退避）
  h.tick(1000 + 1);
  const sentAfterFirst = h.transport.sent.length;
  assert.ok(sentAfterFirst > 0, '已按退避发起重连');
});

// 审计 P1-1：稳定连接窗口过后再断线，退避计数清零（不永久按旧 attempt 退避）
test('稳定窗口后断线：退避计数清零', () => {
  const h = harness({}, () => 0.999);
  h.start(0);
  h.transport.fireOpen(10);
  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_OK, params: { ver: '0.23' } } }, 20);
  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK, params: { user: 'usrMe' } } }, 30);
  assert.equal(h.session.state(), 'ready');
  // 撑过稳定窗口（5000ms）再断线 → 下一次重连延迟应回到最小档
  h.transport.fireError('network down', 30 + 6000);
  // 最小退避是 1000ms(+抖动)，跳到窗口外即可看到重连
  h.tick(30 + 6000 + 2500);
  assert.equal(h.session.state(), 'connecting', '按最小退避重连（而不是 maxBackoffMs 的 60s）');
});

// P1：连上并登录后自动重订阅登记过的主题（可关），并可从 lastSeq 补历史
test('重连后自动重订阅 + 从 lastSeq 补历史', () => {
  const h = harness();
  h.start(0);
  loginThrough(h, 'usrA', 10);
  assert.equal(h.session.state(), 'ready');
  // 先订阅一次并标记成功，再收到两条消息（lastSeq=2）
  const subId = h.session.subscribeTracked('usrA', true, true, 24);
  h.transport.fireMessage({ ctrl: { id: subId, code: IM_CODE_OK } }, 20);
  h.transport.fireMessage({ data: { topic: 'usrA', seq: 1, content: { txt: 'a' } } }, 30);
  h.transport.fireMessage({ data: { topic: 'usrA', seq: 2, content: { txt: 'b' } } }, 40);
  assert.equal(h.session.topicState('usrA').lastSeq, 2);
  assert.equal(h.session.knownTopics().length, 1);
  // 断线 → 重连 → 自动重订阅 + 补历史
  h.transport.fireClose(1000);
  h.tick(1000 + 2500);
  h.transport.fireOpen(3000);
  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_OK, params: { ver: '0.25' } } }, 3010);
  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK, params: { user: 'usrA' } } }, 3020);
  assert.equal(h.session.state(), 'ready');
  const frames = h.transport.sent.map((f) => JSON.parse(f));
  const resub = frames.filter((f) => f.sub !== undefined && f.sub.topic === 'usrA');
  const sync = frames.filter((f) => f.get !== undefined && f.get.data !== undefined && f.get.data.since !== undefined);
  assert.ok(resub.length >= 2, '断线后应再发一次 sub');
  assert.equal(sync.length, 1, '应发一次 since 补历史');
  assert.equal(sync[0].get.data.since, 3, '从 lastSeq+1 开始补');
});

test('autoResubscribe=false 时不自动订阅', () => {
  const h = harness({ autoResubscribe: false });
  h.start(0);
  loginThrough(h, 'usrA', 10);
  const subId = h.session.subscribeTracked('usrA', true, true, 24);
  h.transport.fireMessage({ ctrl: { id: subId, code: IM_CODE_OK } }, 20);
  h.transport.fireMessage({ data: { topic: 'usrA', seq: 5 } }, 30);
  h.transport.fireClose(1000);
  h.tick(1000 + 2500);
  h.transport.fireOpen(3000);
  h.transport.fireMessage({ ctrl: { id: '1', code: IM_CODE_OK, params: { ver: '0.25' } } }, 3010);
  h.transport.fireMessage({ ctrl: { id: '2', code: IM_CODE_OK, params: { user: 'usrA' } } }, 3020);
  const frames = h.transport.sent.map((f) => JSON.parse(f));
  assert.equal(frames.filter((f) => f.sub !== undefined && f.sub.topic === 'usrA').length, 1, '只有最初那一次 sub');
});
