# HarmonyOS 示例工程

> 逐项体验清单（哪些是真收发、哪些是本机演示）见仓库根 [README 的「Demo 体验指引」](../../README.md#demo-体验指引)。

一个**可以直接构建**的最小示例：连接 → 订阅 → 发一条文本 → 显示状态与日志。

## 怎么开

1. 用 **DevEco Studio 打开本目录**（`examples/harmony/`）；
2. 首次真机安装需要**签名**：仓库**不提交任何签名材料**（`build-profile.json5` 里是 `signingConfigs: []`），
   在 DevEco 里用「自动签名」即可（或用你自己的证书）；
3. 在 `entry/src/main/resources/rawfile/` 下建 **`im.local.json`**（**已 gitignore，不要提交**）：

```bash
cp entry/src/main/resources/rawfile/im.local.json.example entry/src/main/resources/rawfile/im.local.json
# 然后填入你自己的 wsUrl / apiKey / token
```

也可以直接在页面输入框里填（优先级：输入框 > 本地文件）。

## 命令行构建（不签名也能出 HAP）

```bash
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
/path/to/hvigorw --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
# 产物：entry/build/default/outputs/default/entry-default-unsigned.hap
```

## SDK 从哪来

示例演示的是"**把 `src/` 拷进你的工程**"这种接入方式；改完 SDK 后同步一下：

```bash
bash examples/harmony/sync-sdk.sh      # ../../src → entry/src/main/ets/tinode
```

（另一种形态是 HAR，见 `docs/getting-started.md`。）

## 在 DevEco Studio 里导入（逐步）

> 前提：DevEco Studio + HarmonyOS SDK 与你现有工程一致即可。本示例的工程配置就是照"能在这台机器上构建"的值写的：
> `compatibleSdkVersion: 5.0.3(15)`、`targetSdkVersion: 26.0.0`、`modelVersion: 6.0.0`。

1. **拿到代码**

   ```bash
   git clone https://github.com/robeshell/tinode-harmony.git
   ```

2. **打开工程**：DevEco Studio → **`File → Open…`** →
   选中 **`tinode-harmony/examples/harmony`** 这个目录（⚠️ 不是仓库根目录；根目录不是一个 DevEco 工程）。
   - 弹出 **Trust Project** → 信任；
   - 弹出 **Sync / ohpm install** → 让它同步（没有第三方依赖，几秒就好）；
   - 若提示 SDK / modelVersion 升级 → 接受（上面三个值就是从你现有工程抄的）。

3. **配签名（真机运行才需要）**：**`File → Project Structure… → Signing Configs`** →
   勾选 **Automatically generate signature**（需登录华为账号）→ Apply。
   签名信息会被 DevEco 写进**你本地**的 `build-profile.json5`，**不要提交**（仓库里 `signingConfigs` 是空的）。

4. **填服务配置**（二选一）：
   - 页面输入框里直接填 `wsUrl / apikey / token / topic`；或
   - ```bash
     cp entry/src/main/resources/rawfile/im.local.json.example entry/src/main/resources/rawfile/im.local.json
     # 编辑 im.local.json 填你自己的值（该文件已 gitignore）
     ```
   字段含义与取值见 [`docs/configuration.md`](../../docs/configuration.md)。

5. **运行**：接真机 → 选 `entry` → **Run**。页面上点「连接」→ 状态走到 `ready` → 点「订阅并发一条」。

6. **只出包不运行**：**`Build → Build Hap(s)/APP(s)`**，产物在
   `entry/build/default/outputs/default/entry-default-unsigned.hap`（未签名）。

### 常见坑

| 现象 | 原因 |
| --- | --- |
| 打开后提示"不是工程/无法同步" | 打开的是仓库根目录，应该打开 `examples/harmony` |
| Run 报签名错误 | 没做第 3 步（自动签名） |
| 点「连接」提示 `token 为空` | 第 4 步没填；或勾上页面上的 `anonymous` 先自测 |
| 改了 SDK 不生效 | 示例里的 SDK 是拷贝副本：跑 `bash sync-sdk.sh` 重新同步 |

### ⚠️ 签名材料不要提交

DevEco 的「自动签名」会把 `certpath / storeFile / keyPassword / storePassword` 写进
**本目录的 `build-profile.json5`**（这个文件是**仓库里跟踪**的）。所以：

- 你本地跑之前做一次自动签名即可（`git status` 会显示 `build-profile.json5` 被改，**这是预期的**）；
- **提交/推送前**把这段清回空再提交：

```bash
git checkout -- examples/harmony/build-profile.json5     # 丢弃本地签名改动（下次 Run 前再签一次）
# 或者手工把 "signingConfigs" 和 products 里的 "signingConfig" 去掉
```

- 自检（只检查将要提交的内容，不会因为本地签名而误报）：

```bash
bash scripts/check-no-secrets.sh
```
