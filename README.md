# tinode-harmony

Tinode 即时通讯协议的 **HarmonyOS NEXT 客户端 SDK**（纯 ArkTS/TypeScript）。

- MIT（[LICENSE](./LICENSE) · 上游归属见 [NOTICE](./NOTICE)）· 版本见 [VERSION](./VERSION) · 变更见 [CHANGELOG.md](./CHANGELOG.md)
- 测试：`npm test`（`node --test tests/*.test.mjs`，纯逻辑，不需要设备）
- 示例：[examples/harmony](./examples/harmony/README.md)（DevEco 工程）· [examples/node](./examples/node/README.md)（零依赖脚本）

## 能力

**能做什么**

- 连接 Tinode，断线自动重连；重连后自动重新订阅、补回断掉期间的消息
- 登录 / 注册：token、用户名密码、匿名；也能改密码、加凭据、改名片
- 收发消息：文本、富文本（加粗/斜体）、表情、图片、语音、文件、位置、引用
- 会话列表：名字、头像、未读、在线、最后在线、权限；已读、正在输入、撤回、历史分页
- 附件：校验、分块、进度、缓存淘汰（示例里只做本机演示，不上传服务端）
- 存储：可替换的存储端口 + 内存实现 + LRU 读缓存；消息去重、未读统计、会话摘要
- 入站帧守卫、出站帧体量上限、日志脱敏

**还没有**：群组、推送（要等 AGC 开通）、服务端侧多端同步、按关键词搜人。

<details>
<summary>详细能力与状态（含 API，点开看）</summary>

