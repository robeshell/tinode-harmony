# 安全与凭据

## 1. 绝不要把真实服务地址与密钥提交进仓库

- 仓库里只有**占位符**：`wss://im.example.com:6061/v0/channels`、`YOUR_API_KEY`、`YOUR_LOGIN_TOKEN`；
- 本地真实配置放**被忽略的文件**：
  - HarmonyOS：`entry/src/main/resources/rawfile/im.local.json`（`.gitignore` 已含，仓库给 `im.local.json.example`）；
  - Node 示例：`examples/node/config.local.json` 或环境变量（`.gitignore` 已含 `*.local.json` / `.env`）；
- 我们的宿主 App 也是这个约定：apikey 只存在本地 `im.local.json`，**不入库**。

**提交前自检**（示例）：

```bash
git diff --cached | grep -nEi "apikey|token|192\.168\.|10\.[0-9]+\.|smartmeter\.vip|-----BEGIN"
```

## 2. SDK 自己怎么处理凭据

| 项 | 行为 |
| --- | --- |
| apikey | 由宿主注入（`TinodeSocket(url, apiKey)`）；为空则**不发送**该头，不内置默认值 |
| token | 由宿主注入（`config.token`）；SDK **不落盘**、不打日志 |
| 日志 | 统一走日志端口；`redactTopic()` 把 topic 截断成 `usrD7D…(14)`；`redactError()` 只保留 `code`/`message` |
| 错误文案 | `onFailure` 给的是**用户可读中文**（如「消息服务未连接」），不含服务端原文与凭据 |

## 3. 传输安全

- 优先 **`wss://`**；`ws://` 明文时 SDK **默认放行但告警**（内网常见），可用
  `new TinodeSocket(url, apiKey, false)` **拒绝**明文；
- HarmonyOS 的 WebSocket 由系统栈做 TLS 校验，SDK **没有**"跳过证书校验"这类开关（也不提供）。

## 4. 入站数据

- 单帧超过 `maxFrameBytes`（默认 1 MB 入站 / 256 KB 出站）→ **直接丢弃**；
- `ctrl.code`、`data.seq` 类型不对 → 丢弃（不让脏数据进状态机）；
- 非文本 WebSocket 帧 → 忽略并记一条日志（Tinode 下行是文本帧）。

## 5. 权限与合规

- 只申请 `ohos.permission.INTERNET`（示例工程可见）；
- 消息正文与附件由宿主处理（本 SDK 不做附件上传/下载），落库与留存策略由宿主按自身合规要求决定。
