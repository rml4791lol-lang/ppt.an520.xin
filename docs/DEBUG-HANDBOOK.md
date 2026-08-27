# AnPPT 探查与 Debug 手册（agent 交接用）

> 写给接手探查/debug 的 agent：本文是系统全貌的唯一权威入口。改完代码请同步更新本文。
> 最后更新：2026-08-22（功能开关板与测试用户、轻量文字可编辑导出、上游消耗计量）

## 1. 系统是什么

ppt.an520.xin = **AnPPT**（anppt-v2）：AI 生成 PPT 网站。技术栈：Next.js 16.3.1 App Router + React 19 + TypeScript + better-sqlite3（WAL）+ 自研 lib 层。生图走 OpenAI 兼容图片接口，大纲/梳理走 LLM 模型链，转可编辑走 Codia Open API。

- 仓库：本地 `/Users/an/ZCodeProject/anppt-v2`，GitHub `An-an-525/anppt-v2` 分支 `main`。
- 站点：https://ppt.an520.xin

## 2. 服务器与部署

- SSH：`ssh hk-hermes`（ubuntu，`sudo -n` 免密可用）。
- 应用目录 `/opt/anppt-v2/current`，systemd 服务 `anppt-v2.service`，监听 `127.0.0.1:3100`。
- 环境变量：`/opt/anppt-v2/shared/.env`（SMTP / epay / 微信 / LLM / IMAGE / ALIYUN_SMS_* / ANPPT_V2_CODIA_API_KEY / `ANPPT_V2_ADMIN_CONFIG_KEY` 等）。**密钥绝不打印进会话/日志/仓库**。
- DB：`/opt/anppt-v2/shared/data/anppt-v2.db`（env `ANPPT_V2_DB_PATH`）；上传/生成/导出文件在 `/opt/anppt-v2/shared/data/` 下。
- **每日备份**：root cron `25 3 * * * /usr/local/sbin/anppt-v2-backup.sh`（日志 `/var/log/anppt-v2-backup.log`）。
  内容 = `VACUUM INTO` 在线备份 DB（WAL 一致，勿用 cp）+ `.env`（600）+ 数据清单 + `data-assets.tar.gz`（uploads/generated/exports 三目录打包，~50M），保留 7 天于 `/opt/anppt-v2/backups/daily/`。
  ⚠️ 老的 `anppt-daily-backup.sh`（03:15）备份的是 **slideflow 老系统**，与 anppt-v2 无关，别看错。
- Caddy 反代：`ppt.an520.xin → 127.0.0.1:3100`（Caddyfile 备份 `/etc/caddy/Caddyfile.bak-anppt-20260819-205014`）。
- 部署：仓库根 `bash deploy/deploy.sh`（本地 build → rsync → 服务器 npm ci → **脚本再次检查双队列** → restart → 自检）。**restart 会打断在线用户的在途请求**；任一队列非 0 或检查失败时脚本会拒绝重启。
- **部署前必须同时检查生成与导出队列**（可编辑转换也可能在后台下载结果）：

```bash
ssh hk-hermes 'sudo -n node' <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/opt/anppt-v2/shared/data/anppt-v2.db", { readOnly: true });
console.log({
  generation: db.prepare("SELECT count(*) c FROM generation_jobs WHERE status IN ('queued','running')").get().c,
  export: db.prepare("SELECT count(*) c FROM export_jobs WHERE status IN ('pending','processing')").get().c,
});
NODE
```

  任一结果 > 0 → 等任务自然完成后重新检查，禁止直接重启。崩溃恢复虽可退款/续查，但会明显伤害 20 页生成与转换体验。
- 看日志：`ssh hk-hermes 'sudo -n journalctl -u anppt-v2.service -n 200 --no-pager'`。

## 3. 监控告警（邮件来源）

- root cron 每 5 分钟：`/usr/local/sbin/anppt-health-monitor.py`（日志 `/var/log/anppt-monitor.log`，状态 `/var/lib/anppt-monitor/state.json`）。
- 检查项：slideflow-studio/caddy 服务存活 + `https://ppt.an520.xin/api/health` + 磁盘 + **anppt-v2 备份新鲜度（26h 无新备份即告警）**。（img2pptx-v4-node 已于 2026-08-22 退役下线，见 §17。）
- **health 契约**：顶层 `ok`、`llm.configured`、`image.configured`、`editable.configured`——缺了任何一项监控就误报。连续失败 2 次起每 5 分钟发邮件到 366150820@qq.com，恢复后发一封恢复通知。

## 4. 业务主链路（整套 PPT）

