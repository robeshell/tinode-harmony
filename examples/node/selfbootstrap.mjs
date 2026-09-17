/**
 * 自举示例：**注册账号 → 自动登录 → 订阅 me → 打印会话列表**（不需要自建后端）。
 *
 * ```bash
 * export TINODE_WS_URL='wss://im.example.com:6061/v0/channels'
 * export TINODE_API_KEY=''                 # 服务端要求就填
 * export TINODE_NEW_USER="demo$(date +%s)" # 要注册的用户名（basic 方案）
 * export TINODE_NEW_PASSWORD='pw123456'
 * node examples/node/selfbootstrap.mjs
 * ```
 *
 * 成功后打印 `{uid, token}`（**token 请自行安全保存**，下次用 `scheme: 'token'` 登录）。
 */
import { ImSession, defaultSessionConfig, encodeBasicSecret, isValidBasicLogin, parseWsEndpoint } from '../../src/Index.ts';
import { NodeWebSocketTransport } from './transport.mjs';

const wsUrl = process.env.TINODE_WS_URL ?? '';
const apiKey = process.env.TINODE_API_KEY ?? '';
const user = process.env.TINODE_NEW_USER ?? '';
const password = process.env.TINODE_NEW_PASSWORD ?? '';
if (wsUrl.length === 0 || user.length === 0 || password.length === 0) {
  console.error('需要 TINODE_WS_URL / TINODE_NEW_USER / TINODE_NEW_PASSWORD（TINODE_API_KEY 可选）');
  process.exit(2);
}

const parsed = parseWsEndpoint(wsUrl);
console.log(`[demo] 目标端点：${parsed === null ? '(无法解析)' : `${parsed.tls ? 'wss' : 'ws'}://***:${parsed.port}/v0/channels`}`);
console.log(`[demo] 注册用户：${user}`);

class LoggingTransport extends NodeWebSocketTransport {
  send(text) {
    if (text.includes('"acc"')) {
      const safe = text.replace(/"secret":"[^"]*"/, '"secret":"***"');
      console.log(`[demo] 出站 acc 帧：${safe}`);
    }
    super.send(text);
  }
}
const transport = new LoggingTransport(wsUrl, apiKey);
const config = defaultSessionConfig(wsUrl, '', 'tinode-harmony-selfbootstrap/0.1.0', '');
config.loginScheme = 'none';                     // 注册流程：不需要预置 token
const session = new ImSession(transport, config, {
  onState: (state) => console.log(`[demo] 状态 → ${state}`),
  onServerVersion: (ver, build) => console.log(`[demo] 服务端协议版本 ${ver} ${build}`),
  onAuth: (auth) => {
    console.log(`[demo] 注册并登录成功：uid=${auth.uid} token=${auth.token.length > 0 ? `${auth.token.slice(0, 8)}…（已截断）` : '(无)'}`);
    session.loadSubscriptions(50);               // 拉"我的订阅列表"（P5：me）
  },
  onMeta: (meta) => {
    const subs = meta.sub ?? [];
    console.log(`[demo] 会话列表（${subs.length} 个）：`);
    for (const sub of subs) {
      // 服务端可能不带 topic（用自己的主题名兜底），SDK 的 profilesFromMeta 也是这样处理的
      const topic = sub.topic ?? meta.topic ?? '';
      const name = sub.pub && sub.pub.fn ? sub.pub.fn : '(无名片)';
      console.log(`       ${topic}  ${name}  seq=${sub.seq ?? 0} read=${sub.read ?? 0} online=${sub.online === true}`);
    }
  },
  onTopicState: (state) => console.log(`[demo] 主题 ${state.topic} subscribed=${state.subscribed} lastSeq=${state.lastSeq}`),
  onCtrl: (ctrl) => console.log(`[demo] ctrl id=${ctrl.id ?? ''} code=${ctrl.code} text=${ctrl.text ?? ''}`),
  onFailure: (text) => console.log(`[demo] 失败：${text}`),
  onData: () => {}, onInfo: () => {}, onPres: () => {}, onNote: () => {}
});

session.start(Date.now());
const timer = setInterval(() => session.tick(Date.now()), 200);

let registered = false;
const waiter = setInterval(() => {
  if (registered || session.state() !== 'ready') return;
  registered = true;
  if (!isValidBasicLogin(user)) {
    console.log('[demo] 用户名不能包含冒号');
    process.exit(2);
  }
  // basic 的 secret 是 base64("用户名:密码")（上游 AuthScheme.encodeBasicToken 同口径）
  session.createAccount('basic', encodeBasicSecret(user, password), user);
}, 200);

setTimeout(() => {
  clearInterval(timer); clearInterval(waiter);
  session.stop();
  process.exit(0);
}, 12000);
