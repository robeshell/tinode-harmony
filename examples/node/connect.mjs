/**
 * 最小可跑示例：连接 Tinode → 握手 → （有 token 时）登录 → （有 topic 时）订阅并发一条文本。
 *
 * ## 配置（**不要提交真实地址与密钥**）
 * 优先级：命令行环境变量 > `examples/node/config.local.json`（已 gitignore）。
 *
 * ```bash
 * export TINODE_WS_URL='wss://im.example.com:6061/v0/channels'   # 你的 Tinode 服务地址
 * export TINODE_API_KEY='YOUR_API_KEY'                           # 服务端要求的 apikey（没有就留空）
 * export TINODE_TOKEN=''                                         # 登录 token（由你自己的后端签发）
 * export TINODE_TOPIC=''                                         # 想试订阅/发消息就填 usrXXXXXX
 * node examples/node/connect.mjs
 * ```
 */
import { readFileSync } from 'node:fs';
import { ImSession, defaultSessionConfig, parseWsEndpoint } from '../../src/Index.ts';
import { NodeWebSocketTransport } from './transport.mjs';

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(new URL('./config.local.json', import.meta.url), 'utf8'));
  } catch (_) {
    // 没有本地配置文件是正常的：全部走环境变量。
  }
  return {
    wsUrl: process.env.TINODE_WS_URL ?? file.wsUrl ?? '',
    apiKey: process.env.TINODE_API_KEY ?? file.apiKey ?? '',
    token: process.env.TINODE_TOKEN ?? file.token ?? '',
    // 没有自有后端 token 时，可以用 basic（user:password）或 anonymous 直接试公开 Tinode 服务
    scheme: process.env.TINODE_SCHEME ?? file.scheme ?? 'token',
    topic: process.env.TINODE_TOPIC ?? file.topic ?? '',
    appName: process.env.TINODE_APP ?? 'tinode-harmony-example/0.1.0'
  };
}

/** 默认只打印脱敏后的端点（`TINODE_VERBOSE=1` 才打全量）。 */
function endpointLabel(wsUrl) {
  const parsed = parseWsEndpoint(wsUrl);
  if (parsed === null) return '(无法解析，检查 TINODE_WS_URL 是否是完整的 ws(s)://host:port/v0/channels)';
  const host = parsed.loopback ? 'localhost' : '***';
  const port = parsed.port > 0 ? `:${parsed.port}` : '';
  return `${parsed.tls ? 'wss' : 'ws'}://${host}${port}/v0/channels`;
}

const config = loadConfig();
if (config.wsUrl.length === 0) {
  console.error('请先设置 TINODE_WS_URL（例如 wss://im.example.com:6061/v0/channels），或用 examples/node/config.local.json。');
  process.exit(2);
}

console.log(`[example] 目标端点：${endpointLabel(config.wsUrl)}（apikey ${config.apiKey.length > 0 ? '已提供' : '未提供'}）`);
const transport = new NodeWebSocketTransport(config.wsUrl, config.apiKey);
const sessionConfig = defaultSessionConfig(config.wsUrl, config.token, config.appName, '');
sessionConfig.loginScheme = config.scheme;
console.log(`[example] 登录方式：${config.scheme}`);
const session = new ImSession(transport, sessionConfig, {
  onState: (state) => console.log(`[example] 状态 → ${state}`),
  onServerVersion: (ver, build) => console.log(`[example] 服务端协议版本 ${ver}${build ? ` (build ${build})` : ''}`),
  onFailure: (text) => console.log(`[example] 失败：${text}`),
  onCtrl: (ctrl) => console.log(`[example] ctrl id=${ctrl.id ?? ''} code=${ctrl.code}`),
  onData: (data) => console.log(`[example] 收到消息 topic=${data.topic} seq=${data.seq}`),
  onInfo: () => {}, onPres: () => {}, onMeta: () => {}, onNote: () => {}
});

session.start(Date.now());
const timer = setInterval(() => session.tick(Date.now()), 200);

// 拿到 ready 之后再订阅/发消息（示例只做一次）
let acted = false;
const waiter = setInterval(() => {
  if (acted || session.state() !== 'ready') return;
  acted = true;
  console.log('[example] 已就绪（hi + login 完成）');
  if (config.topic.length > 0) {
    session.subscribe(config.topic, true, true, 24);
    console.log(`[example] 已订阅 ${config.topic}，并发一条文本`);
    setTimeout(() => session.sendPub(config.topic, null, { txt: 'hello from tinode-harmony example' }), 500);
  } else {
    console.log('[example] 未设置 TINODE_TOPIC，只验证到登录这一步（可设 TINODE_TOPIC=usrXXXXXX 试订阅与发消息）');
  }
}, 200);

// 15 秒后收尾，避免示例常驻
setTimeout(() => {
  console.log('[example] 结束（示例默认 15s 退出）');
  clearInterval(timer); clearInterval(waiter);
  session.stop();
  process.exit(0);
}, 15000);
