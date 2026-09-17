# 把 SDK 指向 Tinode 服务

这一页回答："我的 Tinode 在哪、SDK 怎么连上去、apikey 和 token 从哪来"。

## 1. 三个必填/可选参数

| 参数 | 形态 | 说明 |
| --- | --- | --- |
| `wsUrl` | `wss://host:port/v0/channels` | Tinode 的 **WebSocket 端点**。路径固定 `/v0/channels`；`ws://` 明文、`wss://` TLS |
| `apiKey` | 字符串（可空） | 服务端要求的 `X-Tinode-APIKey`。**没有就留空**（很多自建部署不校验） |
| `token` | 字符串（可空，见 scheme） | 登录凭据。通常由**你自己的后端**签发（见 §3） |
| `loginScheme` | `token`（默认）/ `basic` / `anonymous` | `token`：token 作为 secret；`basic`：secret 写 `user:password`；`anonymous`：公开服务自测，不需要 token |
| `topic` | `usrXXXXXX`（P2P）/ `grpXXXXXX`（群） | 要订阅/发消息的目标会话 |

> **地址从哪来**：本 SDK 不猜地址。宿主工程约定是"**后端下发**"（我们自己的 App 就是调
> `GET device/app/im/token` 拿到 `wsUrl` + Tinode `token`，客户端不写死地址）；自建/自测时也可以直接填。

## 2. apikey 怎么传

| 平台 | 传法 | 原因 |
| --- | --- | --- |
| HarmonyOS / 原生（`TinodeSocket`） | 请求头 `X-Tinode-APIKey` | WebSocket 客户端可自定义头 |
| 浏览器 / Node 内置 WebSocket | 查询参数 `?apikey=xxx` | WHATWG `WebSocket` 不能自定义头；官方 JS SDK 同样做法（`examples/node/transport.mjs` 用的就是这个） |

两者服务端都认；**不要同时用**。

## 3. token 从哪来（我们自己的部署）

我们这条链路是：**业务后端换 Tinode 凭据**——客户端带自己的会话 token 调
`GET {baseUrl}/device/app/im/token`（见宿主仓 `contracts/business/im.protocol.json`），响应里给
`wsUrl`（Tinode 端点）+ `token`（Tinode 登录 token）；客户端用 `scheme: "token"` 登录。

自建 Tinode 时，也可以：
- 用 `scheme: "basic"`，secret 写 `用户名:密码`（方便自测，**生产不建议**把密码放客户端）；
- 或在自己的后端用 Tinode 的 `/auth` 换 token 后再下发（推荐，token 可过期/可吊销）。

## 4. 明文还是 TLS

- **`wss://`（推荐）**：凭据（apikey、token）都在 TLS 里。
- **`ws://`**：SDK **默认放行但打印告警**（内网部署常用）。要强制禁止：
  `new TinodeSocket(url, apiKey, false)` —— 这时明文连接会直接回调
  `onError('已禁止明文连接（allowInsecure=false），请改用 wss://')`。

## 5. 自建 Tinode 服务的要点

1. 服务端 `max_message_size` 决定单帧上限：SDK 默认 `maxFrameBytes = 256 KB`（超限**不发**并回调 `onFailure`），
   可按服务端配置调大/调小；
2. 若服务端要求 apikey：在服务端配置里拿到 key，通过上面的头/查询参数传；
3. 首次连接流程是 `hi` → `login` → `sub`；`sub` 必须**先于** `pub`（Tinode 会回 409），
   SDK 的 `subscribe` 内部已处理；
4. 历史消息：`get{what:"history"}` 需要服务端授权，未开放时会回 **403**（我们自己的部署就是这种，
   宿主因此只用订阅内联的 `get{what:"desc sub", data:{limit:N}}` 拿最近若干条）。

## 6. 自检清单（连不上时按这个顺序看）

1. `wsUrl` 是否是**完整的** `wss://host:port/v0/channels`（少了 `/v0/channels` 会连不上）；
2. apikey 是否**必需**且填对（缺了通常回 **403**）；
3. token 是否过期/是否属于这个服务（换过账号会看到 `UID mismatch`）；
4. 明文连接是否被服务端/网关拒绝（用 `wss://` 试）；
5. 是不是把 SDK 的 `wsUrl` 与业务后端的 `baseUrl` 搞混了（前者是 Tinode，后者是你的 API）。
