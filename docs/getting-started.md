# 快速开始

## 1. 拿到 SDK

三种方式，按你的工程形态选：

| 方式 | 适用 | 做法 |
| --- | --- | --- |
| **源码目录**（推荐） | ArkTS + 纯 `.ts` 逻辑混用 | 把本仓 `src/` 拷进工程，例如 `entry/src/main/ets/tinode/` |
| **HAR** | `.ets`-only 应用 / 走 ohpm | 按 `oh-package.json5` 建 HAR 模块（`main: Index.ets`、`harTasks`、`apiType: stageMode`、`module.json5` 里 `type: "har"`），`hvigorw assembleHar` 后用 `"tinode-harmony": "file:../tinode-harmony"` 引入 |
| **示例工程** | 想先跑起来看效果 | 打开 `examples/harmony/`（DevEco 直接打开即可构建；它演示的正是"源码目录"接入方式） |

> 实测约束（决定了为什么分两个出口）：`.ts` 文件**不能**从 HAR/ArkTS 包导入；ArkTS 也不允许跨模块 `src/` 相对导入。
> 所以纯逻辑走 `src/Index.ts`（`.ts` 侧可安全导入），平台传输单独走 `src/Socket.ets`（`.ets` 侧导入）。

## 2. 最小接线（HarmonyOS）

```ts
import { ImSession, ImSessionState, ImData, defaultSessionConfig } from '../tinode/Index.ts';
import { TinodeSocket } from '../tinode/Socket.ets';

const transport = new TinodeSocket('wss://im.example.com:6061/v0/channels', 'YOUR_API_KEY');
const config = defaultSessionConfig('wss://im.example.com:6061/v0/channels', 'YOUR_LOGIN_TOKEN', 'MyApp/1.0', '');
const session = new ImSession(transport, config, {
  onState: (s: ImSessionState) => { /* connecting → handshake → login → ready */ },
  onData: (d: ImData) => { /* 收到的 data 报文：topic/seq/content */ },
  onInfo: () => {}, onPres: () => {}, onMeta: () => {}, onNote: () => {},
  onCtrl: (c) => { /* ready 之后的应答，pub 的 params.seq 在这里 */ },
  onFailure: (text: string) => { /* 用户可读的中文原因 */ },
  onServerVersion: () => {}
});

session.start(Date.now());                       // 内部会 transport.open(...)
setInterval(() => session.tick(Date.now()), 200); // 时间由宿主喂进来（纯逻辑、可测）
session.subscribe('usrXXXXXX', true, true, 24);  // desc + sub，最近 24 条
session.sendPub('usrXXXXXX', null, { txt: 'hi' });
```

首次使用建议照 `examples/harmony/entry/src/main/ets/pages/Index.ets` 抄：输入框填地址/apikey/token → 连接 → 订阅 → 发一条。

## 3. 用门面（更省事）

不需要自己解析报文/落库时，用 `Tinode` 门面 + 一个存储实现：

```ts
import { Tinode, MemoryTinodeStorage } from '../tinode/Index.ts';

const tinode = Tinode.withDefaults(transport, 'YOUR_LOGIN_TOKEN', 'MyApp/1.0', new MemoryTinodeStorage(), {
  onMessage: (m) => { /* 已落库，这里只做业务投影 */ },
  onFailure: (text) => {}
});
tinode.start(Date.now());
tinode.subscribe('usrXXXXXX');
```

存储端口默认给内存实现；生产请实现 `TinodeStorage`（RDB/文件皆可），见 `docs/architecture.md`。

## 4. 不想上设备？先跑 Node 示例

`examples/node/` 是**零依赖**（用 Node 22+ 内置 `WebSocket`）的示例：连上 → 握手 → 登录 → 订阅/发消息，
用来先确认「服务地址 / apikey / token」是否配对：

```bash
export TINODE_WS_URL='wss://im.example.com:6061/v0/channels'
export TINODE_API_KEY='YOUR_API_KEY'
export TINODE_TOKEN='YOUR_LOGIN_TOKEN'
node examples/node/connect.mjs
```

下一步：[把 SDK 指向 Tinode 服务](./configuration.md) → [API 一览](./api.md) → [架构与端口](./architecture.md) →
[安全与凭据](./security.md) → [排错](./troubleshooting.md)。
