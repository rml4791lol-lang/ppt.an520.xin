# AnPPT 探查与 Debug 手册（agent 交接用）

> 写给接手探查/debug 的 agent：本文是系统全貌的唯一权威入口。改完代码请同步更新本文。
> 最后更新：2026-10-28（门命令化 `npm run gate`、提交前钩子与 CI、工作树脚本、测试互斥、发布脚本 `npm run release`；此前：问题日志请求追踪 / 脱敏 / 落盘健康契约 / 发布后自动校验与回滚；PPT 美化批量任务服务端化 / 刷新续看 / 项目更新时间按页修正）

## 1. 系统是什么

ppt.an520.xin = **AnPPT**（anppt-v2）：AI 生成 PPT 网站。技术栈：Next.js 16.3.1 App Router + React 19 + TypeScript + better-sqlite3（WAL）+ 自研 lib 层。生图走 OpenAI 兼容图片接口，大纲/梳理走 LLM 模型链，转可编辑走 WPS AIPPT / Image2PPT / Codia 多通道。

- 仓库：GitHub `rml4791lol-lang/ppt.an520.xin`（private）分支 `production`；本地唯一开发目录 `/Users/an/Desktop/Atlas/ppt.an520.xin网站`（2026-10-26 起；旧 `anppt-v2.production` worktree 与 launchd 同步已下线）。
- 站点：https://ppt.an520.xin

## 2. 服务器与部署

- SSH：`ssh hk-hermes`（ubuntu，`sudo -n` 免密可用）。团队账号 `anppt-dev` 使用独立 SSH key，仅能写源码目录并执行受限部署命令。
- 源码：`/opt/anppt-v2/source`（Git，分支 `production`，GitHub 同分支为唯一事实源）。发布目录 `/opt/anppt-v2/releases/<commit>-<timestamp>`，`/opt/anppt-v2/current` 是指向当前 release 的软链。
- systemd 服务 `anppt-v2.service`，监听 `127.0.0.1:3100`。本地开发目录即仓库根 `/Users/an/Desktop/Atlas/ppt.an520.xin网站`，直接推送 `production`；旧的每 5 分钟 fast-forward 同步 worktree 已下线。服务器端改动提交后可执行 `sudo -n -u ubuntu /opt/anppt-v2/bin/publish-production production`，一次完成 push + 发布。
- 环境变量：`/opt/anppt-v2/shared/.env`（SMTP / epay / 微信 / LLM / IMAGE / ALIYUN_SMS_* / ANPPT_V2_CODIA_API_KEY / `ANPPT_V2_ADMIN_CONFIG_KEY` 等）。**密钥绝不打印进会话/日志/仓库**。
- DB：`/opt/anppt-v2/shared/data/anppt-v2.db`（env `ANPPT_V2_DB_PATH`）；上传/生成/导出文件在 `/opt/anppt-v2/shared/data/` 下。
- **每日备份**：root cron `25 3 * * * /usr/local/sbin/anppt-v2-backup.sh`（日志 `/var/log/anppt-v2-backup.log`）。
  内容 = `VACUUM INTO` 在线备份 DB（WAL 一致，勿用 cp）+ `.env`（600）+ 数据清单 + `data-assets.tar.gz`（uploads/generated/exports 三目录打包，~50M），保留 7 天于 `/opt/anppt-v2/backups/daily/`。
  ⚠️ 老的 `anppt-daily-backup.sh`（03:15）备份的是 **slideflow 老系统**，与 anppt-v2 无关，别看错。
- Caddy 反代：`ppt.an520.xin → 127.0.0.1:3100`（Caddyfile 备份 `/etc/caddy/Caddyfile.bak-anppt-20260819-205014`）。
- 部署：本地工作区干净并已提交后运行 `bash deploy/deploy.sh`。脚本把 HEAD 推到 `production`，服务器从 `/opt/anppt-v2/source` 拉取、构建、生成不可变 release，**再次检查三队列**后原子切换 `current` 并 restart。**restart 会打断在线用户的在途请求**；任一队列非 0 或检查失败时只暂存 release，不切换、不重启。重启后还必须通过 `/api/health` 的 `db/logging.ok/logging.writable/release` 契约，失败自动回滚。修改 `deploy/deploy-production.sh` 时先按 `docs/LOGGING.md` §5 做一次 helper bootstrap。
- **发布脚本 `npm run release`（2026-10-28）**：本地与远端历史分叉、`deploy.sh` 的 push 推不动时走这条。补丁用 `git diff --binary`（排除本地工具链与忽略文件）→ 上传（sha256 校验，rsync 可续传，≤3 次）→ 服务器 `git apply` → **`git write-tree` 必须等于本地 `HEAD^{tree}`** → 在远端历史上 `commit-tree` 提交 → push → 触发 `deploy-production`（deploy helper 自带队列检查与健康回滚）。失败语义：push 之前失败会把远端 checkout 恢复到 `remoteHead` 且不留半成品提交；push 之后失败（部署）不回滚已推送的提交，按提示修好后重跑 helper。先 `npm run release -- --dry-run` 确认 base 可解析（远端 HEAD 被推进后先 `git fetch origin` 或传 `--base`）；补丁只含已提交的 HEAD 树。
- **部署前必须同时检查整套生成、PPT 美化批量任务与导出队列**（可编辑转换也可能在后台下载结果）：

```bash
ssh hk-hermes 'sudo -n node' <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/opt/anppt-v2/shared/data/anppt-v2.db", { readOnly: true });
console.log({
  generation: db.prepare("SELECT count(*) c FROM generation_jobs WHERE status IN ('queued','running')").get().c,
  singlePageBatches: db.prepare("SELECT count(*) c FROM single_page_batches WHERE status IN ('queued','running')").get().c,
  export: db.prepare("SELECT count(*) c FROM export_jobs WHERE status IN ('pending','processing')").get().c,
});
NODE
```

  任一结果 > 0 → 等任务自然完成后重新检查，禁止直接重启。崩溃恢复虽可退款/续查，但会明显伤害 20 页生成与转换体验。
- 看日志：`ssh hk-hermes 'sudo -n journalctl -u anppt-v2.service -n 200 --no-pager'`。

## 3. 监控告警（邮件来源）

- root cron 每 5 分钟：`/usr/local/sbin/anppt-health-monitor.py`（仓库副本 `deploy/anppt-health-monitor.py`；日志 `/var/log/anppt-monitor.log`，状态 `/var/lib/anppt-monitor/state.json`）。SMTP 读 **`/opt/anppt-v2/shared/.env`**，不要读 slideflow 的 `.env`。
- 检查项：`anppt-v2.service` + `caddy.service` 存活 + `https://ppt.an520.xin/api/health`（含 `release`）+ 问题日志落盘/体积 + 磁盘 + **anppt-v2 备份新鲜度（26h 无新备份即告警）** + **生图上游 402（2026-10-26 欠费导致 10 页生成失败的回归闸；30 分钟内出现 402 即告警，非 402 错误 30 分钟内 ≥5 次也报）**。
- **不要**把 `slideflow-studio.service` 列为存活条件：老站已 disable、Caddy 不再代理 3300。禁区仍是不杀、不重新代理；监控盯它会导致每 5 分钟刷邮箱（2026-09-07 修：`fail_count` 曾卡在 33）。img2pptx-v4-node 已于 2026-08-22 退役，见 §17。
- **health 契约**：顶层 `ok`、`db`、`llm.configured`、`image.configured`、`editable.configured`、`plugins` 装配清单（装配失败降级为 `plugins.error`），以及 `logging.ok` / `writable` / `recentFailure` / `totalBytes`。发布验证额外要求 `plugins` 存在且无 `error`、`release` 等于本次 commit；监控对 `plugins.error` 告警（缺字段视为回滚到旧版，不告警）。连续失败 2 次起发一封到 366150820@qq.com；持续异常最多每小时再提醒一次；恢复后发一封恢复通知。
- **QQ From**：告警信 `From` 必须是 SMTP 登录邮箱；中文显示名走 `email.utils.formataddr`（RFC2047）。不要把 `.env` 里带中文、未编码的 `SMTP_FROM` 原文塞进邮件头——QQ 会 550 拒信，监控看起来像“发了”其实没发出去。用户 OTP 走 nodemailer，一般会自动编码，不受这条影响。

## 4. 业务主链路（整套 PPT）

注册/登录（邮箱 OTP 或手机号短信 OTP 或密码，注册送 100🌟）→ 上传文档（txt/md/docx/pdf；页数支持四档快捷或自定义 4–40 页，服务端 `/api/deck/parse` 上限 40，自定义时汇报时长按 1.5 分钟/页派生；超 20 页不可转可编辑 PPTX，见 §可编辑导出限制）或按页录入 → 大纲（LLM）→ 内容梳理（tagged DSL，结构校验+数据保真 diff）→ 确认冻结（contentLocked）→ 选择公开正式风格包（测试资产已过滤）→ 逐页生图（10🌟/页）→ 导出。

