#!/usr/bin/env bash
# 手机直连本地 dev server。用法：npm run phone
#
# 为什么需要：这个项目的核心行为（摄像头给什么流、手势准不准、观感对不对）
# **只有真机能验**，而我一直是「改代码 → 发版 → Gary 上手机 → 截图」跑一整轮，
# 一轮只能验一个假设。摄像头那几次反复慢就慢在这。
#
# 直接用局域网 IP 不行：iOS Safari 只在 **HTTPS 或 localhost** 下给 getUserMedia，
# http://192.168.x.x 会直接拿不到摄像头。自签证书要在手机上装根证书，太折腾。
# cloudflared 的临时隧道给的是**真的 HTTPS 域名**，不用账号也不用配置。
#
# 这样改一行代码手机刷新一下就能看到，不用发版。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-3000}
npx next dev -p "$PORT" &
DEV=$!
# 隧道连上一个还没起来的端口会立刻断，所以先等 dev server 真的能响应
until curl -sf "http://127.0.0.1:$PORT" -o /dev/null; do
  kill -0 $DEV 2>/dev/null || { echo "dev server 起不来"; exit 1; }
  sleep 1
done
echo "本地好了，开隧道…（下面那个 https://xxx.trycloudflare.com 用手机开）"
trap 'kill $DEV 2>/dev/null || true' EXIT
cloudflared tunnel --url "http://localhost:$PORT"
