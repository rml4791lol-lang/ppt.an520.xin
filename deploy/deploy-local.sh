#!/usr/bin/env bash
# Local atomic release fallback for environments where GitHub is unreachable.
# Builds on this machine, uploads an immutable release, installs prod deps there,
# then switches /opt/anppt-v2/current symlink and restarts with rollback.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${DEPLOY_SERVER:-hk-hermes}"
CURRENT=/opt/anppt-v2/current
RELEASES=/opt/anppt-v2/releases
BRANCH="${DEPLOY_BRANCH:-production}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing deploy: local Git tree is not clean" >&2
  exit 1
fi

echo "== 1/5 local build =="
npm run build

COMMIT="$(git rev-parse HEAD)"
SHORT="${COMMIT:0:12}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE="$RELEASES/${SHORT}-${STAMP}"
echo "== 2/5 sync release $RELEASE =="
ssh "$SERVER" "sudo -n mkdir -p '$RELEASE/.next' '$RELEASE/public' '$RELEASE/scripts' && sudo -n chown -R ubuntu:ubuntu '$RELEASE'"
rsync -az --delete --exclude 'cache/' .next/ "$SERVER:$RELEASE/.next/"
rsync -az --delete public/ "$SERVER:$RELEASE/public/"
rsync -az package.json package-lock.json next.config.ts "$SERVER:$RELEASE/"
rsync -az scripts/verify-health.mjs "$SERVER:$RELEASE/scripts/verify-health.mjs"

echo "== 3/5 install production deps =="
ssh "$SERVER" "cd '$RELEASE' && npm ci --omit=dev --no-audit --no-fund && printf '%s\n' '$COMMIT' > '$RELEASE/.deploy-commit'"

echo "== 4/5 check in-flight queues =="
active="$({ ssh "$SERVER" 'sudo -n node'; } <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/anppt-v2/shared/data/anppt-v2.db', { readOnly: true });
const generation = Number(db.prepare("SELECT count(*) c FROM generation_jobs WHERE status IN ('queued','running')").get().c);
const exports = Number(db.prepare("SELECT count(*) c FROM export_jobs WHERE status IN ('pending','processing')").get().c);
process.stdout.write(`${generation} ${exports}`);
NODE
)"
read -r generation_active export_active <<<"$active"
echo "generation=$generation_active export=$export_active"
if [[ ! "$generation_active" =~ ^[0-9]+$ || ! "$export_active" =~ ^[0-9]+$ ]]; then
  echo "cannot confirm queues; refusing restart" >&2
  exit 1
fi
if (( generation_active > 0 || export_active > 0 )); then
  echo "in-flight work detected; release staged but not activated" >&2
  exit 2
fi

echo "== 5/5 switch and restart =="
ssh "$SERVER" "set -euo pipefail
OLD=\$(readlink '$CURRENT' 2>/dev/null || true)
if [[ -d '$CURRENT' && ! -L '$CURRENT' ]]; then
  LEGACY='$RELEASES/legacy-'\"\$(date +%Y%m%d-%H%M%S)\"
  sudo -n mv '$CURRENT' \"\$LEGACY\"
  OLD=\"\$LEGACY\"
fi
rollback() {
  echo 'post-deploy verification failed; rolling back' >&2
  if [[ -n \"\$OLD\" ]]; then
    sudo -n ln -sfn \"\$OLD\" '$CURRENT'
    sudo -n systemctl restart anppt-v2 || true
  fi
}
sudo -n ln -sfn '$RELEASE' '$CURRENT'
if ! sudo -n systemctl restart anppt-v2; then
  echo 'restart failed' >&2
  rollback
  exit 1
fi
sleep 2
if ! sudo -n systemctl is-active --quiet anppt-v2; then
  rollback
  exit 1
fi
if [[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/me)\" != '401' ]]; then
  echo 'local /api/me did not return 401' >&2
  rollback
  exit 1
fi
if ! HEALTH=\"\$(curl -fsS http://127.0.0.1:3100/api/health)\"; then
  rollback
  exit 1
fi
if ! printf '%s' \"\$HEALTH\" | EXPECTED_RELEASE='$COMMIT' node '$RELEASE/scripts/verify-health.mjs'; then
  rollback
  exit 1
fi
"
node scripts/verify-health.mjs https://ppt.an520.xin/api/health "$COMMIT"
echo "deployed $COMMIT -> $RELEASE"
