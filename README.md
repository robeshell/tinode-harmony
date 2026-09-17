# tinode-harmony

Tinode 即时通讯协议的 **HarmonyOS NEXT 客户端 SDK（ArkTS/TypeScript）**：协议报文编解码、会话状态机
（连接 → 握手 → 登录 → 就绪、退避重连、代次守卫）、Drafty 富文本子集、**存储端口**与**日志端口**。

- 许可：**MIT**（见 [LICENSE](./LICENSE)；第三方归属见 [NOTICE](./NOTICE)）
- 版本：见 [VERSION](./VERSION)，变更见 [CHANGELOG.md](./CHANGELOG.md)
- 包名：`@otq/tinode-harmony`（见 [oh-package.json5](./oh-package.json5)）
- 参考实现：Tinode 官方 [协议文档](https://github.com/tinode/chat/blob/master/docs/API.md) 与
  Apache-2.0 的 `co/tinode/tinodesdk`（**本 SDK 是独立的 ArkTS 重写**，未复制其源码）

```ts
const tinode = Tinode.withDefaults(socket, token, 'MyApp/1.0', new MemoryTinodeStorage(), hooks);
tinode.start(Date.now());
tinode.subscribe('usrXXXXXX');                  // desc + sub，最近 24 条
tinode.publish('usrXXXXXX', { txt: 'hi' });
```

---

## 1. 它做什么 / 不做什么

**做**：把 Tinode 的线路协议与会话生命周期封装成"宿主不用自己解析报文"的一层；
错误、超时、重连、代次（切号/重连后的迟到回调）都在内部收敛；存储、传输、日志全部是**端口**，SDL 不碰宿主实现。

**不做**（有意留白）：群组（`grp`）、多端同步、推送（`set{what:"deviceToken"}`）、附件上传下载、
业务语义（内容类型、送达状态、置顶、草稿策略）——这些留在宿主应用层。

## 2. 安装

### 方式 A：源码目录（推荐给 ArkTS/TS 混合工程）

把 `src/` 拷进工程（例如 `entry/src/main/ets/tinode/`），然后：

```ts
// .ts 侧（纯逻辑）
import { Tinode, ImSession, defaultSessionConfig } from '../tinode/Index.ts';
// .ets 侧（需要平台 WebSocket 时）
import { TinodeSocket } from '../tinode/Socket.ets';
```

> 实测约束：`.ts` 文件**不能**从 HAR/ArkTS 包导入；ArkTS 也不允许跨模块 `src/` 的相对导入。
> 所以纯逻辑与平台传输分成两个出口：`Index.ts` / `Socket.ets`。

### 方式 B：HAR（给 `.ets`-only 的应用或 ohpm）

按 [oh-package.json5](./oh-package.json5) 建 HAR 模块（`main: Index.ets`、`hvigorfile.ts` 用 `harTasks`、
`build-profile.json5` 的 `apiType: stageMode`、`src/main/module.json5` 的 `type: "har"`），`hvigorw assembleHar` 产出 `.har`，
使用方在 `oh-package.json5` 里写 `"@otq/tinode-harmony": "file:../tinode-harmony"` 或 ohpm 仓库地址。
（本仓库把源码与测试都带齐，HAR 只是分发形态。）

## 3. 快速开始（门面，推荐）

```ts
import { Tinode, TinodeSocket, MemoryTinodeStorage } from '../tinode/Index.ts';

const socket = new TinodeSocket('wss://im.example.com:6061/v0/channels', apiKey);
const tinode = Tinode.withDefaults(socket, token, 'MyApp/1.0', new MemoryTinodeStorage(), {
  onMessage: (m) => { /* 已落库，这里只做业务投影 */ },
  onState: (s) => {}, onCtrl: (c) => {}, onInfo: (i) => {}, onPres: (p) => {},
  onNote: (n) => {}, onFailure: (text) => {}
});

tinode.start(Date.now());                        // 内部会 transport.open(...)
setInterval(() => tinode.tick(Date.now()), 200); // 时间由宿主喂进来（纯逻辑、可测）
tinode.subscribe('usrXXXXXX');                   // 默认 desc+sub、最近 24 条
tinode.publish('usrXXXXXX', { txt: 'hi' }, { mime: 'text/x-drafty' });   // 注意参数顺序：(topic, content, head)
tinode.setRead('usrXXXXXX', 12);
tinode.setTyping('usrXXXXXX');
const page = await tinode.messagesOf('usrXXXXXX', 20, 0);
```

### 最小用法（只要状态机，不要门面）

```ts
import { ImSession, TinodeSocket, defaultSessionConfig, setTinodeLogSink } from '../tinode/Index.ts';

setTinodeLogSink({ detail: (topic, message, level) => {}, failure: (topic, error) => {} });
const session = new ImSession(socket, defaultSessionConfig(token, 'MyApp/1.0', ''), {
  onState: () => {}, onData: () => {}, onInfo: () => {}, onPres: () => {}, onMeta: () => {},
  onNote: () => {}, onCtrl: () => {}, onFailure: () => {}, onServerVersion: () => {}
});
session.start(Date.now());
session.tick(Date.now());                        // 宿主每 200ms 驱动一次
session.subscribe('usrXXXXXX');
session.sendPub('usrXXXXXX', null, { txt: 'hi' });
```

## 4. API 一览

| 入口 | 方法 | 返回 | 失败方式 |
| --- | --- | --- | --- |
| `Tinode` | `start/tick/stop` | `void` | — |
| | `state/ready/myUid/generation` | 状态查询 | — |
| | `subscribe(topic, opts?)` | 报文 id 或 `''` | `onFailure` |
| | `publish(topic, content, head?)` | 报文 id 或 `''` | `onFailure`（含超帧 `maxFrameBytes`） |
| | `history(topic, beforeSeq, limit)` | 报文 id 或 `''` | `onFailure` |
| | `setRead/setTyping/leave/deleteTopic/deleteMessages` | 报文 id 或 `''` | `onFailure` |
| | `conversations/messagesOf/draftOf` 等存储读写 | `Promise<…>` | 抛异常（宿主存储实现决定） |
| `ImSession` | `start/tick/stop`、`subscribe/publish/sendPub/sendPubWithId`、`markRead`、`sendNoteKeyPress`、`loadHistory*`、`delete*`、`leave` | 报文 id 或 `void` | `onFailure` 回调 |
| `TinodeSocket` | `open(handlers)` / `send(text)` / `close()` | `void` | `handlers.onError` |
| 工具 | `parseServerMessage/parseDraftyJson/encodeDrafty/ctrlKind/ctrlFailureText/backoffDelayMs/…` | 纯函数 | 返回 `null`/空串 |

### 错误模型（重要）

1. **协议类失败**（未连接、超帧、服务端 4xx/5xx）→ 不抛异常，通过 `hooks.onFailure(text)` 上报，
   同时对应方法返回 `''`（没有再细分错误码，**渲染前请先看 `onFailure`**）。
2. **存储类失败**（宿主 `TinodeStorage` 抛错）→ SDK 不吞，交给 `Promise` 的 `catch`。
3. **传输类失败**（socket error/close）→ 会话进入 `idle` 并按指数退避（含抖动，上限 `maxBackoffMs`）自动重连；
   一次断线的 `error`+`close` 双回调按**一次**处理。
4. 畸形/超大入站帧（超过 `maxFrameBytes` 或字段类型不对）→ **直接丢弃**，不进状态机。

## 5. 安全说明

- **凭据只由宿主注入**：`TinodeSocket(url, apiKey)` 的 apikey、`config.token` 的登录 token；SDK 内不落盘、不打日志。
- **明文 `ws://`**：默认**告警放行**（很多内网部署如此）；传 `new TinodeSocket(url, apiKey, false)` 可**拒绝**明文连接。
- **日志脱敏**：SDK 侧统一把 topic 截断成 `usrD7D…(14)`，错误只保留 `code`/`message`。
  宿主如需原文，请在自己的日志层记录并自行评估合规。

## 6. 端口（宿主可替换）

| 端口 | 作用 | 默认实现 |
| --- | --- | --- |
| `ImTransport` | 收发文本帧；`open(handlers)/send(text)/close()` | `TinodeSocket`（`@kit.NetworkKit` WebSocket） |
| `TinodeStorage` | 消息/会话/草稿读写（宿主用 RDB/文件/内存皆可） | `MemoryTinodeStorage` |
| `TinodeLogSink` | `setTinodeLogSink({detail, failure})`，不注入则静默 | 无 |

## 7. 测试

```bash
npm test          # 等价于 node --test tests/*.test.mjs
```

44 例覆盖：报文构造/解析（含入站守卫与类型校验）、会话状态机（握手/登录/超时/退避/代次/双回调去重）、
Drafty 子集、门面 + 存储端口（假传输）。全部是**纯逻辑主机测试**，不需要设备。

## 8. 版本与发布

- `VERSION` 是版本唯一真相，语义化版本：协议不兼容 → MAJOR，加功能 → MINOR，修 bug → PATCH；同步更新 `CHANGELOG.md`。
- 发布形态：源码目录 / HAR（见 §2）。发布前请跑通 §7 测试，并在一个空工程里验证
  「连上 → 订阅 → 发一条 → 收到一条」。

## 9. 许可与归属

MIT（见 [LICENSE](./LICENSE)）。本实现为独立 ArkTS 重写；协议常量与报文形状参考 Tinode 官方文档与
Apache-2.0 的 `co/tinode/tinodesdk`，归属与许可说明见 [NOTICE](./NOTICE)。
未使用 Tinode 服务端（GPLv3）源码。
