#!/usr/bin/env bash
# Publish the current clean server checkout, then deploy the same commit.
# Intended for the limited sudoers rule on hk-hermes:
#   sudo -n -u ubuntu /opt/anppt-v2/bin/publish-production
set -Eeuo pipefail

REPO=/opt/anppt-v2/source
BRANCH="${1:-production}"

cd "$REPO"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing publish: $REPO is dirty; commit first" >&2
  exit 1
fi
git push origin "HEAD:refs/heads/$BRANCH"
exec /opt/anppt-v2/bin/deploy-production "$BRANCH"
