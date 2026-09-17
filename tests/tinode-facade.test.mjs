import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_FRAME_BYTES, MemoryTinodeStorage, Tinode, tinodeMessageFromData
} from '../src/Index.ts';

// SDK 门面：协议状态机 + 存储端口的接线（用假传输，不碰网络/数据库）

/** 假传输：记录发出去的报文，可手动喂服务端报文。 */
function fakeTransport() {
  const sent = [];
  let handlers = null;
  return {
    sent,
    open(next) { handlers = next; next.onOpen(Date.now()); },
    send(text) { sent.push(text); },
    close() {},
    feed(obj) { handlers.onMessage(JSON.stringify(obj), Date.now()); },
    feedRaw(text) { handlers.onMessage(text, Date.now()); },
    fail(msg) { handlers.onError(msg, Date.now()); },
    isOpen() { return handlers !== null; }
  };
}

function connect(facade, transport) {
  facade.start(1000);   // start() 内部会调 transport.open(handlers)
  // hi → 服务端 ctrl（带 ver）→ login → ctrl（带 user）
  transport.feed({ ctrl: { id: '0', code: 200, text: 'ok', params: { ver: '0.25' } } });
  const loginId = JSON.parse(transport.sent[transport.sent.length - 1]).login.id;
  transport.feed({ ctrl: { id: loginId, code: 200, text: 'ok', params: { user: 'usrMe' } } });
}

