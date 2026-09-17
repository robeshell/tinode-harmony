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

## 权限与账号管理（`TinodeAcs.ts` + wire，P5/P3 余项）

| 入口 | 作用 |
| --- | --- |
| `normalizeAccessMode` / `acsAllows` / `acsCanRead` / `acsCanWrite` / `acsIsOwner` / `acsSummary` | 权限字母（`J R W P A S D O`，`N`=显式无权限）解析与判定 |
| `updateAccessMode(mode, change)` | **P7**：权限增量修改 —— 整串替换（`'JSA'` → `'JAS'`）或 `+/-` 增量（`'+P-S'` → `'RWP'`）；非法返回 `null` |
| `parseAcs(raw)` / `parseDefacs(raw)` | `desc.acs = {given,want,mode}`、`desc.defacs = {auth,anon}` |
| `buildGetMetaDesc(id, topic)` / `buildGetMetaSub(id, topic, limit)` | 拉名片 / 拉订阅列表（结果在 `meta`） |
| `buildSetPublicDesc(id, topic, fn, photo?)` | 改公开名片（`set{desc:{public}}`） |
| `buildAccUpdate(id, uid, scheme, secret, fn?, cred?)` / `buildAccAddCredential(id, uid, meth, val)` | 改密 / 改名片 / 加凭据 |
| `Tinode.loadProfile/loadSubscriptions/updatePublicName/changePassword/addCredential` | 门面包装（返回报文 id，结果走 `onMeta`/`onCtrl`/`onFailure`） |

## 群组（`TinodeGroup.ts` + wire + 门面，P7 批次一/二）

> 状态：**源码已实现 + 主机测试通过（56 例）**；**真实服务端已验证**（`examples/node/group-check.mjs`
> 在 dev 服务端 **17/17**：建群改名、成员、权限、移出、**群内双向收发**）；
> 示例 App 的「建群 / 群聊 / 成员 / 邀请」已在**真机双向跑通**：自己发的与对方发的消息都显示
> （对方那条是实时送达）；根因修复见 CHANGELOG「批次五」（打开会话早于连接就绪 → 请求被静默丢弃）。
> 报文形状依据上游 `Sub`/`Set`/`Del` 报文与 `Topic.java:96,880-935,952-958,1298-1391`、`Tinode.java:1752`。

**门面 / 会话（批次二）——日常用这一层**

| 入口 | 作用 |
| --- | --- |
| `Tinode.createGroup(name, options?)` | **建群/建频道** → `Promise<TinodeGroupCreated>`；`options` = `{photo?, defacs?, tags?, channel?}` |
| `TinodeGroupCreated` | `{requestedTopic, topic, name, renamed, mode}`：**`topic` 是服务端给的真名**，`requestedTopic` 只是本地占位名 |
| `Tinode.inviteMember(topic, uid, mode)` / `setMemberMode(topic, uid, mode)` | 邀请成员 / 改成员权限（`mode` 是**整串**，用 `updateAccessMode` 先算） |
| `Tinode.removeMember(topic, uid)` | 移出群（封禁用 `setMemberMode(topic, uid, 'N')`） |
| `Tinode.updateGroupDefacs(topic, auth, anon)` | 改群默认权限（空串 = 这一侧不改） |
| `Tinode.members(topic, limit?)` | 成员列表 → `Promise<TinodeMember[]>`（`limit<=0` 用服务端默认） |
| `Tinode.groupInfo(topic)` | 群资料 → `Promise<TinodeGroupInfo \| null>`（单聊/未知话题为 `null`） |
| `ImSession.createTopic(topic, options)` | 会话层建群：发 `sub{topic:"new…", set}`，**2xx 时用 `ctrl.topic` 自动改名**；返回报文 id |
| `ImSession.inviteMember` / `removeMember` / `setTopicDefacs` / `loadMembers` | 会话层同名能力（返回报文 id；参数非法返回 `''`） |