关键代码：
- 大纲/引擎：`src/lib/server/engine.ts`（**引擎 3002 的 internal/ppt 契约端点未上线，无 PPT_ENGINE_INTERNAL_TOKEN 时走 LLM 兜底——这是定案**）。LLM 提示按创新创业/挑战杯、技能教学/世校赛、职业规划、企业经营、政企行政、科研学术六类场景选择叙事骨架；页数不足时合并、原文无依据的任务省略，禁止机械套模板和补造事实。改动必须同步更新契约测试。
- 生图 prompt 组装（**八段式**，2026-10-13 定契约）：`src/lib/server/generation/style-packs.ts` —— `SLIDE_PROMPT_STAGE_DEFS` 钉死八段（1 任务与语境 / 2 整套一致性 / 3 页面角色与页型协议 / 4 页面文案与防幻觉 / 5 版式与配图建议 / 6 风格 DNA 与参考样张 / 7 内容真实性硬约束 / 8 易转可编辑条款），`buildSlideImagePromptStages()` 输出结构、`buildSlideImagePrompt()` 按段序拼接（空段跳过、段位不消失）。段数与职责键是对外口径，改段必须同步 `scripts/test-generation.mjs` 的 4 条八段契约断言。整套标题 + 有限原文语义只用于场景/受众推断，不直接泄露进提示词。页型归一：`src/lib/server/generation/page-types.ts`（40 页型，覆盖赛事、企业、政企、科研、教学与技能展示；role 优先 + 关键词最长匹配）。
- 风格数据：`src/data/style-packs.ts` 保留 30 个稳定 id，公开过滤 2 个测试目录后展示 28 包；公开名称/slug 已整理，`legacySlugs` 兼容历史链接。`src/data/style-design-dna.ts` 为每包维护色板、栅格、装饰母题、场景和逐页参考类别。
- 生成管线：`src/lib/server/generation/generate.ts`（估价→整单 402 预检→建 job→单套逐页并发 6；`images.ts` 再统一约束全站在途 20 / 每分钟启动 24→debit 幂等键 `deck-generate:{deckId}:{jobId}:{slideId}`→失败 refund）。每个已启动任务固定一次配置快照，管理员中途改模型、并发或密钥只影响后续任务。
- 状态机：decks.ts（parsed→outlined→structured→confirmed→generating→generated/partial；stale 作废机制）。
- **崩溃恢复（2026-08-20 上线）**：`src/lib/server/generation/recovery.ts`。重启/崩溃打断生成后，deck 卡 generating（409 死锁）、页卡 queued/running、已扣费页无退款的问题由懒恢复解决：鉴权门统一收敛（机制见本段末），把中断页收敛为 failed、deck 收敛为 partial/confirmed，并按 ledger **实扣金额**补退款（refund 幂等键与正常失败退款同格式，不双退）。判定依据 = job 心跳（每页完成刷新 `generation_jobs.updated_at`）超过 `ANPPT_V2_JOB_STALE_MS`（默认生图超时+2min，下限 5min）或 job 已终态；本进程活跃任务有注册表守卫不会误伤。**整批在途守卫（2026-08-24 修）**：deck 有活跃 job 时整体跳过收敛——页先置 queued、`slide_versions` 行要等蓝图/调度后才逐页落库，此前按「页最新版本所属旧 job 已死」判收敛会把在途页误置 failed，并对 refine/重生成页按旧版本误退原始扣费。单页扣费键存 `single_page_versions.charge_key`（老库懒迁移补列）。**整套扣费键入库（2026-10-28）**：`slide_versions.charge_key`（同一懒迁移模式）在**扣费前**随版本行落库，恢复优先读存储键、不再从 deck/job/slide 重拼；迁移前的老行键为空时回退键模块 `deckChargeKey()`，派生出的退款键与正常失败退款同格式（存储键存在但无匹配扣费时**不回退**重拼——否则可能退掉另一笔钱）。**ppt_to_base 懒恢复（2026-10-11 补）**：`ppt_to_base_jobs`（user_id/request_id/charge_key/status/updated_at）在**扣费前**落 running 行，懒恢复把超 `jobStaleMs` 的 running 残留行置 failed 并按 `charge_key` 补退款；读点 = 用户的任意鉴权请求（含站点头部每次加载都查的 `/api/credits/balance`），本进程在途任务有注册表守卫。**退款幂等键统一改为定长派生** `refund:<sha256(chargeKey)[0:32]>`（`credits.chargeRefundKeys`）——旧写法 `${chargeKey}:refund` 在超长键下会被 128 截断撞回扣费键，退款被 duplicate 静默吞掉。**单一收敛实现 + 读口自动接入（2026-10-27）**：原先分散在各生成类型里的三份收敛收成 `recovery.reconcileInterrupted(runs)`——生成类型只列「在途任务 + 收敛动作 + 扣费键」，判活、置终态、按实扣金额补退与日志由它统一做，整套 / 单页 / 可编辑导出 / ppt_to_base 共用。**唯一恢复入口（同日收口）**：`recovery.reconcileUser(userId)` 一次扫该用户的整套 / 单页 / ppt_to_base 三类在途任务，由 `requireUser` 在鉴权门触发；读函数、路由、动作分发都不再各自调用 `reconcile*`，新增读/写接口只要走鉴权门就自动收敛（新增读点无需写恢复代码，已用临时只读路由实测：新接口读一眼即解除死锁并补退，验证后删除）。可编辑导出仍留在模块自己的读路径（`getExport`/`listExports`）现场续跑——它需要模块的 async 管线，进不了同步鉴权门。层内语义不变：可编辑导出是**续跑**（重跑管线、不退星），其余是置 failed + 退星。**技术债清理（2026-10-27）**：`ppt_to_base_jobs` 的读写收归模块（`src/modules/ppt-to-base/server/recovery.ts` 导出结算入口 `interruptedPptToBaseRuns`），平台恢复入口只注入判活口径（本进程注册表 + 心跳）并调度，平台件不再直接 UPDATE 模块表；判活、收敛与退星口径不变。可编辑导出改走 `recovery.reconcileInterruptedRun(run)`，调用方不再伪造 `interrupted: true` 字面量。
- **软删清理（同日上线）**：`projects.ts` `listProjects` 时懒清理软删超 `ANPPT_V2_PROJECT_RETENTION_DAYS`（默认 7 天）的项目——行级联删除（FK ON）+ 生成图删除（deck 整目录、单页按 version.image_path）；**复刻壳图**（`single_pages.shell_path` 与 `uploads/{userId}/replicate/` 中超期且未被在用页引用的文件）一并清；导出文件仍不清；**credit_ledger 永不删除**。

## 5. 计费与支付

- 价格表：**归 pricing 插件**（`src/plugins/pricing/prices.ts` 的 `DEFAULT_PRICES`；动作键与公开动作键的映射在 `src/lib/plugin/contracts/pricing.ts`）。默认 `deck_page_generate:10`、`deck_page_refine:5`、`export_editable:20`、`export_editable_text:5`、`ppt_to_base:5`、`single_page_generate`/`single_page_refine:10`、outline/export_image:0。env `CREDIT_ACTION_PRICES` 可整份覆盖（出现即不回落默认价，缺项 = 该动作未定价）；单页单价走独立旋钮 `ANPPT_V2_SINGLE_PAGE_CREDITS`，不受整份覆盖影响。**换价 = 换 pricing 插件的一份实现（如改从 DB 读价）并换进 profile，平台与业务代码零改动**（ADR-0001 G1，2026-10-27）。
- 充值档：DEFAULT_RECHARGE_PLANS（¥9.9/100🌟、¥39.9/500🌟、¥79.9/1000🌟、¥149.9/2000🌟），env `RECHARGE_PLANS` 可覆盖。
- 账：`credit_ledger` 幂等键防重；所有扣费先整单估价+余额预检（402）；失败自动退还（refund 键唯一）。**退款键（2026-10-11）**：扣费/退款成对键由 `credits.chargeRefundKeys` 生成——`chargeKey` 走 cleanKey（trim+截 128），退款键固定为 `refund:<sha256(chargeKey)[0:32]>`，两侧都断言两键不同；改为拼后缀会在超长 chargeKey 下退化成同一个键、退款静默失效。**整套逐页键唯一来源（2026-10-28）**：由 `src/lib/server/generation/charge-keys.ts` 的 `deckChargeKey()` 产出（前缀 `deck-generate` 与历史账本一致），调用方与恢复都不再拼字符串。
- 估价接口：`estimateCredits` 覆盖全部客户端可见单价，**只经 `ctx.pricing` 读价**（估价与扣费同一来源，`credits.ts` 不 import 任何价格常量）；单页生成/改图用动作键 `single_page_generate` / `single_page_refine`，与 deck 同一张价格表。**任务启动时定格单价快照**：整套生成在 `startDeckGeneration` 估价一次、逐页扣费/退款都用该快照；单页在 `runSinglePageJob` 进入时取一次——任务跑动中换价不会造成估价与实扣漂移。
- **幂等键口径（2026-08-24 修复）**：deck 生成/导出的键含服务端 jobId/exportId，客户端不可控；单页生成/改图接受客户端 `requestId`，命中幂等键（`duplicate`）一律 409 `DUPLICATE_REQUEST` 拒绝——此前只防重扣不防重生，重放可扣一次费无限生图且失败分支误退首笔。前端不传 `requestId`（永远落服务端 jobId），拒绝重放不影响第一方 UI。
- 支付渠道：
  - **epay 支付宝收银台（活）**
  - **微信支付 Native 直连（2026-08-20 已上线）**
    - 密钥目录 `/opt/anppt-v2/shared/secrets/`（`600 ubuntu:ubuntu`）：`wechat-pay-private.pem`（商户私钥）、`wechat-pay-platform-public.pem`（平台公钥）。**绝不打印/提交/外传。**
    - `.env`：`WECHAT_PAY_ENABLED=true`，`WECHAT_PAY_*_PATH`/`_FILE` 指向上述 secrets；商户号 `1747212050`、APP `wxeb7e1885c25df663`、证书序列与 APIv3 已为真值（值本身勿入手册）。
    - 回调：`POST /api/recharge/notify/wechat`（平台公钥验签 → 幂等入账）。
    - **mock 硬拒（2026-08-24）**：`NODE_ENV=production` 时 `WECHAT_PAY_MOCK`/`EPAY_MOCK` 被强制关闭（加载期大字告警），免验签回调只存在于非生产，误开不会变免费充值。
- 频控（进程内固定窗）：登录/注册按 IP+账号；下单/兑换按用户+IP 20/h；**免费 LLM 动作（outline 重生成/structure/拆页）按用户 30 次/10min**（`llm-free`，复用路径不计）；**复刻拆文案**单独走 `replicate-plan` 30 次/10min，不占用大纲桶；**上传按用户 60 次/h**（2026-08-24 加，防零成本刷上游与磁盘）。
    - **坑**：下单 `description` 不可含 emoji/非 BMP。微信报「请求内容传入了非UTF8参数」。`sanitizeWechatDescription` 必须用 `/[^\u0000-\uFFFF]/gu`（**带 `u` 旗**）；无 `u` 时代理对各自落在 BMP 内，过滤失效。建单文案用「星」不用「🌟」。
    - 验收：先只建单（`codeUrl` 以 `weixin://` 开头）不付款；真实小额扫码由人工核对回调验签 + 星星入账 + 订单 `paid`。

## 6. 转可编辑 PPTX（WPS 免费优先 / Image2PPT / Codia 备用，20🌟/页）

