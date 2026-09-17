import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IM_CODE_ACCEPTED, IM_CODE_BAD_REQUEST, IM_CODE_CONFLICT, IM_CODE_FORBIDDEN, IM_CODE_INTERNAL, IM_CODE_NOT_FOUND, IM_CODE_OK, IM_CODE_UNAUTHORIZED, IM_CODE_UNAVAILABLE, IM_DEFAULT_PAGE_LIMIT, IM_FIRST_PAGE_LIMIT, IM_HEADER_API_KEY, IM_HEADER_AUTH, IM_PROBE_PAYLOAD, IM_PROTO_VERSION, IM_PROTO_VERSION_INT, IM_WS_PATH, backoffDelayMs, buildDelMessages, buildDelTopic, buildGetHistory, buildHi, buildLeave, buildLogin, buildNoteKeyPress, buildNoteRead, buildPub, buildSub, cardName, cardPhotoRef, ctrlFailureText, ctrlIsFatal, ctrlKind, ctrlOk, metaSubs, parseServerMessage, parseWsEndpoint
} from '../src/TinodeWire.ts';

// Tinode 线路层（WebSocket 报文）。事实来源：vendored SDK 的 model/*.java 与 Tinode.java，
// 见 docs/22 §2.2–2.5；这些用例把上行报文形状、下行解析、ctrl 码语义与 wsUrl 归一化钉住。

test('协议常量与 SDK 一致', () => {
  assert.equal(IM_PROTO_VERSION, '0.22', 'Tinode.java:85 VERSION');
  assert.equal(IM_PROTO_VERSION_INT, 0, 'Tinode.java:84 PROTOVERSION');
  assert.equal(IM_WS_PATH, '/v0/channels');
  assert.equal(IM_HEADER_API_KEY, 'X-Tinode-APIKey');
  assert.equal(IM_HEADER_AUTH, 'X-Tinode-Auth');
  assert.equal(IM_PROBE_PAYLOAD, '1', 'networkProbe() 发字面量 "1"');
  assert.equal(IM_DEFAULT_PAGE_LIMIT, 24);
  assert.equal(IM_FIRST_PAGE_LIMIT, 24);
});

test('wsUrl 归一化：wss/https 走 tls，路径固定 /v0/channels，端口缺省不带', () => {
  const secure = parseWsEndpoint('wss://im.example.com:6061');
  assert.equal(secure.channelUrl, 'wss://im.example.com:6061/v0/channels');
  assert.equal(secure.host, 'im.example.com');
  assert.equal(secure.port, 6061);
  assert.equal(secure.tls, true);
  assert.equal(secure.loopback, false);
  const plain = parseWsEndpoint('ws://192.0.2.10:6060/');
  assert.equal(plain.channelUrl, 'ws://192.0.2.10:6060/v0/channels');
  assert.equal(plain.tls, false);
  const noPort = parseWsEndpoint('https://im.example.com');
  assert.equal(noPort.channelUrl, 'wss://im.example.com/v0/channels');
  assert.equal(noPort.port, 0);
  // 回环地址标记出来（本端不照抄 Android 的改写，如实失败）
  assert.equal(parseWsEndpoint('ws://127.0.0.1:6060').loopback, true);
  assert.equal(parseWsEndpoint('ws://localhost:6060').loopback, true);
  assert.equal(parseWsEndpoint('ws://0.0.0.0:6060').loopback, true);
  // 非法输入
  assert.equal(parseWsEndpoint(''), null);
  assert.equal(parseWsEndpoint('   '), null);
  assert.equal(parseWsEndpoint('im.example.com:6060'), null);
  assert.equal(parseWsEndpoint('http://'), null);
});

test('hi：ver/ua/dev/lang/bkg 与 id 与 SDK 同形状', () => {
  const text = buildHi('1', 'LeakDetector/1.0.0', 'ATC2512300001-05E5', 'zh', true);
  assert.deepEqual(JSON.parse(text), {
    hi: { id: '1', ver: '0.22', ua: 'LeakDetector/1.0.0', dev: 'ATC2512300001-05E5', lang: 'zh', bkg: true }
  });
});

