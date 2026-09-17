# 与 Android 版（官方 Java SDK + TinodeImClient）的对比

一句话：**Android 用的是 Tinode 官方 Java SDK（`tindroid`，功能全、自带主题生命周期与附件能力），
本 SDK 是一个"薄协议层 + 端口"的 ArkTS 重写** —— 只覆盖 P2P 文本/自定义消息所需的最小协议面，
存储、业务语义与附件都交给宿主。**两者定位不同，不是替代关系。**

## 1. 功能矩阵

| 能力 | Android（`TinodeImClient` + 官方 Java SDK） | 本 SDK（tinode-harmony） |
| --- | --- | --- |
| 连接 / `hi` 握手 | ✅（WebSocket，内置心跳探测） | ✅ `start/tick` + `hi`，**时间由宿主喂**，无内置心跳（`heartbeatMs=0`） |
| 登录 scheme | ✅ token（+ 官方 SDK 支持 basic/anonymous） | ✅ `token` / `basic` / `anonymous`（`loginScheme`） |
| 订阅 `sub`（desc/sub） | ✅ 由 SDK 的主题对象管理 | ✅ `subscribe(topic, withDesc, withSub, limit)` |
| 发文本 / 自定义 head | ✅ | ✅ `publish(topic, content, head)`（head 走 `mime` + `ld_*` 双键） |
| 历史分页 | ✅ `get{what:"history"}` + 订阅内联 `get` | ✅ 两者都有（服务端未开历史会 403，已登记） |
| 已读 `read` / 正在输入 `kp` | ✅ | ✅（note 报文，返回 `boolean`） |
| 送达 / 已读回执语义 | ✅ 官方 SDK 的 `recv/read` + 应用状态机 | ⚠️ 只提供 note 回调，**业务状态机在应用层**（宿主自己算 `✓/✓✓`） |
| 撤回 | ✅ 发撤回标记 + 本地占位 | ✅ `del{what:"msg"}` / 本地撤回标记（同口径，服务端不真删） |
| 删除 topic / 消息 | ✅ | ✅ `deleteTopic` / `deleteMessages` |
| **附件上传/下载** | ✅ 官方 SDK `file/upload` + `AttachFileApi` | ❌ **不在 SDK 内**（宿主自己调后端 `file/upload`；SDK 只搬运 Drafty 里的 ref） |
| **群组 `grp`** | ❌ Android 客户端也没做（源码里 0 处 group） | ❌ 有意留白（见 README） |
| **推送 `set{deviceToken}`** | 有协议侧能力（未接推送平台） | ❌ 已从公开面移除（`expires` 需平台 Push Kit 真值） |
| 多端同步 / 断线后再同步 | ✅ 官方 SDK 有 topic 与消息同步逻辑 | ❌ 只保证重连（`hi`+`login`），**重订阅由宿主负责** |
| Drafty | ✅ 官方 SDK 读+写、含格式化 | ⚠️ **读侧子集**（`txt/ent` + 10 类实体白名单；`fmt` 不消费）+ `encodeDrafty` 写回 |
| 消息内容类型（业务） | ✅ 文本/图片/语音/视频/文件/位置/分享/表情/引用 | ✅ 应用层已对齐（同一套 `kind`），但**语义不在 SDK 内** |
| 存储 | ✅ Room（DAO/实体在 app 里）+ 官方 SDK 的 `Storage` 接口 | ✅ **存储端口** `TinodeStorage`（默认内存实现，宿主可换 RDB） |
| 日志 | Android Log / 自建 | ✅ 日志端口 `setTinodeLogSink`（默认静默，**SDK 侧脱敏**） |
| 明文/加密 | OkHttp 默认 TLS | ✅ `wss` 优先；`ws://` 默认**告警**，`allowInsecure=false` 可拒绝 |
| 入站防御 | 由 Java SDK 处理 | ✅ 单帧上限 + `ctrl.code`/`data.seq` 类型校验，畸形帧直接丢弃 |
| 平台 | Android（Java/Kotlin + OkHttp） | HarmonyOS NEXT（ArkTS + `@kit.NetworkKit`）；其它平台实现 `ImTransport` 即可 |

**Android 独有、本 SDK 有意不做**：附件上传（`file/upload`）、群组、富文本 `fmt` 渲染、官方 SDK 的主题/消息自动同步。
**本 SDK 独有**：零依赖的纯逻辑层（可 `node --test` 直接测状态机）、三个可替换端口、日志脱敏、入站帧防御、明文策略可配。

