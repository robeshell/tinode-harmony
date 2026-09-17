# 维护指南（给人和 AI 协作用）

> 这份文件是**开新会话时的启动说明**：把「开场提示词」整段复制给 AI，它就能在没有上下文的情况下接手这个仓库。

## 开场提示词（复制这段）

```
你负责维护 tinode-harmony —— 一个 Tinode 协议的 HarmonyOS NEXT 客户端 SDK（ArkTS），MIT 开源。

仓库：/Volumes/LexarE300/Code/tinode-harmony（= GitHub robeshell/tinode-harmony，public）
宿主仓的 vendored 副本：/Volumes/LexarE300/Code/leakdetector-next/harmony/entry/src/main/ets/tinode（改这里要同步两处，保持内容一致）

先读：README.md（能力与 TODO）、CHANGELOG.md（最近改了什么）、docs/（9 篇：getting-started / configuration / api /
architecture / attachments / storage / security / troubleshooting / comparison-android）。

工作方式：
1. 纯逻辑先写、先测（tests/*.test.mjs，node --test 跑；接口类型要用 `import type`，否则 node 类型擦除会报错），再接平台层/界面；
2. 每批收口前必须跑：
   - 独立仓：node --test tests/*.test.mjs  （当前 94 例）
   - 宿主仓：node --test harmony/tests/*.test.mjs、assembleHap 0 ERROR、tools/check-sdk-hygiene.py、tools/check-evidence.py
   - 示例工程：examples/harmony 里 hvigorw assembleHap 0 ERROR
   - 推送前：bash scripts/check-no-secrets.sh（绝不提交真实服务地址与密钥）
3. 改完更新 CHANGELOG.md + 相关 docs/；能力/状态照实标注：官方接口存在 / 源码已实现 / 测试通过 / 真机通过 / 用户接受；
4. 提交推送给 GitHub 前先说明要提交什么；用户说"推送"再推。宿主仓（GitLab）同理。

红线：
- 不提交 build-profile.json5（里面有本机签名）、examples/harmony/entry/src/main/resources/rawfile/im.local.json（真实 apikey）
- 仓库里只允许占位符：wss://im.example.com:6061/v0/channels、YOUR_API_KEY
- 示例里的附件（图片/语音/文件）只做本机演示，不接文件服务，文案不要写成"上传失败"这类像 bug 的话

已知坑（别重复踩）：
- ArkTS：不能用 any/unknown、不能有未标注类型的对象字面量；ForEach 回调参数要写类型；Stack 用 alignContent 居中
- TextInput 的 text 是一次性初始化 → 异步读到的值要用 $$this.xxx 双向绑定
- picker 返回的 URI 是临时授权 → 先复制进 context.cacheDir 再渲染/使用
- Tinode 会把你发的消息回显成 data，且服务端会裁掉实体里的自定义字段（ref/title/url 等）→ 本地副本要保留、回显与本地消息按内容归并去重
- 判定消息类型用 draftyEntities（draftySegments 会跳过 LN/MN/HT）
- 未订阅就 pub 会 409 → 订阅成功后再发（示例里做了排队）
- basic 登录的 secret 必须是 base64("用户名:密码")；Node 侧 apikey 走 ?apikey=，HarmonyOS 侧走 X-Tinode-APIKey 头

待办（TODO）：
- 群组 grp（P7）；推送 set{deviceToken}（P8，需 AGC 开通）
- 附件平台上传的真机验证（HarmonyAttachmentHttp）、断点续传/秒传/图片转码
- HAR 打包并在空工程验证；RDB 存储实现示例；CI（npm test + 许可头检查）
- 示例小问题：撤回占位待用户确认；远方消息到达后会话列表预览刷新不够及时；满屏长历史的自动滚动未验证
- 模糊搜人不在 Tinode WebSocket 协议里（上游 Java SDK 也没有），需要服务端 REST 或自有目录

需要真机时：设备 PSN-AL00（hdc 6CS9K25C23081634），服务地址/apikey 在宿主仓的本地 im.local.json（不要写进仓库）；
系统 picker 不在 dumpLayout 里，用 uitest screenCap 截图核对。
```

## 常用命令

```bash
cd /Volumes/LexarE300/Code/tinode-harmony
node --test tests/*.test.mjs          # SDK 自测（94 例）
bash scripts/check-no-secrets.sh      # 提交前脱敏自检
bash examples/harmony/sync-sdk.sh     # 把 src/ 同步进示例工程

# 示例工程构建
cd examples/harmony
DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk \
  /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw \
  --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
```

## 版本与发布

- `VERSION` 是唯一真相；改行为时同步 `CHANGELOG.md`（Keep a Changelog 格式）。
- 发布形态：源码目录 / HAR（步骤见 `docs/getting-started.md`）。