test('login：token scheme，secret 原样带上', () => {
  assert.deepEqual(JSON.parse(buildLogin('2', 'tok-abc')), {
    login: { id: '2', scheme: 'token', secret: 'tok-abc' }
  });
});

test('sub：what 组合与分页', () => {
  assert.deepEqual(JSON.parse(buildSub('3', 'usrPeer', true, true, 24)), {
    sub: { id: '3', topic: 'usrPeer', get: { what: 'desc sub', data: { limit: 24 } } }
  });
  // 切号必须全量：withSub=false 时 what 只有 desc
  assert.deepEqual(JSON.parse(buildSub('4', 'me', true, false, 0)), {
    sub: { id: '4', topic: 'me', get: { what: 'desc' } }
  });
  assert.deepEqual(JSON.parse(buildSub('5', 'me', false, true, 0)), {
    sub: { id: '5', topic: 'me', get: { what: 'sub' } }
  });
});

test('get/pub/note/leave 报文形状', () => {
  assert.deepEqual(JSON.parse(buildGetHistory('6', 'usrPeer', 12, 24)), {
    get: { id: '6', topic: 'usrPeer', what: 'data', data: { before: 12, limit: 24 } }
  });
  assert.deepEqual(
    JSON.parse(buildPub('7', 'usrPeer', { ld_mime: 'application/x-leakdetector.location' }, { txt: '[位置] 合肥' })),
    { pub: { id: '7', topic: 'usrPeer', head: { ld_mime: 'application/x-leakdetector.location' }, content: { txt: '[位置] 合肥' } } });
  assert.deepEqual(JSON.parse(buildPub('8', 'usrPeer', null, { txt: 'hi' })),
    { pub: { id: '8', topic: 'usrPeer', content: { txt: 'hi' } } });
  assert.deepEqual(JSON.parse(buildNoteRead('usrPeer', 10)), {
    note: { topic: 'usrPeer', what: 'read', seq: 10 }
  });
  assert.deepEqual(JSON.parse(buildNoteKeyPress('usrPeer')), {
    note: { topic: 'usrPeer', what: 'kp' }
  });
  assert.deepEqual(JSON.parse(buildLeave('9', 'usrPeer')), {
    leave: { id: '9', topic: 'usrPeer' }
  });
});

test('parseServerMessage：五类信封识别，脏数据返回 null', () => {
  const ctrl = parseServerMessage(JSON.stringify({ ctrl: { id: '1', code: 200, params: { ver: '0.23', user: 'usrMe' } } }));
  assert.equal(ctrl.ctrl.code, 200);
  assert.equal(ctrl.ctrl.params.user, 'usrMe');
  const data = parseServerMessage(JSON.stringify({ data: { topic: 'usrPeer', seq: 7, from: 'usrPeer', content: { txt: 'hi' } } }));
  assert.equal(data.data.seq, 7);
  assert.equal(data.data.content.txt, 'hi');
  assert.equal(parseServerMessage(JSON.stringify({ info: { topic: 'usrPeer', what: 'read', seq: 7 } })).info.what, 'read');
  assert.equal(parseServerMessage(JSON.stringify({ meta: { topic: 'me' } })).meta.topic, 'me');
  assert.equal(parseServerMessage(JSON.stringify({ pres: { topic: 'usrPeer', what: 'on' } })).pres.what, 'on');
  // 脏数据 / 未知结构 / 空
  assert.equal(parseServerMessage(''), null);
  assert.equal(parseServerMessage('   '), null);
  assert.equal(parseServerMessage('not json'), null);
  assert.equal(parseServerMessage('[1,2]'), null);
  assert.equal(parseServerMessage('null'), null);
  assert.equal(parseServerMessage('{"extra":{}}'), null, '不含已知键的 JSON 不当成报文');
});

