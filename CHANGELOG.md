# Changelog

本文件记录 `tinode-harmony` 的版本变更（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本）。

## [Unreleased]

### 群组 P7 批次五：**真机双向群聊通过**（修「打开会话早于连接就绪」）
- **真机（PSN-AL00 / hdc 6CS9K25C23081634，2026-09-17）双向跑通**：会话列表→打开群「项目部」
  （`grpvDIh1A3NamA`）→ 群里同时显示**自己发的位置消息**（`📍 公司 31.86,117.28 ✓`）与
  **对方账号发的三条消息**（`成员B：我在群里说话`、`成员B：实时消息`、`成员B：双向验证消息`，
  最后一条是当场实时送达：对端 `pub` → `ctrl{202}`、本端收到 `data{seq:4}`）。
  → 至此「建群 → 两个账号在群里互发消息」在真机上**双向通过**；上一版"未跑通"的记录由本条**取代**。
- **根因与修法**：示例的 `openTopic()` 在**会话还没就绪**时就发 `subscribe`/`history`
  （真机上那次点「密码登录」会 `start()` 重启一次会话），而 SDK 对未就绪的请求按约定返回 `''`
  **静默丢弃** → 既没拿到历史、也没真正订阅上，于是"打开群一片空白、别人发的也收不到"。
  修法：`openTopic` 增加就绪检查，未就绪就记进 `pendingOpenTopic`，在 `onState('ready')` 时补发；
  并把发出去的报文 id 写进运行日志（`打开会话 …：sub=… 名片=… 历史=…`）便于真机核对。
- 顺带加了一条真机诊断日志：`收到 data <topic> seq=<n> mine=<bool>`（能收到却没气泡=渲染问题；
  收不到=订阅/时机问题）——就是靠它把"渲染"与"订阅"两类原因分开的。
- 测试：独立仓 **150/150 pass**；示例工程 assembleHap **0 ERROR**（本轮未改 SDK `src/`，
  宿主仓测试/构建沿用上一轮 1058/1058 与 0 ERROR）。

### 群组 P7 批次四：示例界面（建群 / 成员 / 群名）+ 群内收发验证 + 修 303 订阅判定
- **示例 App 能玩群聊了**（`examples/harmony`）：
  - 会话列表顶栏新增「**建群**」→ 填群名 → 创建（走 `createGroup`，自动进入新群）；
  - 聊天页标题对**群话题**显示**群名** + 「**成员**」入口：成员列表（名字 / uid / 权限 / 在线点）、
    「邀请 JRWPA」（填 uid）、每行「移出」（自己那行不显示）；
  - 真机实测（PSN-AL00）**群会话能出现在会话列表里**、`建群`/`成员` 入口能渲染。
- **真机发现并修掉一个真 bug**：群会话原来只显示 `grpXXXXXX` 话题 id —— 因为群名在**群自己的
  `desc.public.fn`** 里，而 `meta.sub[].pub` 是"我的订阅的 public"（对群通常是空的）。
  示例因此新增 `loadGroupInfo()`（`get{what:"desc"}`）来取群名，并在拿到后更新标题与会话列表。
  **这条对 SDK 使用者同样重要**：只订阅 `me` 是拿不到群名的。
- **真实服务端抓出第二个真 bug（已修）**：`sub` 的应答 **303 See Other = "已经订阅过了"**
  （上游 `Topic.java:911` 就是这么判的），而 `ImSession` 原来用 `ctrlOk`（严格 2xx）判定订阅结果，
  于是把**已订阅**的话题标成"未订阅"。后果不只是重连多订一次：宿主的「等订阅成功再发送」队列
  （示例的 `whenSubscribed`）会**永远不补发**。改为 `ctrlAccepted`（2xx/3xx 都算订阅成功），
  4xx 仍然标未订阅；新增回归用例。