```ts
const g = await tinode.createGroup('项目群', { defacs: { auth: 'JRWPA', anon: 'N' } });
tinode.subscribe(g.topic);                                  // ← 必须用返回的 topic（真名 grp…）
await tinode.inviteMember(g.topic, 'usrPeer01', 'JRWPA');
const rows = await tinode.members(g.topic);                 // TinodeMember[]
const info = await tinode.groupInfo(g.topic);               // 名字/头像/defacs/我的权限
```

> **应答归因**：门面按报文 id 等在途请求，`ctrl` 与 `meta` 都能兑现 —— `get{what:"sub"|"desc"}` 成功回 `meta`，
> **失败回的是 `ctrl`**；断线时统一 reject（「连接已断开，请重试」），不让 Promise 悬着。
>
> **3xx 口径**：Tinode 对**幂等写**回 3xx（相同的 `set` 再发一次 → **304 Not Modified**），
> 对**已订阅**的话题回 **303 See Other**（真实服务端实测）。所以：
> **写操作**与**订阅结果**都用 `ctrlAccepted`（`200 ≤ code < 400`，依据上游 `Tinode.java:713-714`
> 与 `Topic.java:911`）判成功 —— 只认 2xx 会把"已订阅"标成"未订阅"，让宿主等 `subscribed` 的发送队列
> 永远不补发；但 `createGroup` 只认 2xx —— 3xx 时上游**不换名**，返回的占位名不可用。
>
> **群名不在 `meta.sub[].pub` 里**：那是"我的订阅的 public"，对群话题通常是空的；群名在群自己的
> `desc.public.fn`，要 `get{topic:"grp…", what:"desc"}`（门面 `groupInfo()`，示例的 `loadGroupInfo()`）。

**纯逻辑与报文（批次一）**

| 入口 | 作用 |
| --- | --- |
| `topicKindOf(name)` | 话题种类：`grp`/`chn`/`p2p`/`me`/`fnd`/`sys`/`unknown`（`new…` 算 `grp`，`nch…` 算 `chn`） |
| `isGroupTopic` / `isNewTopic` / `isP2PTopic` / `isChannelTopic` | 分类判定；`isNewTopic`（`new…`/`nch…`）用于**拦住"还没同步就发 set"** |
| `newGroupTopicName(nowMs, counter, randomFraction)` / `newChannelTopicName(…)` | 造待创建的话题名（`new…`/`nch…`）；**建群成功后必须用应答 `ctrl.topic` 换名** |
| `buildSubCreate(id, topic, {name, photo, defacs, tags})` | `sub{topic, set{desc{public,defacs}, tags}}`：**建群/建频道** |
| `buildGetMetaSub(id, topic, limit)` | 复用：`get{topic:"grp…", what:"sub"}` 拉**成员列表**（结果在 `meta.sub[]`） |
| `membersFromMeta(meta, fallbackTopic?)` / `memberFromSub(sub, fallbackTopic?)` | `meta.sub[]` → `TinodeMember`（uid/权限/名片/在线）；没有 `user` 的行会被丢弃 |
| `mergeMembers(known, incoming)` / `memberOf(members, uid)` / `sortMembers(members)` | 增量合并（`"N"` 也是有效值）、查找、排序（所有者→在线→有名字→uid） |
| `buildSetSubMode(id, topic, user, mode)` | **邀请成员**或改成员权限（`set{sub:{user,mode}}`，整串 mode；`user` 空 = 改我自己） |
| `buildSetDefacs(id, topic, auth, anon)` | 改群**默认权限**（`set{desc:{defacs}}`） |
| `buildDelSubscription(id, topic, user)` | **移出群**（`del{what:"sub",user}`）；封禁不是删除，而是 `buildSetSubMode(…, 'N')` |
| `groupInfoFromMeta(meta)` | `meta.desc` → `{topic, kind, name, photo, defacs, acs}`；只认群类话题 |
| `groupPermissionsOf(mode)` / `canInviteMembers` / `canApproveMembers` / `canEditGroup` / `canDeleteGroupMessages` | 由我在群里的 `mode` 算出可做的事（**UI 提示**；服务端才是权威） |

**没做**：示例界面里的群聊入口；改群资料（改名/换头像，只有建群时能带 `desc.public`）；成员审批与加入申请；
**真机与真实服务端均未验证**。

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