注册/登录（邮箱 OTP 或手机号短信 OTP 或密码，注册送 100🌟）→ 上传文档（txt/md/docx/pdf；页数支持四档快捷或自定义 4–40 页，服务端 `/api/deck/parse` 上限 40，自定义时汇报时长按 1.5 分钟/页派生；超 20 页不可转可编辑 PPTX，见 §可编辑导出限制）或按页录入 → 大纲（LLM）→ 内容梳理（tagged DSL，结构校验+数据保真 diff）→ 确认冻结（contentLocked）→ 选择公开正式风格包（测试资产已过滤）→ 逐页生图（10🌟/页）→ 导出。

关键代码：
- 大纲/引擎：`src/lib/server/engine.ts`（**引擎 3002 的 internal/ppt 契约端点未上线，无 PPT_ENGINE_INTERNAL_TOKEN 时走 LLM 兜底——这是定案**）。LLM 提示按创新创业/挑战杯、技能教学/世校赛、职业规划、企业经营、政企行政、科研学术六类场景选择叙事骨架；页数不足时合并、原文无依据的任务省略，禁止机械套模板和补造事实。改动必须同步更新契约测试。
- 生图 prompt 组装：`src/lib/server/generation/style-packs.ts`（整套标题 + 有限原文语义用于场景/受众推断，不直接泄露进提示词；逐页注入同风格参考、页型任务、原创设计 DNA、文案与易转可编辑约束）。页型归一：`src/lib/server/generation/page-types.ts`（35 页型，覆盖赛事、企业、政企、科研、教学与技能展示；role 优先 + 关键词最长匹配）。
- 风格数据：`src/data/style-packs.ts` 保留 30 个稳定 id，公开过滤 2 个测试目录后展示 28 包；公开名称/slug 已整理，`legacySlugs` 兼容历史链接。`src/data/style-design-dna.ts` 为每包维护色板、栅格、装饰母题、场景和逐页参考类别。
- 生成管线：`src/lib/server/generation/generate.ts`（估价→整单 402 预检→建 job→单套逐页并发 6；`images.ts` 再统一约束全站在途 20 / 每分钟启动 24→debit 幂等键 `deck-generate:{deckId}:{jobId}:{slideId}`→失败 refund）。每个已启动任务固定一次配置快照，管理员中途改模型、并发或密钥只影响后续任务。
- 状态机：decks.ts（parsed→outlined→structured→confirmed→generating→generated/partial；stale 作废机制）。
- **崩溃恢复（2026-08-20 上线）**：`src/lib/server/generation/recovery.ts`。重启/崩溃打断生成后，deck 卡 generating（409 死锁）、页卡 queued/running、已扣费页无退款的问题由懒恢复解决：`getDeckState`/`startDeckGeneration`/单页读写入口触发 `reconcile*`，把中断页收敛为 failed、deck 收敛为 partial/confirmed，并按 ledger **实扣金额**补退款（refund 幂等键与正常失败退款同格式，不双退）。判定依据 = job 心跳（每页完成刷新 `generation_jobs.updated_at`）超过 `ANPPT_V2_JOB_STALE_MS`（默认生图超时+2min，下限 5min）或 job 已终态；本进程活跃任务有注册表守卫不会误伤。**整批在途守卫（2026-08-24 修）**：deck 有活跃 job 时整体跳过收敛——页先置 queued、`slide_versions` 行要等蓝图/调度后才逐页落库，此前按「页最新版本所属旧 job 已死」判收敛会把在途页误置 failed，并对 refine/重生成页按旧版本误退原始扣费。单页扣费键存 `single_page_versions.charge_key`（老库懒迁移补列）。
- **软删清理（同日上线）**：`projects.ts` `listProjects` 时懒清理软删超 `ANPPT_V2_PROJECT_RETENTION_DAYS`（默认 7 天）的项目——行级联删除（FK ON）+ 生成图删除（deck 整目录、单页按 version.image_path）；导出文件与 uploads 不清；**credit_ledger 永不删除**。

## 5. 计费与支付

