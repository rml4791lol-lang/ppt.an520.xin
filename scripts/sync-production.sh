#!/usr/bin/env bash
# Keep the local production checkout fast-forwarded to origin/production.
# Safe by default: refuses to touch a dirty or diverged working tree.
set -u

REPO="${ANPPT_PRODUCTION_WORKTREE:-/Users/an/ZCodeProject/anppt-v2.production}"
LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/anppt-v2-git-sync.log"
mkdir -p "$LOG_DIR"
ts="$(date '+%Y-%m-%d %H:%M:%S %z')"

cd "$REPO" || { echo "$ts repo missing: $REPO" >>"$LOG"; exit 0; }

branch="$(git branch --show-current 2>/dev/null || true)"
if [[ "$branch" != "production" ]]; then
  echo "$ts skipped: current branch is ${branch:-detached}, expected production" >>"$LOG"
  exit 0
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "$ts skipped: working tree is dirty" >>"$LOG"
  exit 0
fi

if ! git fetch origin --prune >>"$LOG" 2>&1; then
  echo "$ts fetch failed" >>"$LOG"
  exit 0
fi

if git merge --ff-only origin/production >>"$LOG" 2>&1; then
  echo "$ts synced to $(git rev-parse --short=12 HEAD)" >>"$LOG"
else
  echo "$ts skipped: local production has diverged from origin/production" >>"$LOG"
fi
