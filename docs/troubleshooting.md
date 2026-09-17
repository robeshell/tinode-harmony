# 排错

按现象查：

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 连不上、状态停在 `connecting` | `wsUrl` 不完整（漏了 `/v0/channels`）、端口/网关、明文被拒 | 用 `examples/node` 先验证地址；必要时改 `wss://` |
| `onFailure: 消息服务连接出错，请检查网络后重试` | 网络/网关抖动 | 会按退避自动重连；连续失败看 §"退避" |
| 连上后 `403` | apikey 缺失/不对（服务端要求时）；或历史 `get` 未授权 | 补 `X-Tinode-APIKey`（或 `?apikey=`）；历史上限用订阅内联 `get{desc sub,limit}` |
| `UID mismatch` → `failed` | 服务端返回的 uid 与当前登录账号不一致（换号/换 token） | SDK 会**停止重连**并报错；重新取凭据后再 `start()` |
| `缺少消息服务凭据` | `token` 为空且 scheme 不是 `anonymous` | 补 token，或临时用 `loginScheme: 'anonymous'`（仅自测） |
| 登录后立刻断、反复重连 | 退避与抖动；弱网 | 正常行为。封顶 `maxBackoffMs`（默认 60s）；稳定 5s 后计数清零 |
| 发消息没反应 | 未 `ready`、超帧、或 `sendPub` 在未就绪时被拒 | 看 `onFailure`；`maxFrameBytes` 默认 256 KB（出站） |
| 收到的消息少 / 没有历史 | 服务端未开历史，或只订阅了 `desc sub` 的最近 N 条 | 用 `history(topic, beforeSeq, limit)`（可能 403） |
| 明文告警 `明文 ws:// 连接：凭据将不经 TLS 传输` | 用了 `ws://` | 换 `wss://`，或 `allowInsecure=false` 直接拒绝 |
| 日志里 topic 变成 `usrD7D…(14)` | SDK 脱敏 | 预期行为；需要原文请在自己的日志层记录 |

## 定位手段

1. 打开日志端口：

```ts
setTinodeLogSink({ detail: (topic, message, level) => console.log(topic, message), failure: (t, e) => console.warn(t, e) });
```

2. SDK 会打的关键行（示例）：
   - `[im/service-endpoint] endpoint=…`（**只到 host:port/path**，不带 query/token）；
   - `[im/pub] id=… topic=… state=ready`（出站报文）；
   - `[im/ctrl] id=… code=…`（应答；`code=202` 且带 `seq` 才算落库成功）。

3. 状态机视角：`connecting → handshake → login → ready`；卡在哪一段就查那一段的输入（地址/apikey/token）。

## 什么时候该怀疑 SDK

- 状态机没有回调、退避不触发 → 先确认宿主**每 200ms 调了 `tick(Date.now())`**（SDK 不起定时器）；
- 真机与 Node 行为不一致 → 注意 Node 用 `?apikey=`、HarmonyOS 用请求头，两者服务端都应支持。
