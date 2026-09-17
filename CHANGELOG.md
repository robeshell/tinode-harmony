# Changelog

本文件记录 `tinode-harmony` 的版本变更（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本）。

## [Unreleased]

### 修复：`me` 自动订阅必须等已认证
- `autoSubscribeMe` 之前在 `ready` 就订阅 `me`：**未认证**（`loginScheme:'none'` 的注册流程）时服务端回 **401**，
  而 401 是致命错误 → 会话被打成 `failed`，随后的注册也失败。现在改为**拿到 uid 后**（登录/注册成功）才订阅，
  并加了回归测试（未认证时不得出现 `sub{topic:"me"}`）。
- 真机验证（示例 App，2026-09-17）：注册成功 → `凭据已签发 uid=usr…` → `主题 me 已订阅=true` → `ctrl 200/204`。

### 语音可播放 + 图片可预览（让能力真正能体验）
- 新增 SDK 纯函数 **`wavFromPcm(pcm, sampleRate, channels)`**（裸 PCM → 44 字节 RIFF 头，任何播放器都能播）与 `wavDurationMsOf()`，含主机测试；
- 示例：录音结束把 PCM **落盘成 WAV**（`context.cacheDir/voice/`），语音气泡显示 **▶ + 时长**，**点气泡用 `@kit.MediaKit` 的 AVPlayer 播放**（播放中显示 ⏸，再点停止，播完复位）；
  对端语音没有本地文件时点击如实提示「对端语音：无本地文件」；
- 示例：**点图片气泡打开全屏预览**（点任意处关闭）；点文件气泡给出可读提示（文件名 + 大小 + "示例不做打开/下载"）；点位置气泡给出坐标提示；
- 另修：气泡点击此前**没有接线**（`onBubbleTap` 定义了但没挂上），导致点了没反应。

### 修复：图片消息不显示（现在渲染缩略图）
- 现象：示例里发图片只显示 `[图片]` 文案，**看不到图**（用户反馈）。
- 原因有三：① picker 给的 URI 是**临时授权**，不复制进沙箱后续读取/渲染会失败；② 图片气泡根本没渲染 `Image`；
  ③ 自己发的图片会被服务端**回显**成 `data` 报文（且服务端可能裁掉实体里的自定义 `ref`），于是本地那份被回显覆盖、本地沙箱路径丢失。
- 修法：picker 选中的文件**复制进 `context.cacheDir`**（`fileIo.copyFileSync`）后返回沙箱路径；demo 侧维护 `ref → 本地路径` 映射；
  `IM` 实体用 `Image('file://'+路径)` 渲染缩略图（200×150、圆角 8、失败回落文案）；**回显消息与本地"发送中"那条按内容归并**（保留本地图片副本与富文本片段、清掉占位），
  避免同一张图显示两次；对端图片在没有可访问地址时如实提示。
- 真机验证（PSN-AL00）：系统 picker 选图 → 发送 → 聊天里**显示缩略图**（文件名 + ✓ 送达标记）✓，且只出现一次 ✓。

### 示例：界面重做（像真实 IM）· 真机跑通收发
- 真机（PSN-AL00）用**两个账号**跑通完整链路：App 侧注册/密码登录 → 打开对端会话（`usr<peerUid>`）→ 发消息（表情/位置/引用，无需打字）
  → 对端用 Node 脚本（`examples/node` 的传输层 + token 登录）发两条 → App 侧**实时收到**并按气泡渲染 ✓；
- 会话列表能把 peer 的 **`public.fn` 解析成名字**（截图里显示 `ldpeer103137`，来自 `get{what:"desc"}` → `profileFromDesc` ✓）；
- 打磨：`onFailure` 不再把整页打成 failed（只记日志）；会话列表加**加载态**；气泡按内容收缩（不再被 `layoutWeight` 拉满）；消息变化后刷新会话预览与未读。

### 界面重做（第一批）
- 新增 `demo/DemoTheme.ets`（品牌色/文本色/气泡色/圆角/头像尺寸，数值照宿主 App 与 Android 基线）与 `demo/DemoFormat.ets`（时间标签 5 分钟规则、送达标记、文件大小、时长、附件预览前缀）；
- `pages/Index.ets` 重写为 4 个视图：**登录/连接**（品牌区 + 状态徽标 + 卡片式带标签输入 + 主/次按钮 + 运行日志）、
  **会话列表**（顶部栏 + 圆形首字母头像 + 名字/预览/时间/未读徽标/在线点 + 空状态）、
  **聊天**（顶部栏含在线/最后在线、气泡（自己品牌色靠右/对方白底靠左、圆角 12、最大宽 260）、时间标签、送达标记、对方头像、
  富文本按 `draftySegments` 渲染、图片/文件/语音/引用气泡、输入栏含 B/I/＋/发送、按住说话模式、空会话提示）、
  **能力清单**（分组卡片 + API + 源码位置 + ✅/⚠️/❌ 状态徽标）；
- 交互修正：注册/登录成功自动进入会话列表；`TextInput` 用 `$$` 绑定（异步读到的本地配置能显示）；会话列表过滤掉 `me` 伪主题；
  **订阅完成前发送排队**（Tinode 对"未订阅就 pub"回 409），订阅成功后自动补发。

