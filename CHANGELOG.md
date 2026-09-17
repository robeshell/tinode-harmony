# Changelog

本文件记录 `tinode-harmony` 的版本变更（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本）。

## [Unreleased]

### 账号自举（P3-min）
- `TinodeWire`：`buildAccCreate(id, scheme, secret, fn, login=true)`（`acc{user:"new", login:true, scheme, secret, desc:{public:{fn}}}`）
  与 `accFailureText`（409 → 用户名已被占用、400 → 用户名/密码不符合要求）；
- `ImSessionConfig.loginScheme` 新增 **`'none'`**：握手后**不发 login**，直接进入就绪态（未认证），供注册流程使用；
  新增 `ImSession.createAccount(scheme, secret, fn)` / `setLoginScheme` / `setToken`，以及可选 hook **`onAuth({uid, token})`**（登录或注册成功时回调）；
- 门面：`registerAccount(user, password, fn?): Promise<TinodeAuth>`（就绪后发 `acc` 并等待 ctrl）、
  `configurePasswordLogin(user, password)`（`start()` 之前切 `basic` 方案）、`configureTokenLogin(token)`；
- 效果：**第三方不写后端也能注册账号并登录**（Tinode 服务端直接可用）。

### 会话与资料自举（P5-min）
- 新增 `src/TinodeMeta.ts`（纯逻辑）：`profileFromSub` / `profilesFromMeta`（`meta.sub[]` → `TinodeProfile`：
  名字/头像/`seq`/`read`/`recv`/`online`/最后活动）、`mergeProfiles`（非空字段优先 + 位点取最大 + 时间取最新）、
  `topicOfProfile`（→ 端口模型 `TinodeTopic`）、`displayNameOf`（**通讯录 → `public.fn` → topic** 三级兜底）、`sortTopicsByActivity`；
- 门面：连上后**自动订阅 `me`**（`autoSubscribeMe`，默认开）→ 收到 `meta` 自动合并成**会话列表**、落库（`storage.upsertTopic`）
  并回调 **`hooks.onTopics`**；新增 `profiles()` / `profileOf(topic)` / `rememberTopic(topic)`；
- 效果：宿主不再需要自己写"从 meta 取名字/头像/未读"这一层（我们自己的 App 之前写了 446 行的 `ImConversation.ts`）。

## [0.1.0] - 2026-09-17

首个公开版本。协议层（`hi/login/sub/pub/get/set/note/del/leave`）与会话状态机（连接→握手→登录→就绪、退避重连、代次守卫）
完整可用，附带存储端口、Drafty 子集、日志端口与主机测试。

### 加固（开源前评审 docs/28 的修复项）
- **入站帧防御**：`parseServerMessage` 增加体量上限（`DEFAULT_MAX_INBOUND_BYTES`，默认 1 MB）与
  `ctrl.code`/`data.seq` 类型校验，畸形/超大帧直接丢弃。
- **出站帧守卫唯一出口**：`sendPub` 改为委托 `sendPubWithId`，`maxFrameBytes` 不再可被绕过。
- **同帧事件不再丢失**：服务端一帧里 `info` 与 `pres/meta/note` 共存时全部回调（此前 `info` 之后的键被吞）。
- **重连退避**：一次断线的 `onError`+`onClose` 双回调按一次处理（不再让退避翻倍）；
  连接稳定 ≥ 5s 后再断线会清零退避计数（避免弱网下退避被推满）。
- **平台传输**：重复 `open()` 先关闭并解绑旧 socket（修泄漏与旧回调复活）；
  未就绪时发送不再静默丢弃，而是回调 `onError`；明文 `ws://` 默认**告警**（可用 `allowInsecure: false` 拒绝）。
- **日志脱敏**：SDK 侧统一把 topic 截断（`usrD7D…(14)`）、错误只保留 `code`/`message`。
- **公开面收敛**：移除 `setDeviceToken`（协议要求毫秒时间戳 `expires`，平台侧需 Push Kit 返回值；
  实现不正确的方法比没有更糟）、移除 `rawSession()`/`nextRequestId()` 这类内部方法。
- **归属声明**：新增 `NOTICE`，逐文件补许可头。

