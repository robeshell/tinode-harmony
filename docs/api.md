# API 一览

所有类型都从 `src/Index.ts` 导出（纯逻辑）；`TinodeSocket` 在 `src/Socket.ets`。

## 门面 `Tinode`

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `Tinode.withDefaults(transport, token, appName, storage?, hooks?)` | `Tinode` | 常用构造：只给 transport + token |
| `new Tinode(options)` | `Tinode` | 完整构造（可配 `maxFrameBytes` / `persistIncoming` / `hooks`） |
| `start(nowMs)` / `tick(nowMs)` / `stop()` | `void` | `tick` 由宿主定时驱动（建议 200ms） |
| `state()` / `ready()` / `myUid()` / `generation()` | 状态查询 | `generation` 用于识别"换号/重连后的迟到回调" |
| `subscribe(topic, opts?)` | 报文 id / `''` | 默认 `desc + sub`、24 条；`''` 表示未就绪或参数非法（原因走 `onFailure`） |
| `publish(topic, content, head?)` | 报文 id / `''` | 超帧（`maxFrameBytes`）不发并回调 `onFailure` |
| `history(topic, beforeSeq, limit)` | 报文 id / `''` | 分页拉历史（服务端可能 403） |
| `deleteTopic(topic)` / `deleteMessages(topic, ranges, hard)` | 报文 id / `''` | — |
| `setRead(topic, seq)` / `setTyping(topic)` / `leave(topic)` | **`boolean`（是否已发出）** | note/leave 协议里没有 id，故不进 id 口径 |
| `knownTopics()` / `topicState(topic)` | `TinodeTopicState[]` / `TinodeTopicState \| null` | **P1**：订阅意图 + 位点（`lastSeq`/`read`/`recv`）快照 |
| `conversations()` / `messagesOf(topic, limit, beforeSeq)` / `draftOf(topic)` | `Promise<…>` | 存储端口包装 |
| `upsertTopic/saveDraft/clearHistory/removeTopic` | `Promise<void>` | 同上 |

## 会话 `ImSession`（不要门面时）

| 方法 | 返回 |
| --- | --- |
| `start/tick/stop` | `void` |
| `state/ready/myUid/generation` | 查询 |
| `subscribe(topic, withDesc, withSub, limit)` | `void`（报文 id 由 `takeId()` 内部管理） |
| `sendPub(topic, head, content)` / `sendPubWithId(id, topic, head, content)` | `void`（超限不发 → `onFailure`） |
| `loadHistoryWithId(topic, before, limit)` / `deleteTopic` / `deleteMessages` | 报文 id |
| `markRead(topic, seq)` / `sendTyping(topic)` / `leave(topic)` | `boolean` |
| `knownTopics()` / `topicState(topic)` | 主题快照（P1） |
| `setAutoResubscribe(on)` / `setSyncHistoryOnReconnect(on)` | `void`（默认都开） |

## 平台传输 `TinodeSocket`

| 方法 | 说明 |
| --- | --- |
| `new TinodeSocket(url, apiKey, allowInsecure = true)` | `allowInsecure=false` 时拒绝明文 `ws://` |
| `open(handlers)` / `send(text)` / `close()` | 未就绪时 `send` 会回调 `handlers.onError`，不静默丢 |
| `isOpen()` | 仅表示"已连上"，**不代表已认证** |

## 纯函数（可直接单测/复用）

`buildHi / buildLogin / buildSub / buildPub / buildGetHistory / buildNoteRead / buildNoteKeyPress / buildLeave /
buildDelTopic / buildDelMessages / parseServerMessage / parseWsEndpoint / ctrlOk / ctrlKind / ctrlIsFatal /
ctrlFailureText / backoffDelayMs / parseDraftyJson / encodeDrafty / draftyText / draftyEntities / redactTopic / redactError`

## 错误模型（重要）

1. **协议类失败**（未连接、超帧、服务端 4xx/5xx）→ 不抛异常：`hooks.onFailure(text)` + 对应方法返回 `''`（或 `false`）；
2. **存储类失败**（你的 `TinodeStorage` 抛错）→ SDK 不吞，交给 `Promise.catch`；
3. **传输类失败**（socket error/close）→ 会话转 `idle` 并按指数退避（含抖动、上限 `maxBackoffMs`）自动重连；
   一次断线的 `error`+`close` **只算一次**；
4. **畸形/超大入站帧**（超过 `maxFrameBytes` 或 `ctrl.code`/`data.seq` 类型不对）→ **直接丢弃**，不进状态机。