## 2. 架构对比

| 维度 | Android | tinode-harmony |
| --- | --- | --- |
| 分层 | `TinodeImClient`（应用适配）→ 官方 Java SDK（连接/主题/存储/附件）→ OkHttp | `Tinode`（门面）→ `ImSession`（状态机）→ `TinodeWire`（报文纯函数）→ `ImTransport` 端口 |
| 时间驱动 | SDK 内部线程/定时器 | **宿主每 200ms 调 `tick(nowMs)`**（纯逻辑，可测） |
| 主题生命周期 | 官方 SDK 持有 topic、自动重订阅、`AlreadySubscribedException` 等 | 会话只跟踪"当前订阅请求"，**重订阅由宿主**（我们的 App 在 `ImService` 里记 `subscribed`） |
| 存储 | Room（app 内 DAO）+ 官方 `Storage` | `TinodeStorage` 端口（消息/会话/草稿），默认内存 |
| 并发/换代 | 官方 SDK 内部同步 | `generation` 代次守卫：切号/重连后丢弃迟到回调；断线 `error`+`close` 去重 |
| 失败模型 | 异常 + 回调混杂 | 统一：`onFailure(text)` + 有 id 的请求返回报文 id（未就绪/非法返回 `''`），note/leave 返回 `boolean` |
| 消息模型 | 官方 SDK 模型 + `ImMessageContent` sealed class | 线路级 `TinodeMessage`/`TinodeTopic`；**业务语义留在应用层**（我们的 App 有 `kind`/`ImActions` 等） |
| 接入形态 | Gradle 依赖 | 源码目录或 HAR；`.ts`/`.ets` 双出口（实测约束见 README） |

## 3. 为什么这样设计

1. **可测**：协议与状态机全是纯逻辑（时间从外面喂），所以能在主机上用假 transport 跑 45 个用例，不需要设备；
2. **可替换**：传输/存储/日志三个端口，换平台或换数据库不改 SDK；
3. **不猜业务**：SDK 只保证"协议与生命周期正确"，`✓/✓✓`、未读、置顶、草稿策略这些**业务语义**由宿主决定（我们的鸿蒙 App 就是在应用层对齐 Android 的那套语义）；
4. **不复制上游**：独立 ArkTS 重写，只参考协议文档与 Apache-2.0 的 Java SDK 行为（见 NOTICE）。

## 4. 适用 / 不适用

- **适用**：需要在 HarmonyOS 上做 P2P 文本/自定义消息、自己掌控存储与 UI、希望协议层可单测的项目；
- **不适用**：需要群组、附件上传、Rich Text 渲染、开箱即用的多端同步 —— 这些要么自己实现（端口都留好了），要么等项目补（见 roadmap）。

## 5. Roadmap（与 Android 的差距补齐顺序）

1. 附件：把 `file/upload` + 下载/缓存做成可选模块（或文档化"宿主负责"的最佳实践）；
2. 群组：`grp` 主题与成员（协议面 + 权限）；
3. 推送：`set{what:"deviceToken"}`（等平台 Push Kit 真值 + AGC 开通）；
4. 断线后再同步：把"重订阅 + 补历史"从宿主收回 SDK（可选开关）；
5. 富文本：`fmt` 的偏移语义与渲染（Android 自己在两条路径上不一致，需要样本对齐）。

> 对比用到的两边源码：Android 见 `android/app/src/main/java/com/otq/leakdetector/data/repository/TinodeImClient.kt`
> 与 vendored `android/libs/tindroid/tinodesdk`；本 SDK 见 `src/`（行号在评审文档里）。

---

## 6. 更正与更直白的差距说明（2026-09-17 补充）

上面第 1 节按"能力"对齐容易让人误读，这里把话说直白：**必须分两层看**。

### 6.1 两个不同的比较对象

| 层 | 安卓那边是什么 | 我们这边是什么 | 对齐情况 |
| --- | --- | --- | --- |
| **App 层**（界面与交互：附件面板、各类气泡、转发、搜索、设置、分享…） | `android/app/.../ui/screens/message` | `harmony/entry/src/main/ets/im` + `pages/ChatPage.ets` | ✅ **已逐项对齐**（16 条缺口清单全部完成，见宿主仓 `docs/16`/`docs/27`） |
| **SDK 层**（协议客户端能力） | 官方 Java SDK `tindroid`（**64 个类**） | 本 SDK（**11 个源文件**） | ❌ **没有对齐**（见 6.2） |