- 代码（2026-09-06 归拢进模块）：`src/modules/editable-export/server/wps-aippt.ts`（WPS 内部页面转 PPT 客户端）、`src/modules/editable-export/server/image2ppt.ts`（Image2PPT 客户端）、`src/modules/editable-export/server/codia.ts`（Codia 客户端）、`src/modules/editable-export/server/editable.ts`（deck / single-page / upload 共用 `launchEditableExport` + 多通道管线 + 懒恢复），路由 `POST /api/deck/[id]/export-editable`、`POST /api/single-page/export-editable-pptx`、`POST /api/editable-conversions`，状态 `GET /api/pptx-exports/[id]`，回调 `POST /api/webhooks/image2ppt`。
- 通道接口（2026-10-28，T12）：`server/providers/types.ts` 声明 start / advance / save / cleanup 四个动词与能力声明（`maxPages` / `resumable` / `attempts` / `configured`）；`server/providers/registry.ts` 是回退顺序唯一来源（配置主通道优先 → 剔除未配置 → 按请求页数剔除能力不足的通道）；`server/providers/{wps,image2ppt,codia}.ts` 是适配器。管线与懒恢复只依赖接口，不出现通道名分支；新增第四个通道 = 新增一个适配器文件 + registry 排一次序。
- 主备顺序：`wps` / `auto` = WPS（配置 Cookie 时）→ Image2PPT → Codia；`image2ppt` = Image2PPT → WPS → Codia；`codia` = Codia → Image2PPT → WPS。顺序由 registry 产出，并按请求页数过滤——WPS `maxPages=50`、Image2PPT `maxPages=50`、Codia `maxPages=20`（上游单任务 ≤20 页），所以 >20 页的请求自动剔除 Codia；站内 20 页商品上限仍是独立策略（`EDITABLE_MAX_PAGES`，属另一张票的口径，不在通道能力里）。任一通道成功即停，全部失败才退星。WPS 是网页内部接口而非公开 API，必须由服务端 WPS 登录 Cookie 驱动，受登录态、限时免费额度和风控影响；Cookie 失效或转换失败时自动回退，不向普通用户暴露凭据/上游细节。**合规边界**：WPS 在线服务协议写明账号由用户自行保管、服务仅供本人使用，不得出租/借用/分享；把个人 WPS 账号作为面向多用户的 SaaS 共享后端存在条款与封号风险，生产启用前必须取得账号本人/组织授权，或改用 WPS 官方企业/开放平台方案。
- 流程：站内作品读页图，外部入口接受单份 PDF 或最多 20 张 PNG/JPG；图片先用 pdf-lib 合成 image-only PDF。WPS 走 `token_by_kso` 换取 KS3 上传凭证 → PUT PDF → `POST /api/structppt/convert_pptx`（SSE 进度）→ 下载 `file_url`；Image2PPT 走 `POST /api/v1/jobs`（multipart，`Idempotency-Key: anppt-editable-{exportId}`）→ 4s 轮询 `GET /api/v1/jobs/{id}` → 带 Bearer 下载 `/download`；Codia 走 uploads → tasks → poll → 下载。PPTX 流式/内存写临时文件并原子落盘；上传源 PDF 在所有终态安全删除。
- 回调：`POST /api/webhooks/image2ppt` 按 Standard Webhooks 校验 `webhook-id/timestamp/signature`（HMAC-SHA256，5 分钟时间窗）；只用于提前推进状态，下载仍由同一管线完成，webhook 与轮询按 exportId 去重。`PUBLIC_BASE_URL` 非 HTTPS 公网时不传 callback，纯轮询。
- 幂等：同项目进行中任务直接复用；同一来源指纹已有成功结果默认复用；只有显式 `force=true` 才重新建任务、重新扣星。查重、建行、扣费在同一 `BEGIN IMMEDIATE` 事务中。
- 请求恢复：GET 最多 3 次；带固定 `Idempotency-Key` 的提交最多 2 次；仅网络错误、429、5xx 与非 JSON 临时响应短退避恢复。401/402/403 与业务参数错误不盲目重试。提交级重试复用同一幂等键；通道级重建（Codia `attempts=2`）用接口层生成的 `-retry1` 幂等键，且轮询抖动只继续等同一任务、不重建——重建会多打一次上游付费接口。
- WPS 限流：上游错误码 `10712` / `convert2pptxRateLimited` 映射为 429，并进入进程级 10 分钟冷却；冷却期内直接回退 Image2PPT/Codia，不再打 WPS。2026-10-20 实测单账号 16 路并发 1 页转换全部成功（约 2.7s 完成），未观察到并发上限，但内部接口不承诺 SLA。
- 失败语义：单通道 failed 先自动切备用通道；同一通道的重建次数由适配器的 `attempts` 能力声明（Codia = 2，仍用 `-retry1` 幂等键重建一次），幂等键形状只在接口层一处生成。全部失败 → 幂等退星 + 行 failed。普通用户只看到“服务器开小差/稍后在下载中心查看”等安全文案，不暴露供应商名称、私网地址、密钥、额度或上游响应正文；原始技术信息只进服务端日志。上游 402 → 立即退星 + journal 告警。
- 懒恢复：pending/processing 的 editable 行在 getExport/listExports 时被现场推进。恢复只按 `upstream_provider` 找到适配器并问 `capabilities.resumable`：可恢复通道（Image2PPT / Codia）按 `upstream_task_id` 调 `advance()` 现场推进，拿到产物即 `save()`；不可恢复通道（WPS 内部接口没有任务查询端点）重跑整条管线；无 task_id 且创建超 30s 同样重跑。管线与恢复都不再写通道名分支。上游状态轮询没有虚假的前端倒计时。
- 限制（站内商品口径，2026-10-28 未改）：每任务 ≤20 页（`EDITABLE_MAX_PAGES` → `EXPORT_TOO_MANY_PAGES`）；通道侧能力由 registry 的 `maxPages` 另行过滤（见上），两者不是同一个常量。deck 必须 status==='generated'；单页项目取全部有 activeVersion 的页；同 ref 并发请求复用同一任务，不返回重复任务、不重复扣星。
- 上游计费：WPS 当前为网页限时免费通道，但依赖登录 Cookie 与上游风控；Image2PPT 按页扣账号 credits（当前 200 credits；API 与网页共用积分池）；Codia 13 credits/页。用户侧仍统一 20🌟/页，免费通道不改变站内计价。**测试禁止真实调用付费上游**；真机验收只允许小额度单页。
- 参考入口：https://aippt.wps.cn/aippt/convert-ppt/home （WPS 内部页面，无公开 API 契约）、https://image2ppt.com/en/docs/api 、https://codia.ai/pdf-to-editable-ppt-api

## 7. 前端要点

- 工作台：`src/components/deck/deck-workbench.tsx` + `step-*.tsx`（生成 CTA 状态机：生成中禁用「正在生成中…」/部分完成「生成剩余 N 页」/全完成「使用此风格重新生成」）。
- 内容梳理：`src/components/deck/step-structure.tsx` 支持标题、区域、模块、正文、重点正文、数据、表格等块的可视化增删改、排序与高级 DSL 双模式；客户端解析后仍由服务端 `validateTaggedDsl()` 校验。编辑器打开时禁用批量梳理与失败页重试，避免竞态；普通正文换行保存时合并为空格，刷新后仍能正确解析。
- 转可编辑按钮：`step-generate.tsx`（仅 deck.status==='generated' 可点）与 `single-page-client.tsx` 共用 `useEditableExport`；刷新/离开后恢复原任务，完成时明确提示已进入下载中心，成功结果可直接下载，显式“重新转换”才再次扣星。
- 下载中心：`src/app/(main)/exports/page.tsx`（来源文件名、真实页数/进度、状态、反复下载；processing 自动刷新）。侧栏有「下载中心」入口。
- 外部文件转可编辑：侧栏 `/tools/editable-converter` 已上线，支持 PDF 与图片排序；未登录先引导登录，不会误发受保护请求。
- **会话只取一次（2026-10-27）**：`src/lib/client/api.ts` 的 `getSession()` 做进程内 in-flight 去重，壳/导出中心/项目/单页工作台/onlyoffice/可编辑转换共用它；此前 6 个组件各打一次 `/api/auth/session`。登录或登出后必须调 `resetSessionCache()`，否则读到旧会话。
- **前端唯一请求入口（2026-10-27）**：一律走 `apiFetch()`（信封解包 + 写操作 `x-anppt-action` CSRF 头 + `ApiClientError` 的 401/402 语义）。`admin-client` 曾自带一套 `adminFetch`/`mutationInit` 把错误降级成普通 `Error`，已删除；新增页面不要再自建 adapter。**组件目录裸 `fetch(` 已归零**（2026-10-27，含管理员问题日志面板）；刻意保留的豁免：无。新增读接口按能力命名加进 `src/lib/client/api.ts`，不要再把 URL 字面量或信封解包写进组件。
- **扣费键唯一来源（2026-10-27）**：可编辑导出的 `credit_ledger.idempotency_key` 由 `modules/editable-export/server/charge-keys.ts` 的 `editableChargeKey({kind, refId, exportId})` 生成，扣费与退款共用。此前两处各拼一份模板（`editable.ts:307` / `:807`），漂移会让退款派生到别的键上——表现是钱扣了不退且不报错。
- 本地编辑器：侧栏 `/tools/onlyoffice`（`src/components/tools/onlyoffice-client.tsx`）已上线；未充值不显示下载链接，三个 Windows 下载路由再次做服务端权益校验。页面口径固定为「第三方开源免费的 ONLYOFFICE Desktop Editors + AnPPT 的下载整理/校验/兼容服务」，2026-10-13 起首屏先讲清「装的是什么、拿来做什么、为什么用它」，再往下才是下载区与权益对比，避免读者误以为软件是自研产品或需付费购买。

## 8. 测试与验证（全部零真实付费调用）

```bash
npm run gate         # 完整门：分支范围空白/冲突标记 → lint → typegen+tsc → 两套测试 → build（全 mock，零真实付费调用）
npm run gate:fast    # 快集：跳过 build 与两套测试
npm run test:guardrails  # 护栏自检：用坏夹具证明门/钩子/工作树/发布脚本会红
# 单跑某一层（排查用）：node scripts/test-generation.mjs（577 断言）/ node scripts/test-backend.mjs（171 断言）
node scripts/e2e-ui-audit.mjs        # Playwright 真机 UI 审查（需要登录态，见脚本头注释）
BASE_URL=http://localhost:3000 node scripts/e2e-fullchain.mjs  # ⚠️ 真实生图扣费（约 $0.08），慎用
```

## 9. 日志前缀速查

- `[anppt-v2][problem][category]` — 问题日志写入行（同内容落盘 `logs/problems-*.jsonl`，带 `requestId`，见 §24）；category ∈ api / generation / image-upstream / editable / ppt-to-base / payments / otp / sms
- `[anppt-v2][problem-log]` — 日志落盘探针/写入失败兜底行；出现即先查磁盘和目录权限
- `[anppt-v2][codia]` — Codia 上游调用告警（超时/非 JSON/HTTP 错误/重试）
- `[anppt-v2][exports]` — 导出管线内部异常（上传源清理、懒恢复轮询、文字层单页提取）
- `[anppt-v2][generation]` — 生成管线非致命降级（如全局视觉规范生成失败后继续）
- `[anppt-v2][image-upstream]` — 生图上游瞬态重试/灾备切换（非 2xx 终态失败已进问题日志）
- `[anppt-v2][recovery]` — 崩溃懒恢复触发（出现即说明发生过中断，值得看上一条 journal）
- `[anppt-v2][admin]` / `[anppt-v2][admin-config]` — 管理员审计写入或运行时配置异常（日志仍须脱敏）

## 10. 已知未修（勿重复排查）

- **大纲错误口径已统一（2026-08-20 修）**：`engine.ts` `generateOutline` 兜底路径已包 `engineFailure()`——超时/非 JSON/未配置统一 `ENGINE_UNAVAILABLE` 503 可重试；空大纲保持 `OUTLINE_FAILED` 502。线上生效需部署。
- 磁盘 78%（非 AnPPT 数据，53M）；导出文件（exports/）无清理机制，量大后需运维处理。
- 注册仅需用户名+密码即送 100🌟，可换 IP 刷号薅生图成本（产品决策）。
- 当前 140 张风格样张路径完整，但仍是迁移期素材；禁止将它们误称为原创资产，需按 `docs/ORIGINAL-TEMPLATE-REGEN.md` 分批原创重制并原子替换。

## 10.1 LLM 模型链与回退（2026-09-07：DeepSeek 官方 flash）

- 大纲/内容梳理的 LLM 兜底走「模型链」：`ANPPT_V2_LLM_MODEL`（主）+ `ANPPT_V2_LLM_FALLBACK_MODELS`（回退，逗号分隔，最多 3 个）。
- 当前线上：直连 `https://api.deepseek.com/v1`，主模型 `deepseek-v4-flash`，**回退链为空、不用 PRO**。密钥与生图（sqface）分离，禁止把 LLM 指回 6800 或 sqface 文本分组。
- DeepSeek V4 默认思考强度是 high，20 页结构化大纲会贴 120s 超时。请求体对 DeepSeek 候选显式带 `thinking: {type:enabled}` + `reasoning_effort`（默认 `low`）。`ANPPT_V2_LLM_REASONING_EFFORT` 可选 `low` / `high` / `max` / `off`（off=关闭思考）。其它 OpenAI 兼容上游不附这些字段。
- 切换策略：主模型失败（超时/HTTP 错/空响应）自动换下一个；超时梯度 45s/90s/末位 120s。切模型会打日志 `[anppt-v2][engine] LLM 模型 X 失败，切换 Y`。当前无回退模型，失败即失败。
- **回退操作**（改 env + `systemctl restart anppt-v2`，改前备份 .env、查在途任务）：
  - 关思考：`ANPPT_V2_LLM_REASONING_EFFORT=off`
  - 加回退：`ANPPT_V2_LLM_FALLBACK_MODELS=` 逗号分隔（须是当前 BASE_URL 能跑的模型；跨站用 `ANPPT_V2_LLM_BACKUP_*`）
  - 可用模型：DeepSeek 官方 `GET /v1/models`（不要再用中转 `/v1/models`）
