# editable-export（可编辑导出 + 导出中心）

图片版 PPT 转可编辑 PPTX 的独立功能模块。机制与二阶语义见 `docs/DEBUG-HANDBOOK.md` §6/§16。

## 边界

- `server/editable.ts`：唯一服务端出口——Codia 重转换链（`startDeckEditableExport` / `startSinglePageEditableExport` / `startUploadedEditableExport`，20🌟/页，任务制+懒恢复）、轻量文字档（`startDeckTextEditableExport`，VLM 覆盖层 5🌟/页，开关 `editable_text_overlay`）、导出中心查询（`listExports` / `getExport` / `quoteExport`，含进行中可编辑行的懒恢复触发）。
- `server/codia.ts`：Codia 开放 API 客户端（uploads/tasks，依赖注入 fetcher，含上游计量）。
- `client/`：`use-editable-export.ts`（导出编排 hook）、`editable-converter-client.tsx`（/tools/editable-converter 工具页）。
- 薄壳路由（只做鉴权/参数/调模块）：`/api/deck/[id]/export-editable{,-text}`、`/api/single-page/export-editable-pptx`、`/api/editable-conversions`、`/api/pptx-exports{,/quote,/[id]}`。

## 依赖的平台件（只准用，不准在本模块改）

`lib/server/exports.ts`（图片版 PPTX 导出 + pptxgenjs 类型/页面尺寸常量，模块→平台方向合法）、`credits.ts`（扣费/退款幂等）、`engine.ts`（VLM/LLM）、`generation/*`（decks/single-pages/storage/db/config）、`usage-meter.ts`。注意 `export_jobs` 表由平台与模块共享：图片版写记录走平台 `recordExport`。

## 测试

`scripts/tests/editable-export.test.mjs`（套件内段名 [6b]-[6e]，由 test-generation.mjs 注入 ctx）；开关可见性矩阵在 test-backend.mjs [11]。**禁止真实调用 Codia/VLM/生图。**
