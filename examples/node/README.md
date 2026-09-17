# Node 示例（零依赖）

用 Node 22+ 内置的 `WebSocket` 直接跑 SDK 的**纯逻辑**部分：连上 Tinode → 握手 → 登录 → 订阅/发消息。
不需要 HarmonyOS 设备，适合先验证「服务地址 / apikey / token」是否配对。

```bash
export TINODE_WS_URL='wss://im.example.com:6061/v0/channels'
export TINODE_API_KEY='YOUR_API_KEY'      # 没有就留空
export TINODE_TOKEN='YOUR_LOGIN_TOKEN'    # 由你自己的后端签发；没有则只到握手
export TINODE_TOPIC=''                    # 想试订阅+发消息就填 usrXXXXXX
node examples/node/connect.mjs
```

也可以把同样四个键写进 **`examples/node/config.local.json`**（**已 gitignore，不要提交**）：

```bash
cp examples/node/config.example.json examples/node/config.local.json
```

## 注意

- **不要把真实服务地址与密钥提交进仓库**：本目录只提供 `config.example.json` 占位符；
  真实值走环境变量或 `config.local.json`（已忽略）。
- 浏览器/Node 的内置 WebSocket 不能自定义请求头，所以 apikey 走查询参数 `?apikey=…`（Tinode 支持，官方 JS SDK 同样做法）。
  HarmonyOS 端（`TinodeSocket`）用的是请求头 `X-Tinode-APIKey`。
- 默认只打印**脱敏**后的端点；`TINODE_VERBOSE=1` 可打印全量。