- 背景：2026-09 本机 6800 中转无进程；`api.an520.xin` / `console.an520.xin` 中转 503。原 `gemini-3.1-flash-lite` → `gpt-5.6-luna` → `deepseek-v4-flash` 链依赖该中转，已废弃。

## 11. 禁区与注意事项

- Caddy 禁区：api/console.an520.xin（另一套系统）、6800 隧道、老机 101.32.220.164、slideflow 3300 服务（不杀、只不再代理）。
- 密钥只存在于服务器 env，任何情况下不打印、不进仓库、不进前端。
- 客户端 IP：`getClientIp` 只信 `X-Real-IP`（Caddy 显式 `header_up` 覆写），XFF 仅作无代理兜底——Caddy 对 XFF 是追加链，首值客户端可伪造，限流曾因此可绕（2026-08-24 修）。
- 大纲与页型契约可继续优化，但必须保持 DSL、历史项目和 `legacySlugs` 兼容，并通过完整生成测试；不得直接照搬第三方模板序列或编造原文没有的页面。
- commit 用英文祈使句；部署前跑 `npm run gate`（完整门，含分支范围空白与冲突标记）；部署会重启服务。
- 竞品调研资料库：`/Users/an/Archive/2026-08-28-项目清理/anppt-v2-recon/`（旁门/花卷/抖研三站报告 + 可编辑路线调研 RESEARCH-image-to-editable-pptx-2026.md）。
- 调研资料和已授权前端源码只用于学习机制与交互，不得复制第三方 CDN 图片、PPTX、Logo、品牌文案或远程模板地址进入产品。

## 12. 2026-08-21 全站工具与并发升级

- 外部文件转可编辑：`/tools/editable-converter`，接受单份 PDF 或最多 20 张 PNG/JPG；统一走 `pdf_to_ppt`，20🌟/页。任务记录 `ref_type=upload`，同内容指纹复用，刷新后从下载中心恢复。
- ONLYOFFICE：`/tools/onlyoffice`。软件本身是第三方开源免费软件；AnPPT 的三个 Windows 一键下载入口、版本校验、兼容工具包与附带支持，仅在任意真实充值成功后永久解锁。权益判定为 `recharge_orders.status='paid'`，兑换码不算“充值一次”。
- 项目导航：侧栏只保留一个「我的项目」，页面按 `updated_at DESC` 同时承担原“最近项目”视图。
- 生图调度：单套默认并发 6、全站最大在途 20、滚动每分钟启动 24；429/5xx/网络抖动最多后台恢复 2 次，400/401/403/超时不盲目重试；单请求超时默认 8 分钟。
- **生图回退（2026-10-13 落地）**：`src/lib/server/generation/images.ts` `imageEndpoints()` 在主站之后挂跨站灾备，**三项齐备才生效**：`ANPPT_V2_IMAGE_BACKUP_BASE_URL` + `_API_KEY` + `_MODEL`（改图另用 `_EDIT_MODEL`，缺省回落 `_MODEL`）。切站规则 `isFailoverWorthy()`：401/402/403/429/5xx/网络/超时都切，400/413 是请求本身的问题不切（省灾备费用）。atlascloud 走异步 `/model/generateImage` + `/model/prediction/{id}` 轮询，其余渠道按 OpenAI `/images/generations`。日志 `[anppt-v2][image-upstream] 主站生图失败，切换灾备站`。
  - **历史缺口（2026-10-13 修复）**：代码一直支持灾备，但生产 `.env` 从未配 `ANPPT_V2_IMAGE_BACKUP_*`，灾备形同不存在——10-04 主站 402（insufficient balance）直接拖垮整站生成 6 个任务。**灾备必须与主站分账号/分额度**，否则同账号欠费一起挂；跨站灾备（atlascloud）还需账户有余额，2026-10-13 实测 atlascloud 与 KIE 均不可用（前者 402、后者无凭证）。
  - 回归：`scripts/test-generation.mjs` 4 条断言（主站 402 切灾备出图 / 灾备确被调用 / 主站 400 不切 / 灾备三项不全按单站失败）。
- 下载：`/api/files/...` 使用文件流，支持 `HEAD`、`Range`、206 和 416；Codia PPTX 结果也直接流式落盘，避免并发时整文件进入 Node 堆内存。
- 原创模板生成链：已落地「整套场景识别 → 六类叙事骨架 → 35 页型任务 → 逐页同风格参考 → 25 包设计 DNA」。当前不调用付费生图批量重制；后续按高校赛事、企业商务、政企工作三套逐张验收并原子替换，详见 `docs/ORIGINAL-TEMPLATE-REGEN.md`。

## 13. 管理员后台与运行时配置（2026-08-22）

- 入口：`/admin`。页面与 `/api/admin/**` 都会校验当前会话用户 `users.role='admin'`；普通用户页面重定向、API 返回 403。管理员身份来自数据库角色，不硬编码邮箱。
- 能力：总用户/24h 新增/生成与导出在途/24h 失败/项目数、进程内存、磁盘、数据库、集成配置状态、最新注册用户与最近审计可视化；支持生成 1000 星等兑换码和用户角色管理。（2026-08-26 起按用户决策移除“重点用户监控”，`admin_user_watches` 表随之废弃。）
- 运行时配置：LLM、生图、WPS / Image2PPT / Codia 与容量参数保存在 DB；密钥由 `ANPPT_V2_ADMIN_CONFIG_KEY` 派生 AES-256-GCM 密钥后加密，浏览器只获得“已配置”和短指纹，永不返回明文。公网 API 地址必须 HTTPS，HTTP 只允许本机/内网。
- `ANPPT_V2_ADMIN_CONFIG_KEY` 至少 32 字符，只能存在生产 `.env`，文件权限保持 600。**轮换前必须先导出/重新录入所有运行时密钥**；直接更换主密钥会使旧密文无法解密。备份 `.env` 时同样按密钥材料保护。
- 连接检查零付费：LLM/Image 仅 `GET /models`，Codia 仅 `GET /v2/open/credits`，Image2PPT 仅 `GET /api/v1/account`，WPS 仅 `GET /api/v3/islogin`；全部 `redirect: 'error'`，不会跟随到未知端点，不调用 `/tasks`、`/uploads`、转换、聊天或生图接口。
- 运行时配置有 30 秒进程缓存；保存/清除后主动失效。已经启动的生图或可编辑任务使用启动时配置快照，避免中途切换密钥/地址造成半套任务跨供应配置。
- 所有管理员写操作进入 `admin_audit_logs`；详情递归脱敏 secret/password/token/api key/authorization/cookie/private key 等字段，审计写失败只记服务端错误，不反向破坏已成功业务操作。

## 14. 上游消耗本地计量与财务统计（2026-08-22）

- 口径（用户拍板）：**只记本项目自己的逐条消耗**，不拉上游余额接口。每次真实上游调用（LLM/生图/WPS/Image2PPT/Codia）落一条 `upstream_usage_records`（provider/kind/model/status/tokens/units/cost_fen/duration_ms）。
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
- 链路（`src/modules/editable-export/server/editable.ts` `runTextEditablePipeline`）：读页图 → **主 LLM 链 VLM** 提取文字块（bbox/字号/颜色/字重/对齐，`TEXT_EXTRACT_PROMPT` 自写提示词，未抄竞品）→ sharp 采样文字区外围底色 → pptxgenjs 整页图垫底 + 纯色底文本框覆盖。
- 路由：`POST /api/deck/[id]/export-editable-text`（挂 `assertFeatureVisible('editable_text_overlay')` 硬门）；状态/下载复用 `GET /api/pptx-exports/[id]`；下载中心列表 `kind` 过滤，标签「文字可编辑」。
- 失败语义：**单页提取失败只记日志降级**（该页无文本框，整页图仍在，不中断）；全部页失败才整单 failed + 幂等退星（ledger 前缀 `export-editable-text`，与 Codia 档 `export-editable` 分开）。用户文案：「文字层提取服务暂时不可用，星星已退回；稍后可重新转换。」upload 来源暂不支持（发起即校验）。
- 计价：独立动作 `export_editable_text`（5🌟/页），估价/预检/幂等键/退星与 Codia 档同套机制；VLM 消耗照常落 `upstream_usage_records`（provider `llm-primary`，kind `chat`）。
- 懒恢复：`ensureEditablePipeline` 按 kind 分发，重启不丢单；复用/重转语义与 Codia 档一致（显式「重新转换」才再扣星）。
- 前端：`step-generate.tsx` 底栏按钮（挂 `/api/features` 可见性）+ `use-editable-export` 的 `kind` 选项；实测截图 `output/playwright/text-editable-bar.png` / `text-editable-modal.png`。
- **禁止为测试真实调用 VLM**（测试全 mock）；dev 真机实测过一次（2 页 ≈18s，PPTX 解包确认文本框分级字号正确）。

## 17. img2pptx-v4-node 退役（2026-08-22）

- 背景：v1 时代自研"图片转可编辑 PPT"Node 服务（127.0.0.1:8014），可编辑链路已由 Codia 重转换档（§6）+ 轻量文字档（§16）完全替代；anppt-v2 代码与 Caddyfile 均无任何引用，删除无调用方风险。
- 已执行：停+disable `img2pptx-v4-node.service` 并删 unit → 监控脚本 `/usr/local/sbin/anppt-health-monitor.py` 移除该检查项（备份 `.bak-20260822`，语法已验）→ 删除 `/opt/img2pptx-v4-node`、`/opt/img2pptx-fonts`、`/opt/img2pptx-v4-releases`、`/opt/img2pptx-v4-rollback-20260804-contract-v1`（释放 ~1.5G）→ transient 单元记录已 reset-failed。
- 代码保全：原 GitHub `An-an-525/anppt-img2pptx-v4`（main + codex/font-match-v2 + codex/v4.2.2-font-quality）—— **该账号已失效、远端不可达**，现仅以本地归档为准；服务器最终运行版源码归档在本地 `~/Documents/AI PPT/AnPPT-asset-archive/img2pptx-v4-retired-20260822/`（`img2pptx-v4-final-20260822.tar.gz` 508 项，含源码/docs/deploy/backups，排除 venv/cache/staging/qa 产物；releases 构建产物只留 manifest，按 commit hash 可重建）。**wip/qwen-normalize-2026-08-15 分支在本地、服务器、GitHub 三处均未找到**，若日后冒出可对照归档恢复。
- 删后验证：`/api/health` ok（llm/image/editable 全 configured）、anppt-v2 active、监控手动跑"全部正常"。

## 18. 金奖版式测试包（gold_layouts_beta，beta，2026-08-24）

- 定位：从 2025 国赛金奖路演 PPT（14 份已脱敏研究，产物在 Archive/2026-08-28-项目清理/anppt-v2-recon/award-samples/）提炼的 6 页真模板——封面/痛点卡片列/单字锚点对比/竞品整行高亮表/数据大字页/对仗封底。用户裁定「版式锁死、只能改内容」→ kind=template 真模板路线（灌内容，非借风格）。
- 门控机制（测试资产挂开关板的成例）：包登记在 `src/data/style-packs.ts` 的 **`GATED_STYLE_PACKS`（不进 STYLE_PACKS 公开数组**，客户端 bundle 天然不含）；`StylePack.featureFlag='gold_layouts_beta'`。服务端全集出口 `ALL_STYLE_PACKS` 供 findStylePack/getTemplate 解析；`templates.ts` 的 `visibleStylePacks(user)` 是列表注入唯一入口，`assertStylePackUsable(stylePackId, user)` 是生成硬门（不可见 404）。
- 挂接点：`/api/style-packs`、`/api/templates`（listTemplates 第二参带 user）、`/api/templates/[id]`（不可见 404）、建 deck 两路由（parse/paged-copy-v2）、actions `style` 动作，全部走同一硬门。前端三组件（UploadCard/step-style/TemplateLibrary）用 `src/components/use-gated-style-packs.ts` 按 `/api/features` 并入列表——只决定「列不列出来」，兜底在服务端。
- 载体：`public/assets/style-packs/gold-tianxun/01..06.png`（虚构项目「天巡」，AI 直出已验收，见 award-samples/samples/VERDICT.md）；`templatePages` 逐页标注逻辑页型，mapping 精确命中，未覆盖页型兜底内容桶。DNA 用 COMPETITION_ACADEMIC 预设。
- 单页工作室（sp-panels）**未接入**门控包（beta 期只走 deck 主流线）；核心技术页框图/证据墙页的「程序化底座」已由 §23 落地（`/tools/ppt-to-base`）。
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

