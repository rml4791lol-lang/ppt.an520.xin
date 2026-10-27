# ppt-replicate（PPT 美化 / 复刻）

上传参考稿保画面、换文案的独立功能模块。开关 `ppt_replicate`（beta 起步），机制与二阶语义见 `docs/DEBUG-HANDBOOK.md` §21。

## 边界

- `server/facade.ts`：模块唯一的服务端对外入口——项目/页/版本实体、提示词契约、计费动作声明；平台单页运行时的复刻分支只经它调用（实现暂委托平台，见下）。
- `server/replicate.ts`：结构卡（VLM）、拆文案计划、复刻生图指令、模块常量与限流键。
- `server/batch.ts`：PPT 美化批量任务状态机（服务端 3 页并发、在途复用、心跳超时收敛、轮询详情）；HTTP 薄壳为 `/api/single-page/batch`。
- `client/`：`beautify-client.tsx`（/beautify 工作台编排）、`beautify-ui.tsx`（UI 零件）、`beautify-pages.ts`（扣费名单/横幅/草稿规则/`requestId`）、`beautify-api.ts`（请求）、`beautify-handoff.ts`（首页→/beautify 文件交接）、`replicate-shell.ts`（浏览器拆页/壳图，PDF worker 同站打包）、`replicate-urls.ts`（URL 白名单与跳转）、`own-template-panel.tsx`（模板库入口卡）。
- 薄壳（只做鉴权/参数/调模块，不在本目录）：`src/app/(main)/beautify/page.tsx`、`src/app/api/tools/replicate/plan/route.ts`。

## 依赖的平台件（只准用，不准在本模块改）

`lib/server/generation/single-pages.ts`（复刻是单页运行时的 `mode:'replicate'` 分支，扣费/退款/版本/恢复全部复用，生成链路检查+落版本+置 running 在同一 BEGIN IMMEDIATE 事务）、`storage.ts`（壳图落盘与清理）、`rate-limit.ts`、`engine.ts`（LLM）、`credits.ts`（`/api/credits/estimate` 现读单价，客户端不硬编码）。改这些走平台评审，不算模块改动。

## 测试

`scripts/tests/ppt-replicate.test.mjs`（由 `scripts/test-generation.mjs` 注入 ctx 调用）+ 开关门控在 `test-backend.mjs` [11]。禁止真实 VLM/生图/Codia。
