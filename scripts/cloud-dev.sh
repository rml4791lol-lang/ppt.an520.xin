#!/usr/bin/env bash
# Cursor Cloud 启动：密钥来自 Dashboard Secrets，禁止写进仓库。
# 本机 LLM 常用 127.0.0.1:6800 隧道，云端 VM 没有这条隧道，自动改走 LLM 备份站。
set -euo pipefail

if [[ "${ANPPT_V2_LLM_BASE_URL:-}" == *'127.0.0.1'* || "${ANPPT_V2_LLM_BASE_URL:-}" == *'localhost'* ]]; then
  if [[ -n "${ANPPT_V2_LLM_BACKUP_BASE_URL:-}" && -n "${ANPPT_V2_LLM_BACKUP_API_KEY:-}" ]]; then
    export ANPPT_V2_LLM_BASE_URL="$ANPPT_V2_LLM_BACKUP_BASE_URL"
    export ANPPT_V2_LLM_API_KEY="$ANPPT_V2_LLM_BACKUP_API_KEY"
    export ANPPT_V2_LLM_MODEL="${ANPPT_V2_LLM_BACKUP_MODEL:-deepseek-v4-flash}"
  fi
fi

export OTP_DEV_ECHO="${OTP_DEV_ECHO:-true}"
export WECHAT_PAY_ENABLED="${WECHAT_PAY_ENABLED:-true}"
export WECHAT_PAY_MOCK="${WECHAT_PAY_MOCK:-true}"
export EPAY_ENABLED="${EPAY_ENABLED:-true}"
export EPAY_MOCK="${EPAY_MOCK:-true}"

exec npm run dev -- --hostname 0.0.0.0 --port 3000