### 主题生命周期（P1）
- 新增 `TinodeTopics`（纯逻辑）：登记每个 topic 的**订阅意图**与**位点**（`lastSeq` / `read` / `recv`）；
- 连接 `ready` 后 SDK **自动重新订阅**登记过的主题，并（可选）从 `lastSeq+1` 补历史（`get{what:"data",data:{since,limit}}`，
  新增 `buildGetHistorySince`）；断线时只清"本轮已订阅"标记，**保留订阅意图与位点**；
- 新增 `Tinode.knownTopics()` / `Tinode.topicState(topic)` / `ImSession.knownTopics()/topicState()` 与可选 hook `onTopicState`；
- 可关：`TinodeOptions.autoResubscribe`、`TinodeOptions.syncHistoryOnReconnect`（默认都开），
  会话侧对应 `setAutoResubscribe(false)` / `setSyncHistoryOnReconnect(false)` —— 自己管订阅与增量同步的宿主可关掉。

### 附件（P2，可选模块）
- 新增 `src/TinodeAttachment.ts`（纯逻辑）：`validateAttachment`（大小/类型/文件名）、`planChunks` + `initialProgress` +
  `mergeChunkProgress` + `uploadedBytesOf` + `progressPercent` + `isUploadComplete`（大文件分块与进度）、
  `attachmentDrafty` / `attachmentOfDrafty`（消息内容 ↔ 附件元数据，实体类型按 MIME 选 `IM/AU/VD/EX`）、
  `cacheKeyOf` / `cacheBytesOf` / `planEviction`（缓存键与 LRU 淘汰规划）、`attachmentUploadUrl` / `uploadedRefOf`（Tinode 上传地址与响应解析）；
- 新增 `src/TinodeAttachmentHttp.ets`：HarmonyOS 平台的 `AttachmentTransferPort` 实现（multipart 上传 + 下载，带进度回调）——
  **未真机验证**，且核心 SDK 不依赖它（宿主可继续用自己的后端附件接口）；
- 索引：`Index.ts` 导出纯逻辑，`Socket.ets` 导出平台实现；`tools/check-sdk-hygiene.py` 的平台文件白名单同步更新。

### 存储与缓存策略（P4）
- 新增 `src/TinodeStore.ts`（纯逻辑）：`mergeMessages`（同 seq 覆盖 + 升序）、`unreadOf`/`isUnreadMessage`、
  `lastMessageOf`/`previewOf`、`conversationSummaryOf`/`conversationSummariesOf`、`planMessageEviction`（每会话保留最近 N 条）、
  `draftPreviewOf`、`messageKeyOf`；
- 新增 `src/TinodeStorageCache.ts`：`CachedTinodeStorage` 装饰器 —— 给任意 `TinodeStorage` 加**容量受限的读缓存**（LRU），
  写操作按会话失效，附 `stats()` / `reset()` / `invalidate(topic)`；
- `MemoryTinodeStorage` 仍是默认实现与参考实现（语义不变）。

### 日志
- 明文 `ws://` 的提示走 **detail（level=warn）**，不再经 failure 通道（宿主不会把它渲染成"失败"）；
  真正需要拒绝明文时用 `new TinodeSocket(url, apiKey, false)`。

### 公开 API 口径
- **有 id 的请求**（`subscribe/publish/history/deleteTopic/deleteMessages`）返回**报文 id**，未就绪或参数非法返回 `''`，失败原因统一走 `onFailure`；
- **note / leave**（协议里没有 id）返回 **`boolean`（是否已发出）**；
- 存储端口方法返回 `Promise`，失败按宿主实现的语义 `reject`；
- 移除了 `rawSession()` / `nextRequestId()` 这类内部方法（需要底层能力可直接使用 `ImSession`）。

### 已知限制
- 未实现：群组（`grp`）、多端同步、推送（`set{what:"deviceToken"}`）、附件上传/下载（由宿主负责）、
  面向第三方的完整 API 文档（见 README 的 API 一览）。
- 平台传输只覆盖 HarmonyOS（`@kit.NetworkKit` WebSocket）；其它平台请实现 `ImTransport`。
