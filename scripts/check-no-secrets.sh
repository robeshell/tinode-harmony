#!/usr/bin/env bash
# 提交前自检：**将要提交的内容**（staged，没有 staged 就看 HEAD）里不允许出现真实服务地址/密钥。
# 本地被 DevEco 写进 build-profile.json5 的签名材料属于"工作区脏改动"，只要不 stage 就不会命中。
# 用法：bash scripts/check-no-secrets.sh
set -uo pipefail
cd "$(dirname "$0")/.."

if git diff --cached --quiet 2>/dev/null; then
  scope="HEAD"; reader="git grep -I -n -E PATTERN HEAD -- . ':!scripts/check-no-secrets.sh'"
  echo "（没有 staged 改动，检查 HEAD）"
else
  scope="staged"; reader="git diff --cached -U0 | grep -E '^\\+' | grep -vE '^\\+\\+\\+'"
  echo "（检查 staged 内容）"
fi

patterns=(
  '192\.168\.[0-9]+\.[0-9]+'
  '10\.[0-9]+\.[0-9]+\.[0-9]+'
  'smartmeter\.vip'
  'im\.dev\.'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '"(certpath|storeFile|keyPassword|storePassword)"'
)
fail=0
for pat in "${patterns[@]}"; do
  if [ "$scope" = "HEAD" ]; then
    hits=$(git grep -I -n -E "$pat" HEAD -- . ':!scripts/check-no-secrets.sh' 2>/dev/null || true)
  else
    hits=$(git diff --cached -U0 | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E "$pat" || true)
  fi
  if [ -n "$hits" ]; then
    echo "✗ 命中敏感模式 /$pat/："
    echo "$hits" | head -5
    fail=1
  fi
done
if [ "$fail" -eq 0 ]; then
  echo "✓ 未发现真实服务地址 / 密钥（只有占位符）"
else
  echo "—— 请把真实值放到本地忽略文件（im.local.json / config.local.json / .env），不要 stage 它们。"
fi
exit "$fail"