- 价格表：`src/lib/server/env.ts` DEFAULT_ACTION_PRICES（`deck_page_generate:10`、`export_editable:20`、`export_editable_text:5`、outline/export_image:0）。可用 env `CREDIT_ACTION_PRICES` JSON 覆盖（整体覆盖缺 `export_editable_text` 时轻量档回退 5🌟/页）。
- 充值档：DEFAULT_RECHARGE_PLANS（¥9.9/100🌟、¥39.9/500🌟、¥79.9/1000🌟、¥149.9/2000🌟），env `RECHARGE_PLANS` 可覆盖。
- 账：`credit_ledger` 幂等键防重；所有扣费先整单估价+余额预检（402）；失败自动退还（refund 键唯一）。
- **幂等键口径（2026-08-24 修复）**：deck 生成/导出的键含服务端 jobId/exportId，客户端不可控；单页生成/改图接受客户端 `requestId`，命中幂等键（`duplicate`）一律 409 `DUPLICATE_REQUEST` 拒绝——此前只防重扣不防重生，重放可扣一次费无限生图且失败分支误退首笔。前端不传 `requestId`（永远落服务端 jobId），拒绝重放不影响第一方 UI。
- 支付渠道：
  - **epay 支付宝收银台（活）**
  - **微信支付 Native 直连（2026-08-20 已上线）**
    - 密钥目录 `/opt/anppt-v2/shared/secrets/`（`600 ubuntu:ubuntu`）：`wechat-pay-private.pem`（商户私钥）、`wechat-pay-platform-public.pem`（平台公钥）。**绝不打印/提交/外传。**
    - `.env`：`WECHAT_PAY_ENABLED=true`，`WECHAT_PAY_*_PATH`/`_FILE` 指向上述 secrets；商户号 `1747212050`、APP `wxeb7e1885c25df663`、证书序列与 APIv3 已为真值（值本身勿入手册）。
    - 回调：`POST /api/recharge/notify/wechat`（平台公钥验签 → 幂等入账）。
    - **mock 硬拒（2026-08-24）**：`NODE_ENV=production` 时 `WECHAT_PAY_MOCK`/`EPAY_MOCK` 被强制关闭（加载期大字告警），免验签回调只存在于非生产，误开不会变免费充值。
- 频控（进程内固定窗）：登录/注册按 IP+账号；下单/兑换按用户+IP 20/h；**免费 LLM 动作（outline 重生成/structure/拆页）按用户 30 次/10min**（复用路径不计）；**上传按用户 60 次/h**（2026-08-24 加，防零成本刷上游与磁盘）。
    - **坑**：下单 `description` 不可含 emoji/非 BMP。微信报「请求内容传入了非UTF8参数」。`sanitizeWechatDescription` 必须用 `/[^\u0000-\uFFFF]/gu`（**带 `u` 旗**）；无 `u` 时代理对各自落在 BMP 内，过滤失效。建单文案用「星」不用「🌟」。
    - 验收：先只建单（`codeUrl` 以 `weixin://` 开头）不付款；真实小额扫码由人工核对回调验签 + 星星入账 + 订单 `paid`。

## 6. 转可编辑 PPTX（Codia 链，20🌟/页）

- 代码：`src/lib/server/codia.ts`（客户端）、`src/lib/server/exports.ts`（deck / single-page / upload 共用 `launchEditableExport` + 管线 + 懒恢复）、路由 `POST /api/deck/[id]/export-editable`、`POST /api/single-page/export-editable-pptx`、`POST /api/editable-conversions`，状态 `GET /api/pptx-exports/[id]`。
- 流程：站内作品读页图，外部入口接受单份 PDF 或最多 20 张 PNG/JPG；图片先用 pdf-lib 合成 image-only PDF → Codia 上传（multipart `file`）→ 建任务（`Idempotency-Key: anppt-editable-{exportId}`）→ 4s 轮询真实进度 → PPTX 流式写临时文件并原子落盘。上传源 PDF 在所有终态安全删除。
- 幂等：同项目进行中任务直接复用；同一来源指纹已有成功结果默认复用；只有显式 `force=true` 才重新建任务、重新扣星。查重、建行、扣费在同一 `BEGIN IMMEDIATE` 事务中。
- 请求恢复：GET 最多 3 次；上传与带固定 `Idempotency-Key` 的建任务最多 2 次；仅网络错误、429、5xx 与非 JSON 临时响应短退避恢复。401/402/403 与业务参数错误不盲目重试。建任务重试始终复用同一幂等键。
- 失败语义：task failed 自动以 `-retry1` 键重建一次（上游对 failed 任务幂等退费，不双扣）；再失败 → 幂等退星 + 行 failed。普通用户只看到“服务器开小差/稍后在下载中心查看”等安全文案，不暴露 Codia 名称、私网地址、密钥、额度或上游响应正文；原始技术信息只进服务端日志。上游 402 → 立即退星 + journal 告警。
- 懒恢复：pending/processing 的 editable 行在 getExport/listExports 时被现场推进（有 task_id 现场 poll；无 task_id 且创建超 30s 后台重跑整条管线，幂等安全）。上游状态轮询没有虚假的前端倒计时。
- 限制：每任务 ≤20 页（EXPORT_TOO_MANY_PAGES）；deck 必须 status==='generated'；单页项目取全部有 activeVersion 的页；同 ref 并发请求复用同一任务，不返回重复任务、不重复扣星。
- Codia 计费：13 credits/页，提交即扣；用户已订 $49/月档（5500 credits ≈ 423 页/月）。**禁止为测试真实调用 Codia**（测试全 mock）。
- 官方文档：https://codia.ai/pdf-to-editable-ppt-api 、https://codia.ai/blog/notebooklm-style-pdf-to-editable-pptx-open-api

## 7. 前端要点

