# AnPPT 探查与 Debug 手册（agent 交接用）

> 写给接手探查/debug 的 agent：本文是系统全貌的唯一权威入口。改完代码请同步更新本文。
> 最后更新：2026-08-20（单页可编辑导出上线 + 备份纳入数据资产）

## 1. 系统是什么

ppt.an520.xin = **AnPPT**（anppt-v2）：AI 生成 PPT 网站。技术栈：Next.js 15 App Router + TypeScript + better-sqlite3（WAL）+ 自研 lib 层。生图走 gpt-image-2，大纲/梳理走 LLM，转可编辑走 Codia Open API。

- 仓库：本地 `/Users/an/ZCodeProject/anppt-v2`，GitHub `An-an-525/anppt-v2` 分支 `main`。
- 站点：https://ppt.an520.xin

## 2. 服务器与部署

- SSH：`ssh hk-hermes`（ubuntu，`sudo -n` 免密可用）。
- 应用目录 `/opt/anppt-v2/current`，systemd 服务 `anppt-v2.service`，监听 `127.0.0.1:3100`。
- 环境变量：`/opt/anppt-v2/shared/.env`（SMTP / epay / 微信 / LLM / IMAGE / ALIYUN_SMS_* / ANPPT_V2_CODIA_API_KEY 等）。**密钥绝不打印进会话/日志/仓库**。
- DB：`/opt/anppt-v2/shared/data/anppt-v2.db`（env `ANPPT_V2_DB_PATH`）；上传/生成/导出文件在 `/opt/anppt-v2/shared/data/` 下。
- **每日备份**：root cron `25 3 * * * /usr/local/sbin/anppt-v2-backup.sh`（日志 `/var/log/anppt-v2-backup.log`）。
  内容 = `VACUUM INTO` 在线备份 DB（WAL 一致，勿用 cp）+ `.env`（600）+ 数据清单 + `data-assets.tar.gz`（uploads/generated/exports 三目录打包，~50M），保留 7 天于 `/opt/anppt-v2/backups/daily/`。
  ⚠️ 老的 `anppt-daily-backup.sh`（03:15）备份的是 **slideflow 老系统**，与 anppt-v2 无关，别看错。
- Caddy 反代：`ppt.an520.xin → 127.0.0.1:3100`（Caddyfile 备份 `/etc/caddy/Caddyfile.bak-anppt-20260819-205014`）。
- 部署：仓库根 `bash deploy/deploy.sh`（本地 build → rsync → 服务器 npm ci → restart → 自检）。**restart 会打断在线用户的在途请求**，部署前知会用户。
- 看日志：`ssh hk-hermes 'sudo -n journalctl -u anppt-v2.service -n 200 --no-pager'`。

## 3. 监控告警（邮件来源）

- root cron 每 5 分钟：`/usr/local/sbin/anppt-health-monitor.py`（日志 `/var/log/anppt-monitor.log`，状态 `/var/lib/anppt-monitor/state.json`）。
- 检查项：slideflow-studio/img2pptx-v4-node/caddy 服务存活 + `https://ppt.an520.xin/api/health` + 磁盘 + **anppt-v2 备份新鲜度（26h 无新备份即告警）**。
- **health 契约**：顶层 `ok`、`llm.configured`、`image.configured`、`editable.configured`——缺了任何一项监控就误报。连续失败 2 次起每 5 分钟发邮件到 366150820@qq.com，恢复后发一封恢复通知。

## 4. 业务主链路（整套 PPT）

注册/登录（邮箱 OTP 或手机号短信 OTP 或密码，注册送 100🌟）→ 上传文档（txt/md/docx/pdf）或按页录入 → 大纲（LLM）→ 内容梳理（tagged DSL，结构校验+数据保真 diff）→ 确认冻结（contentLocked）→ 选风格包（27 包）→ 逐页生图（10🌟/页）→ 导出。