## 21. PPT 美化 / 复刻（ppt_replicate，public，2026-10-13 上线）

- 定位：上传参考稿保画面、换文案。不进大纲→风格包工作台。
- **开关状态（2026-10-13）**：`ppt_replicate` 已由 beta 转 **public**，全员可见可用（侧栏「PPT 美化」、首页「PPT美化」页签、模板库「自己的 PPT」均按 `/api/features` 显隐；服务端硬门仍在）。上线前做了生产真机验收（admin 账号 1 页：结构卡 1/1、`/images/edits` 出图 1536×864、扣 10🌟、`source=replicate`、工作台缺省生成 409 `REPLICATE_PROJECT`），验收项目已删除。
- **UI 贡献点（2026-10-27，ADR-0001 G2）**：三条入口由 `src/plugins/ppt-replicate/ui.ts` 的 `ui.entries` 声明（静态数据 + 懒加载指令），壳经 `src/plugins/ui-registry.ts` 按 `flag` 过滤、`next/dynamic` 懒加载面板——壳里不再有 `if (ppt_replicate)` 分支；关掉开关三条入口一起消失，改开关无需改壳代码。
- **回滚**：管理端「功能开关板」把 `ppt_replicate` 转回 `beta`/`off` 即时生效（开关读库不缓存，无需发版重启）。
- **模块目录（2026-09-06 归拢，首个自包含模块样板）**：`src/modules/ppt-replicate/`——`server/facade.ts` 是模块唯一对外服务端入口（项目/页/版本 + 草稿写入 + 逐页生成 + 提示词契约 + 计费动作声明）；**2026-10-27 实体搬回**：草稿写入与复刻生成在 `server/pages.ts`，平台 `single-pages.ts` 只剩通用单页运行时（`runSinglePageJob` 接受调用方传入的提示词策略，不再认识复刻），扣费/退款/版本表/懒恢复仍只有平台一份。平台不再 import 模块，`import/no-restricted-paths` 对单页运行时恢复生效（§22）。`client/` 全部前端（工作台/ui/规则/请求/交接/拆页/URL/入口卡），边界与四件套见模块 README；薄壳留在 `src/app/(main)/beautify/page.tsx` 与 `src/app/api/tools/replicate/plan/route.ts`。
- 入口：首页「PPT美化」、模板库「自己的 PPT」、侧栏「PPT 美化」、`/beautify`。旧地址 `/tools/replicate-ppt.html` 跳到 `/beautify`。开关不可见直接显示「功能尚未开放」（先查开关再要求登录），可见但未登录去 `/login?next=...`。`robots` disallow `/beautify` 与 `/tools/`。
- 前端拆分（均在模块 `client/` 下）：规则在 `beautify-pages.ts`（扣费名单/失败横幅/草稿/计划回写）；请求在 `beautify-api.ts`；UI 零件在 `beautify-ui.tsx`；`BeautifyClient` 只编排。内部 source 仍是 `replicate`。
- 链路：参考稿（浏览器拆页）→ 上传壳图 → VLM 读每页画面结构（仅计划阶段）→ LLM 按主题/大纲/材料拆文案 → 逐页 `/images/edits` 换字保画面（10🌟）→ 可选 Codia 转可编辑（20🌟，20 页一批）。
- 文案：`POST /api/tools/replicate/plan` 只做鉴权/开关/读入，业务在 `runReplicatePlan`。`copyMode` 默认 `improve`。壳图写入 `single_pages.shell_path`，美化页可用 `?projectId=` 恢复。
- 生成：`mode:'replicate'` + `colorMode` 缺省 `follow-shell`。生图 **不再抽 VLM**（结构卡计划回传；不带则空卡 + 保画面）。硬门 `ppt_replicate`。
- 二阶（钱/失败/恢复）：
  - 整批生成**跳过已有成品图的页**，不重复扣 10🌟；要重做只点「重试本页」。
  - 中途 402 停住，横幅保持失败语义，已生成页保留，未生成页未扣成图星。
  - 转可编辑后一批失败：已排队批次仍在下载中心，已扣星不因后面失败退回。
  - 换新参考稿**不沿用旧文案**（避免画面和文字对不上）。
  - 打开旧项目：结构卡需再点完善文案；壳图过期则提示重传。草稿键仍是 `anppt-replicate-draft-v1`。
  - **2026-09-08 对抗审查修补**：生成/改图 `requestId` 改为每次 UUID（刷新后再点「重试本页」不再撞 `DUPLICATE_REQUEST`）；改图失败保留旧成品图；再完善文案若字变了会清成品图并提示重新扣星；`refine` 对 `source=replicate` 项目也走 `ppt_replicate` 硬门；PDF worker 改走同站打包资源，不再拉 unpkg。
  - **2026-10-19 导出入口补齐**：PPT 美化第 4 步新增「导出图片版 PPTX」（免费，走 `/api/single-page/export-image-pptx`），生成成功后自动下载并写入导出中心；同时常驻「打开下载中心」入口。生成/恢复项目后把 `projectId` 写回 URL（`/beautify?projectId=...`），刷新不会丢项目。
  - **2026-10-19 草稿持久化**：上传参考稿后立即并发上传壳图并 `POST /api/single-page/draft`（不生成、不扣星），保存项目/页面/文案/参考稿路径；完善文案和整批生成结束后补存。刷新或换设备可通过 `?projectId=` 恢复；服务端校验参考稿路径必须属于当前用户。
  - **2026-10-20 批量任务服务端化**：`POST /api/single-page/batch` 只负责创建/复用 `single_page_batches` 在途任务并立即返回，worker 在服务端按 3 页并发调用现有单页运行时；`GET /api/single-page/batch?projectId=` 返回任务进度与页面图，前端轮询回填。刷新/关页不再中断后续页；同一项目唯一在途任务防重复扣星。任务保存每页起始版本快照，已生成页改文案重做时旧版本不会被算成本批成功；服务端在文案/壳图变更时清空旧 active 版本并置回待生成，避免刷新后又把旧图当新结果。任务心跳超 `ANPPT_V2_JOB_STALE_MS` 且页状态已收敛时，批量行置 partial/failed，释放唯一索引供重试。项目列表/详情更新时间取 `MAX(project.updated_at, MAX(single_pages.updated_at))`，修复生成完成后项目仍按创建时间沉底。
  - **2026-10-19 PDF 解析修复**：浏览器端 worker 由 `scripts/sync-pdf-worker.mjs` 在 predev/prebuild 复制到 `public/pdf.worker.min.mjs`，固定走同站 URL，避免 Next/Turbopack 的 `?url` 导入返回非字符串触发 `Invalid 'workerSrc' type`；服务端 `documents.ts` 显式把 pdfjs `workerSrc` 指到 node_modules 真实文件，并配置本地 `cmaps/`、`standard_fonts/`、`wasm/`，避免服务端 chunk 相对路径去找 `.next/server/chunks/pdf.worker.mjs`，也避免中文 CID 字体因缺 CMap 解析为空。回归：`scripts/test-generation.mjs` 新增中文 CID PDF 断言（424 项）。
- 视觉预算：单次最多 24 页结构；10 分钟 48 次 VLM。文案 LLM 走 `replicate-plan:{userId}` 30/10min，**不占**大纲 `llm-free`。
- 项目身份：`source='replicate'`。列表「美化 ·」链到 `/beautify`；工作台缺省生成 409 `REPLICATE_PROJECT`（文案「请到 PPT 美化」）。
- `/api/me` 的 `features.beautify` 跟开关走，不再写死 true。
- 页数：与整套解析对齐 **1–40**，超出在拆页/拆文案拒绝，不先扣星。仍受单文件 30MB、上传 60 次/小时。
- 路径：拒绝 `.` / `..` / 编码穿越。预览图只允许 `/api/files/` 与 `data:image`。
- 壳图清理：软删过期后删 `shell_path`；`uploads/{userId}/replicate/` 中超保留期且未被在用页引用的文件懒清理。导出文件仍不清。
- 转可编辑：20 页一批；可编辑是位图转 PPTX，不是原槽位（产品边界）。
- 计费：10🌟/页生成、失败退星；可编辑 20🌟/页。单价由 `/api/credits/estimate` 现读（`single_page_generate`/`export_editable`），客户端不硬编码。
- **2026-10-11 审查修补**：恢复项目优先用 `page.activeVersionId` 的版本（找不到才回落最新成功版，避免把非当前版本送去转可编辑）；壳图 `imagePaths` 改为定长数组按页对齐（缺失留空，服务端 `ownedReplicateImagePaths` 同样保下标，不再过滤塌缩导致结构卡串页）；`structureExtracted` 只统计非 null 结构卡（VLM 失败不再虚报 N/M）；限流桶各记自己的 windowMs，短窗口调用不再驱逐长窗口桶。
- 测试：`scripts/tests/ppt-replicate.test.mjs`（套件内段名 [7c]）含结构卡/路径/项目 source/llm-free 隔离/40 页上限/壳图过期清理/美化 URL 白名单/已生成不扣星/402 横幅/409 文案/服务端批量任务回填与中断恢复/项目更新时间；开关门控在 test-backend.mjs [11]。**禁止真实 VLM/生图/Codia。**

## 22. 插件运行时三件与先锋插件（pricing / models，2026-09-06）

