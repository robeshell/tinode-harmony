#!/usr/bin/env bash
# 把 SDK 源码同步进示例工程（示例演示的正是"把 src/ 拷进你的工程"这条接入方式）。
# 用法：bash examples/harmony/sync-sdk.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../src"
dst="$here/entry/src/main/ets/tinode"
mkdir -p "$dst"
cp "$src"/*.ts "$src"/*.ets "$dst"/
echo "已同步 SDK：$src → $dst"
