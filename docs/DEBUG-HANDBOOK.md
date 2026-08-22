# AnPPT 探查与 Debug 手册（agent 交接用）

> 写给接手探查/debug 的 agent：本文是系统全貌的唯一权威入口。改完代码请同步更新本文。
> 最后更新：2026-08-22（管理员后台、可视化内容编辑、Codia 稳定性与原创生成链）

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
- 检查项：slideflow-studio/img2pptx-v4-node/caddy 服务存活 + `https://ppt.an520.xin/api/health` + 磁盘 + **anppt-v2 备份新鲜度（26h 无新备份即告警）**。
- **health 契约**：顶层 `ok`、`llm.configured`、`image.configured`、`editable.configured`——缺了任何一项监控就误报。连续失败 2 次起每 5 分钟发邮件到 366150820@qq.com，恢复后发一封恢复通知。

## 4. 业务主链路（整套 PPT）

注册/登录（邮箱 OTP 或手机号短信 OTP 或密码，注册送 100🌟）→ 上传文档（txt/md/docx/pdf）或按页录入 → 大纲（LLM）→ 内容梳理（tagged DSL，结构校验+数据保真 diff）→ 确认冻结（contentLocked）→ 选择公开正式风格包（测试资产已过滤）→ 逐页生图（10🌟/页）→ 导出。

关键代码：
- 大纲/引擎：`src/lib/server/engine.ts`（**引擎 3002 的 internal/ppt 契约端点未上线，无 PPT_ENGINE_INTERNAL_TOKEN 时走 LLM 兜底——这是定案**）。LLM 提示按创新创业/挑战杯、技能教学/世校赛、职业规划、企业经营、政企行政、科研学术六类场景选择叙事骨架；页数不足时合并、原文无依据的任务省略，禁止机械套模板和补造事实。改动必须同步更新契约测试。
- 生图 prompt 组装：`src/lib/server/generation/style-packs.ts`（整套标题 + 有限原文语义用于场景/受众推断，不直接泄露进提示词；逐页注入同风格参考、页型任务、原创设计 DNA、文案与易转可编辑约束）。页型归一：`src/lib/server/generation/page-types.ts`（35 页型，覆盖赛事、企业、政企、科研、教学与技能展示；role 优先 + 关键词最长匹配）。
- 风格数据：`src/data/style-packs.ts` 保留 30 个稳定 id，公开过滤 2 个测试目录后展示 28 包；公开名称/slug 已整理，`legacySlugs` 兼容历史链接。`src/data/style-design-dna.ts` 为每包维护色板、栅格、装饰母题、场景和逐页参考类别。
- 生成管线：`src/lib/server/generation/generate.ts`（估价→整单 402 预检→建 job→单套逐页并发 6；`images.ts` 再统一约束全站在途 20 / 每分钟启动 24→debit 幂等键 `deck-generate:{deckId}:{jobId}:{slideId}`→失败 refund）。每个已启动任务固定一次配置快照，管理员中途改模型、并发或密钥只影响后续任务。
- 状态机：decks.ts（parsed→outlined→structured→confirmed→generating→generated/partial；stale 作废机制）。
- **崩溃恢复（2026-08-20 上线）**：`src/lib/server/generation/recovery.ts`。重启/崩溃打断生成后，deck 卡 generating（409 死锁）、页卡 queued/running、已扣费页无退款的问题由懒恢复解决：`getDeckState`/`startDeckGeneration`/单页读写入口触发 `reconcile*`，把中断页收敛为 failed、deck 收敛为 partial/confirmed，并按 ledger **实扣金额**补退款（refund 幂等键与正常失败退款同格式，不双退）。判定依据 = job 心跳（每页完成刷新 `generation_jobs.updated_at`）超过 `ANPPT_V2_JOB_STALE_MS`（默认生图超时+2min，下限 5min）或 job 已终态；本进程活跃任务有注册表守卫不会误伤。单页扣费键存 `single_page_versions.charge_key`（老库懒迁移补列）。
- **软删清理（同日上线）**：`projects.ts` `listProjects` 时懒清理软删超 `ANPPT_V2_PROJECT_RETENTION_DAYS`（默认 7 天）的项目——行级联删除（FK ON）+ 生成图删除（deck 整目录、单页按 version.image_path）；导出文件与 uploads 不清；**credit_ledger 永不删除**。