test('门面：握手后 ready，subscribe/publish/setRead 发出正确报文', () => {
  const transport = fakeTransport();
  const storage = new MemoryTinodeStorage();
  const facade = new Tinode({ transport, storage, config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' } });
  assert.equal(facade.ready(), false);
  connect(facade, transport);
  assert.equal(facade.ready(), true, 'hi+login 之后 ready');
  assert.equal(facade.myUid(), 'usrMe');
  assert.ok(transport.sent[0].indexOf('"hi"') >= 0);
  assert.ok(transport.sent.some((m) => m.indexOf('"login"') >= 0));

  const subId = facade.subscribe('usrPeer');
  const sub = JSON.parse(transport.sent[transport.sent.length - 1]);
  assert.equal(sub.sub.id, subId);
  assert.equal(sub.sub.topic, 'usrPeer');
  assert.equal(sub.sub.get.what, 'desc sub');
  assert.equal(sub.sub.get.data.limit, 24, '默认取最近 24 条（与 Android 客户端一致）');

  const pubId = facade.publish('usrPeer', { txt: 'hi' }, { mime: 'text/x-drafty' });
  const pub = JSON.parse(transport.sent[transport.sent.length - 1]);
  assert.equal(pub.pub.id, pubId);
  assert.equal(pub.pub.topic, 'usrPeer');
  assert.deepEqual(pub.pub.content, { txt: 'hi' });
  assert.deepEqual(pub.pub.head, { mime: 'text/x-drafty' });

  facade.setRead('usrPeer', 7);
  const note = JSON.parse(transport.sent[transport.sent.length - 1]);
  assert.deepEqual(note, { note: { topic: 'usrPeer', what: 'read', seq: 7 } });

  facade.setTyping('usrPeer');
  const kp = JSON.parse(transport.sent[transport.sent.length - 1]);
  assert.deepEqual(kp, { note: { topic: 'usrPeer', what: 'kp' } });
});

test('门面：收到的 data 自动落库 + 回调宿主，同 seq 覆盖不重复', async () => {
  const transport = fakeTransport();
  const storage = new MemoryTinodeStorage();
  const seen = [];
  const facade = new Tinode({
    transport, storage,
    config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' },
    hooks: { onMessage: (m) => { seen.push(`${m.seq}:${m.isMine}:${m.content === null ? '' : m.content.txt}`); } }
  });
  connect(facade, transport);
  transport.feed({ data: { topic: 'usrPeer', seq: 5, from: 'usrPeer', ts: '2026-09-16T03:04:05Z', content: { txt: '你好' } } });
  transport.feed({ data: { topic: 'usrPeer', seq: 6, from: 'usrMe', content: { txt: '我发的' } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen, ['5:false:你好', '6:true:我发的']);
  const rows = await facade.messagesOf('usrPeer');
  assert.deepEqual(rows.map((m) => m.seq), [5, 6], '按 seq 升序返回');
  assert.equal(rows[1].isMine, true, 'from == myUid → isMine');
  assert.ok(rows[0].ts > 0, 'ts 解析成毫秒');

  // 同 seq 再发一次（服务端活数据覆盖本地 echo）
  transport.feed({ data: { topic: 'usrPeer', seq: 5, from: 'usrPeer', content: { txt: '改过了' } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await facade.messagesOf('usrPeer');
  assert.equal(after.length, 2, '同 seq 不新增行');
  assert.equal(after[0].content.txt, '改过了', '同 seq 覆盖');
});

test('门面：脏包丢弃、分页语义、草稿、删消息/删会话', async () => {
  const transport = fakeTransport();
  const storage = new MemoryTinodeStorage();
  const facade = new Tinode({ transport, storage, config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' } });
  connect(facade, transport);
  // 脏包：没有 topic / seq<=0 / 非 JSON
  transport.feed({ data: { topic: '', seq: 5 } });
  transport.feed({ data: { topic: 'usrPeer', seq: 0 } });
  transport.feedRaw('{oops');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await facade.messagesOf('usrPeer'), [], '脏包不进库');

  for (let seq = 1; seq <= 5; seq++) {
    transport.feed({ data: { topic: 'usrPeer', seq: seq, from: 'usrPeer', content: { txt: `m${seq}` } } });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual((await facade.messagesOf('usrPeer', 2)).map((m) => m.seq), [4, 5], 'limit 取最新一页');
  assert.deepEqual((await facade.messagesOf('usrPeer', 2, 4)).map((m) => m.seq), [2, 3], 'before 严格小于 4');

  await facade.saveDraft('usrPeer', '半句话', 1234);
  const draft = await facade.draftOf('usrPeer');
  assert.equal(draft.text, '半句话');
  assert.equal(draft.updatedAt, 1234);
  await facade.saveDraft('usrPeer', '   ', 2000);
  assert.equal(await facade.draftOf('usrPeer'), null, '空白草稿即清除');

  const removed = await storage.deleteMessages('usrPeer', [2, 3, 99]);
  assert.equal(removed, 2, '只删存在的 seq');
  await facade.removeTopic('usrPeer');
  assert.deepEqual(await facade.messagesOf('usrPeer'), [], '删会话连消息一起清');
});

test('tinodeMessageFromData：线路级转换的边界', () => {
  assert.equal(tinodeMessageFromData({ topic: '', seq: 1 }, 'me', 0), null);
  assert.equal(tinodeMessageFromData({ topic: 't', seq: -3 }, 'me', 0), null);
  const ok = tinodeMessageFromData({ topic: 't', seq: 3, from: 'me', ts: 'not-a-date' }, 'me', 999);
  assert.equal(ok.id, 't-3');
  assert.equal(ok.ts, 999, 'ts 解析失败用 fallback');
  assert.equal(ok.isMine, true);
  assert.equal(ok.content, null);
  assert.equal(ok.head, null);
});

test('persistIncoming=false：门面只做协议操作，落库交给宿主的原始报文钩子', async () => {
  const transport = fakeTransport();
  const storage = new MemoryTinodeStorage();
  const raw = [];
  const persisted = [];
  const facade = new Tinode({
    transport, storage, persistIncoming: false,
    config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' },
    hooks: {
      onRawData: (data) => { raw.push(data.seq); },
      onMessage: (m) => { persisted.push(m.seq); }
    }
  });
  connect(facade, transport);
  transport.feed({ data: { topic: 'usrPeer', seq: 8, from: 'usrPeer', content: { txt: 'hi' } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(raw, [8], '原始报文钩子照常触发');
  assert.deepEqual(persisted, [], '门面不再回调已落库的消息');
  assert.deepEqual(await facade.messagesOf('usrPeer'), [], '存储端口没有被写');
  await facade.saveDraft('usrPeer', '草稿', 1);
  assert.equal((await facade.draftOf('usrPeer')).text, '草稿', '协议侧包装仍可用');
});

// ── 审计 P0-1 / P0-2：门面输入校验与帧体量守卫 ──────────────────────────────

test('门面校验：空 topic / 非法 seq / 非法区间一律不发帧，并走 onFailure', async () => {
  const transport = fakeTransport();
  const failures = [];
  const facade = new Tinode({
    transport,
    persistIncoming: false,
    config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' },
    hooks: { onFailure: (text) => { failures.push(text); } }
  });
  connect(facade, transport);
  transport.sent.length = 0;

  assert.equal(facade.publish('', { txt: 'hi' }, null), '', '空 topic → 不给 id');
  assert.equal(facade.subscribe('  '), '', '空 topic 订阅 → 空 id');
  facade.setRead('usrPeer', 0);
  facade.setRead('usrPeer', -3);
  facade.setTyping('');
  assert.equal(facade.history('', 10, 24), '');
  assert.equal(facade.deleteTopic(''), '');
  assert.equal(facade.deleteMessages('usrPeer', [{ low: 5, hi: 2 }, { low: 0, hi: 3 }], true), '', '区间都不合法 → 不发');
  facade.leave('');

  assert.equal(transport.sent.length, 0, '一帧都没发出去');
  assert.equal(failures.length, 9, '每次拒绝都如实回调宿主');
  assert.ok(failures[0].indexOf('空 topic') >= 0);

  // 合法输入仍然照常发
  facade.setRead('usrPeer', 7);
  const pubId = facade.publish('usrPeer', { txt: 'hi' }, null);
  assert.notEqual(pubId, '');
  facade.setTyping('usrPeer');
  facade.history('usrPeer', -5, 0);
  const del = facade.deleteMessages('usrPeer', [{ low: 5, hi: 2 }, { low: 3, hi: 9 }], true);
  assert.notEqual(del, '');
  assert.equal(transport.sent.length, 5);
  const frames = transport.sent.map((text) => JSON.parse(text));
  assert.equal(frames[0].note.seq, 7);
  assert.equal(frames[1].pub.topic, 'usrPeer');
  assert.equal(frames[2].note.what, 'kp');
  assert.equal(frames[3].get.data.before, 0, '负 beforeSeq 归一为 0（取最新一页）');
  assert.equal(frames[3].get.data.limit, 24, 'limit 0 → 用默认 24');
  assert.deepEqual(frames[4].del.delseq, [{ low: 3, hi: 9 }], '非法区间被丢掉');
});

test('帧体量守卫：超过 maxFrameBytes 的 publish 不发且回调失败', async () => {
  const transport = fakeTransport();
  const failures = [];
  const facade = new Tinode({
    transport, persistIncoming: false, maxFrameBytes: 1024,
    config: { wsUrl: 'wss://x/v0/channels', token: 't', appName: 'T/1.0', apiKey: '' },
    hooks: { onFailure: (text) => { failures.push(text); } }
  });
  connect(facade, transport);
  transport.sent.length = 0;
  const big = { txt: 'x'.repeat(2000) };
  assert.equal(facade.publish('usrPeer', big, null), '', '超限不发');
  assert.equal(transport.sent.length, 0);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].indexOf('超过上限') >= 0, `失败文案应说明超限：${failures[0]}`);
  // 小帧正常
  assert.notEqual(facade.publish('usrPeer', { txt: 'ok' }, null), '');
  assert.equal(transport.sent.length, 1);
  // 默认上限是 256 KB
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 256 * 1024);
});


// P5-min：收到 meta 后自动落库会话列表并回调 onTopics；ready 时自动订阅 me
test('P5-min：meta.sub 变会话列表（落库 + onTopics），ready 时自动订 me', async () => {
  const { Tinode } = await import('../src/Tinode.ts');
  const { MemoryTinodeStorage } = await import('../src/TinodeStorage.ts');
  const { defaultSessionConfig } = await import('../src/TinodeSession.ts');

  const sent = [];
  let handlers = null;
  const transport = {
    open: (h) => { handlers = h; },
    send: (text) => sent.push(text),
    close: () => { handlers = null; }
  };
  const storage = new MemoryTinodeStorage();
  const topicsSeen = [];
  const facade = new Tinode({
    transport,
    config: defaultSessionConfig('wss://im.example.com:6061/v0/channels', 'tk', 'App/1.0', ''),
    storage,
    hooks: { onTopics: (topics) => topicsSeen.push(topics) }
  });
  facade.start(0);
  handlers.onOpen(10);
  handlers.onMessage(JSON.stringify({ ctrl: { id: '1', code: 200, params: { ver: '0.25' } } }), 20);
  handlers.onMessage(JSON.stringify({ ctrl: { id: '2', code: 200, params: { user: 'usrMe' } } }), 30);

  const frames = sent.map((f) => JSON.parse(f));
  const meSub = frames.find((f) => f.sub !== undefined && f.sub.topic === 'me');
  assert.ok(meSub, 'ready 后自动订阅 me');
  assert.equal(meSub.sub.get.what, 'sub', 'me 只要 sub（订阅列表）');

  handlers.onMessage(JSON.stringify({
    meta: {
      id: '3', topic: 'me',
      sub: [
        { topic: 'usrA', user: 'usrA', seq: 12, read: 10, recv: 11, touched: '2026-09-17T01:00:00Z', pub: { fn: '张三', photo: 'ref/p1' } },
        { topic: 'usrB', user: 'usrB', seq: 3, read: 3, recv: 3, touched: '2026-09-16T01:00:00Z', pub: { fn: '李四' } }
      ]
    }
  }), 40);
  await new Promise((r) => setTimeout(r, 20));

  const profiles = facade.profiles();
  assert.equal(profiles.length, 2);
  assert.equal(facade.profileOf('usrA').name, '张三');
  assert.equal(facade.profileOf('usrA').photo, 'ref/p1');
  assert.equal(topicsSeen.length, 1, 'onTopics 回调一次');
  assert.deepEqual(topicsSeen[0].map((t) => t.topic), ['usrA', 'usrB'], '按最后活动倒序');
  const stored = await storage.loadTopics();
  const storedA = stored.find((t) => t.topic === 'usrA');
  assert.equal(storedA.name, '张三', '已落库');
  assert.equal(storedA.seq, 12);

  // 再来一条 meta：名字为空时保留旧值、seq 取最大
  handlers.onMessage(JSON.stringify({ meta: { id: '4', topic: 'me', sub: [{ topic: 'usrA', seq: 20, pub: { fn: '' } }] } }), 50);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(facade.profileOf('usrA').name, '张三');
  assert.equal(facade.profileOf('usrA').seq, 20);
  assert.equal(facade.profiles().length, 2, '没有把 usrB 弄丢');
});

// P3-min：loginScheme='none' 不发 login；registerAccount 走 acc 并拿回 {uid, token}
test('P3-min：注册账号（acc user:"new"）成功后拿回 uid/token', async () => {
  const { Tinode } = await import('../src/Tinode.ts');
  const { MemoryTinodeStorage } = await import('../src/TinodeStorage.ts');
  const { defaultSessionConfig } = await import('../src/TinodeSession.ts');

  const sent = [];
  let handlers = null;
  const transport = { open: (h) => { handlers = h; }, send: (t) => sent.push(t), close: () => { handlers = null; } };
  const config = defaultSessionConfig('wss://im.example.com:6061/v0/channels', '', 'App/1.0', '');
  config.loginScheme = 'none';                       // 注册流程：不需要 token
  const authSeen = [];
  const facade = new Tinode({ transport, config, storage: new MemoryTinodeStorage(), hooks: { onAuth: (a) => authSeen.push(a) } });

  facade.start(0);
  handlers.onOpen(10);
  handlers.onMessage(JSON.stringify({ ctrl: { id: '1', code: 200, params: { ver: '0.25' } } }), 20);
  assert.equal(facade.state(), 'ready', 'none 模式：握手完就就绪');
  const frames = sent.map((f) => JSON.parse(f));
  assert.equal(frames.filter((f) => f.login !== undefined).length, 0, '不发 login');

  // 注册（异步）
  const pending = facade.registerAccount('alice', 'pw123456', '爱丽丝');
  const accFrame = sent.map((f) => JSON.parse(f)).find((f) => f.acc !== undefined);
  assert.ok(accFrame, '发出 acc');
  assert.equal(accFrame.acc.user, 'new');
  assert.equal(accFrame.acc.login, true);
  assert.equal(accFrame.acc.scheme, 'basic');
  assert.equal(accFrame.acc.secret, 'alice:pw123456');
  assert.equal(accFrame.acc.desc.public.fn, '爱丽丝');

  handlers.onMessage(JSON.stringify({ ctrl: { id: accFrame.acc.id, code: 200, params: { user: 'usrAlice', token: 'tk-1' } } }), 30);
  const auth = await pending;
  assert.deepEqual(auth, { uid: 'usrAlice', token: 'tk-1' });
  assert.equal(facade.myUid(), 'usrAlice');
  assert.equal(authSeen.length, 1, 'onAuth 回调一次');

  // 失败路径：用户名冲突
  const failing = facade.registerAccount('alice', 'pw123456');
  const second = sent.map((f) => JSON.parse(f)).filter((f) => f.acc !== undefined).pop();
  handlers.onMessage(JSON.stringify({ ctrl: { id: second.acc.id, code: 409, text: 'conflict' } }), 40);
  await assert.rejects(() => failing, /用户名已被占用/);

  // 参数校验
  await assert.rejects(() => facade.registerAccount('  ', 'pw123456'), /用户名不能为空/);
  await assert.rejects(() => facade.registerAccount('bob', '123'), /密码至少 6 位/);
});

test('P3-min：configurePasswordLogin 在 start 之前切换 basic scheme', async () => {
  const { Tinode } = await import('../src/Tinode.ts');
  const { MemoryTinodeStorage } = await import('../src/TinodeStorage.ts');
  const { defaultSessionConfig } = await import('../src/TinodeSession.ts');
  const sent = [];
  let handlers = null;
  const transport = { open: (h) => { handlers = h; }, send: (t) => sent.push(t), close: () => { handlers = null; } };
  const config = defaultSessionConfig('wss://im.example.com:6061/v0/channels', '', 'App/1.0', '');
  const facade = new Tinode({ transport, config, storage: new MemoryTinodeStorage(), hooks: {} });
  facade.configurePasswordLogin('alice', 'pw123456');
  facade.start(0);
  handlers.onOpen(10);
  handlers.onMessage(JSON.stringify({ ctrl: { id: '1', code: 200, params: { ver: '0.25' } } }), 20);
  const login = sent.map((f) => JSON.parse(f)).find((f) => f.login !== undefined);
  assert.equal(login.login.scheme, 'basic');
  assert.equal(login.login.secret, 'alice:pw123456');
});
