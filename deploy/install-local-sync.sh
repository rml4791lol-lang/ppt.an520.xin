#!/usr/bin/env bash
# Install a launchd job that fast-forwards the local production checkout every 5 minutes.
set -euo pipefail

LABEL="xin.anppt.v2-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT="/Users/an/Desktop/Atlas/ppt.an520.xin网站/scripts/sync-production.sh"   # 已废弃：2026-10-26 起单目录开发
LOG="$HOME/Library/Logs/anppt-v2-git-sync.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
plutil -create xml1 "$PLIST"
plutil -insert Label -string "$LABEL" "$PLIST"
plutil -insert ProgramArguments -json "[\"/bin/bash\",\"$SCRIPT\"]" "$PLIST"
plutil -insert RunAtLoad -bool true "$PLIST"
plutil -insert StartInterval -integer 300 "$PLIST"
plutil -insert StandardOutPath -string "$LOG" "$PLIST"
plutil -insert StandardErrorPath -string "$LOG" "$PLIST"

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"
echo "installed $LABEL -> $PLIST"
