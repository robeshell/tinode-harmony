# tinode-harmony

Tinode 即时通讯协议的 **HarmonyOS NEXT 客户端 SDK**（纯 ArkTS/TypeScript）。
本仓库是 SDK 的独立仓库：源码、测试、示例、文档都在这里。

- 许可：**MIT**（[LICENSE](./LICENSE)；上游归属见 [NOTICE](./NOTICE)）
- 版本：[VERSION](./VERSION) · 变更：[CHANGELOG.md](./CHANGELOG.md)
- 测试：`npm test`（`node --test tests/*.test.mjs`，纯逻辑，不需要设备）
- 示例：[examples/harmony](./examples/harmony/README.md)（DevEco 工程）· [examples/node](./examples/node/README.md)（零依赖）

## 能力

| 能力 | 主要 API | 状态 |
| --- | --- | --- |
| 连接 / `hi` 握手 / 服务端版本 | `ImSession.start` · `onServerVersion` | ✅ |
| 超时 / 指数退避重连（含抖动与上限）/ 代次守卫 / 双回调去重 | `ImSession.tick`（宿主喂时间） | ✅ |
| 登录：`token` / `basic`(base64) / `anonymous` / `none` | `loginScheme` · `configurePasswordLogin` | ✅ |
| 注册账号 `acc{user:"new"}` · 改密 · 加凭据 · 改名片 | `registerAccount` · `changePassword` · `addCredential` · `updatePublicName` | ✅ |
| 订阅 / 发布 / 历史分页 / 已读 / 正在输入 / 撤回 / 删除会话 | `subscribe` · `publish` · `history` · `setRead` · `setTyping` · `deleteMessages` | ✅ |
| 主题登记 + 断线自动重订阅 + `since` 补历史 | `TinodeTopics` · `knownTopics()` · `onTopicState` · `autoResubscribe` | ✅ |
| 会话列表（`meta.sub` / `meta.desc`）/ 显示名三级兜底 / 在线 / 最后在线 | `onTopics` · `profiles()` · `loadProfile` · `loadSubscriptions` | ✅ |
| 权限模型（`Acs` / `Defacs`） | `acsAllows` · `parseAcs` · `parseDefacs` · `acsSummary` | ✅ |
| 存储端口 + 内存实现 + LRU 读缓存 | `TinodeStorage` · `MemoryTinodeStorage` · `CachedTinodeStorage` | ✅ |
| 去重合并 / 未读 / 会话摘要 / 容量淘汰 / 草稿预览 | `mergeMessages` · `unreadOf` · `conversationSummaryOf` · `planMessageEviction` | ✅ |
| 富文本 Drafty：读侧、写侧（样式/实体/插入删除位移）、渲染片段 | `parseDraftyJson` · `draftyWithStyle` · `draftyInsert` · `draftySegments` | ✅ |
| 附件：校验 / 分块 / 进度 / 缓存键 / LRU 淘汰 | `validateAttachment` · `planChunks` · `planEviction` | ✅ |
| 附件：平台 HTTP 上传/下载 | `HarmonyAttachmentHttp` | ⚠️ **本示例不接文件服务**：附件（图片/语音/文件）**仅本机演示**（可见 / 可播 / 可预览），不同步给对端；该实现未验证成功路径 |
| 系统 picker（图片 / 文件） | `examples/harmony` 的 `demo/DemoPickers.ets` | ✅ 真机验证（选择后复制进沙箱，图片消息**在聊天里渲染缩略图**） |
| 麦克风录音（按住说话） | `examples/harmony` 的 `DemoVoiceRecorder` + `ohos.permission.MICROPHONE` | ✅ 真机验证（授权弹窗 + 录到 PCM，例：1494 ms / 43520 B） |
| 语音播放 | `wavFromPcm`（SDK）+ `DemoVoicePlayer`（AVPlayer） | ✅ 真机验证（点气泡播放：▶ → ⏸「正在播放语音…」 → 播放结束复位） |
| 图片全屏预览 / 文件·位置提示 | `examples/harmony` 的气泡点击 | 🟡 已实现（图片预览点任意处关闭；文件与位置给出可读提示），未逐项截图核对 |
| 入站帧体量守卫 + 字段类型校验 / 出站帧守卫 / 日志脱敏 | `parseServerMessage` · `maxFrameBytes` · `redactTopic` | ✅ |
| 群组（`grp`） | — | ❌ TODO |
| 推送（`set{deviceToken}`） | — | ❌ TODO（依赖 AGC 开通） |
| 多端同步 / 断线后再同步（服务端侧） | — | ❌ TODO |
| 模糊搜人（按关键词） | — | ❌ 不在 Tinode WS 协议内，需要服务端 REST 或自有目录 |
| HAR 打包 | — | ⚠️ 文档有步骤，未实测 |