- 工作台：`src/components/deck/deck-workbench.tsx` + `step-*.tsx`（生成 CTA 状态机：生成中禁用「正在生成中…」/部分完成「生成剩余 N 页」/全完成「使用此风格重新生成」）。
- 内容梳理：`src/components/deck/step-structure.tsx` 支持标题、区域、模块、正文、重点正文、数据、表格等块的可视化增删改、排序与高级 DSL 双模式；客户端解析后仍由服务端 `validateTaggedDsl()` 校验。编辑器打开时禁用批量梳理与失败页重试，避免竞态；普通正文换行保存时合并为空格，刷新后仍能正确解析。
- 转可编辑按钮：`step-generate.tsx`（仅 deck.status==='generated' 可点）与 `single-page-client.tsx` 共用 `useEditableExport`；刷新/离开后恢复原任务，完成时明确提示已进入下载中心，成功结果可直接下载，显式“重新转换”才再次扣星。
- 下载中心：`src/app/(main)/exports/page.tsx`（来源文件名、真实页数/进度、状态、反复下载；processing 自动刷新）。侧栏有「下载中心」入口。
- 外部文件转可编辑：侧栏 `/tools/editable-converter` 已上线，支持 PDF 与图片排序；未登录先引导登录，不会误发受保护请求。
- 本地编辑器：侧栏 `/tools/onlyoffice` 已上线；未充值不显示下载链接，三个 Windows 下载路由再次做服务端权益校验。

## 8. 测试与验证（全部零真实付费调用）

```bash
node scripts/test-generation.mjs  # 当前 294 断言，Codia/生图/VLM 全部 mock
node scripts/test-backend.mjs     # 当前 124 断言，含管理员权限/开关板/只读连接检查/ONLYOFFICE
npm run lint -- --max-warnings=0
npx tsc --noEmit
npm run build
git diff --check
node scripts/e2e-ui-audit.mjs        # Playwright 真机 UI 审查（需要登录态，见脚本头注释）
BASE_URL=http://localhost:3000 node scripts/e2e-fullchain.mjs  # ⚠️ 真实生图扣费（约 $0.08），慎用
```

## 9. 日志前缀速查

- `[anppt-v2][codia]` — Codia 上游调用/402 告警
- `[anppt-v2][exports]` — 导出管线/退星失败
- `[anppt-v2][generation]` — 生成管线/退星失败
- `[anppt-v2][recovery]` — 崩溃懒恢复触发（出现即说明发生过中断，值得看上一条 journal）
- `[anppt-v2][admin]` — 管理员审计写入或运行时配置异常（日志仍须脱敏）
- `[anppt-v2][api] unexpected error` — 路由未捕获异常（含堆栈）

## 10. 已知未修（勿重复排查）

- **大纲错误口径已统一（2026-08-20 修）**：`engine.ts` `generateOutline` 兜底路径已包 `engineFailure()`——超时/非 JSON/未配置统一 `ENGINE_UNAVAILABLE` 503 可重试；空大纲保持 `OUTLINE_FAILED` 502。线上生效需部署。
- 磁盘 78%（非 AnPPT 数据，53M）；导出文件（exports/）无清理机制，量大后需运维处理。
- 注册仅需用户名+密码即送 100🌟，可换 IP 刷号薅生图成本（产品决策）。
- 当前 140 张风格样张路径完整，但仍是迁移期素材；禁止将它们误称为原创资产，需按 `docs/ORIGINAL-TEMPLATE-REGEN.md` 分批原创重制并原子替换。

## 10.1 LLM 模型链与回退（2026-08-21 上线）

- 大纲/内容梳理的 LLM 兜底走「模型链」：`ANPPT_V2_LLM_MODEL`（主）+ `ANPPT_V2_LLM_FALLBACK_MODELS`（回退，逗号分隔，最多 3 个）。
- 当前线上：主 `gemini-3.1-flash-lite`（快：20 页大纲 ~10s，原 deepseek-v4-flash 要 31s，kel 真实文档 123s），回退 `gpt-5.6-luna` → `deepseek-v4-flash`（末位兜底）。
- 切换策略：主模型失败（超时/HTTP 错/空响应）自动换下一个；超时梯度 45s/90s/末位 120s。切模型会打日志 `[anppt-v2][engine] LLM 模型 X 失败，切换 Y`——看到即说明主模型有问题。
- **回退操作**（改 env 两行 + `systemctl restart anppt-v2`，改前备份 .env、查在途任务）：
  - 换回 deepseek：`ANPPT_V2_LLM_MODEL=deepseek-v4-flash`、`ANPPT_V2_LLM_FALLBACK_MODELS=`
  - 换主模型：改 `ANPPT_V2_LLM_MODEL`（可用模型见中转 `/v1/models`）
  - 上次备份：`/opt/anppt-v2/shared/.env.bak-20260821-llm`
