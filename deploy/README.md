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

## 服务器 Git 布局（2026-10-19 起）

```
/opt/anppt-v2/source       Git checkout，分支 production（团队协作目录）
/opt/anppt-v2/releases/    每次部署的不可变发布目录
/opt/anppt-v2/current      → releases/<commit>-<timestamp> 的软链
/opt/anppt-v2/shared/      .env、微信支付 PEM、SQLite、uploads/generated/exports
/opt/anppt-v2/bin/         服务端部署脚本（root 所属，团队只读执行）
```

`production` 是线上分支，GitHub `rml4791lol-lang/ppt.an520.xin` 同分支是唯一代码事实源。
服务器源码、发布目录与本地开发目录 `/Users/an/Desktop/Atlas/ppt.an520.xin网站` 使用同一个提交。
2026-10-26 起只在这一个目录开发；原独立 clean worktree `anppt-v2.production` 与 launchd
每 5 分钟同步已废弃（`deploy/install-local-sync.sh` 保留但不再安装）。

## 首次初始化（只做一次）

```bash
ssh hk-hermes
mkdir -p /opt/anppt-v2/releases /opt/anppt-v2/shared/data
# source 由 Git clone 到 /opt/anppt-v2/source，部署脚本复制到 /opt/anppt-v2/bin/
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
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM   # QQ 邮箱授权码；SMTP_FROM 不设则地址回落 SMTP_USER，设了地址须等于 SMTP_USER
WECHAT_PAY_ENABLED=true 及全部 WECHAT_PAY_*                  # 正式商户号参数
EPAY_ENABLED=true 及全部 EPAY_*
ANPPT_V2_LLM_API_KEY                                        # DeepSeek 官方，与生图密钥分开
ANPPT_V2_IMAGE_API_KEY                                      # sqface 生图

PPT_ENGINE_BASE_URL=http://127.0.0.1:3002
PPT_ENGINE_INTERNAL_TOKEN=<与引擎侧一致的内部 token>
```

注意：不要在 .env 里开 `WECHAT_PAY_MOCK` / `EPAY_MOCK` / `OTP_DEV_ECHO`。

## 日常发版（Git 优先）

```bash
# 1) 本地必须干净，且改动已经提交
git status --short
bash deploy/deploy.sh

# 等价于：
# git push origin HEAD:refs/heads/production
# ssh hk-hermes 'sudo -n -u ubuntu /opt/anppt-v2/bin/deploy-production production'
```

服务端脚本会 `git fetch` → `npm ci` → `npm run build` → 生成不可变 release →
检查整套生成/单页批量/导出三队列 → 原子切换 `/opt/anppt-v2/current` → 重启 → 校验
`/api/me=401`、`/api/health` 契约和运行时 `release`。队列非 0 时只暂存 release、
不切换、不重启；重启或健康契约失败会自动回滚。

### 架构深化批次（2026-10-29）发布注意

- **schema 只增不改**：`slide_versions.charge_key` 是 `TEXT NOT NULL DEFAULT ''` 的懒迁移列（启动时 `ALTER TABLE` 补列，老行留空、恢复按键模块回退），没有手工迁移脚本；部署不需要停机跑 SQL。
- **在途检查照旧且必须为 0**：三队列（整套生成 / 单页批量 / 导出）任一非 0 时只暂存 release，不切换、不重启——在途任务跨版本会同时存在新旧扣费/恢复语义。
- **账本键前缀未变**：`deck-generate:`、`single-page:`、`export-editable:`、`export-editable-text:`、`ppt-to-base:`；退款键仍是 `refund:<sha256(chargeKey)[0:32]>` 的定长派生，历史 ledger 可直接对账。
- **重启后自检**：`src/instrumentation.ts` 会在启动期登记四个恢复运行源（deck / single-page / ppt-to-base / editable）；`/api/health` 应返回 `plugins` 无 `error`，并抽一个已登录用户的任意读接口确认鉴权门恢复循环可运行。
- 本次收口断言：`test-generation 946 / test-backend 184`（全量门 8/8）。