test('meta.sub：会话清单的空安全读取与名片字段', () => {
  const meta = parseServerMessage(JSON.stringify({
    meta: {
      id: '3', topic: 'me',
      sub: [
        { topic: 'usrA', user: 'usrA', seq: 12, read: 9, recv: 12, touched: '2026-09-16T02:00:00.000Z', online: true, pub: { fn: '张三', photo: { ref: 'https://img/a.png' } } },
        { topic: 'usrB', seq: 4, read: 4, pub: { fn: '李四', photo: 'https://img/b.png' } }
      ]
    }
  })).meta;
  assert.equal(meta.topic, 'me');
  const subs = metaSubs(meta);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].topic, 'usrA');
  assert.equal(subs[0].seq, 12);
  assert.equal(subs[0].online, true);
  assert.equal(cardName(subs[0].pub), '张三');
  assert.equal(cardPhotoRef(subs[0].pub), 'https://img/a.png', 'photo 是 {ref} 结构');
  assert.equal(cardPhotoRef(subs[1].pub), 'https://img/b.png', 'photo 也可能是字符串');
  assert.equal(cardName(subs[1].pub), '李四');
  // 空安全
  assert.deepEqual(metaSubs(null), []);
  assert.deepEqual(metaSubs({ topic: 'me' }), []);
  assert.equal(cardName(null), '');
  assert.equal(cardName({}), '');
  assert.equal(cardPhotoRef({ photo: {} }), '');
  assert.equal(cardPhotoRef(null), '');
});

test('ctrl 码：分类、成功判定与致命判定', () => {
  // 常量值照 SDK model/ServerMessage.java 的 HTTP 语义
  assert.equal(IM_CODE_OK, 200);
  assert.equal(IM_CODE_ACCEPTED, 202);
  assert.equal(IM_CODE_BAD_REQUEST, 400);
  assert.equal(IM_CODE_UNAUTHORIZED, 401);
  assert.equal(IM_CODE_FORBIDDEN, 403);
  assert.equal(IM_CODE_NOT_FOUND, 404);
  assert.equal(IM_CODE_CONFLICT, 409);
  assert.equal(IM_CODE_INTERNAL, 500);
  assert.equal(IM_CODE_UNAVAILABLE, 503);
  assert.equal(ctrlKind(IM_CODE_OK), 'ok');
  assert.equal(ctrlKind(IM_CODE_ACCEPTED), 'ok');
  assert.equal(ctrlKind(303), 'redirect');
  assert.equal(ctrlKind(IM_CODE_UNAUTHORIZED), 'client');
  assert.equal(ctrlKind(IM_CODE_INTERNAL), 'server');
  assert.equal(ctrlKind(0), 'unknown');
  assert.ok(ctrlOk(200) && ctrlOk(299));
  assert.ok(!ctrlOk(300) && !ctrlOk(199));
  assert.ok(ctrlIsFatal(IM_CODE_UNAUTHORIZED));
  assert.ok(ctrlIsFatal(IM_CODE_FORBIDDEN));
  assert.ok(ctrlIsFatal(IM_CODE_BAD_REQUEST));
  assert.ok(ctrlIsFatal(IM_CODE_NOT_FOUND));
  assert.ok(!ctrlIsFatal(IM_CODE_INTERNAL), '5xx 要退避重试');
  assert.ok(!ctrlIsFatal(503));
});

test('失败文案：中文原话优先，否则按码给中文，不把英文原文丢给用户', () => {
  assert.equal(ctrlFailureText(IM_CODE_UNAUTHORIZED, '令牌已过期'), '令牌已过期');
  assert.equal(ctrlFailureText(IM_CODE_UNAUTHORIZED, 'unauthorized'), '登录状态已失效，请重新登录后再试');
  assert.equal(ctrlFailureText(IM_CODE_NOT_FOUND, ''), '会话不存在或已被删除');
  assert.equal(ctrlFailureText(IM_CODE_INTERNAL, 'Internal Server Error'), '消息服务暂时不可用，请稍后重试');
  assert.equal(ctrlFailureText(500, ''), '消息服务暂时不可用，请稍后重试');
  assert.ok(ctrlFailureText(418, '').length > 0);
});