- 背景：deepseek-v4-flash 是推理模型，出 20 页结构化大纲思考极慢（kel 两单 101s/123s，贴 120s 硬超时悬崖）；gemini-3.1-flash-lite 同任务 9.5s 且输出结构合法。

## 11. 禁区与注意事项

- Caddy 禁区：api/console.an520.xin（另一套系统）、6800 隧道、老机 101.32.220.164、slideflow 3300 服务（不杀、只不再代理）。
- 密钥只存在于服务器 env，任何情况下不打印、不进仓库、不进前端。
- 客户端 IP：`getClientIp` 只信 `X-Real-IP`（Caddy 显式 `header_up` 覆写），XFF 仅作无代理兜底——Caddy 对 XFF 是追加链，首值客户端可伪造，限流曾因此可绕（2026-08-24 修）。
- 大纲与页型契约可继续优化，但必须保持 DSL、历史项目和 `legacySlugs` 兼容，并通过完整生成测试；不得直接照搬第三方模板序列或编造原文没有的页面。
- commit 用英文祈使句；部署前跑齐 generation/backend/lint/typecheck/build 与 `git diff --check`；部署会重启服务。
- 竞品调研资料库：`/Users/an/ZCodeProject/anppt-v2-recon/`（旁门/花卷/抖研三站报告 + 可编辑路线调研 RESEARCH-image-to-editable-pptx-2026.md）。
- 调研资料和已授权前端源码只用于学习机制与交互，不得复制第三方 CDN 图片、PPTX、Logo、品牌文案或远程模板地址进入产品。

## 12. 2026-08-21 全站工具与并发升级

- 外部文件转可编辑：`/tools/editable-converter`，接受单份 PDF 或最多 20 张 PNG/JPG；统一走 `pdf_to_ppt`，20🌟/页。任务记录 `ref_type=upload`，同内容指纹复用，刷新后从下载中心恢复。
- ONLYOFFICE：`/tools/onlyoffice`。软件本身是第三方开源免费软件；AnPPT 的三个 Windows 一键下载入口、版本校验、兼容工具包与附带支持，仅在任意真实充值成功后永久解锁。权益判定为 `recharge_orders.status='paid'`，兑换码不算“充值一次”。
- 项目导航：侧栏只保留一个「我的项目」，页面按 `updated_at DESC` 同时承担原“最近项目”视图。
- 生图调度：单套默认并发 6、全站最大在途 20、滚动每分钟启动 24；429/5xx/网络抖动最多后台恢复 2 次，400/401/403/超时不盲目重试；单请求超时默认 8 分钟。
- 下载：`/api/files/...` 使用文件流，支持 `HEAD`、`Range`、206 和 416；Codia PPTX 结果也直接流式落盘，避免并发时整文件进入 Node 堆内存。
- 原创模板生成链：已落地「整套场景识别 → 六类叙事骨架 → 35 页型任务 → 逐页同风格参考 → 25 包设计 DNA」。当前不调用付费生图批量重制；后续按高校赛事、企业商务、政企工作三套逐张验收并原子替换，详见 `docs/ORIGINAL-TEMPLATE-REGEN.md`。

## 13. 管理员后台与运行时配置（2026-08-22）

- 入口：`/admin`。页面与 `/api/admin/**` 都会校验当前会话用户 `users.role='admin'`；普通用户页面重定向、API 返回 403。管理员身份来自数据库角色，不硬编码邮箱。
- 能力：总用户/24h 新增/生成与导出在途/24h 失败/项目数、进程内存、磁盘、数据库、集成配置状态、最新注册用户与最近审计可视化；支持生成 1000 星等兑换码和用户角色管理。（2026-08-26 起按用户决策移除“重点用户监控”，`admin_user_watches` 表随之废弃。）
- 运行时配置：LLM、生图、Codia 与容量参数保存在 DB；密钥由 `ANPPT_V2_ADMIN_CONFIG_KEY` 派生 AES-256-GCM 密钥后加密，浏览器只获得“已配置”和短指纹，永不返回明文。公网 API 地址必须 HTTPS，HTTP 只允许本机/内网。
- `ANPPT_V2_ADMIN_CONFIG_KEY` 至少 32 字符，只能存在生产 `.env`，文件权限保持 600。**轮换前必须先导出/重新录入所有运行时密钥**；直接更换主密钥会使旧密文无法解密。备份 `.env` 时同样按密钥材料保护。
- 连接检查零付费：LLM/Image 仅 `GET /models`，Codia 仅 `GET /v2/open/credits`；三者均 `redirect: 'error'`，不会跟随到未知端点，不调用 `/tasks`、`/uploads`、聊天或生图接口。
- 运行时配置有 30 秒进程缓存；保存/清除后主动失效。已经启动的生图或可编辑任务使用启动时配置快照，避免中途切换密钥/地址造成半套任务跨供应配置。
- 所有管理员写操作进入 `admin_audit_logs`；详情递归脱敏 secret/password/token/api key/authorization/cookie/private key 等字段，审计写失败只记服务端错误，不反向破坏已成功业务操作。