若本次修改了 `deploy/deploy-production.sh`，首次部署前先把 source 里的新脚本安装到
`/opt/anppt-v2/bin/deploy-production`；之后脚本会自更新安装副本。命令见 `docs/LOGGING.md` §5。

回滚：

```bash
ssh hk-hermes 'ls -1dt /opt/anppt-v2/releases/* | sed -n "1,5p"'
# 选定上一个 release 后
ssh hk-hermes 'sudo -n ln -sfn /opt/anppt-v2/releases/<previous> /opt/anppt-v2/current && sudo -n systemctl restart anppt-v2'
```

## 团队访问

- 独立账号 `anppt-dev`（禁止密码登录，仅 SSH key），属于 `anppt-devs`；
- 可写 `/opt/anppt-v2/source`，可执行受限的 `sudo -n -u ubuntu /opt/anppt-v2/bin/deploy-production` 与 `publish-production`；
- 不授予 root、不直改 `/opt/anppt-v2/shared`、不直改 `current`；
- 新增成员必须各自提交公钥，不要共用私钥。交接包只用于首次应急交接，拿到后应尽快换成个人 key。

团队改动的固定闭环（服务器端）：

```bash
cd /opt/anppt-v2/source
git pull --ff-only origin production
# edit + test
git add -A && git commit -m "Describe the change"
sudo -n -u ubuntu /opt/anppt-v2/bin/publish-production production
```

`publish-production` 先 push 当前 HEAD 到 `origin/production`，再调用
`deploy-production`。服务器 Git 凭据由 root-only token + `git-credential-anppt`
helper 提供，团队账号不能读取 token，也不能执行任意 ubuntu/root 命令。

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

- 运行日志：`journalctl -u anppt-v2 -f`
- 问题日志：`<ANPPT_V2_DATA_DIR>/logs/problems-YYYY-MM-DD[.N].jsonl`；后台 `/admin/problems`。保留 14 天、单文件 20 MiB 滚动、总量 100 MiB 上限。完整变更/上线/监控流程见 `docs/LOGGING.md`。
- 数据备份：
  - SQLite 每日 03:30 自动热备（`anppt-backup.timer` → `/opt/anppt-v2/shared/backup-db.sh`），`VACUUM INTO` 后用 gzip 存到 `/opt/anppt-v2/shared/backups/`，保留 14 天。手工触发：`sudo systemctl start anppt-backup.service`。
  - 备份只含账户/积分/订单/项目元数据；`uploads/`、`generated/`、`exports/` 原文件仍需另行归档。
- 健康邮件：`deploy/anppt-health-monitor.py` → 服务器 `/usr/local/sbin/anppt-health-monitor.py`（root cron `*/5`）。盯 `anppt-v2` + `caddy` + health 契约（含 `plugins.error` 插件装配告警）+ 问题日志落盘/体积 + 磁盘 + 备份新鲜度 + 生图上游 402（欠费）与连续错误，**不要**把已 disable 的 `slideflow-studio` 加回去消警，也不要为消警去 `systemctl start slideflow-studio`。改脚本后 `python3 -m py_compile`，再安装并手动跑一次；恢复时会发一封「服务已恢复」。

```bash
python3 -m py_compile deploy/anppt-health-monitor.py
ssh hk-hermes 'sudo -n install -m 0755 /opt/anppt-v2/source/deploy/anppt-health-monitor.py /usr/local/sbin/anppt-health-monitor.py'
ssh hk-hermes 'sudo -n /usr/local/sbin/anppt-health-monitor.py'
```
- 引擎联调细节：`../image2-studio-v2/docs/ANPPT-V2-INTEGRATION-CONTRACT.md`

## 禁区（勿动）

- api/console.an520.xin 中转站及其配置
- 127.0.0.1:6800 ssh 隧道、127.0.0.1:3002 PPT 引擎（归各自服务管）
- 老机 101.32.220.164 不登录不改动