- **群内收发消息已验证**（真实服务端，`examples/node/group-check.mjs` 扩到 **17/17 通过**）：
  群主发 → 成员收到（下行）、成员发 → 群主收到（上行）、自己的消息被服务端**回显**成 data。
- 测试：独立仓 **150/150 pass**；宿主仓 **1058/1058 pass**、`assembleHap` 0 ERROR、
  `check-sdk-hygiene.py`、`check-evidence.py`、`dead-exports.mjs` 全绿；三处 `src/` 一致。
- **真机已完成（PSN-AL00 / hdc 6CS9K25C23081634，2026-09-17）**：
  连接 →「在线 · 服务端协议 0.25」→ 密码登录 → 会话列表「建群」入口渲染；
  建群面板输入中文群名「**项目部**」→ 创建 → **自动进入群聊页**，标题显示**群名**（`groupInfo` 生效）+「成员」入口；
  **群内发消息**：加号 → 位置 → 群里出现 `📍 公司 31.86000, 117.28000 ✓`（送达标记）；
  **成员面板**：`群成员（1）` → 真实名册（我 = `JRWPASDO` 所有者，自己那行显示「（我）」而不是「移出」）；
  **邀请成员**：填 uid 邀请 → `群成员（2）`，新成员显示 `JRWPA` + 「移出」；
  **另一个账号（Node，uid `usrd1wiPvxHnMk`）在同一个群里成功发言**（服务端回显 `{"txt":"成员B：我在群里说话"}`）。
- **真机未完成（照实标注）**：**对方发的那条群消息在 App 里没显示出来** —— 重新打开该群只看到
  「这里还没有消息」。已排除的现象：群会话在列表里、群聊页标题正确、自己发的消息能显示；
  **原因未查明**，候选是演示 App 的取法问题（`openTopic` 会发 `get{what:"data"}`，而本部署的历史接口
  受限、仓库文档已登记该部署历史 403）叠加"消息在 App 未订阅期间发出"。因此
  「**两个账号在真机上互发消息**」只完成**单向**（App → 群 ✓；对方 → App ✗），
  **不算跑通**；协议层与门面层的双向收发由真实服务端 17/17 覆盖（那条是通的）。
- **2026-09-17 第二轮真机诊断（结论，供下轮接着修）**：
  - 用一个 **Node 客户端登录同一个账号**（示例配置里的账号）订阅同一个群，实测：**显式 `get{what:"data"}`
    能拿到历史**（`data{seq:2}`、`data{seq:1}`、`ctrl{208}`）；而**订阅内联窗口**（`sub{get:{data:{limit:24}}}`）
    **不回历史**（只有 `ctrl{200}` + `meta`）。→ `docs/configuration.md` 里「本部署历史 403、改用内联窗口」
    的说法已**订正**。
  - 同一账号用 Node 能收到群里的**实时**消息（对端 `pub` 回 `ctrl{202}`，本端收到 `data{seq:3}`），
    而**示例 App 停在群聊页时既没显示历史、也没显示那条实时消息** → 问题在**示例 App 那一侧**
    （打开会话时的订阅/取历史时机或渲染路径），**不在 SDK 的群能力**（数据确实到达了这个账号）。
  - 已排除：群会话在列表里、群聊页标题正确、**自己发的**消息能显示（位置消息带 ✓）、成员面板与邀请都正常。
  - 下轮修法候选：给示例的 `openTopic` 加可见日志（确认 `sub`/`get` 是否真发出、`onMessage` 是否触发），
    并把「打开会话」改成**登录 ready 之后再发**（怀疑打开时会话尚未 ready，`subscribe`/`history` 被 `''` 静默丢弃）。
- 另外两条工具/环境限制（不是功能缺陷，供下次避免踩）：`uitest inputText` 不会同步 ArkUI 的
  `$$` 双向绑定（所以真机上"打字发消息"发不出去，改用「位置」这类无需输入的消息验证）；
  测试期间**设备被另一个会话占用**（宿主 App 反复抢回前台），交互多次被中断。

