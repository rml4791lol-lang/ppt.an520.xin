#!/usr/bin/env bash
# Server-side deploy: pull a Git commit, build, stage an immutable release, then switch /opt/anppt-v2/current.
# Run as ubuntu. Team members may invoke it through the limited sudoers rule.
set -Eeuo pipefail

REPO=/opt/anppt-v2/source
CURRENT=/opt/anppt-v2/current
RELEASES=/opt/anppt-v2/releases
BRANCH="${1:-production}"
LOCK=/var/lock/anppt-v2-deploy.lock

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another AnPPT deploy is already running" >&2
  exit 1
fi

cd "$REPO"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing deploy: $REPO has uncommitted or untracked files" >&2
  echo "commit and push first, then run deploy again" >&2
  exit 1
fi

git fetch origin "$BRANCH"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout -q "$BRANCH"
else
  git checkout -q -B "$BRANCH" "origin/$BRANCH"
fi
git merge --ff-only "origin/$BRANCH"

INSTALLED_HELPER=/opt/anppt-v2/bin/deploy-production
if [[ -f "$REPO/deploy/deploy-production.sh" ]] && ! cmp -s "$REPO/deploy/deploy-production.sh" "$INSTALLED_HELPER"; then
  echo "== update installed deploy helper for future runs =="
  sudo -n install -m 0755 "$REPO/deploy/deploy-production.sh" "$INSTALLED_HELPER"
fi

COMMIT="$(git rev-parse HEAD)"
SHORT="${COMMIT:0:12}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE="$RELEASES/${SHORT}-${STAMP}"

echo "== source commit $SHORT =="
npm ci --no-audit --no-fund
# `.next` must not be reused across machines/build roots: Turbopack can keep stale
# module-resolution state that makes @tailwindcss/postcss look missing on Linux.
if [[ -d .next ]]; then
  find .next -mindepth 1 -delete
  rmdir .next
fi
NEXT_TELEMETRY_DISABLED=1 npm run build

echo "== stage release $RELEASE =="
mkdir -p "$RELEASE"
rsync -a --delete --exclude 'cache/' .next/ "$RELEASE/.next/"
rsync -a --delete public/ "$RELEASE/public/"
install -m 0644 package.json package-lock.json next.config.ts "$RELEASE/"
(cd "$RELEASE" && npm ci --omit=dev --no-audit --no-fund)
printf '%s\n' "$COMMIT" > "$RELEASE/.deploy-commit"

echo "== check in-flight queues =="
active_counts="$({ sudo -n node; } <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/anppt-v2/shared/data/anppt-v2.db', { readOnly: true });
const generation = Number(db.prepare("SELECT count(*) c FROM generation_jobs WHERE status IN ('queued','running')").get().c);
const exports = Number(db.prepare("SELECT count(*) c FROM export_jobs WHERE status IN ('pending','processing')").get().c);
process.stdout.write(`${generation} ${exports}`);
NODE
)"
read -r generation_active export_active <<<"$active_counts"
if [[ ! "$generation_active" =~ ^[0-9]+$ || ! "$export_active" =~ ^[0-9]+$ ]]; then
  echo "cannot confirm in-flight queues; refusing restart: $active_counts" >&2
  exit 1
fi
echo "generation=$generation_active export=$export_active"
if (( generation_active > 0 || export_active > 0 )); then
  echo "in-flight work detected; release staged but not activated. Retry when queues are empty." >&2
  exit 2
fi

OLD_TARGET="$(readlink "$CURRENT" 2>/dev/null || true)"
if [[ -d "$CURRENT" && ! -L "$CURRENT" ]]; then
  LEGACY="$RELEASES/legacy-$(date +%Y%m%d-%H%M%S)"
  mv "$CURRENT" "$LEGACY"
  OLD_TARGET="$LEGACY"
fi

rollback() {
  echo "rolling back to ${OLD_TARGET:-no previous release}" >&2
  if [[ -n "$OLD_TARGET" ]]; then
    ln -sfn "$OLD_TARGET" "$CURRENT"
    sudo -n systemctl restart anppt-v2 || true
  fi
}

ln -sfn "$RELEASE" "$CURRENT"
if ! sudo -n systemctl restart anppt-v2; then
  echo "restart failed" >&2
  rollback
  exit 1
fi

sleep 2
if ! sudo -n systemctl is-active --quiet anppt-v2; then
  echo "service is not active after restart" >&2
  rollback
  exit 1
fi
if [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/me)" != "401" ]]; then
  echo "local /api/me did not return 401 after restart" >&2
  rollback
  exit 1
fi
if ! curl -fsS http://127.0.0.1:3100/api/health | EXPECTED_RELEASE="$COMMIT" node "$REPO/scripts/verify-health.mjs"; then
  echo "post-deploy health contract failed" >&2
  rollback
  exit 1
fi

echo "deployed $COMMIT -> $RELEASE"
