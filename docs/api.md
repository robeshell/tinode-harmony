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
| `registerAccount(user, password, fn?)` | `Promise<TinodeAuth>` | **P3-min**：`acc{user:"new", login:true}` 注册并登录（需 `loginScheme:'none'` 且已 ready） |
| `configurePasswordLogin(user, password)` / `configureTokenLogin(token)` | `void` | **P3-min**：`start()` 之前切换登录方案 |
| `profiles()` / `profileOf(topic)` | `TinodeProfile[]` / `TinodeProfile \| null` | **P5-min**：会话轮廓（名字/头像/位点/在线/最后活动） |
| `rememberTopic(topic)` | `void` | 把宿主自己维护的 `TinodeTopic`（含 `lastPreview`）同步进门面 |
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

## 附件（`TinodeAttachment.ts`，P2 可选模块）

| 函数 | 作用 |
| --- | --- |
| `validateAttachment(meta, limits?)` | 大小/类型/文件名校验 → `{ok, reason}` |
| `planChunks(total, chunk?)` / `initialProgress` / `mergeChunkProgress` / `uploadedBytesOf` / `progressPercent` / `isUploadComplete` | 大文件分块与进度 |
| `attachmentDrafty(meta, ref, text?)` / `attachmentOfDrafty(drafty)` | 消息内容 ↔ 附件元数据（`IM/AU/VD/EX` 按 MIME） |
| `cacheKeyOf` / `cacheBytesOf` / `planEviction` | 缓存键与 LRU 淘汰规划 |
| `attachmentUploadUrl(serverBase)` / `uploadedRefOf(body)` | Tinode 上传地址与响应解析 |
| `HarmonyAttachmentHttp`（`Socket.ets` 出口） | 平台 HTTP 上传/下载（**未真机验证**） |

## 富文本（`Drafty.ts`，P6）

读侧：`parseDraftyJson` / `draftyText` / `draftyEntities` / `hasEntityType` / `firstEntityOfType` / `entityMime` / `sanitizeEntityData` / `encodeDrafty`。
写侧（偏移统一 **UTF-16 code unit**）：

| 函数 | 作用 |
| --- | --- |
| `draftyPlain` / `draftyAppend` / `cloneDrafty` | 构造与追加（纯函数） |
| `draftyWithStyle` / `draftyWithoutStyle` | 加/去样式（`ST/EM/DL/CO`），越界裁剪、同类相邻合并、切残段 |
| `draftyWithEntity` / `draftyLink` / `draftyMention` / `draftyImage` | 加实体（`data` 按白名单过滤） |
| `draftyInsert` / `draftyDelete` | 编辑文本，**已有样式/实体偏移自动位移** |
| `draftyTrim` | 截断（越界样式裁掉、实体整批丢弃） |
| `draftySegments` | 渲染模型：`{at, text, styles, entity}[]`，UI 直接画 |

## 账号（P3-min）

| 入口 | 说明 |
| --- | --- |
| `buildAccCreate(id, scheme, secret, fn, login?)` | `acc` 报文（`user:"new"` 创建；`basic` 的 `secret` 是 `用户名:密码`） |
| `accFailureText(code, text)` | `acc` 专用错误文案（409 用户名占用、400 用户名/密码不合规） |
| `ImSession.createAccount(scheme, secret, fn)` | 会话层发 `acc`，结果走 `onAuth`/`onFailure` |
| `Tinode.registerAccount(user, password, fn?)` | 门面 Promise 版：`{uid, token}` |
| `loginScheme: 'none'` | 握手后不发 `login`（注册/未认证场景） |

## 会话与资料（`TinodeMeta.ts`，P5-min）

| 函数 | 作用 |
| --- | --- |
| `profileFromSub(sub, fallbackTopic?)` / `profilesFromMeta(meta)` | `meta.sub[]` → `TinodeProfile`（名字/头像/`seq`/`read`/`recv`/`online`/最后活动） |
| `mergeProfiles(known, incoming)` | 增量合并：非空字段优先、位点取最大、时间取最新、不丢旧会话 |
| `topicOfProfile(profile, previous?)` | 轮廓 → 端口模型 `TinodeTopic`（保留宿主的 `lastPreview`） |
| `displayNameOf(topic, contactName, publicFn)` | **通讯录 → Tinode `public.fn` → topic** 三级兜底 |
| `applyPresence(profile, what, t, nowMs)` | `pres` → 在线/离线 + `lastSeenMs`（`off`/`gone`/`rec` 记最后在线） |
| `sortTopicsByActivity(topics)` | 会话列表按最后活动倒序 |

门面侧：连上自动订阅 `me`（`autoSubscribeMe`）→ 收到 `meta` 自动落库并回调 `hooks.onTopics`。

## 存储与缓存（`TinodeStore.ts` / `TinodeStorageCache.ts`，P4）

| 函数/类 | 作用 |
| --- | --- |
| `mergeMessages` / `messageKeyOf` | 同 seq 覆盖 + 升序合并 |
| `unreadOf` / `isUnreadMessage` | 未读数（自己发的不算） |
| `lastMessageOf` / `previewOf` / `conversationSummaryOf` / `conversationSummariesOf` | 会话摘要与排序 |
| `planMessageEviction(byTopic, keepPerTopic)` | 每会话保留最近 N 条（返回该删的引用） |
| `draftPreviewOf(draft)` | 草稿预览 |
| `CachedTinodeStorage(inner, capacity)` | 读缓存装饰器：`stats()` / `reset()` / `invalidate(topic)`，写操作按会话失效 |

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