- 定位：插件化路线（`docs/PLUGIN-ARCHITECTURE.md`）第一步。Phase 1 纯增量；**Phase 2（2026-09-06 下午）起生产读价接通**：`credits.estimateCredits` 经 `ctx.pricing` 读价；**G1（2026-10-27）起价格表的存储与解析也归插件**——平台 `src/lib` 内不再有任何价格常量或 env 价格解析（`grep -r DEFAULT_ACTION_PRICES src/lib` = 0，ADR-0001 G1）。
- **机制**：运行时三件在 `src/lib/plugin/`——`types.ts`（`AnPlugin` 接口 + 冻结数据契约 Ref/Page/Result 的唯一定义处）、`ctx.ts`（服务注册表 `register/use/has/reset`，`createCtx()` 造实例）、`profile.ts`（`boot(profile, host)` 异步 / `bootSync(profile, host)` 同步、宿主服务先于插件注册注入、遇异步 register 即 fail fast；`assembleSync(profile, host, requiredServices)` 启动期验收服务键并产出装配清单）、`default.ts`（启动期组合根：装配 `defaultProfile` 并注入 `config` 宿主服务，清单与 ctx 挂 `globalThis` 全进程单例，生产高频同步读点从这里取服务）。系统 = 一张配置单：默认 profile 在 `src/plugins/default-profile.ts`，按 pricing → models 顺序 boot。
- **契约层**：`src/lib/plugin/contracts/pricing.ts` 是动作 key 清单、动作 key ↔ 公开动作键映射与 `PricingService` 类型的唯一定义处；`contracts/config.ts` 是插件配置契约（`HostConfigService`：`pricingSource()` / `models()`）与 `HOST_CONFIG_KEY` 的唯一定义处。平台（credits.ts）与插件都只依赖契约，互不 import 实现。
- **边界（lint 强制）**：`eslint.config.mjs` 的 `import/no-restricted-paths`——`src/plugins/*` 之间禁止直接 import（成对 zone）；插件不得 import 平台内部 `src/lib/server` 与具体功能模块 `src/modules`（ADR-0001 G4）；`src/lib` 不得 import `src/plugins` / `src/modules`。登记例外：插件组合根 `src/lib/plugin/default.ts`（复刻分支已于 2026-10-27 搬回模块，见 §21）；插件侧另有一处 strangler 例外——`src/plugins/ppt-replicate/ui.ts` 与 `client/beautify-tab.tsx` 仍 import 模块（懒加载面板 / 文件交接），删例条件见 `PLUGIN-ARCHITECTURE.md` §5。
- **pricing 插件**（`src/plugins/pricing/`）：暴露 `ctx.pricing` = `{ quote(actionKey), table() }`。**价格表的存储与解析都在插件内**（`prices.ts`：默认表 + `CREDIT_ACTION_PRICES` 整份覆盖 + `ANPPT_V2_SINGLE_PAGE_CREDITS`）；平台层不存价格也不解析价格（2026-10-27 G1：`grep -r DEFAULT_ACTION_PRICES src/lib` 为 0）。部署旋钮原值经宿主 `config` 服务的 `pricingSource()` 交入（G4，插件不 import `@/lib/server`），调用时现读。动作 key 含 `generate.page`/`edit.page`/`export.editable`/`export.editable-text`/`export.image`/`outline`/`tool.ppt-to-base`/`generate.single-page`/`edit.single-page`。**未定价动作 quote 返回 0 且不在表内——免费是合法形态，不许 throw。** 换实现即换价：替代实现换进默认上下文后 `estimateCredits` 与全站扣费随之变（`scripts/tests/plugin-runtime.test.mjs` + `scripts/test-generation.mjs` 真实生成链实证，业务代码零改动）。
- **models 插件**（`src/plugins/models/`）：暴露 `ctx.models` = `{ text(), image(), fallback(model) }`。经 `config` 服务只读包装 `generation/config.ts`（含管理端覆盖）：文本链 = 主模型→fallbacks→跨站备份；图像按用途成对（文生图/改图各有灾备）。`fallback` 链尾或未知模型返回 null。
- **启动期装配（2026-10-27，ADR-0001 G3）**：`src/instrumentation.ts` 的 `register()` 在 Next 服务就绪前调用 `default.ts` 的 `startDefaultPlugins()`——同步 boot 默认 profile → 按 `REQUIRED_SERVICE_KEYS`（当前只有 `pricing`，即 credits 的计价依赖）验收服务键 → 打一行 `[anppt-v2][plugin]` 日志（`key@version` + 服务键）→ 装配清单（含 `assembledAt` / `services`）挂 `globalThis.__anpptV2PluginAssembly`。instrumentation 与路由是两套 webpack 入口、模块缓存不跨 bundle，所以必须进程级共享；`/api/health.plugins` 返回该清单。测试可把替身 profile 直接传给 `assembleSync(profile, host, requiredServices)`，无需起 Next。`setDefaultCtx` 换实现时喂同一份清单：原 ctx 归还则恢复其装配清单，外来 ctx 无 profile 元数据可报，标记 `profile=runtime-replaced` 且 `plugins` 为空（`services` 取自新 ctx），绝不沿用旧版本。
- **失败语义**：`use` 未注册键启动期即 throw（信息含已注册键清单）；同键重复注册 / profile 内插件键重复即冲突报错；启动期装配缺必需服务键（例如从 profile 删掉 pricing）在 `instrumentation.register` 里直接失败，报出 profile 名与缺失键——fail fast，不许运行期 undefined 漂移，也不把失败拖到首个计价请求。**与 dsh 的有意偏离**：dsh inject 是持续跟踪（服务缺失则消费方 PENDING 等待），营收系统选启动期 fail fast。dsh 的 effect/disposer、`cordis.patch.yml` 三层格式（`{id, name, disabled, config}`、同 id 后写赢、config 整行替换）列入运行时下一版迭代。
- **启动失败的验证等级（2026-10-27）**：启动期 fail-fast 目前只有单测证据（`boot` / `assembleSync` 的失败路径）+ Next 行为推断（`instrumentation` 同步注册失败会阻止服务就绪）；**没有起真实进程的端到端 e2e**。要升级证据等级需另起 Next 进程核对启动日志与 `/api/health`，不要仅凭源码推断宣称已验证。
- **测试约束**：`scripts/tests/plugin-runtime.test.mjs`（套件内段名 [20]，23 断言）含**插拔实证**——同一消费函数 `c.use('pricing').quote('generate.page')` 在默认 profile 与替换 fake pricing 的测试 profile 上分别得 10 与 99，调用方代码零改动；G3 起含启动期装配（清单带 `pricing@0.2.0 + models@0.1.0`、`getDefaultCtx` 复用同一实例）、缺 pricing 的启动期报错、`/api/health.plugins` 可读，以及替身 profile 经 `assembleSync` 注入；G1 起含换实现即换价（`setDefaultCtx` 换替身后 estimateCredits 3 页=297）与单页档同走服务键；G2 收尾起含 flag off 三处生效断言（`ui.entries` 过滤后三条入口不可见、`/api/tools/replicate/plan` 404、工作台门=closed）。全 mock，无真实上游。

## 23. PPT 转模版底座（ppt_to_base，beta，2026-09-15）

- 定位：§18 留下「需程序化底座」缺口的落地。工具页 `/tools/ppt-to-base`（侧栏入口按开关 `ppt_to_base` 门控，beta 期带「试验」标）。**输入是截图/PPT 图片，输出两样：①主标题原文（可复制）②去风格化通用模版底图**——版式栅格/区域位置大小/元素数量形状全保留，具体文字全部替换为中性角色词（"标题/副标题/正文/要点/标签/编号/图片/数据"），配色归一为中性浅色系（白底、浅灰分区、中灰线条、无 Logo/水印）。产物定位 = `templatePages` 真模板位图的通用化来源：拿到手填内容、换风格即可。
- **主路线·截图 AI 通用化（5🌟/张）**：`POST /api/tools/ppt-to-base`（multipart：file=PNG ≤10MB + requestId；mutation 带 CSRF）。服务端 `src/modules/ppt-to-base/server/base-image.ts`：`assertFeatureVisible('ppt_to_base')` 硬门（开关外用户 404）→ 限流 `ppt-to-base:{uid}` 30 次/时 → `estimateCredits({action:'ppt_to_base'})` 取价（插件动作键 `tool.ppt-to-base`，§22 pricing 契约已映射）→ chargeKey `ppt-to-base:{uid}:{requestId}` 幂等扣费（duplicate→409，不重复扣；扣费前先落 `ppt_to_base_jobs` running 行）→ VLM 抽主标题（带图 vision 分段，**失败降级空串不阻塞主流程**）→ `editImage` 精准编辑 → `saveFile('generated',…,{kind:'ppt-to-base'})` 落盘（行置 succeeded）；任一步失败经定长派生退款键全退星星后抛 `toPublicImageError` 公开码，崩溃/重启打断则由 `recovery.reconcileUser` 在鉴权门补退（见 §4）。路由在解析 multipart 之前先做开关硬门 + content-length 预检（formData 会把整个 body 读进内存）。客户端先把任意截图 letterbox 成 1536×864 白底 PNG 再传（`client/image-prepare.ts`）。
- 生图规范：编辑档默认走 `ANPPT_V2_IMAGE_EDIT_MODEL`（管理端运行时配置可热切换），image2.5 时代档名 `gpt-image-2.5-sunburst`（精准编辑）/ `gpt-image-2.5-flare`（快速）。编辑指令 `BASE_IMAGE_INSTRUCTION` 按 GPT Image 精准编辑最佳实践固化：点名参考图角色 → 改变项/保留项分离 → 不变量重复声明（构图/栅格/区域位置大小/元素数量/栏数/边距/16:9）→ 中性词逐字加引号 → 约束词频与原页面同类文字块数量一致、禁原文字与品牌残留。改提示词先改常量再跑 [7f] 契约断言。
- image2.5 渠道实况（2026-09-15 校准记录）：an520 中转站已退役（503）；atlascloud 已上架 `openai/gpt-image-2.5-sunburst/edit`（IMAGE-TO-IMAGE，≤16 参考图），但**入参与现网 gpt-image-2/edit 不同**：图字段是 `images` 数组（现网灾备调用体用 `image` 单数），size 枚举无 1536x864，16:9 选 `2048x1152`，quality 新增 xhigh/max。主站恢复后切 2.5 只改 `ANPPT_V2_IMAGE_EDIT_MODEL`；若要灾备也上 2.5，需同步改 `images.ts` atlas 分支调用体。校准脚本 `output/ppt-to-base-e2e/calibrate-prompt.mjs`（主站默认 / 加 `atlas:` 前缀走灾备）。
- **次路线·pptx 本地擦除（免费）**：页面底部折叠入口。上传 `.pptx`，浏览器本地 jszip + DOMParser 解析 OOXML 并重绘——不画任何文字，保留版式/配色/图片/装饰形状——导出 1536×864 底座 PNG + 槽位 JSON。无任何服务端路由、无计价；文件不出浏览器。渲染划界（有意为之）：文字一律不画只收槽位；graphicFrame（表格/图表/SmartArt）跳过并计数提示；未识别 prstGeom 回退 rect；渐变只近似线性、组旋转/flip 忽略。**文字已烧进位图的页面擦不掉**——那类页正由主路线覆盖，两路互补。
- 测试：`scripts/tests/ppt-to-base.test.mjs`——[7e]（17 断言）钉 pptx 纯函数层契约（EMU 换算、Office 基准色值 tint 0.2≈#d9e2f3 / shade 0.5≈#203864、槽位角色启发式）；[7f]（19 断言）截图 AI 路线服务端全 mock：成功链路（标题+落盘+扣 5🌟）、提示词契约（点名参考图/改变项不变量分离/中性词加引号）、VLM vision 分段、requestId 重放 409 且不重复扣费、VLM 失败降级、edits 400→`IMAGE_REQUEST_INVALID` 且全退、开关外 404、余额不足 402、缺 requestId 400、估价 5🌟、崩溃残留行懒恢复补退（在途不误退 / 幂等）。真实 image2.5 校准（付费）走 `output/ppt-to-base-e2e/calibrate-prompt.mjs` 手测，不进套件。

## 24. 问题日志与可观测性（结构化落盘 + 请求追踪 + 健康契约，2026-10-20）

