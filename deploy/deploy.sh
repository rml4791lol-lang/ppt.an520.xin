#!/usr/bin/env bash
# AnPPT v2 部署到 hk-hermes。构建在本地（Mac），产物 rsync 到服务器。
# 首次使用前按 deploy/README.md 完成服务器初始化（目录 / .env / systemd）。
# 用法：deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${DEPLOY_SERVER:-hk-hermes}"
REMOTE_DIR=/opt/anppt-v2/current

echo "== 1/5 本地构建 =="
npm run build

echo "== 2/5 同步产物到 $SERVER =="
ssh "$SERVER" "mkdir -p $REMOTE_DIR"
rsync -az --delete --exclude 'cache/' .next/ "$SERVER:$REMOTE_DIR/.next/"
rsync -az package.json package-lock.json next.config.ts "$SERVER:$REMOTE_DIR/"
rsync -az --delete public/ "$SERVER:$REMOTE_DIR/public/"

echo "== 3/5 服务器安装生产依赖 =="
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --omit=dev --no-audit --no-fund"

echo "== 4/5 重启前检查在途任务 =="
active_counts="$({ ssh "$SERVER" 'sudo -n node' <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/anppt-v2/shared/data/anppt-v2.db', { readOnly: true });
const generation = Number(db.prepare("SELECT count(*) c FROM generation_jobs WHERE status IN ('queued','running')").get().c);
const exports = Number(db.prepare("SELECT count(*) c FROM export_jobs WHERE status IN ('pending','processing')").get().c);
process.stdout.write(`${generation} ${exports}`);
NODE
} 2>/dev/null)"
read -r generation_active export_active <<<"$active_counts"
if [[ ! "$generation_active" =~ ^[0-9]+$ || ! "$export_active" =~ ^[0-9]+$ ]]; then
  echo "无法确认在途任务数量，拒绝重启：$active_counts" >&2
  exit 1
fi
echo "生成队列=$generation_active，导出队列=$export_active"
if (( generation_active > 0 || export_active > 0 )); then
  echo "检测到在途任务，已中止重启；等待任务完成后重新部署。" >&2
  exit 2
fi

echo "== 5/5 重启并自检 =="
ssh "$SERVER" "sudo -n systemctl restart anppt-v2 && sleep 2 && sudo -n systemctl is-active anppt-v2 \
  && test \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/me)\" = 401 \
  && echo 'local /api/me -> 401 OK'"