test('退避：1s 起、2^n 增长、n 上限 10、抖动有界', () => {
  assert.equal(backoffDelayMs(0, 0), 1000);
  assert.equal(backoffDelayMs(1, 0), 2000);
  assert.equal(backoffDelayMs(3, 0), 8000);
  assert.equal(backoffDelayMs(10, 0), 1024000);
  assert.equal(backoffDelayMs(11, 0), 1024000, '超过 10 不再翻倍');
  assert.equal(backoffDelayMs(-5, 0), 1000);
  assert.equal(backoffDelayMs(0, 0.5), 1500, '抖动 = base * random');
  assert.ok(backoffDelayMs(2, 1) <= 8000, 'random 越界被夹住');
  assert.ok(backoffDelayMs(2, Number.NaN) === 4000);
});

// `del` 信封（删除会话 / 删除消息区间）：形状对齐 SDK MsgClientDel。

test('buildDelTopic：what="topic"，软删不带 hard，硬删带 hard:true', () => {
  assert.deepEqual(JSON.parse(buildDelTopic('7', 'usrA', false)), { del: { id: '7', topic: 'usrA', what: 'topic' } });
  assert.deepEqual(JSON.parse(buildDelTopic('8', 'usrA', true)),
    { del: { id: '8', topic: 'usrA', what: 'topic', hard: true } });
});

test('buildDelMessages：delseq 区间（low 必填、hi 可省）+ hard', () => {
  assert.deepEqual(JSON.parse(buildDelMessages('9', 'usrA', [{ low: 3 }], false)),
    { del: { id: '9', topic: 'usrA', what: 'msg', delseq: [{ low: 3 }] } });
  assert.deepEqual(JSON.parse(buildDelMessages('10', 'usrA', [{ low: 1, hi: 20 }], true)),
    { del: { id: '10', topic: 'usrA', what: 'msg', delseq: [{ low: 1, hi: 20 }], hard: true } });
});

test('退避上限（审计 P1-2）：传 maxMs 时截断，不传保持原序列', () => {
  assert.equal(backoffDelayMs(0, 0), 1000);
  assert.equal(backoffDelayMs(20, 0.5, 60000), 60000, '第 20 次退避被 60 s 截断');
  assert.equal(backoffDelayMs(3, 0, 60000), 8000, '没到上限就按原值');
  assert.equal(backoffDelayMs(20, 0.5), 1536000, '不传上限时保持历史语义');
  assert.equal(backoffDelayMs(5, 0.5, 0), 48000, 'maxMs ≤ 0 视为不设上限');
});


// 审计 P0-2：入站帧体量守卫 + 关键字段类型校验
test('parseServerMessage 拒绝超大帧与类型不对的关键字段', () => {
  const big = `{"ctrl":{"id":"1","code":200,"text":"${'x'.repeat(300)}"}}`;
  assert.notEqual(parseServerMessage(big, 1000), null, '未超上限 → 正常解析');
  assert.equal(parseServerMessage(big, 50), null, '超过 maxBytes → 直接丢弃');
  assert.notEqual(parseServerMessage(big, 0), null, '上限非法时退回默认 1 MB → 放行');
  assert.equal(parseServerMessage('{"ctrl":{"id":"1","code":"200"}}'), null, 'code 不是数字 → 丢弃');
  assert.equal(parseServerMessage('{"data":{"topic":"t","seq":"7","content":"x"}}'), null, 'seq 不是数字 → 丢弃');
  assert.notEqual(parseServerMessage('{"data":{"topic":"t","seq":7,"content":"x"}}'), null);
  assert.equal(parseServerMessage(`{"note":{"what":"kp"}}`, 5), null, '小上限也能挡住正常帧');
});