### 群组 P7 批次三：真实服务端验证（Node 客户端）+ 修 3xx 幂等写
- 新增可复跑的**群组端到端自检** `examples/node/group-check.mjs`（零依赖，走门面 + Node 内置 WebSocket）：
  在一个真实 Tinode 服务上跑完「注册群主 → 建群 → members → 邀请 → 改默认权限 → groupInfo → 移出 → 清理」。
- **实测（dev 服务端，协议 0.25，2026-09-17）：14/14 项通过** ——
  `createGroup` 拿到服务端改名（`requested=new1lan17p1e6` → `topic=grp2V9zP97pZoY`，`renamed=true`）、
  建群应答 `ctrl.params.acs=JRWPASDO`（所有者）、`members` 邀请前 1 条 → 邀请后 2 条且对端 `mode=JRWPA` →
  移出后 1 条、`groupInfo` 的 `name`/`defacs` 与请求一致、结束时软删自检群。
  **口径**：这是「Node 客户端 + 真实服务端」，**不是 HarmonyOS 真机**；真机与示例界面仍未验证。
- **真实服务端当场抓出一个真问题并已修**：Tinode 对**幂等写**回 3xx —— 把相同的 `set{desc:{defacs}}`
  再发一次会拿到 **304 Not Modified**；本端原来用 `ctrlOk`（严格 2xx）判定，于是把"什么都没变"的
  成功当成失败，抛出兜底文案「消息服务返回了未知错误」。
- 修复：`TinodeWire` 新增 **`ctrlAccepted(code)`**（`200 <= code < 400` = 服务端**接受**了请求，
  依据上游 promise 判定 `Tinode.java:713-714`），群组的幂等写（邀请/改权限/改默认权限/移出）改用它；
  `ctrlFailureText` 补 3xx 分支（「服务端没有修改任何内容（3xx）」）。
  **`createGroup` 有意不跟随这条放宽**：上游对 `sub` 的 3xx 是"已订阅"且**不会换名**
  （`Topic.java:911-925`），把占位名 `new…` 当结果返回给调用方是不可用的 → 显式 reject（注释写明理由）。
- 测试：`tests/im-group.test.mjs` 21 → **24 例**（`ctrlAccepted` 边界、304/303 写操作 resolve、
  createGroup 3xx 必须 reject）。独立仓 **149/149 pass**；宿主仓 **1050/1050 pass**、`assembleHap` 0 ERROR、
  `check-sdk-hygiene.py`、`check-evidence.py`、`dead-exports.mjs` 全绿；示例工程已同步。
- **残留（如实登记）**：自检会在 dev 服务端注册**一次性测试账号**（每次运行一个 `grpcheck…`）并留下
  **软删的群**（软删只对群主隐藏，服务端仍留行）；被邀请人已移出、其订阅已删除。

### 群组 P7 批次二：会话与门面接线（建群改名、成员、权限、应答归因）
- `TinodeTopics.rename(from, to)`：建群成功时把登记状态**搬到服务端给的真名**下（订阅意图与位点都保留）；
  目标名已登记时合并（位点取最大、`subscribed` 取或），并**保留目标名自己的订阅意图**——
  不让改名把已有信息降级。
- `ImSession` 新增群组发送口：
  - `createTopic(topic, options)`：建群/建频道走 `sub{topic:"new…", set{desc,tags}}`（**不是 `set`**）。
    收到 2xx 时用应答里的 **`ctrl.topic`** 改名并标记订阅成功；**4xx/5xx 忘掉占位名**
    （否则重连会对一个不存在的 `new…` 重新订阅，上游 4xx 也是 `stopTrackingTopic` + `expunge`）；
    3xx（已订阅）保留占位名、不换名（上游口径）。
  - `inviteMember(topic, user, mode)`（邀请/改成员权限）、`removeMember(topic, user)`（`del{what:"sub"}`）、
    `setTopicDefacs(topic, auth, anon)`（改默认权限）、`loadMembers(topic, limit)`（`get{what:"sub"}`）。
    参数非法（空话题/非法权限/空 user）返回 `''`，**不发脏帧**。