## 5. 计费与支付

- 价格表：`src/lib/server/env.ts` DEFAULT_ACTION_PRICES（`deck_page_generate:10`、`export_editable:20`、outline/export_image:0）。可用 env `CREDIT_ACTION_PRICES` JSON 覆盖。
- 充值档：DEFAULT_RECHARGE_PLANS（¥9.9/100🌟、¥39.9/500🌟、¥79.9/1000🌟、¥149.9/2000🌟），env `RECHARGE_PLANS` 可覆盖。
- 账：`credit_ledger` 幂等键防重；所有扣费先整单估价+余额预检（402）；失败自动退还（refund 键唯一）。
- 支付渠道：
  - **epay 支付宝收银台（活）**
  - **微信支付 Native 直连（2026-08-20 已上线）**
    - 密钥目录 `/opt/anppt-v2/shared/secrets/`（`600 ubuntu:ubuntu`）：`wechat-pay-private.pem`（商户私钥）、`wechat-pay-platform-public.pem`（平台公钥）。**绝不打印/提交/外传。**
    - `.env`：`WECHAT_PAY_ENABLED=true`，`WECHAT_PAY_*_PATH`/`_FILE` 指向上述 secrets；商户号 `1747212050`、APP `wxeb7e1885c25df663`、证书序列与 APIv3 已为真值（值本身勿入手册）。
    - 回调：`POST /api/recharge/notify/wechat`（平台公钥验签 → 幂等入账）。
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
node scripts/test-generation.mjs  # 当前 226 断言，Codia/生图全部 mock
node scripts/test-backend.mjs     # 当前 94 断言，含管理员权限/只读连接检查/ONLYOFFICE
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
- 能力：总用户/24h 新增/生成与导出在途/24h 失败/项目数、进程内存、磁盘、数据库、集成配置状态、最新注册用户、重点用户与最近审计可视化；支持生成 1000 星等兑换码和维护重点用户标签。
- 重点账号只读监控：用于确认余额、登录、项目和任务元数据正常，禁止读取文档正文、原始材料或 prompt，也禁止借监控流程修改余额、角色、项目和任务。
- 运行时配置：LLM、生图、Codia 与容量参数保存在 DB；密钥由 `ANPPT_V2_ADMIN_CONFIG_KEY` 派生 AES-256-GCM 密钥后加密，浏览器只获得“已配置”和短指纹，永不返回明文。公网 API 地址必须 HTTPS，HTTP 只允许本机/内网。
- `ANPPT_V2_ADMIN_CONFIG_KEY` 至少 32 字符，只能存在生产 `.env`，文件权限保持 600。**轮换前必须先导出/重新录入所有运行时密钥**；直接更换主密钥会使旧密文无法解密。备份 `.env` 时同样按密钥材料保护。
- 连接检查零付费：LLM/Image 仅 `GET /models`，Codia 仅 `GET /v2/open/credits`；三者均 `redirect: 'error'`，不会跟随到未知端点，不调用 `/tasks`、`/uploads`、聊天或生图接口。
- 运行时配置有 30 秒进程缓存；保存/清除后主动失效。已经启动的生图或可编辑任务使用启动时配置快照，避免中途切换密钥/地址造成半套任务跨供应配置。
- 所有管理员写操作进入 `admin_audit_logs`；详情递归脱敏 secret/password/token/api key/authorization/cookie/private key 等字段，审计写失败只记服务端错误，不反向破坏已成功业务操作。
