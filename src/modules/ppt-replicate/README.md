# ppt-replicate（PPT 美化 / 复刻）

上传参考稿保画面、换文案的独立功能模块。开关 `ppt_replicate`（beta 起步），机制与二阶语义见 `docs/DEBUG-HANDBOOK.md` §21。

## 负责什么

- 复刻（PPT 美化）的项目/页实体与生成：`server/pages.ts`——`saveReplicateDraft`（草稿只存项目/页/参考稿，不生成不扣星）、`generateReplicatePage`（壳图校验 → 页写入 → 结构/配色指令装配 → 交给平台单页运行时）。
- 提示词契约：`server/replicate.ts`（结构卡 VLM、拆文案计划、复刻生图/改图指令、模块常量与限流键）。
- 批量任务状态机：`server/batch.ts`（服务端 3 页并发、在途复用、心跳超时收敛、轮询详情）。

## 暴露什么

- `server/facade.ts`：模块唯一对外服务端入口——实体读写（项目/页/版本）、草稿写入、逐页生成、提示词契约、计费动作声明、懒恢复入口。
- `client/`：`beautify-client.tsx`（/beautify 工作台编排）、`beautify-ui.tsx`（UI 零件）、`beautify-pages.ts`（扣费名单/横幅/草稿规则/`requestId`）、`beautify-api.ts`（请求）、`beautify-handoff.ts`（首页→/beautify 文件交接）、`replicate-shell.ts`（浏览器拆页/壳图，PDF worker 同站打包）、`replicate-urls.ts`（URL 白名单与跳转）、`own-template-panel.tsx`（模板库入口卡）。
- 薄壳（只做鉴权/参数/调模块，不在本目录）：`src/app/(main)/beautify/page.tsx`、`src/app/api/tools/replicate/plan/route.ts`、`src/app/api/single-page/{draft,batch,generate}`（`generate` 按 `mode` 分派到本模块）。

## 依赖的平台件（只准用，不准在本模块改）

`lib/server/generation/single-pages.ts`：通用单页运行时——页/项目/版本表、`runSinglePageJob`（生成链路检查 + 落版本 + 置 running 同一 BEGIN IMMEDIATE 事务、扣费/退款/幂等键、懒恢复）。模块只把提示词与页面草稿交给它，钱与恢复全平台只有一份；`storage.ts`（壳图落盘与清理）、`rate-limit.ts`、`engine.ts`（LLM）、`credits.ts`（`/api/credits/estimate` 现读单价，客户端不硬编码）。改这些走平台评审，不算模块改动。

平台件不得 import 本模块（`eslint.config.mjs` 的 `import/no-restricted-paths` 强制）；反向依赖（模块 → 平台）才合法。

## 测试

`scripts/tests/ppt-replicate.test.mjs`（由 `scripts/test-generation.mjs` 注入 ctx 调用）+ 开关门控在 `test-backend.mjs` [11]。禁止真实 VLM/生图/Codia。