- `Tinode` 门面新增群组 API：
  - `createGroup(name, options?)` → `Promise<TinodeGroupCreated>`：返回 `{requestedTopic, topic, name, renamed, mode}`，
    其中 **`topic` 是服务端给的真名**（占位名 `new…`/`nch…` 只在本地出现过），`mode` 取自 `ctrl.params.acs`；
  - `inviteMember` / `setMemberMode` / `removeMember` / `updateGroupDefacs` → `Promise<void>`（2xx resolve，失败 reject 可读文案）；
  - `members(topic, limit?)` → `Promise<TinodeMember[]>`；`groupInfo(topic)` → `Promise<TinodeGroupInfo | null>`（单聊/未知话题为 null）。
- **应答归因**（本批新增的内部机制）：门面按报文 id 等在途请求，`ctrl` 与 `meta` **都能兑现同一条请求** ——
  因为 `get{what:"sub"|"desc"}` 成功回 `meta`、**失败回的是 `ctrl`**；只等 `meta` 会让失败请求永远挂着。
  断线时统一 reject（文案「连接已断开，请重试」），不让 Promise 悬着。
- `ImCtrlParams` 增加 `acs` 字段（建群应答里服务端算好的我方权限，上游 `Topic.java:918-921`）。
- **本批自己写出、又被测试当场抓出的两处**（已修，留档以免重犯）：
  ① 建群 2xx 只改名、**没标记订阅成功** → `knownTopics()` 永远显示"未订阅"、重连还会重订一次；
  ② `rename` 合并时用占位名的 prefs **覆盖**了已登记话题的意图（`withSub`/`limit` 被降级）。
- `tests/im-group.test.mjs`：**21 例**（建群改名/失败清理/3xx、重连用真名重订阅的重归测试、成员与权限报文、
  门面 createGroup/members/groupInfo/权限写操作、断线不挂死）。**独立仓 `node --test tests/*.test.mjs` → 146/146 pass**；
  宿主仓同步后：`node --test harmony/tests/*.test.mjs` → **1047/1047 pass**、`assembleHap` **0 ERROR**、
  `check-sdk-hygiene.py`（19 个源文件）、`check-evidence.py`、`harmony/tools/dead-exports.mjs` 全部通过；示例工程已同步。
- **未做（照实标注）**：示例界面没有群聊入口；**真机与真实服务端均未验证**（建群全链路没跑过）；
  改群资料（改群名/换头像）没有实现（只有建群时能带 `desc.public`）；成员审批/加入申请、频道订阅、
  群消息回执等仍是宿主或后续批次的事。