- 背景：站点关键失败此前只 `console.error` 进 systemd journal，没有集中记录、管理员在后台不可查。现在问题日志同时承担“失败审计 + 多人协作定位 + 发布版本关联”，但**任何日志写入失败都不能反向阻断业务**。
- 请求追踪：`src/lib/server/request-context.ts` 用 Node `AsyncLocalStorage` 给每个 `defineRoute()` 请求生成 `req_<24 hex>`；响应头 `x-request-id` 与 500 错误 envelope 的 `error.requestId` 同步回填。问题日志自动采集 `requestId` / `method` / `route`。
- 发布关联：`src/lib/server/release-info.ts` 读取 release 根目录 `.deploy-commit`（本地 production build 回退 `.next/BUILD_ID`，非生产为 `dev`），每条问题日志写入 `release`；`/api/health.release` 也返回同一值，部署脚本据此校验运行时版本。
- 写入端 `src/lib/server/problem-log.ts` 的 `logProblem()`：追加 JSONL 到 `<ANPPT_V2_DATA_DIR>/logs/problems-YYYY-MM-DD[.N].jsonl`（生产 = `/opt/anppt-v2/shared/data/logs/`；目录可用 `ANPPT_V2_PROBLEM_LOG_DIR` 覆盖）。固定字段：`ts` / `level` / `category` / `message` / `detail` / `userId` / `refType` / `refId` / `eventId` / `requestId` / `method` / `route` / `release`；旧记录缺新字段时读取回退为空串。message ≤500 / detail ≤4000 字符。
- 脱敏：Bearer、Authorization、Cookie、password、token、API key、secret、credential、private key、OTP/验证码字段递归打码；对象先按敏感 key 替换再 JSON 化，Error 取脱敏后的 stack；日志文本中的 `key=value` 与 URL 查询参数也会打码。
- 双写与兜底：`logProblem()` 全函数 try/catch；落盘/序列化/清理失败时只写 `[anppt-v2][problem-log] ...` 到 stderr，不抛给业务。正常写入同时输出 `[anppt-v2][problem][category] ... requestId=...`，journal 仍可 grep。
- 容量：按天分文件；单文件 20 MiB 后写同日 `.1.jsonl` / `.2.jsonl`；保留 14 天；总量超 100 MiB 时从最旧文件删到 80 MiB 以下；若当天文件单独触顶则拒绝新落盘并记 `[anppt-v2][problem-log]` 告警，避免填满磁盘。读取端最多解析 3000 行、坏行跳过、未知字段忽略。
- 已接入的失败点（category）：`api` 路由未捕获异常；`generation` 逐页/单页生成退款失败、生成管线异常中断、崩溃恢复补退款失败；`ppt-to-base` 底座退款失败；`payments` 微信/epay 回调入账失败与回调异常；`otp` 验证码交付失败；`sms` 阿里云拒发；`image-upstream` 主站与 atlas 非 2xx；`editable` 可编辑导出失败/402/退款失败/文字档管线失败。
- 读取端 `readProblems({days, category, level, limit, offset})`：读最近 N 天（默认 3、上限 14；limit 默认 200、上限 500），返回 `{ items, categories, total, hasMore, nextOffset, scanLimited }`；categories 动态发现，新增 category 无需改前端常量。
- 管理后台 `/admin/problems`：管理员会话守卫；动态类别筛选、级别/天数筛选、每次 200 条“加载更多”、总条数、落盘健康状态、请求号/发布版本列；异常时显示目录不可写或近期写入失败提示。API `GET /api/admin/problems?days=&category=&level=&limit=&offset=` 返回 `{ ok, data: { items, categories, total, hasMore, nextOffset, scanLimited, health } }`，`private, no-store`。
- 健康契约：`GET /api/health` 提供 `release`、`plugins`（启动期装配清单；装配异常降级为 `plugins.error`，不拖垮整条探针）与 `logging`（`ok/writable/fileCount/totalBytes/writeFailures/lastFailureAt/recentFailure/retentionDays`）。应用侧健康探针 60 秒缓存；`logging.ok` 通过真实临时文件写入验证，目录不存在会自动创建。
- 监控/发布：`deploy/anppt-health-monitor.py` 检查 `logging.ok`、近期写入失败、总量 80 MiB 预警与 `plugins.error`（插件运行时装配失败）；`scripts/verify-health.mjs` 在发布后强制校验 `ok/db/plugins/logging.ok/logging.writable/release`，失败自动回滚。完整多人协作、上线、回滚和故障流程见 `docs/LOGGING.md`。
- 测试：`node scripts/test-backend.mjs` [12d]（落盘回环/动态类别/分页游标/请求上下文/脱敏/健康探针/分段读取/坏行/14 天清理/不可写降级）与 [10]（未登录 401、普通用户 403、管理员 200）。

## 25. 创新点口径（对外可用，逐条锚定实现与测试，2026-10-13）

> 只列「能在本仓库指到实现、并指到测试或验证命令」的项；没有实现落点的说法不要写进对外材料。实现或数字变化时同步本节与 §8。

1. **八段式提示词（生图）**——提示词不是一段自由文本，而是固定八段契约：任务与语境 / 整套一致性 / 页面角色与页型协议 / 页面文案与防幻觉 / 版式与配图建议 / 风格 DNA 与参考样张 / 内容真实性硬约束 / 易转可编辑条款。段序即拼接序；上下文不适用的段跳过，但段位保留——于是「这一页为什么这样画」可以逐段定位，改一段不会污染其他段。
   - 实现：`style-packs.ts` 的 `SLIDE_PROMPT_STAGE_DEFS` / `buildSlideImagePromptStages()` / `buildSlideImagePrompt()`。整套（`generate.ts` `promptForSlide`）与单页（`single-pages.ts` `buildPagePrompt`）两条路径共用同一装配器；改图/微调指令只在八段之后追加，不新增段。
   - 证据：`node scripts/test-generation.mjs` 4 条八段契约断言（段序与职责键固定、满配八段齐全、拼装结果与提示词逐字一致、缺省只跳段不减位）；2026-10-13 落地时以重构前实现为基准跑过 56 组输入逐字对比，全部一致（行为等价，出图不受影响）。
2. **页型分层协议**——`protocols.ts` 把页型拆成固定 5 条（文字忠实 / 信息任务 / 构图版式 / 配图基因 / 禁忌），整体作为八段式第 3 段进入提示词；页型注册表 `page-types.ts` 当前 40 型（`PAGE_TYPES.length`），role 优先 + 关键词最长匹配。
3. **全局视觉规范（deck 级 blueprint）**——`blueprint.ts` 每套 deck 只调一次 LLM 生成视觉总规范，缓存到 `data/blueprints/{deckId}.json`，风格包或大纲变化时指纹失效重算，失败降级为空串；逐页注入第八段的第 2 段，保证整册像同一位设计师做的。
4. **原创设计 DNA + 确定性样张选择**——`src/data/style-design-dna.ts` 为每个公开风格包维护色板/栅格/图形母题/配图策略/禁区；`selectStyleReferencePath()` 按 `风格包:页型:页序:标题` 稳定散列选样张，提示词只取样张风格、明确禁止复制其文字与 Logo。测试断言每个公开包都有 DNA 且封面样张存在。
5. **可编辑性前移到生图阶段**——`EDITABLE_FRIENDLY_CLAUSE`（八段式第 8 段）固化字体字形、分区、栅格与「每段文案只出现一次」，为下游 Codia 转可编辑链（§6）预先铺路，而不是事后补救。
6. **崩溃懒恢复 + 定长退款幂等键**——`recovery.ts` 按 job 心跳把中断页收敛为 failed 并按 ledger 实扣金额补退；扣费/退款键由 `credits.chargeRefundKeys` 定长派生，避免超长键截断后退款静默失效（§4）。
7. **结构化问题日志**——`problem-log.ts` 把关键失败落成 JSONL 并在 `/admin/problems` 可查（§24），日志侧可审计、可回放。

## 26. 公开站点标准与合规页面（2026-10-19）

- 站点配置 `src/data/site-config.ts` 新增 `publicBaseUrl` / `companyName` / `icpNumber` / `legalUpdatedAt`；`PUBLIC_BASE_URL`、`ANPPT_COMPANY_NAME`、`ANPPT_ICP_NUMBER` 可覆盖。页脚只在 `icpNumber` 非空时渲染备案链接，避免空占位。
- 根布局 `src/app/layout.tsx`：`metadataBase`、canonical 基准、Open Graph / Twitter、robots、manifest、Apple Web App、viewport themeColor，以及 Organization / WebSite / SoftwareApplication JSON-LD；分享卡片由 `src/app/opengraph-image.tsx` 生成（1200×630）。
- 公开内容页：`/help`（格式、流程、美化、可编辑、积分退款、FAQ）、`/about`、`/legal/privacy`、`/legal/terms`、`/legal/refund`。`/login` 增加条款与隐私入口；充值页「查看详细说明」改链 `/help#credits`。
- 站点级状态：根 `not-found.tsx`、`error.tsx`、`global-error.tsx`、`loading.tsx`；`AppShell` 增加跳转主内容链接、移动抽屉 Escape 关闭与滚动锁定、侧栏 `aria-current`、`aria-expanded/controls`。
- SEO：`robots.ts` 只放行公开内容页，应用页与 API 均禁止抓取；`sitemap.ts` 覆盖首页、模板库、帮助、关于与三份规则页；`public/.well-known/security.txt` 提供安全联系入口。
- 规则页内容必须与实现保持一致：生成 10🌟/页、可编辑 20🌟/页且单次最多 20 页、失败未完成部分自动退回；改价或改退款规则时同步 `src/data/recharge.ts`、`/help` 与 `/legal/refund`。
- 校验：`npm run gate`；上线后检查 `/sitemap.xml`、`/robots.txt`、`/opengraph-image`、`/.well-known/security.txt` 与 `/help` 的 200 响应。

## 27. 性能与多用户并发（2026-10-19）

- SQLite：`src/lib/server/db.ts` 增加 `busy_timeout=5000`、`synchronous=NORMAL`、64MB cache、`temp_store=MEMORY`、128MB mmap；启动时清理 7 天前过期会话与 OTP，避免长期运行表膨胀。`recharge_orders(status, created_at)` 与生成/导出 active partial index 已补。
- 生图公平调度：`images.ts` 在全局并发/每分钟启动之外增加单用户配额（默认 6 在途、16 次/分钟，`ANPPT_V2_IMAGE_PER_USER_CONCURRENCY` / `ANPPT_V2_IMAGE_STARTS_PER_USER_PER_MINUTE`）。队列不再只卡队首，单用户占满时其他用户可继续；测试 `[2c]` 断言 A1/B1 先启动。
- 文档解析：PDF/DOCX 是 CPU 重活且 pdfjs 在 Node 下走 fake worker；`documents.ts` 增加进程内解析槽（默认 2，`ANPPT_V2_DOCUMENT_PARSE_CONCURRENCY`）与 20s 排队超时（`ANPPT_V2_DOCUMENT_PARSE_QUEUE_TIMEOUT_MS`），超出返回 `DOCUMENT_PARSE_BUSY` 503。
- 请求侧：`/api/deck/parse` 在 `formData()` 前检查 content-length（防超限 body 整段进内存），并按用户限 60 次/小时；`/api/tools/replicate/plan` 按用户限 40 次/小时。
- 查询：`getDeckState` 改为一次取整套 `slide_versions`（`listVersionsByDeck`），单页项目详情一次取项目版本（`listProjectVersions`），项目列表用相关子查询批量取页数与封面，避免逐项目/逐页 N+1。
- 缓存：公开的 style-pack-categories / showcase-cases / site-config 加 `public` 缓存；style-packs / templates 加 `private, max-age=60` + `Vary: Cookie`。
- 验证：`node scripts/test-generation.mjs` 538 断言、`node scripts/test-backend.mjs` 170 断言；并发生图公平性、中文 CID PDF、PDF/DOCX 解析与现有计费/导出链路均回归通过。

