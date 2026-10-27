#!/usr/bin/env bash
# 完成 GitHub 上传：网络恢复后跑这个收尾。
#
# 背景（2026-10-26 迁移）：本地仓库完整（832 文件 / 136MB），但 GitHub 只推上去前几批。
# 代理链路对接近 100MB 的单次请求会 connection reset，长连接也会被中途掐断。
# 本脚本按 8MB 分块续传（已推对象 git 自动跳过），完成后把 import-batches 提升为 production。
set -u
cd "$(dirname "$0")/.." || exit 1
OLD=$(git rev-parse production)
BR=import-batches
CHUNK_KB=8000
log() { echo "[$(date +%H:%M:%S)] $*"; }
git show-ref --verify --quiet "refs/heads/$BR" || { log "no local branch $BR"; exit 2; }
git checkout -q "$BR" || exit 2
push_ref() {
  i=1
  while [ $i -le 10 ]; do
    if timeout 300 env GIT_TERMINAL_PROMPT=0 git push -q origin "HEAD:refs/heads/$BR" >/tmp/finish_push.log 2>&1; then log "pushed"; return 0; fi
    log "push fail $i: $(tail -1 /tmp/finish_push.log)"
    sleep $((i*8)); i=$((i+1))
  done
  return 1
}
files=()
acc=0
flush() {
  if [ ${#files[@]} -gt 0 ]; then
    git checkout "$OLD" -- "${files[@]}" >/dev/null 2>&1 || { log "checkout failed"; exit 3; }
    if git diff --cached --quiet; then log "skip(empty)"; else
      git commit -qm "import: batch ${#files[@]} files" || { log "commit failed"; exit 3; }
      push_ref || { log "gave up"; exit 4; }
    fi
    files=(); acc=0
  fi
}
A=$(mktemp); B=$(mktemp); R=$(mktemp)
git ls-tree -r --name-only "$OLD" | sort > "$A"
git ls-tree -r --name-only HEAD   | sort > "$B"
comm -23 "$A" "$B" > "$R"
log "remaining files: $(wc -l < "$R" | tr -d " ")"
while IFS= read -r path; do
  [ -z "$path" ] && continue
  kb=$(git cat-file -s "$(git rev-parse "$OLD:$path")" 2>/dev/null || echo 0); kb=$((kb/1024))
  if [ $acc -gt 0 ] && [ $((acc+kb)) -gt $CHUNK_KB ]; then flush; fi
  files+=("$path"); acc=$((acc+kb))
done < "$R"
flush
rm -f "$A" "$B" "$R"
log "=== tree check ==="
if git diff --quiet "$OLD" HEAD; then log "TREE IDENTICAL"; else log "TREE DIFFERS"; git diff --stat "$OLD" HEAD | tail -10; exit 5; fi
log "=== promote ==="
git branch -f production "$(git rev-parse HEAD)"
git checkout -q production
timeout 300 env GIT_TERMINAL_PROMPT=0 git push origin production:production 2>&1 | tail -2
git push origin --delete "$BR" >/dev/null 2>&1 && log "temp branch removed"
git branch --set-upstream-to=origin/production production >/dev/null 2>&1 || true
log "done: $(git rev-parse --short HEAD) files=$(git ls-files | wc -l | tr -d " ")"