## 14. 上游消耗本地计量与财务统计（2026-08-22）

- 口径（用户拍板）：**只记本项目自己的逐条消耗**，不拉上游余额接口。每次真实上游调用（LLM/生图/Codia）落一条 `upstream_usage_records`（provider/kind/model/status/tokens/units/cost_fen/duration_ms）。
- 计量代码：`src/lib/server/usage-meter.ts`（`recordUpstreamUsage`，全路径 try/catch——**记账绝不允许影响主流程**）；接入点在 engine/images/codia 的真实上游调用处。
- 金额估算：`cost_fen` 仅在 `ANPPT_V2_COST_*` 单价 env 配置后衍生估算；未配置保持 NULL——**tokens/张数/次数是上游返回的真实数据，金额只是衍生**。汇总时整组未定价则 costFen 为 null（未配置单价 ≠ 花费 0）。
- 统计接口：`GET /api/admin/finance`（仅 admin）→ `src/lib/server/finance-stats.ts`，返回收入（充值订单）+ 内部消费（星星账/兑换码）+ 上游消耗（total/last30d/byProvider，按 provider+kind+model 分组——便宜渠道与贵渠道据此分开）。当前只有 API，无后台页面。
- 注意：byProvider 分组里的 `model` 字段承载渠道区分（如 seedream vs gpt-image-2），排查成本时先看这一层。

## 15. 功能开关板与测试用户（2026-08-22）

- 机制：`src/lib/server/feature-flags.ts`。三态状态机 `off`（仅管理员）→ `beta`（测试用户+管理员）→ `public`（全员）；新功能一律 beta 起步。
- 登记：新功能在 `FEATURE_FLAG_DEFS` 加一条（key/label/description/defaultState）；运行时状态存 `feature_flags` 表（非密文，区别于加密运行时配置），未覆盖时用 defaultState。
- 服务端硬门：`assertFeatureVisible(key, user)`——不可见一律 **404 NOT_FOUND「功能不存在或尚未开放」**，不暴露功能存在性。前端用 `GET /api/features` 的可见性地图隐藏入口（未登录按普通用户）。
- 测试用户：`users.role='tester'`；管理员在 `/admin` 用户行「设为测试」一键升降（`/api/admin/users/[id]/role`，拒动 admin）；开关管理 `GET/PUT /api/admin/feature-flags`，全部写操作进审计。
- 验收路径：新功能 beta → 测试用户实测 → 管理员后台转 public。**普通用户在 public 之前任何路径都摸不到功能（含直接 POST 路由）**。

## 16. 轻量文字可编辑导出（editable_text_overlay，beta，5🌟/页）

- 定位：对标花卷「导出编辑文字PPT」的自研轻量档——成本近零（不调擦除/重建 API），与 Codia 重转换档（20🌟/页）并存；`export_jobs.kind='editable_text'` 与 `'editable'` 分账互不串扰。
- 链路（`src/lib/server/exports.ts` `runTextEditablePipeline`）：读页图 → **主 LLM 链 VLM** 提取文字块（bbox/字号/颜色/字重/对齐，`TEXT_EXTRACT_PROMPT` 自写提示词，未抄竞品）→ sharp 采样文字区外围底色 → pptxgenjs 整页图垫底 + 纯色底文本框覆盖。
- 路由：`POST /api/deck/[id]/export-editable-text`（挂 `assertFeatureVisible('editable_text_overlay')` 硬门）；状态/下载复用 `GET /api/pptx-exports/[id]`；下载中心列表 `kind` 过滤，标签「文字可编辑」。
- 失败语义：**单页提取失败只记日志降级**（该页无文本框，整页图仍在，不中断）；全部页失败才整单 failed + 幂等退星（ledger 前缀 `export-editable-text`，与 Codia 档 `export-editable` 分开）。用户文案：「文字层提取服务暂时不可用，星星已退回；稍后可重新转换。」upload 来源暂不支持（发起即校验）。
- 计价：独立动作 `export_editable_text`（5🌟/页），估价/预检/幂等键/退星与 Codia 档同套机制；VLM 消耗照常落 `upstream_usage_records`（provider `llm-primary`，kind `chat`）。
- 懒恢复：`ensureEditablePipeline` 按 kind 分发，重启不丢单；复用/重转语义与 Codia 档一致（显式「重新转换」才再扣星）。
- 前端：`step-generate.tsx` 底栏按钮（挂 `/api/features` 可见性）+ `use-editable-export` 的 `kind` 选项；实测截图 `output/playwright/text-editable-bar.png` / `text-editable-modal.png`。
- **禁止为测试真实调用 VLM**（测试全 mock）；dev 真机实测过一次（2 页 ≈18s，PPTX 解包确认文本框分级字号正确）。

