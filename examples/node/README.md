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

## 自举：注册账号 → 登录 → 看会话列表

不需要自建后端也能跑（Tinode 服务端直接支持 `acc{user:"new"}`）：

```bash
export TINODE_WS_URL='wss://im.example.com:6061/v0/channels'
export TINODE_API_KEY='YOUR_API_KEY'
export TINODE_NEW_USER="demo$(date +%s)"
export TINODE_NEW_PASSWORD='pw123456'
node examples/node/selfbootstrap.mjs
```

## 群组端到端自检（P7）

在一个**真实服务端**上跑完「建群 → 成员 → 权限 → 移出 → 清理」，用的是 SDK 门面
（`createGroup` / `members` / `inviteMember` / `updateGroupDefacs` / `removeMember` / `groupInfo`）：

```bash
export TINODE_WS_URL='wss://im.example.com:6061/v0/channels'
export TINODE_API_KEY='YOUR_API_KEY'
export TINODE_NEW_USER="grpcheck$(date +%s)"   # 群主：脚本自己注册的一次性账号
export TINODE_NEW_PASSWORD='pw123456'
export TINODE_PEER_USER='peeraccount'          # 被邀请的人：一个**已存在**账号（basic 登录）
export TINODE_PEER_PASSWORD='peerpassword'
node examples/node/group-check.mjs
```

退出码 0 = 全部检查通过。它会核对：建群应答里服务端给的**真名**（`new…` → `grp…`，这是 Tinode 的建群语义）、
建群应答里的 `ctrl.params.acs`、成员列表、被邀请人的权限、默认权限改动、移出成员，
并在结束时**软删**这个自检群（账号与群会在服务端留下痕迹，见脚本头部注释）。

> 幂等写要留意：把**相同的** `set{desc:{defacs}}` 再发一次，Tinode 回 **304 Not Modified** ——
> 门面把它当成功（`ctrlAccepted`），这正是一条只能靠真实服务端发现的规则。

## 注意

- **不要把真实服务地址与密钥提交进仓库**：本目录只提供 `config.example.json` 占位符；
  真实值走环境变量或 `config.local.json`（已忽略）。
- 浏览器/Node 的内置 WebSocket 不能自定义请求头，所以 apikey 走查询参数 `?apikey=…`（Tinode 支持，官方 JS SDK 同样做法）。
  HarmonyOS 端（`TinodeSocket`）用的是请求头 `X-Tinode-APIKey`。
- 默认只打印**脱敏**后的端点；`TINODE_VERBOSE=1` 可打印全量。