也就是说：**"功能对齐"这件事，之前做的是 App 层**；SDK 层是**刻意做薄**的协议层，不是官方 SDK 的对等替代品。

### 6.2 SDK 层的能力差距（按官方 Java SDK 的类清单核对）

| 能力 | 官方 Java SDK | tinode-harmony | 差距 |
| --- | --- | --- | --- |
| 账号（`MsgClientAcc`、`Credential`、`AuthScheme`） | ✅ | ❌ | 大 |
| 主题生命周期（`Topic`/`MeTopic`/`FndTopic`/`ComTopic`、`MsgSetMeta`/`Sub`/`Desc`、自动重订阅、`NotSynchronizedException` 再同步） | ✅ | ❌（只发 `sub` 请求；重订阅由宿主） | **最大** |
| 附件（`LargeFileHelper`：上传/下载/大文件分片） | ✅ | ❌ | 大 |
| 推送（`MsgClientSet` + `setDeviceToken`） | ✅ | ❌（已移除） | 中 |
| 本地存储/缓存与同步（`Storage`/`LocalData`） | ✅ | ⚠️ 只有端口，无缓存策略 | 中 |
| 用户资料与权限（`User`/`Acs`/`Defacs`/`LastSeen`） | ✅ | ❌ | 中 |
| 群组（通过 `ComTopic` + meta） | ✅ **SDK 支持** | ❌ | 大（但我们与安卓 App 都不用） |
| Drafty | ✅ 读+写+格式化 | ⚠️ 读侧子集（`fmt` 不消费） | 中 |
| presence/在线状态 | ✅ 模型化 | ⚠️ 只透传 `pres` 回调 | 小 |
| 异步/重试框架（`PromisedReply`/`ExpBackoff`） | ✅ | ⚠️ 只有退避计算 | 小 |

> 更正一处早期说法：官方 Java SDK **是支持群组和附件的**（`ComTopic` + `LargeFileHelper`）；"安卓客户端不做群组"指的是**安卓 App 没用到**这个能力，而不是 SDK 没有。

### 6.3 补齐到"对等"的路线与量级（估算，供决策）

| 阶段 | 内容 | 量级 |
| --- | --- | --- |
| P1 | ✅ **已完成**（2026-09-17）：`TinodeTopics` + 自动重订阅 + `since` 补历史 + `knownTopics/topicState/onTopicState`，可关 | 已交付 |
| P2 | ✅ **已完成（可选模块）**：纯逻辑 `TinodeAttachment.ts`（校验/分块/进度/缓存/LRU/Drafty 互转）+ 平台 `TinodeAttachmentHttp.ets`（**未真机验证**）；断点续传/秒传/转码仍缺 | 已交付 |
| P3 | 🟡 **P3-min 已完成**（2026-09-17）：`acc{user:"new"}` 注册 + `login`（token/basic/anonymous/none）+ `onAuth(uid, token)`；`Credential`/`AuthScheme` 的多凭据管理与 `acc` 更新面仍缺 | 部分交付 |
| P4 | ✅ **已完成（策略 + 装饰器）**：`TinodeStore.ts`（去重合并/未读/摘要/淘汰/草稿预览）+ `CachedTinodeStorage`（LRU 读缓存，写操作失效）；RDB/文件实现仍由宿主提供 | 已交付 |
| P5 | 🟡 **P5-min 已完成**（2026-09-17）：`meta.sub[]` → `TinodeProfile`（名字/头像/位点/在线/最后活动）+ `me` 自动订阅 + `onTopics`/`profileOf()` + 显示名三级兜底；`fnd` 搜人、`Acs`/`Defacs` 权限模型仍缺 | 部分交付 |
| P6 | ✅ **已完成**（2026-09-17）：写侧（构造/样式/实体/插入删除位移/截断）+ 渲染模型 `draftySegments`；偏移统一 UTF-16 code unit（与上游解析路径一致） | 已交付 |
| P7 | **群组**（`grp` + 成员/权限） | 大（2–3 批） |
| P8 | **推送**（等平台 Push Kit 真值 + AGC） | 小（受外部条件阻塞） |

**结论（坦白说）**：现在的 SDK 只够"P2P 文本/自定义消息 + 宿主自管存储"这种用法；
要对等官方 Java SDK，需要按上面 P1–P7 补齐 —— **这是个明确的工程量，不是几处补丁。**