## 17. img2pptx-v4-node 退役（2026-08-22）

- 背景：v1 时代自研"图片转可编辑 PPT"Node 服务（127.0.0.1:8014），可编辑链路已由 Codia 重转换档（§6）+ 轻量文字档（§16）完全替代；anppt-v2 代码与 Caddyfile 均无任何引用，删除无调用方风险。
- 已执行：停+disable `img2pptx-v4-node.service` 并删 unit → 监控脚本 `/usr/local/sbin/anppt-health-monitor.py` 移除该检查项（备份 `.bak-20260822`，语法已验）→ 删除 `/opt/img2pptx-v4-node`、`/opt/img2pptx-fonts`、`/opt/img2pptx-v4-releases`、`/opt/img2pptx-v4-rollback-20260804-contract-v1`（释放 ~1.5G）→ transient 单元记录已 reset-failed。
- 代码保全：GitHub `An-an-525/anppt-img2pptx-v4`（main + codex/font-match-v2 + codex/v4.2.2-font-quality）；服务器最终运行版源码归档在本地 `~/Documents/AI PPT/AnPPT-asset-archive/img2pptx-v4-retired-20260822/`（`img2pptx-v4-final-20260822.tar.gz` 508 项，含源码/docs/deploy/backups，排除 venv/cache/staging/qa 产物；releases 构建产物只留 manifest，按 commit hash 可重建）。**wip/qwen-normalize-2026-08-15 分支在本地、服务器、GitHub 三处均未找到**，若日后冒出可对照归档恢复。
- 删后验证：`/api/health` ok（llm/image/editable 全 configured）、anppt-v2 active、监控手动跑"全部正常"。

## 18. 金奖版式测试包（gold_layouts_beta，beta，2026-08-24）

- 定位：从 2025 国赛金奖路演 PPT（14 份已脱敏研究，产物在 anppt-v2-recon/award-samples/）提炼的 6 页真模板——封面/痛点卡片列/单字锚点对比/竞品整行高亮表/数据大字页/对仗封底。用户裁定「版式锁死、只能改内容」→ kind=template 真模板路线（灌内容，非借风格）。
- 门控机制（测试资产挂开关板的成例）：包登记在 `src/data/style-packs.ts` 的 **`GATED_STYLE_PACKS`（不进 STYLE_PACKS 公开数组**，客户端 bundle 天然不含）；`StylePack.featureFlag='gold_layouts_beta'`。服务端全集出口 `ALL_STYLE_PACKS` 供 findStylePack/getTemplate 解析；`templates.ts` 的 `visibleStylePacks(user)` 是列表注入唯一入口，`assertStylePackUsable(stylePackId, user)` 是生成硬门（不可见 404）。
- 挂接点：`/api/style-packs`、`/api/templates`（listTemplates 第二参带 user）、`/api/templates/[id]`（不可见 404）、建 deck 两路由（parse/paged-copy-v2）、actions `style` 动作，全部走同一硬门。前端三组件（UploadCard/step-style/TemplateLibrary）用 `src/components/use-gated-style-packs.ts` 按 `/api/features` 并入列表——只决定「列不列出来」，兜底在服务端。
- 载体：`public/assets/style-packs/gold-tianxun/01..06.png`（虚构项目「天巡」，AI 直出已验收，见 award-samples/samples/VERDICT.md）；`templatePages` 逐页标注逻辑页型，mapping 精确命中，未覆盖页型兜底内容桶。DNA 用 COMPETITION_ACADEMIC 预设。
- 单页工作室（sp-panels）**未接入**门控包（beta 期只走 deck 主流线）；核心技术页框图/证据墙页维持「需程序化底座」判断，未进本期。
- 转正式路径：测试用户实测 → 用户说「采纳」→ 包从 GATED 移入 STYLE_PACKS + 摘 featureFlag + 开关转 public 后移除登记。
- 转正式路径：测试用户实测 → 用户说「采纳」→ 包从 GATED 移入 STYLE_PACKS + 摘 featureFlag + 开关转 public 后移除登记。

## 19. 图片级编辑四工具（magic_erase / image_text_edit / template_fusion / set_as_reference，off 起步，2026-08-24）

