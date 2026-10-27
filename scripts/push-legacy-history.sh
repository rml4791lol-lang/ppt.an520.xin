#!/usr/bin/env bash
# 把 anppt-v2 的 85 条历史（剔除 >50MB 后）作为 legacy/* 分支推到 GitHub。
# 完整历史另有 bundle：_backups/anppt-v2-full-20261026.bundle（+ iCloud）。
set -u
SOURCE="${1:-/tmp/anppt-v2-mirror.git}"
DEST="${2:-https://github.com/rml4791lol-lang/ppt.an520.xin.git}"
MAX_TRY=5
[ -d "$SOURCE" ] || { echo "missing mirror: $SOURCE"; echo "重建：git clone --mirror _backups/anppt-v2-full-20261026.bundle $SOURCE && cd $SOURCE && git filter-repo --strip-blobs-bigger-than 50M --force"; exit 1; }
cd "$SOURCE" || exit 1
git remote remove dest 2>/dev/null || true
git remote add dest "$DEST"
for ref in $(git for-each-ref --format="%(refname:short)" refs/heads); do
  target="legacy/${ref////-}"
  if timeout 30 git ls-remote --heads dest "$target" 2>/dev/null | grep -q .; then echo "skip(exists): $target"; continue; fi
  i=1
  while [ $i -le $MAX_TRY ]; do
    echo "[$(date +%H:%M:%S)] $ref -> $target (try $i)"
    if timeout 600 env GIT_TERMINAL_PROMPT=0 git push dest "refs/heads/$ref:refs/heads/$target" 2>&1 | tail -2; then
      if timeout 30 git ls-remote --heads dest "$target" 2>/dev/null | grep -q .; then echo "  ok"; break; fi
    fi
    sleep $((i*10)); i=$((i+1))
  done
done
echo "remote heads: $(git ls-remote --heads dest | wc -l | tr -d " ")"
