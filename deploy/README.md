# AnPPT v2 部署 Runbook（ppt.an520.xin @ hk-hermes）

## 架构

```
浏览器 → Caddy(443) → next start(127.0.0.1:3100)
                        ├─ sqlite（ANPPT_V2_DB_PATH，默认 shared/data/anppt-v2.db）
                        ├─ 文件存储（ANPPT_V2_DATA_DIR：uploads/generated/exports）
                        ├─ 大纲/梳理 → PPT 引擎 127.0.0.1:3002（Bearer PPT_ENGINE_INTERNAL_TOKEN）
                        │     └─ 引擎不可达时 LLM 兜底 → DeepSeek 官方 /v1（deepseek-v4-flash，低思考）
                        └─ 生图 → sqface（gpt-image-2，OpenAI 兼容 images API；与 LLM 密钥分开）
```

## 首次初始化（只做一次）

```bash
ssh hk-hermes
mkdir -p /opt/anppt-v2/current /opt/anppt-v2/shared/data
cp deploy/anppt-v2.service /etc/systemd/system/anppt-v2.service
systemctl daemon-reload && systemctl enable anppt-v2
```

`/opt/anppt-v2/shared/.env` 关键项（完整模板见仓库根目录 `.env.example`）：

```ini
PUBLIC_BASE_URL=https://ppt.an520.xin
ANPPT_V2_DB_PATH=/opt/anppt-v2/shared/data/anppt-v2.db
ANPPT_V2_DATA_DIR=/opt/anppt-v2/shared/data
ANPPT_OTP_HMAC_SECRET=<openssl rand -hex 32>

# 从 /opt/slideflow-studio/shared/.env 平移：
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM   # QQ 邮箱授权码
WECHAT_PAY_ENABLED=true 及全部 WECHAT_PAY_*                  # 正式商户号参数
EPAY_ENABLED=true 及全部 EPAY_*
ANPPT_V2_LLM_API_KEY                                        # DeepSeek 官方，与生图密钥分开
ANPPT_V2_IMAGE_API_KEY                                      # sqface 生图

PPT_ENGINE_BASE_URL=http://127.0.0.1:3002
PPT_ENGINE_INTERNAL_TOKEN=<与引擎侧一致的内部 token>
```

注意：不要在 .env 里开 `WECHAT_PAY_MOCK` / `EPAY_MOCK` / `OTP_DEV_ECHO`。

## 日常发版

```bash
deploy/deploy.sh        # 本地构建 → rsync → npm ci --omit=dev → 重启 → 自检
```

## Caddy 切换到 v2（上线动作）

```bash
ssh hk-hermes
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)-before-anppt-v2
# 用 deploy/caddy-ppt.an520.xin.conf 替换 ppt.an520.xin 的站点块
# （对照线上原块逐行核对，header 指令里的续行符以线上文件为准）
caddy fmt --overwrite /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
curl -sf https://ppt.an520.xin/api/me   # 期望 401（未登录）
```

回滚：还原备份的 Caddyfile → `systemctl reload caddy`。旧版 slideflow-studio
服务保持原样不stop，随时可切回 3300。

## 运维

- 日志：`journalctl -u anppt-v2 -f`
- 数据备份：打包 `/opt/anppt-v2/shared/data/`（sqlite + 上传/生成图/导出）
- 健康邮件：`deploy/anppt-health-monitor.py` → 服务器 `/usr/local/sbin/anppt-health-monitor.py`（root cron `*/5`）。盯 `anppt-v2` + `caddy`，**不要**把已 disable 的 `slideflow-studio` 加回去消警，也不要为消警去 `systemctl start slideflow-studio`。改脚本后 `python3 -m py_compile` 再手动跑一次；恢复时会发一封「服务已恢复」。
- 引擎联调细节：`../image2-studio-v2/docs/ANPPT-V2-INTEGRATION-CONTRACT.md`

## 禁区（勿动）

- api/console.an520.xin 中转站及其配置
- 127.0.0.1:6800 ssh 隧道、127.0.0.1:3002 PPT 引擎（归各自服务管）
- 老机 101.32.220.164 不登录不改动