- 定位：挂在单页编辑器（step-generate.tsx SlideEditor 右侧「图片级编辑工具」区）的四件图片级工具，对标花卷高精清除/修改文字/模板融合/设为参考图。四件各自挂开关板 key（均 `defaultState:'off'`，仅管理员可见可用），硬门在 `actions.ts` 调度入口 `EDIT_ACTION_FLAGS`——off 时与未知 action 一样 404，不进任何校验。
- 共用机制：erase-slide / text-edit-slide / fuse-slide 全部复用 `kind:'deck-refine'` 管线（估价/402 预检/幂等键/失败退星零新增），计价动作 = `deck_page_refine`（默认可参见 §5 价格表）；提示词即 edits 指令原文（不再套生成 prompt），版本 kind='refine' 正常进版本切换。set-reference 不生图不扣费。
- **高精清除（erase-slide）**：前端涂抹模式在大图上叠 1536x864 canvas（红色半透明笔刷），导出 dataURL 随 `markImageDataUrl` 提交；服务端 `dataUrlToBuffer` 校验 ≤2MB。双图 edits（原图+标记图），固定提示词：「第二张图是第一张的标记版，红色涂抹区是要擦除的内容…图上不得出现红色标记」（自写）。
- **图上改字（text-edit-slide）**：单图 edits；指令 = 用户输入 + 「只改指定文字，其余元素、版式、配色全部保持不变」硬约束。
- **模板融合（fuse-slide）**：body 带 `fusionPackId`（必须 kind=template，门控包过 `assertStylePackUsable` 硬门）；取该包同页型样张作第二图——复用 `buildOutlinePageMapping`+`resolveTemplateReferenceImage` 兜底链（末位首页样张）。指令 = 「把第一张图的版式骨架保留，视觉风格向第二张参考图靠拢融合，文字内容保持不变」+ 可选补充要求。
- **设为参考图（set-reference）**：把该页 activeVersion 图路径写入 `decks.anchor_slide_id/anchor_image_path`（懒迁移补列，见 generation/db.ts）；`slideId` 为空即取消。参考图优先级改为 **锚点 > 真模板 mapping > 风格样张**（generate.ts `promptForSlide`）；锚点存站点存储而非 public，生成时 `readSiteFile` 读取，读取失败降级为无参考不阻塞。改图侧：erase/fuse 自带第二图不叠加；指令微调与图上改字若已设锚点，自动附锚点为第二图并拼「风格锚点」提示行。锚点是路径快照：该页后续重生成/切换版本不回写锚点，unlock 作废页也不清锚点（图文件随 deck 保留至物理清理）。
- **atlascloud 灾备降级**：多图 edits 只在主站（an520 /images/edits 多 `image` 字段，已实测）使用；切到灾备站（多图支持未验证）时丢弃附加图，把第二图意图以文字描述拼进 prompt（erase 用固定兜底文案，fuse 带包名+视觉关键词），并打 `[anppt-v2][image-upstream] 灾备渠道多图编辑未验证` 日志。atlasHttp 已改为吃 `deps.fetchImpl`（此前直连全局 fetch，无法 mock）。
- 前端：四件按 `/api/features` 逐件显示；提交走 `run()` + toast + `notifyCreditsRefresh()`（set-reference 不刷星）；融合包选择器列 `kind==='template'` 的包（STYLE_PACKS + useGatedStylePacks，排除当前包）。涂抹中 ESC/切页会直接退出编辑器（涂抹态随组件重挂载丢弃）。
- 测试约束：scripts/test-generation.mjs [18] 段全 mock（双图字段数/提示词约束/扣费/锚点优先级/灾备降级/开关 off 404）；开关可见性矩阵在 test-backend.mjs [11]。**禁止真实调用生图上游**；真机验收走 dev 小额度。

## 20. 老站（slideflow-studio）用户迁移（2026-08-26 已执行）

- 口径（用户拍板）：只迁 4 个真实账号——kele_88 / admin / an / qa_v65_0814205915；跳过 9 个禁用冒烟号、e2e 测试号、撞名老 kel、4 个 otp_* 手机用户（手机号哈希不可逆，迁了也登不了，日后人工兜底）。
- 余额 = 老 `billing_accounts.purchased_credits` + 100🌟 迁移礼：kele_88=1060、admin=120、an=100、qa_v65=100。台账拆两行（purchased 部分 bucket='purchased' + 礼 bucket='bonus'），event_type='migration'，幂等键 `migrate-slideflow:<old_user_id>:<part>`。
- 密码哈希与老站完全同构（`scrypt:v1:…`，107 字符），直接搬即可登录；role 保留（admin/an 仍是 admin）。
- 脚本：`scripts/migrate-slideflow-users.mjs --from <老库> --to <v2库> [--dry-run]`，幂等可重复执行（username 冲突跳过 + ledger 键防重）；服务器上需 `sudo -n node`（库属 root）。老站项目/PPT 数据不迁（轻量化决策），老 slideflow 3300 服务保留可查。
- 同批轻量化：移除「重点用户监控」功能（`admin_user_watches` 表本地+线上均已 DROP，代码/路由/前端/测试全清）。
