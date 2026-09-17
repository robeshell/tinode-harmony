# 架构与端口

## 分层

```
宿主 App / 页面
   │  用门面（Tinode）或直接用会话（ImSession）
   ▼
src/Tinode.ts          门面：会话 + 存储端口 + 事件回调（把 data 报文转成线路消息并落库）
src/TinodeSession.ts   会话状态机：连接 → hi → login → ready、超时、退避重连、代次守卫、订阅跟踪
src/TinodeWire.ts      线路层：报文构造/解析（纯函数）、ctrl 码分类与错误文案、ws 端点归一化
src/Drafty.ts          Drafty 富文本子集（读侧：txt/ent/白名单/纯文本/预览）
src/TinodeMessage.ts   线路级模型：消息/会话/草稿 + data 报文转换（**不含业务语义**）
src/TinodeStorage.ts   存储端口 + MemoryTinodeStorage
src/TinodeLog.ts       日志端口（setTinodeLogSink）+ 脱敏工具
src/TinodeSocket.ets   平台传输：@kit.NetworkKit WebSocket（.ets 侧）
src/Index.ts           纯逻辑出口（.ts 可导入）；src/Socket.ets 平台出口
```

## 状态机

```
idle ──start()/tick()──▶ connecting ──onOpen──▶ handshake ──hi ctrl──▶ login ──login ctrl──▶ ready
  ▲                          │                    │                    │
  └──── 退避重连（backoff ≤ maxBackoffMs，带抖动）◀──┴── 超时/error/close ──┘        │
                                                                              fatal 4xx ──▶ failed
```

- **时间由宿主喂**：`tick(nowMs)` 驱动超时与重连，SDK 自己不起定时器 —— 所以状态机可以在主机上完整测试；
- **代次（generation）**：每次 `start()` 递增，迟到的旧连接回调会被丢弃（切号/重连安全）；
- **退避**：`1000ms × 2^attempt`（attempt 上限 10）+ 抖动，封顶 `maxBackoffMs`；
  连接**稳定 ≥5s** 后再断线才清零 attempt（避免弱网抖动导致重连风暴）；
- **断线只算一次**：平台层 `error` + `close` 双回调会被幂等处理。

## 主题生命周期（P1）

`TinodeTopics`（纯逻辑）在 SDK 内保存"我关注哪些会话、每个会话到哪了"：

```
subscribe(sub) ──► remember(订阅意图 withDesc/withSub/limit)
ctrl 2xx       ──► markSubscribed(topic, true)         ← 收到应答才算订阅成功
data.seq       ──► lastSeq = max(见过的 seq)
note read/recv ──► read / recv 位点（本端 markRead 同口径）
断线           ──► resetSubscriptions()（保留意图与位点）
重连 ready     ──► 自动重新订阅 needingSubscribe() + 从 gaps()（lastSeq+1）补历史
```

宿主可读 `knownTopics()` / `topicState(topic)`，或订阅 `onTopicState` 回调（订阅结果与位点推进时触发）。
不想让 SDK 管这些的宿主：`autoResubscribe: false`（只重连不重订）与 `syncHistoryOnReconnect: false`（不补历史）。

## 三个端口

| 端口 | 接口 | 默认实现 | 你要做什么 |
| --- | --- | --- | --- |
| 传输 | `ImTransport`：`open(handlers)/send(text)/close()` | `TinodeSocket`（HarmonyOS） | 换平台时实现它（示例见 `examples/node/transport.mjs`，40 行） |
| 存储 | `TinodeStorage`：消息/会话/草稿读写 | `MemoryTinodeStorage` | 生产实现它（RDB/文件），注意 `putMessage` 返回"是否新增" |
| 日志 | `setTinodeLogSink({detail, failure})` | 静默 | 接你自己的日志；SDK 已做脱敏（topic 截断、错误只留 code/message） |

## 门面的两种模式

- `persistIncoming: true`（默认）：门面把收到的 `data` 转成线路消息并 `storage.putMessage(...)`，再回调 `hooks.onMessage`；
- `persistIncoming: false`：门面只做协议操作，收到的原始 `data` 走 `hooks.onRawData` —— 宿主已有自己的消息管线（本地 echo、送达状态、未读、列表刷新）时用这个。

## 为什么 `.ts` 与 `.ets` 两个出口

实测：`.ts` 文件不能从 HAR/ArkTS 包导入；ArkTS 也不允许跨模块 `src/` 相对导入。
因此把**纯逻辑**（wire/session/drafty/storage/message/log/facade）放在 `.ts`，把**平台传输**放 `.ets`，
分别用 `Index.ts` / `Socket.ets` 导出；示例工程演示的就是把 `src/` 拷进工程后的导入方式。