| 能力 | 主要 API | 状态 |
| --- | --- | --- |
| 连接 / `hi` 握手 / 服务端版本 | `ImSession.start` · `onServerVersion` | ✅ |
| 超时 / 指数退避重连（含抖动与上限）/ 代次守卫 / 双回调去重 | `ImSession.tick`（宿主喂时间） | ✅ |
| 登录：`token` / `basic`(base64) / `anonymous` / `none` | `loginScheme` · `configurePasswordLogin` | ✅ |
| 注册 `acc{user:"new"}` · 改密 · 加凭据 · 改名片 | `registerAccount` · `changePassword` · `addCredential` · `updatePublicName` | ✅ |
| 订阅 / 发布 / 历史分页 / 已读 / 正在输入 / 撤回 / 删除会话 | `subscribe` · `publish` · `history` · `setRead` · `setTyping` · `deleteMessages` | ✅ |
| 主题登记 + 断线自动重订阅 + `since` 补历史 | `TinodeTopics` · `knownTopics()` · `onTopicState` | ✅ |
| 会话列表（`meta.sub` / `meta.desc`）/ 显示名兜底 / 在线 / 最后在线 | `onTopics` · `profiles()` · `loadProfile` | ✅ |
| 权限模型（`Acs` / `Defacs`） | `acsAllows` · `parseAcs` · `acsSummary` | ✅ |
| 存储端口 / 内存实现 / LRU 读缓存 | `TinodeStorage` · `MemoryTinodeStorage` · `CachedTinodeStorage` | ✅ |
| 去重合并 / 未读 / 会话摘要 / 容量淘汰 | `mergeMessages` · `unreadOf` · `conversationSummaryOf` · `planMessageEviction` | ✅ |
| 富文本读写与渲染 | `parseDraftyJson` · `draftyWithStyle` · `draftyInsert` · `draftySegments` | ✅ |
| 附件校验 / 分块 / 进度 / 缓存键 | `validateAttachment` · `planChunks` · `planEviction` | ✅ |
| 附件平台 HTTP 上传 | `HarmonyAttachmentHttp` | ⚠️ 示例不接文件服务，未验证成功路径 |
| 系统 picker / 麦克风录音 / 语音播放 | 示例 `demo/DemoPickers.ets` | ✅ 真机验证 |
| 入站帧守卫 / 出站帧上限 / 日志脱敏 | `parseServerMessage` · `maxFrameBytes` · `redactTopic` | ✅ |
| 群组 / 推送 / 多端同步 / 模糊搜人 / HAR 打包 | — | ❌ 见 [TODO](#todo) |

</details>

## 安装

把 `src/` 拷进工程（如 `entry/src/main/ets/tinode/`），按文件类型选出口：

```ts
import { Tinode, ImSession } from '../tinode/Index.ts';   // 纯逻辑（.ts 侧）
import { TinodeSocket } from '../tinode/Socket.ets';      // 平台传输（.ets 侧）
```

> `.ts` 文件不能从 HAR/ArkTS 包导入，ArkTS 也不允许跨模块 `src/` 相对导入 —— 所以分两个出口。
> HAR 打包步骤见 [docs/getting-started.md](./docs/getting-started.md)。

## 快速开始

```ts
import { Tinode, defaultSessionConfig } from '../tinode/Index.ts';
import { TinodeSocket } from '../tinode/Socket.ets';

const url = 'wss://im.example.com:6061/v0/channels';
const config = defaultSessionConfig(url, '', 'MyApp/1.0', '');
config.loginScheme = 'none';                        // 先连上，再注册或登录
const tinode = new Tinode({
  transport: new TinodeSocket(url, 'YOUR_API_KEY'),
  config, storage: myStorage,                      // storage 不传则用内存实现
  hooks: { onState: () => {}, onTopics: () => {}, onMessage: () => {}, onFailure: () => {} }
});
tinode.start(Date.now());
setInterval(() => tinode.tick(Date.now()), 200);    // 时间由宿主驱动

const auth = await tinode.registerAccount('alice', 'pw123456', '爱丽丝');   // { uid, token }
tinode.subscribe('usrXXXXXX');
tinode.publish('usrXXXXXX', { txt: 'hi' }, { mime: 'text/x-drafty' });
```

更多见 [docs/getting-started.md](./docs/getting-started.md)、[docs/api.md](./docs/api.md)，或直接跑示例。

## 示例

1. DevEco Studio → `File → Open…` → 选 **`examples/harmony`**（不是仓库根目录）；真机运行按提示签名。
2. 页面里填 `wsUrl` 与 apikey（或写进 gitignored 的 `entry/src/main/resources/rawfile/im.local.json`）。
3. 点「连接」→「注册并登录」→ 进入会话列表。

- **真收发**（换账号也能看到）：文本、富文本、表情、引用、位置卡片、已读、正在输入、撤回、历史分页、会话列表、断线重连
- **本机演示**（不接文件服务）：图片（缩略图 + 全屏预览）、语音（按住说话 + 点击播放）、文件（卡片）
- **两个账号对聊**：`node examples/node/selfbootstrap.mjs` 注册第二个账号拿 `uid` → 在 App「新会话」填 `usrXXXXXX`

逐项操作清单见 [examples/harmony/README.md](./examples/harmony/README.md)。

## 使用要点

- **错误**：协议类失败不抛异常，走 `hooks.onFailure(text)`（有 id 的请求返回报文 id，未就绪/参数非法返回 `''`）；存储类失败交给 `Promise.catch`；传输类失败自动退避重连。
- **时间**：SDK 不起定时器，超时/重连都由宿主的 `tick(nowMs)` 驱动（推荐 200ms），所以协议与状态机可在 Node 上直接测。
- **安全**：凭据只由宿主注入，SDK 不落盘；日志脱敏（topic 截断、错误只留 code/message）；明文 `ws://` 默认告警，`new TinodeSocket(url, key, false)` 可拒绝。
- **提交前**：`bash scripts/check-no-secrets.sh` 检查将要提交的内容里是否含真实地址/密钥。详见 [docs/security.md](./docs/security.md)。

## 文档

[快速开始](./docs/getting-started.md) · [指向 Tinode 服务](./docs/configuration.md) · [API](./docs/api.md) ·
[架构](./docs/architecture.md) · [附件](./docs/attachments.md) · [存储](./docs/storage.md) ·
[安全](./docs/security.md) · [排错](./docs/troubleshooting.md) · [与 Android 对比](./docs/comparison-android.md) ·
[维护指南](./docs/MAINTAINING.md)（开新会话时的启动提示词）

## TODO

- [ ] 群组 `grp` · [ ] 推送 `set{deviceToken}`（需 AGC）
- [ ] 附件上传真机验证、断点续传 / 秒传 / 图片转码
- [ ] HAR 打包并空工程验证 · [ ] RDB 存储实现示例 · [ ] CI

## 许可

MIT（[LICENSE](./LICENSE)）。协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`；
本实现为**独立 ArkTS 重写**，归属说明见 [NOTICE](./NOTICE)。未使用 Tinode 服务端（GPLv3）源码。