### 群组 P7 批次一：纯逻辑（话题分类/命名 + 成员模型 + 群权限）
- 新增 `src/TinodeGroup.ts`（纯逻辑，协议依据是 Apache-2.0 的 vendored 官方 Java SDK）：
  - **话题分类**：`topicKindOf`（`grp…`/`new…` → `grp`、`chn…`/`nch…` → `chn`、`usr…` → `p2p`、`me`/`fnd`/`sys` 原样）、
    `isGroupTopic`（群+频道都算，对齐上游 `Topic.isGrpType:158-174`）、`isNewTopic`、`isP2PTopic`、`isChannelTopic`；
  - **新话题命名**：`newGroupTopicName` / `newChannelTopicName` / `uniqueTopicSuffix` —— 建群时客户端**先造 `newXXXX` 名字**，
    服务端在应答 `ctrl.topic` 里换成真正的 `grp…`（上游 `Topic.java:96`、`:925-928`）。
    **有意不与上游逐位一致**：上游 `nextUniqueString:2337-2340` 用 Java `long` 做 `(now-…)<<16`，同样写法在 JS/ArkTS 里
    `<<` 会按 int32 溢出、值本身又超过 `Number.MAX_SAFE_INTEGER`，反而**丢掉 counter**（同毫秒撞名）；
    这里改成"秒级时间戳 + 计数 + 随机段"三段 32 进制（随机数由调用方传入，因此可测）；
  - **成员模型**：`TinodeMember` + `memberFromSub` / `membersFromMeta`（`get{what:"sub"}` → `meta.sub[]`）、
    `mergeMembers`（非空优先；`"N"`（封禁）也是**有效值**，判空不判真假）、`memberOf`、`sortMembers`（所有者→在线→有名字→uid）；
  - **群权限**：`groupPermissionsOf` → `{isOwner, canRead, canWrite, canInvite(S), canApprove(A), canDeleteMessages(D), canEdit, isBanned}`
    与单函数 `canInviteMembers` / `canApproveMembers` / `canEditGroup` / `canDeleteGroupMessages`。字母含义来自上游
    `AcsHelper:15-22`；**服务端才是权威**，这些判定只用于 UI 显隐；
  - **群资料**：`groupInfoFromMeta`（`meta.desc` → 名字/头像/`defacs`/`acs`；只认群类话题，单聊走 `profileFromDesc`）。
- `src/TinodeWire.ts` 新增群组报文构造（形状对齐 `MsgClientSub`/`MsgClientSet`/`MsgSetMeta`/`MetaSetDesc`/`MetaSetSub`/`MsgClientDel`）：
  `buildSubCreate`（`sub{topic, set{desc{public,defacs}, tags}}` 建群/建频道）、`buildSetSubMode`（邀请或改成员权限，**整串** mode）、
  `buildSetDefacs`（改群默认权限）、`buildDelSubscription`（`del{what:"sub",user}` 移出群）；成员列表复用已有的 `buildGetMetaSub`。
  参数非法（空 topic / 非法权限 / 空 user）返回 `''`，**不发脏帧**；`ImMetaSub` 增加 `acs` 字段。
- `src/TinodeAcs.ts` 新增 **`updateAccessMode(mode, change)`**（对齐上游 `AcsHelper.update:222-260`）：
  整串替换（`'JSA'` → `'JAS'`）与 `+/-` 增量（`'+P-S'` → `'RWP'`、`'-R'`）；`'N'` 在增量里是"无操作"；
  非法输入（未知字母、`'R+W'`、悬空操作符）返回 `null` —— 这是要发给服务端改**别人**权限的值，宁可报错也不猜。
- `tests/tinode-group.test.mjs`：**31 例**新用例（话题分类、命名确定性/字符集/脏输入、成员解析与合并、权限判定、
  报文形状、权限增量）。**独立仓 `node --test tests/*.test.mjs` → 125/125 pass**；
  宿主仓同步后（`harmony/tests` + vendored `tinode/`）：`node --test harmony/tests/*.test.mjs` → 1026/1026 pass、
  `assembleHap` **0 ERROR**、`tools/check-sdk-hygiene.py`（19 个源文件）、`tools/check-evidence.py`、
  `harmony/tools/dead-exports.mjs` 全部通过；示例工程 `examples/harmony` 的 `sync-sdk.sh` 已同步。
- **未做（照实标注）**：**真机未验证**，也**没有对着真实服务端跑过建群全链路**（本批次只有源码 + 主机测试）；
  facade/session 层入口（`Tinode.createGroup` / `invite` / `members()` 之类）与示例界面属于批次二/三，本次没有实现。

### 修复：`me` 自动订阅必须等已认证
- `autoSubscribeMe` 之前在 `ready` 就订阅 `me`：**未认证**（`loginScheme:'none'` 的注册流程）时服务端回 **401**，
  而 401 是致命错误 → 会话被打成 `failed`，随后的注册也失败。现在改为**拿到 uid 后**（登录/注册成功）才订阅，
  并加了回归测试（未认证时不得出现 `sub{topic:"me"}`）。