关键代码：
- 大纲/引擎：`src/lib/server/engine.ts`（**引擎 3002 的 internal/ppt 契约端点未上线，无 PPT_ENGINE_INTERNAL_TOKEN 时走 LLM 兜底——这是定案**）。大纲链路由另一会话在优化，**契约冻结，勿动**。
- 生图 prompt 组装：`src/lib/server/generation/style-packs.ts`（buildSlideImagePrompt = 整套一致性段 + 页型版式指令 + 文案段 + 风格指令含视觉关键词 + 易转可编辑条款）；页型归一：`src/lib/server/generation/page-types.ts`（16 页型，role 优先 + 关键词最长匹配）。
- 生成管线：`src/lib/server/generation/generate.ts`（估价→整单 402 预检→建 job→逐页并发 3→debit 幂等键 `deck-generate:{deckId}:{jobId}:{slideId}`→失败 refund）。
- 状态机：decks.ts（parsed→outlined→structured→confirmed→generating→generated/partial；stale 作废机制）。
- **崩溃恢复（2026-08-20 上线）**：`src/lib/server/generation/recovery.ts`。重启/崩溃打断生成后，deck 卡 generating（409 死锁）、页卡 queued/running、已扣费页无退款的问题由懒恢复解决：`getDeckState`/`startDeckGeneration`/单页读写入口触发 `reconcile*`，把中断页收敛为 failed、deck 收敛为 partial/confirmed，并按 ledger **实扣金额**补退款（refund 幂等键与正常失败退款同格式，不双退）。判定依据 = job 心跳（每页完成刷新 `generation_jobs.updated_at`）超过 `ANPPT_V2_JOB_STALE_MS`（默认生图超时+2min，下限 5min）或 job 已终态；本进程活跃任务有注册表守卫不会误伤。单页扣费键存 `single_page_versions.charge_key`（老库懒迁移补列）。
- **软删清理（同日上线）**：`projects.ts` `listProjects` 时懒清理软删超 `ANPPT_V2_PROJECT_RETENTION_DAYS`（默认 7 天）的项目——行级联删除（FK ON）+ 生成图删除（deck 整目录、单页按 version.image_path）；导出文件与 uploads 不清；**credit_ledger 永不删除**。

## 5. 计费与支付

- 价格表：`src/lib/server/env.ts` DEFAULT_ACTION_PRICES（`deck_page_generate:10`、`export_editable:20`、outline/export_image:0）。可用 env `CREDIT_ACTION_PRICES` JSON 覆盖。
- 充值档：DEFAULT_RECHARGE_PLANS（¥9.9/100🌟、¥39.9/500🌟、¥79.9/1000🌟、¥149.9/2000🌟），env `RECHARGE_PLANS` 可覆盖。
- 账：`credit_ledger` 幂等键防重；所有扣费先整单估价+余额预检（402）；失败自动退还（refund 键唯一）。
- 支付渠道：**epay 支付宝收银台（活）**；微信支付开不了——商户私钥 apiclient_key.pem 在服务器上不存在（等用户提供）。

## 6. 转可编辑 PPTX（Codia 链，20🌟/页）

- 代码：`src/lib/server/codia.ts`（客户端）、`src/lib/server/exports.ts`（`startDeckEditableExport` / `startSinglePageEditableExport` → 共用 `launchEditableExport` + 管线 + 懒恢复；`readExportSourceImages` 按 ref_type 分发取图）、路由 `POST /api/deck/[id]/export-editable` 与 `POST /api/single-page/export-editable-pptx`（均 202）、状态 `GET /api/pptx-exports/[id]`。
- 流程：读整套页图 → pdf-lib 打 image-only PDF → Codia 上传（multipart `file`）→ 建任务（`Idempotency-Key: anppt-editable-{exportId}`）→ 4s 轮询 → 下载 ppt_url 落盘。
- 失败语义：task failed 自动以 `-retry1` 键重建一次（上游对 failed 任务幂等退费，不双扣）；再失败 → 退星 + 行 failed。上游 402（Codia 余额不足）→ 立即退星 + journal 大字告警 `[anppt-v2][codia] ⚠️⚠️`。
- 懒恢复：pending/processing 的 editable 行在 getExport/listExports 时被现场推进（有 task_id 现场 poll；无 task_id 且创建超 30s 后台重跑整条管线，幂等安全）。**没有硬超时**。
- 限制：单套 ≤20 页（EXPORT_TOO_MANY_PAGES）；deck 必须 status==='generated'；单页项目取全部有 activeVersion 的页；同 ref 并发转换 409 EXPORT_RUNNING。
- Codia 计费：13 credits/页，提交即扣；用户已订 $49/月档（5500 credits ≈ 423 页/月）。**禁止为测试真实调用 Codia**（测试全 mock）。
- 官方文档：https://codia.ai/pdf-to-editable-ppt-api 、https://codia.ai/blog/notebooklm-style-pdf-to-editable-pptx-open-api

