# HarmonyOS 示例工程

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