- 真机验证（示例 App，2026-09-17）：注册成功 → `凭据已签发 uid=usr…` → `主题 me 已订阅=true` → `ctrl 200/204`。

### 文档：新增维护指南
- `docs/MAINTAINING.md`：给协作者/AI 的**开场提示词**（仓库位置、工作方式、红线、已知坑、TODO、常用命令），
  换会话时整段复制即可接手；README 文档索引里加了入口。

### 文档：README 能力小节瘦身
- 原来是一张 20 多行的"能力 | 主要 API | 状态"大表，对第一次看的人太重；现在改成 **8 条一句话能力** + 「还没有」3 条，
  详细的 API 与状态表收进 `<details>` 折叠块（GitHub 上默认折叠、点开即看），安装/快速开始/Demo 指引等小节位置不变。

### 修复：撤回末条"没反应"
- 原因：示例的 `retract()` **只发了 `del` 报文、没有改本地列表**，所以界面上什么都没发生；而且落库回调/服务端回显会把消息对象**重新构造成"未撤回"**。
- 修法：撤回时**本地立刻把该条标记为已撤回**（渲染成居中的「你撤回了一条消息」/「对方撤回了一条消息」），再发 `del{what:"msg"}`；
  服务端 4xx 时**回滚标记**并提示「撤回被拒绝（可能没有删除权限）」；本地还没落库的（`seq = -1`）直接从列表移除；
  落库回调与服务端回显**保留已有的撤回标记**（不再被"未撤回"覆盖）；按钮点击后也会写一条可见提示（`已请求撤回：seq=N`）。

### 示例：位置卡片 / 表情面板 / 自动滚到底部
- **位置卡片**：发送侧把 label 与经纬度写进 Drafty 实体（`LN` + `url: geo:lat,lng` + `title`/`val`），气泡渲染成真正的
  **位置卡片**（照 Android 基线 LocationBubble：上部 80dp 浅蓝 `#E8F0FE` 区域 + 红色定位图标 + 下方地址与坐标）；点击给出坐标提示；
- **表情面板**：输入栏新增 😊 入口 + 一个真正的**表情网格面板**（8×4，点一下插入输入框，可开合，与加号附件面板互斥）；加号面板里的入口改名「表情面板」直接打开它；
- **发送后自动滚到底部**：消息 `List` 接 `Scroller`，打开会话、收到消息、自己发消息（含本地先落一条）后 `scrollEdge(Edge.Bottom)`；
- 顺带修两个真 bug：① 消息**类型判定**原先用 `draftySegments`（它按设计跳过 `LN/MN/HT`）→ 位置消息被当成普通文本；改用 `draftyEntities` 取第一个实体类型；
  ② 服务端回显会裁掉实体里的自定义字段 → **回显归并时保留本地解析出的位置坐标**（否则卡片退化成文本气泡）。

### 文档：README 增加「Demo 体验指引」
- 三步跑起来（DevEco 打开 `examples/harmony` → 填服务地址 → 连接并注册登录）+ **逐项体验清单**（想试什么 / 怎么点 / 现象 / **真收发 or 本机演示**）+ 两个账号对聊的方法；
- 示例工程 README 顶部链接到该指引。

### 示例：撤回入口
- 加号面板新增「撤回末条」（此前 `retract()` 只有实现、没有入口），已落库的消息会发 `del{what:"msg"}`，本地未落库的给出提示。

### 文案：附件明确为"本机演示"口径
- 示例不再显示 `上传失败（HTTP 401），退回本地 ref` 这类像 bug 的提示，改为**本示例未接文件服务：图片仅本机可见 / 语音仅本机可播**；
  技术细节（HTTP 状态）只写进 SDK 日志，不打扰使用者；对端附件的气泡提示同样改为「对端图片/语音（本示例不接文件服务）」；
- README 能力表把附件一行改成"**本示例不接文件服务**，附件仅本机演示（可见/可播/可预览），不同步给对端"。

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