### 示例：系统 picker 与麦克风录音
- `examples/harmony/entry/src/main/ets/demo/DemoPickers.ets`：图片（`photoAccessHelper.PhotoViewPicker`）、文件（`picker.DocumentViewPicker`）、
  麦克风录音（`@kit.AudioKit` 的 `AudioCapturer`，16 kHz/单声道/S16LE，照宿主 App 已真机验证的写法）与 S16LE 电平计算；
- 聊天页新增「选图 / 选文件 / 按住说话」；录音期间显示电平、松开发送 `AU` 实体消息（含 `duration`），页面销毁释放麦克风；
- `module.json5` 声明 `ohos.permission.MICROPHONE`（user_grant，含 `reason`/`usedScene`），首次使用时弹系统授权框；
- 真机验证：系统图片 picker 能打开 ✓、麦克风授权弹窗显示自定义说明 ✓、录音得到 PCM（1494 ms / 43520 B）✓；
  附件上传带 `X-Tinode-Auth` token，但该部署的 `file/u` 仍回 **401** → demo 退回"仅元数据"并在界面如实提示（**上传成功路径未验证**）。

### 示例：完整聊天 demo（`examples/harmony`）
- 4 个视图：连接与账号（注册/密码登录/anonymous）/ 会话列表（名字/未读/在线/最后在线/权限摘要）/ 聊天（历史分页、富文本加粗斜体、附件校验与分块进度、已读、正在输入、撤回）/ **能力清单**（20 项能力 → API → 源码位置）；
- 本地配置支持预填 `user`/`password`（仍只读 gitignored 的 `im.local.json`）；`sync-sdk.sh` 同步 SDK 源码。

### 修复：`basic` 的 secret 必须是 base64
- `basic` 方案的 `secret` 是 **base64(`用户名:密码`)**（上游 `AuthScheme.encodeBasicToken:49-57`），不是明文 `用户名:密码`；
  之前的实现发的是明文 → 真机/真实服务端会回 **`400 malformed`**。新增纯函数 `encodeBasicSecret(user, password)` 与
  `isValidBasicLogin(user)`（用户名不能含 `:`），门面 `registerAccount` / `configurePasswordLogin` 与示例都已改用它；
- **真机验证**（2026-09-17，dev 服务端 0.25）：`loginScheme:'none'` → `acc{user:"new",login:true,scheme:"basic"}` 注册成功，
  服务端返回 `uid=usr…` + `token`，随后 `get{topic:"me",what:"sub"}` 拿到会话列表 —— 自举全链路在真实服务端跑通。

### 权限与账号管理（P5 余项 / P3 余项）
- `TinodeAcs.ts`（纯逻辑）：`normalizeAccessMode`（`"wr"` → `"RW"`，`N` 显式无权限单独保留）、
  `acsAllows` / `acsCanRead` / `acsCanWrite` / `acsIsOwner`、`parseAcs`（`{given,want,mode}`）、`parseDefacs`（`{auth,anon}`）、
  `acsSummary`（`JRW` → `加入·读取·发送`）——对应上游 `Acs`/`AcsHelper`/`Defacs`；
- `TinodeWire`：`buildAccUpdate`（改密/改名片，`user:<uid>` + `login:false`）、`buildAccAddCredential`（`cred:[{meth,val}]`）、
  `buildGetMetaDesc`（`get{what:"desc"}` 拉名片）、`buildGetMetaSub`（`get{topic:"me",what:"sub"}` 拉订阅列表）、
  `buildSetPublicDesc`（`set{topic:"me",desc:{public}}` 改自己的名片）；
- 会话/门面：`loadProfile(topic)` / `loadSubscriptions(limit)` / `updatePublicName(fn, photo?)` / `changePassword(login, pw)` / `addCredential(meth, val)`；
  名片应答（`meta.desc`）由门面并进会话轮廓（`profileFromDesc`），`ImCard.photo` 类型放宽为 `string | {ref}`（线上两种形态都有）。

### 富文本写侧与渲染（P6）
- `Drafty.ts` 新增**写侧**（纯函数，偏移统一 **UTF-16 code unit**）：`draftyPlain` / `draftyAppend` / `cloneDrafty` /
  `draftyWithStyle`（越界裁剪、同类相邻合并）/ `draftyWithoutStyle`（切左右残段）/ `draftyWithEntity`（`data` 过白名单）/
  `draftyLink` / `draftyMention` / `draftyImage` / **`draftyInsert`·`draftyDelete`（偏移自动位移，编辑器语义）** / `draftyTrim`；
- 新增**渲染模型** `draftySegments(drafty)` → `DraftySegment[]`（`{at, text, styles, entity}`），UI 可直接按片段画样式与实体；
- 偏移语义说明写进模块注释：上游 Java SDK 解析用 code unit、构建用 grapheme cluster，本端**只取 code unit**（JS/ArkTS 原生口径）。

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
- **在线状态**：`pres` 自动应用到轮廓 —— `on` → 在线；`off`/`gone`/`rec` → 离线并记录 **`lastSeenMs`（最后在线）**；`TinodeTopic.lastSeenMs` 为**可选**新增字段（宿主老实现不受影响）；
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