偏移语义、错误模型等细节见 [docs/](./docs/)（[索引](#文档)）。

## 安装

**方式 A：源码目录**（`.ts` / `.ets` 混合工程）

把 `src/` 拷进工程（如 `entry/src/main/ets/tinode/`），然后：

```ts
import { Tinode, ImSession } from '../tinode/Index.ts';   // 纯逻辑（.ts 侧可导入）
import { TinodeSocket } from '../tinode/Socket.ets';      // 平台传输（.ets 侧）
```

**方式 B：HAR**（`.ets`-only 或 ohpm）

按 [oh-package.json5](./oh-package.json5) 建 HAR 模块（`main: Index.ets`、`harTasks`、`apiType: stageMode`、`module.json5` 里 `type: "har"`），
`hvigorw assembleHar` 后用 `"tinode-harmony": "file:../tinode-harmony"` 引入。

> 实测约束：`.ts` 文件不能从 HAR/ArkTS 包导入，ArkTS 也不允许跨模块 `src/` 相对导入 —— 所以分 `Index.ts` / `Socket.ets` 两个出口。

## 快速开始

```ts
import { Tinode, ImSessionState, defaultSessionConfig, TinodeStorage } from '../tinode/Index.ts';
import { TinodeSocket } from '../tinode/Socket.ets';

// 1) 连接（none：先连上，再注册或登录）
const sessionConfig = defaultSessionConfig('wss://im.example.com:6061/v0/channels', '', 'MyApp/1.0', '');
sessionConfig.loginScheme = 'none';
const tinode = new Tinode({
  transport: new TinodeSocket('wss://im.example.com:6061/v0/channels', 'YOUR_API_KEY'),
  config: sessionConfig,
  storage: myStorage,                                  // 不传则用内存实现
  hooks: {
    onState: (state: ImSessionState) => {},
    onTopics: (topics) => { /* 会话列表 */ },
    onMessage: (message) => { /* 已落库的消息 */ },
    onFailure: (text) => { /* 用户可读失败原因 */ }
  }
});
tinode.start(Date.now());
setInterval(() => tinode.tick(Date.now()), 200);       // 时间由宿主驱动

// 2) 注册（服务端签发 token）或密码登录
const auth = await tinode.registerAccount('alice', 'pw123456', '爱丽丝');   // { uid, token }
// tinode.configurePasswordLogin('alice', 'pw123456'); tinode.start(Date.now());

// 3) 收发
tinode.subscribe('usrXXXXXX');
tinode.publish('usrXXXXXX', { txt: 'hi' }, { mime: 'text/x-drafty' });
tinode.setRead('usrXXXXXX', 12);
```

完整可运行示例见 [examples/harmony](./examples/harmony/README.md)（DevEco 打开即用）与 [examples/node](./examples/node/README.md)（`node examples/node/selfbootstrap.mjs` 注册→登录→会话列表）。

## Demo 体验指引

三步跑起来：

1. **打开工程**：DevEco Studio → `File → Open…` → 选 **`examples/harmony`**（⚠️ 不是仓库根目录）；首次真机运行按提示做「自动签名」。
2. **填服务地址**：页面里填 `wsUrl` 与 apikey，或把它们写进 `entry/src/main/resources/rawfile/im.local.json`（该文件已 gitignore，仓库只给 `.example`）。
3. **连接并登录**：点「连接」→「注册并登录」（新用户名即可）→ 自动进入会话列表。

体验清单（**真收发** = 走 Tinode 消息、换一个账号也能看到；**本机演示** = 只在当前设备可见/可播，本示例不接文件服务）：

| 想试什么 | 怎么点 | 现象 | 类型 |
| --- | --- | --- | --- |
| 文本 / 富文本 | 输入框输入 → `B` / `I` → 发送 | 气泡按加粗/斜体渲染 | 真收发 |
| 表情 | 输入栏 😊 → 表情网格 → 点一下插入 → 发送 | 表情面板 + 消息气泡 | 真收发 |
| 引用 / 位置 | 加号 → 引用末条 / 位置 | 引用气泡 / **位置卡片**（浅蓝地图区 + 定位图标 + 地址与坐标） | 真收发 |
| 已读 / 正在输入 / 撤回 | 顶部「已读」；加号 → 「撤回末条」 | 位点推进、`del` 报文发出 | 真收发 |
| 历史分页 | 顶部「更早」 | 向前翻页加载 | 真收发 |
| 会话列表 | 登录后自动进入 | 头像 / 名字 / 未读 / 在线 / 最后在线 / 权限摘要 | 真收发 |
| 断线重连 | 关掉网络再打开，或断开再连 | 状态自动恢复、重连后自动重订阅 | 真收发 |
| **图片** | 加号 → 图片 → 选图 → 完成 | 气泡里显示**缩略图**，点击**全屏预览** | 本机演示 |
| **语音** | 切到 🎤 → 按住说话 → 松开 | 气泡 `▶ 1"`，点击**播放**（再点停止） | 本机演示 |
| **文件** | 加号 → 文件 → 选文件 | 文件卡（名 + 大小），点击给出提示 | 本机演示 |
| 自动滚到底部 | 发消息 / 收到消息 / 打开会话 | 列表自动滚到最新一条 | — |
| 能力清单 | 会话列表页「能力」 | 分组卡片：能力 / API / 源码位置 / ✅⚠️❌ | — |

**两个账号对聊**：`node examples/node/selfbootstrap.mjs` 可注册第二个账号（脚本会打印 `uid`），
然后在 App 的「新会话」输入框填对方的 `usrXXXXXX` → 打开 → 互发消息。

> 附件（图片/语音/文件）**只在本机演示**：图片可见可预览、语音可播、文件显示卡片；消息本身会发出去，但**文件内容不同步给对端**（本示例不接文件服务）。

## 错误模型

1. **协议类失败**（未连接、超帧、服务端 4xx/5xx）→ 不抛异常：`hooks.onFailure(text)`；有 id 的请求返回报文 id，未就绪/参数非法返回 `''`；note/leave 返回 `boolean`。
2. **存储类失败** → 不吞，交给 `Promise.catch`。
3. **传输类失败** → 会话转 `idle`，按指数退避重连；一次断线的 `error`+`close` 只算一次。
4. **畸形/超大入站帧** → 直接丢弃（体量上限 + `ctrl.code`/`data.seq` 类型校验）。

## 安全

- 凭据（apikey / token）**只由宿主注入**，SDK 不落盘、不打日志；日志里 topic 会截断（`usrD7D…(14)`），错误只保留 `code`/`message`。
- 明文 `ws://`：默认**告警放行**；`new TinodeSocket(url, apiKey, false)` 可拒绝。
- 仓库内所有示例只用占位符（`wss://im.example.com:6061/v0/channels` / `YOUR_API_KEY`）；真实配置放本地忽略文件（`im.local.json` / `config.local.json` / 环境变量）：
  `bash scripts/check-no-secrets.sh` 检查**将要提交的内容**里是否含真实地址/密钥。

## 时间与线程

SDK 自己**不起定时器**：超时、重连、心跳都由宿主调用 `tick(nowMs)` 驱动（推荐 200 ms）。
因此协议与状态机全是纯逻辑，可在 Node 上直接测试（当前 90+ 例）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/getting-started.md](./docs/getting-started.md) | 四种接入方式、最小接线 |
| [docs/configuration.md](./docs/configuration.md) | **把 SDK 指向 Tinode 服务**：wsUrl / apikey / token 来源 / scheme / 明文与 TLS / 自检清单 |
| [docs/api.md](./docs/api.md) | 逐方法签名、返回与失败口径 |
| [docs/architecture.md](./docs/architecture.md) | 分层、状态机、三个端口、两种门面模式 |
| [docs/attachments.md](./docs/attachments.md) | 附件：Tinode 原生 `file/u` 与自建后端两种接法 |
| [docs/storage.md](./docs/storage.md) | 存储端口、缓存策略、推荐组合 |
| [docs/security.md](./docs/security.md) | 凭据处理与提交前自检 |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | 403 / UID mismatch / 退避 / 脱敏等 |
| [docs/comparison-android.md](./docs/comparison-android.md) | 与官方 Java SDK（`tindroid`）的功能与架构对比、差距补齐路线 |

## TODO

- [ ] 群组 `grp`（订阅/成员/权限，对应 P7）
- [ ] 推送 `set{what:"deviceToken"}`（需 AGC 开通与 Push Kit 真值，对应 P8）
- [ ] 附件平台 HTTP 的真机验证；断点续传 / 秒传 / 图片转码
- [ ] HAR 实际打包并在空工程验证
- [ ] RDB 存储实现示例（当前只有内存实现与缓存装饰器）
- [ ] 断线后再同步（服务端侧）与多端同步
- [ ] CI（跑 `npm test` + 许可头检查）

## 许可与归属

MIT（[LICENSE](./LICENSE)）。协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`；
本实现为**独立 ArkTS 重写**，归属与许可说明见 [NOTICE](./NOTICE)。未使用 Tinode 服务端（GPLv3）源码。