- 备份：`deploy/backup-db.sh` + `deploy/anppt-backup.timer`（每日 03:30，`VACUUM INTO` → gzip，保留 14 天，目录 `/opt/anppt-v2/shared/backups`）。已做一次恢复校验：解压后 `PRAGMA integrity_check=ok`，用户/钱包/订单表可读。备份只含 SQLite；uploads/generated/exports 需另行归档。
- 本机压测基线（2026-10-19，本地 `next start`，非生产 SLA）：20 用户、100 个 deck、600 次 `/api/me` + `/api/projects` + `/api/style-packs` 并发读，40 并发下 p50 18.4ms / p95 34.7ms / p99 115.2ms，0 失败；空库 600 请求 p95 24.7ms。生产进程常驻 RSS 约 195MB（峰值 246MB），远端可用内存 6.2GB。

## 28. 可编辑转换接入（WPS / Image2PPT / Codia，2026-10-20）

- 背景：Codia 的 Full/元素级能力与 Image2PPT 的原生文字/形状/表格重建是两条不同路线。2026-10-20 实测一张 1280×720 中文页，Image2PPT 输出 13 个对象（3 个原生形状 + 7 个文本框），LibreOffice 渲染与源图基本一致；因此保留 Image2PPT 为付费主通道、Codia 为自动备用。同日晚些时候接入 WPS AIPPT 免费网页通道，配置 Cookie 后可设 `ANPPT_V2_EDITABLE_PROVIDER=wps` 排到最前；未配置 WPS 时仍维持 Image2PPT 优先。
- 配置（只放 `shared/.env`，不进仓库）：`ANPPT_V2_EDITABLE_PROVIDER=image2ppt|wps|auto|codia`、`ANPPT_V2_IMAGE2PPT_API_KEY`、`ANPPT_V2_IMAGE2PPT_BASE_URL=https://image2ppt.com`、`ANPPT_V2_IMAGE2PPT_WEBHOOK_SECRET=whsec_...`；WPS 需 `ANPPT_V2_WPS_AIPPT_COOKIE`（可选 `ANPPT_V2_WPS_AIPPT_BASE_URL=https://ippt.wps.cn`）。财务估算可选 `ANPPT_V2_COST_IMAGE2PPT_FEN_PER_PAGE=100`。管理后台「可编辑」连接检查会按当前首选通道调用只读接口（WPS 为 `/api/v3/islogin`），不会创建转换任务。
- 机制：`image2ppt.ts` 负责 multipart 提交、`GET /api/v1/jobs/{id}` 轮询、带 Bearer 下载和 Standard Webhooks 验签；`editable.ts` 负责建行扣费、按 registry 主备切换、`upstream_provider` 记录、懒恢复与 webhook 去重。`export_jobs.upstream_provider` 由 `getGenDb()` 幂等迁移补齐。
- 通道接口（2026-10-28，T12）：三个通道实现同一接口（发起 start / 推进 advance / 保存 save / 清理 cleanup），能力声明 `maxPages`（WPS 50、Image2PPT 50、Codia 20）、`resumable`（只有 WPS 为 false）与 `attempts`（Codia 2）。统一通道视图（状态/进度/完成页/总页/阶段/错误）驱动**同一份**阶段映射与进度落库——此前 `codiaStage` / `image2PptStage` / 两份 persist 各写一套，现在只剩 `stageForStatus()` 与 `persistProviderProgress()`。管线与懒恢复不再按通道名分支；「上游繁忙 / 未配置 / 额度不足」文案与有限数解析收进 `providers/types.ts` 一份。管理员「可编辑」连接检查仍在平台层（`src/lib/server/admin-integrations.ts`）保留自己的通道排序——平台层不得 import 模块（`docs/DEVELOPMENT.md` §1 的 lint 边界），故不在本次收口范围；改配置语义时两处一起改。
- 回调：`POST /api/webhooks/image2ppt` 只做验签和状态推进，最终下载仍走同一条管线；`saveEditableResult` 按 exportId 去重，避免 webhook 与 4s 轮询同时写文件。`PUBLIC_BASE_URL` 非 HTTPS 公网时自动省略 callback。
- 监控：`/api/health` 新增 `editable.provider/providers/image2ppt/wps/queue`；`deploy/anppt-health-monitor.py` 在 Image2PPT/WPS 主通道未配置、Image2PPT 剩余额度 <20、Image2PPT/WPS 登录态失效（401/403）、在途 >45 分钟、或一小时内 ≥3 次失败且 0 成功时发邮件告警。改脚本后先 `python3 -m py_compile` 再手动跑一次。
- 测试：`scripts/tests/image2ppt.test.mjs`（[6f]）覆盖提交/鉴权/回读/签名/非法签名/完成回调/终态不降级/主备切换/仅 Image2PPT 报价；`scripts/tests/wps-aippt.test.mjs`（[6g]）覆盖 WPS 上传凭证/SSE 进度/真实 PPTX 字节校验/WPS 主通道落盘与 provider 记录/WPS 失效回退 Codia/provider 顺序；`scripts/tests/editable-providers.test.mjs`（[6h]）覆盖能力声明（maxPages/resumable）、registry 回退顺序与页数过滤（20/21/51 边界、报价同口径）、假通道驱动管线（start→advance→save→cleanup、统一进度落库、attempts 重建、回退、同步通道）、恢复只走接口（未知通道 id / 不可恢复通道重跑）、共享文案与有限数解析；`scripts/test-generation.mjs` 当前 577 断言，全部 mock，禁止真实付费调用。
- 真机验收：2026-10-20 用非敏感单页 PDF 跑通 `startUploadedEditableExport → Image2PPT → 下载 → 落盘 → getExport`，输出 54,085 bytes PPTX；账户扣 1 credit。WPS 另用真实登录态跑通 `convertPdfWithWpsAippt`：1 页 PDF → 10,591 bytes PPTX，`slides/slide1.xml` 含可编辑 `<a:t>` 文本节点且无整页媒体图片；该验收命令不进测试套件。

## 29. deck 意图通道、动作前置与可用集合（2026-10-27）

- 契约：`src/lib/deck-intents.ts` 是客户端与路由共用的一份意图声明——20 个 kind（`DECK_INTENT_KINDS` 由 `IntentParamsTable<DeckIntentParams>` 强制穷尽登记，表键即 kind）各自带具体参数类型；`DeckIntentExtra` 声明每个意图的响应附带字段。旧动作名词汇（`{action, ...params}` 信封与动作名映射表）已删除，唯一请求形态是 `{intent:{kind,params}}`。
- 路由与分派：`POST /api/deck/[id]` 把整张 `DECK_INTENT_PARAMS` 表交给共享 `readIntentParams` 收窄（缺信封/未知 kind → 400 `VALIDATION_ERROR`），不再有 deck 专用 `readDeckIntent`；`dispatchDeckIntent` 按 `intent.kind` 分派；返回值 `ActionResult<kind>` 的 `extra` 按 kind 收窄（无 `Record<string, unknown>` 兜底），响应恒为「全量 deck 状态 + 该意图 extra」平铺，前端用 `DeckIntentResult<kind>` 按 kind 取字段。
- 动作与前置（唯一声明在 `src/lib/deck-gates.ts`）：
  - 内容类（`generateOutline/addSlide/removeSlide/reorderSlides/splitSlide/updateSlide`）：冻结即拒 → `CONTENT_LOCKED`；`structureSlides/structureSlide` 另加「至少一页」`NO_SLIDES`；`confirmStructure` 再加「全部页梳理完成」`STRUCTURE_INCOMPLETE`（文案带未完成页号）。
  - 冻结态出口与只读动作：`unlockStructure` 生成中拒（`GENERATION_RUNNING`；未冻结时是幂等 no-op，返回 `alreadyUnlocked`）；`commitVersion` 生成中拒 + 未冻结拒（`VERSION_SELECT_TOO_EARLY`）；`setStyle` 生成中拒。
  - 生成类：`generateSlides` 走生成前置（生成中 → 未确认 → 未选风格，码 `GENERATION_RUNNING / STRUCTURE_NOT_CONFIRMED / STYLE_REQUIRED`）；`retryFailedSlides` 先要求有失败页（`VALIDATION_ERROR`）再套生成前置。`generate.ts` 的启动校验复用同一函数，措辞不分叉。
  - 页级意图（`generateSlide/refineSlide/eraseSlide/editSlideText/fuseSlide/setReferenceImage`）的前置依赖具体页（是否已有生成图等），不登记 deck 级集合，逐页判断。
- 可用性：`getDeckState()` 返回 `availableIntents`（同一份规则按当前 deck 事实算出；事实只在 `buildDeckFacts(deck, job)` 一处构造，dispatch 前置与展示面同源，activeJob 在跑时两边一致隐藏/拒绝）；客户端 `deriveDeckAvailability(state)` 直接读它（`canRetryFailed` 等），各步组件不再各写顺序条件；`canGenerate` 仍是「内容已冻结」这个事实，风格由 UI 另行校验。saving/editor/弹窗这类局部 UI 态仍归组件。
- 拒绝语义：拒绝码/文案/HTTP 状态都从 gate 规则生成（含 `STRUCTURE_INCOMPLETE` 的页号文案），错误提示不再与规则各写一份；参数深校验（缺 slideId、DSL 非法等）仍留在动作自身。
- 计费/幂等未改：扣费键、退款键、job 创建顺序与 `unlockStructure` 的作废语义全部沿用原实现。
- 测试：`scripts/tests/deck-intents.test.mjs`（[4d]）钉意图唯一入口、dispatch 覆盖、拒绝理由逐字来自不变量、`availableIntents` 随状态翻转、路由拒旧 `{action}` 信封；`scripts/tests/deck-workbench.test.mjs`（[4e]）钉意图请求体、按意图收窄的响应、可用性推导与静态约束（链路无 `Record<string, unknown>` 请求体、无 `run("action")`、无 `deckAction`）。

## 30. 单页 / 导出 / 后台的 typed intent（2026-10-27）

- 契约：单页 5 个写动作（`src/lib/single-page-intents.ts`）、导出 4 个（`src/lib/export-intents.ts`）、后台 5 个（`src/lib/admin-intents.ts`）与 deck 同一形态：`{kind, params}` + 「意图 → 路由」适配器；客户端只发 `{intent}` 信封，路径与方法由适配器决定，组件与路由不再各抄一份清单（deck 通道见 §29）。
- 路由：`src/lib/server/intents.ts` 的 `readIntentParams(body, 表, expected?)` 解信封——表是 `(kind → 参数校验器)`；单 kind 路由传 expected 收紧到本路由动作，deck 一次收整张表，缺信封/未知 kind/错配一律 400 `VALIDATION_ERROR`，不静默降级。意图形状的唯一解析实现在 `src/lib/intent-envelope.ts`（前后端共用，客户端打包不碰 server/http）；参数深校验、扣费、幂等键、开关硬门仍留在原动作里，信封不复制语义。
- 兼容：无——旧的无类型 body 直通分支已随收缩票删除（2026-10-27），15 条意图路由只收 `{intent:{kind,params}}`；外部脚本一律改发意图。单页逐版本生成/半成功状态与扣费仍由原循环与 `single-pages.ts` 决定。
- 未纳入（刻意）：读接口按能力命名（§7）；multipart 上传（`/api/assets/upload`、`/api/editable-conversions`）没有 JSON body；复刻美化批量/草稿（`/api/single-page/batch|draft`）由模块拥有（§21），不进单页意图通道；后台读接口（overview/config/flags/problems/finance）仍按读处理。
- 测试：`scripts/tests/surface-intents.test.mjs`（[4f]/[10b]）钉单页/导出/后台的意图↔路由、解析护栏、适配器错配 400，以及版本选择/导出报价/后台配置三条真实路由的意图端到端（全程 mock，零付费调用）。
