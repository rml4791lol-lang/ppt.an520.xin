#!/usr/bin/env bash
# AnPPT v2 部署到 hk-hermes。构建在本地（Mac），产物 rsync 到服务器。
# 首次使用前按 deploy/README.md 完成服务器初始化（目录 / .env / systemd）。
# 用法：deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${DEPLOY_SERVER:-hk-hermes}"
REMOTE_DIR=/opt/anppt-v2/current

echo "== 1/4 本地构建 =="
npm run build

echo "== 2/4 同步产物到 $SERVER =="
ssh "$SERVER" "mkdir -p $REMOTE_DIR"
rsync -az --delete --exclude 'cache/' .next/ "$SERVER:$REMOTE_DIR/.next/"
rsync -az package.json package-lock.json next.config.ts "$SERVER:$REMOTE_DIR/"
rsync -az --delete public/ "$SERVER:$REMOTE_DIR/public/"

echo "== 3/4 服务器安装生产依赖 =="
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --omit=dev --no-audit --no-fund"

echo "== 4/4 重启并自检 =="
ssh "$SERVER" "systemctl restart anppt-v2 && sleep 2 && systemctl is-active anppt-v2 \
  && curl -sf -o /dev/null -w 'local /api/me -> %{http_code}\n' http://127.0.0.1:3100/api/me"