## 7. 前端要点

- 工作台：`src/components/deck/deck-workbench.tsx` + `step-*.tsx`（生成 CTA 状态机：生成中禁用「正在生成中…」/部分完成「生成剩余 N 页」/全完成「使用此风格重新生成」）。
- 转可编辑按钮：`step-generate.tsx`（仅 deck.status==='generated' 可点）→ 确认弹窗 → 4s 轮询 → 成功自动下载。单页生成器同款：`single-page-client.tsx` + `sp-panels.tsx` ExportPanel（doneCount×单价确认弹窗 → 轮询 getExportRecord → 自动下载/失败退星提示）。
- 下载中心：`src/app/(main)/exports/page.tsx`（列表 + 状态 + 再下载，processing 自动刷新）。侧栏有「下载中心」入口。
- 「图片转可编辑」侧栏入口仍是占位（未做，属规划外）。

## 8. 测试与验证（全部零真实付费调用）

```bash
node --experimental-strip-types scripts/test-generation.mjs  # 172 断言（含 [6b] deck / [6c] 单页 Codia 全链 mock、[9] 崩溃恢复/清理）
node --experimental-strip-types scripts/test-backend.mjs     # 54 断言
./node_modules/.bin/tsc --noEmit
npm run build
node scripts/e2e-ui-audit.mjs        # Playwright 真机 UI 审查（需要登录态，见脚本头注释）
BASE_URL=http://localhost:3000 node scripts/e2e-fullchain.mjs  # ⚠️ 真实生图扣费（约 $0.08），慎用
```

## 9. 日志前缀速查

- `[anppt-v2][codia]` — Codia 上游调用/402 告警
- `[anppt-v2][exports]` — 导出管线/退星失败
- `[anppt-v2][generation]` — 生成管线/退星失败
- `[anppt-v2][recovery]` — 崩溃懒恢复触发（出现即说明发生过中断，值得看上一条 journal）
- `[anppt-v2][api] unexpected error` — 路由未捕获异常（含堆栈）

## 10. 已知未修（勿重复排查）

- **大纲错误口径已统一（2026-08-20 修）**：`engine.ts` `generateOutline` 兜底路径已包 `engineFailure()`——超时/非 JSON/未配置统一 `ENGINE_UNAVAILABLE` 503 可重试；空大纲保持 `OUTLINE_FAILED` 502。线上生效需部署。
- 磁盘 78%（非 AnPPT 数据，53M）；导出文件（exports/）无清理机制，量大后需运维处理。
- 注册仅需用户名+密码即送 100🌟，可换 IP 刷号薅生图成本（产品决策）。

## 11. 禁区与注意事项

- Caddy 禁区：api/console.an520.xin（另一套系统）、6800 隧道、老机 101.32.220.164、slideflow 3300 服务（不杀、只不再代理）。
- 密钥只存在于服务器 env，任何情况下不打印、不进仓库、不进前端。
- 大纲生成链路契约冻结（另一会话在改），只能动生图 prompt 拼装层。
- commit 用英文祈使句；部署前跑齐 4 项验证；部署会重启服务。
- 竞品调研资料库：`/Users/an/ZCodeProject/anppt-v2-recon/`（旁门/花卷/抖研三站报告 + 可编辑路线调研 RESEARCH-image-to-editable-pptx-2026.md）。
