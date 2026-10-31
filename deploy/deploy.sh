#!/usr/bin/env bash
# Git-first production deploy for ppt.an520.xin.
# Local tree must be clean. This pushes HEAD to the production branch, then the server
# pulls/builds/stages an immutable release and restarts the service after queue checks.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${DEPLOY_SERVER:-hk-hermes}"
BRANCH="${DEPLOY_BRANCH:-production}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing deploy: local Git tree is not clean" >&2
  echo "commit the intended changes first; do not deploy uncommitted work" >&2
  exit 1
fi

if ! GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "origin/$BRANCH unavailable; using local atomic release deploy"
  exec bash deploy/deploy-local.sh
fi

echo "== 1/3 push HEAD to origin/$BRANCH =="
if ! git push origin "HEAD:refs/heads/$BRANCH"; then
  echo "push failed; using local atomic release deploy"
  exec bash deploy/deploy-local.sh
fi

echo "== 2/3 server pull, build, stage, restart =="
ssh "$SERVER" "sudo -n -u ubuntu /opt/anppt-v2/bin/deploy-production '$BRANCH' '$(git rev-parse HEAD)'"

echo "== 3/3 verify deployed commit and public health =="
LOCAL_COMMIT="$(git rev-parse HEAD)"
REMOTE_COMMIT="$(ssh "$SERVER" 'cat /opt/anppt-v2/current/.deploy-commit')"
if [[ "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ]]; then
  echo "deployed commit mismatch: local=$LOCAL_COMMIT server=$REMOTE_COMMIT" >&2
  exit 1
fi
node scripts/verify-health.mjs https://ppt.an520.xin/api/health "$LOCAL_COMMIT"
echo "deployed $LOCAL_COMMIT"
