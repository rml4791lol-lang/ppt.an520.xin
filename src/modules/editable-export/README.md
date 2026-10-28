# editable-export（可编辑导出 + 导出中心）

图片版 PPT 转可编辑 PPTX 的独立功能模块。机制与二阶语义见 `docs/DEBUG-HANDBOOK.md` §6/§16。

默认优先级：WPS AIPPT（免费通道，配置 Cookie 后）→ Image2PPT → Codia；任一路成功即停，全部失败才退星。

## 边界

- `server/editable.ts`：唯一服务端出口——`startEditableExport(source, kind, { force })` 单入口（source 适配器声明取页 / 页数上限 / 来源指纹 / 计费动作 / 引用；上传来源另声明展示字段与临时源文件 `cleanup`；返回 10 字段可序列化 view，无 `done`；测试经 `deps.onPipelineDone` 等管线）。来源适配器：`deckEditableSource`（20🌟/页）、`deckTextEditableSource`（5🌟/页）、`singlePageEditableSource`（20🌟/页）、`uploadedEditableSource`（异步工厂：PDF 或图片 → image-only PDF + 临时源文件落盘）。内部仍是 WPS / Image2PPT / Codia 多通道（20🌟/页，任务制+续跑+主备切换；页数上限 = 已配置通道链能力 `editablePageCapacity`，21–50 页来源先转 JPEG 再合成 PDF）、轻量文字档（`editable_text`，VLM 覆盖层 5🌟/页，产品上限 50 页，开关 `editable_text_overlay`）、导出中心查询（`listExports` / `getExport`，只推进已有上游任务，不再自行判活重跑）、Image2PPT webhook 验签与状态推进。扣费/退款顺序归平台计费运行模块 `paid-run`（单位数 = 页数）；中断续跑由 `server/recovery.ts` 登记为运行源。四个导出路由只做鉴权 / 参数 / 调用 / 序列化；旧 starter（`startSinglePageEditableExport` / `startUploadedEditableExport`）、`StartedEditableExport` 类型与测试 `done` 垫片已删除（T11）。
- `server/providers/`：上游通道接口层。`types.ts` 声明 start / advance / save / cleanup 与能力声明（`maxPages` / `resumable` / `attempts` / `configured`），并持有共享文案与有限数解析；`registry.ts` 是回退顺序与页数上限唯一来源（配置主通道优先 → 已配置过滤 → 按请求页数剔除，>20 页剔除 Codia；`editablePageCapacity` = 已配置链能力上限）；`wps.ts` / `image2ppt.ts` / `codia.ts` 是适配器。管线与懒恢复只依赖该接口，新增第四个通道 = 新增适配器文件 + registry 登记一次。- `server/wps-aippt.ts`：WPS 网页版内部 PDF/图片转 PPT 客户端（KS3 上传 + SSE 转换 + PPTX 下载）；依赖服务端 WPS 登录 Cookie，失败由管线自动回退。
- `server/image2ppt.ts`：Image2PPT 开放 API 客户端（multipart jobs、状态轮询、Bearer 下载、Standard Webhooks 验签，依赖注入 fetcher，含上游计量）。
- `server/codia.ts`：Codia 开放 API 客户端（uploads/tasks，依赖注入 fetcher，含上游计量）。
- `server/recovery.ts`：运行源 `editableRunSource`（域 `editable`）——只列用户在途的 `export_jobs`（pending/processing）并给出结算动作；判活口径（`updated_at` 心跳 + paid-run 在飞注册表，键 = 扣费键）由平台恢复入口经 `RunSourceContext` 注入，结算方式是**续跑**（`settlement='resume'`，不退星；hub 只启动不等待，同一导出最多一条管线由 `ensureEditablePipeline` 去重）。未扣费的中途行按失败收敛；退款已落账、置终态前崩溃的行只补 failed 终态，不续跑（避免免费交付）。由顶层装配点 `src/recovery-assembly.ts` 在启动期登记；平台恢复入口不 import 本模块。
- `client/`：`use-editable-export.ts`（导出编排 hook）、`editable-converter-client.tsx`（/tools/editable-converter 工具页）。
- 薄壳路由（只做鉴权/参数/调模块）：`/api/deck/[id]/export-editable{,-text}`、`/api/single-page/export-editable-pptx`、`/api/editable-conversions`、`/api/pptx-exports{,/[id]}`。

## 依赖的平台件（只准用，不准在本模块改）

`lib/server/exports.ts`（图片版 PPTX 导出 + pptxgenjs 类型/页面尺寸常量，模块→平台方向合法）、`credits.ts`（估价；扣费/退款只经 `paid-run`）、`engine.ts`（VLM/LLM）、`generation/*`（decks/single-pages/storage/db/config、paid-run 计费运行、run-source 运行源契约）、`usage-meter.ts`。注意 `export_jobs` 表由平台与模块共享：图片版写记录走平台 `recordExport`。

## 测试

`scripts/tests/editable-export.test.mjs`（[6b]-[6e]、[6i]/[6j] 单入口：共享 view / 四个来源（deck / 单页 / 上传）/ 上限来自 source / 复用与 force / 失败退星 / 上传临时源文件清理 / 路由直接序列化 / 旧 starter 与测试垫片已删除；[6k] T13：扣费走 `beginPaidRun`、失败退款按实扣金额、判活 = 心跳 + 在飞（480s 上传窗口）、鉴权门续跑推进既有上游任务、未扣费中途行不白跑、30s 宽限与 `reconcileInterruptedRun` 已删除）、`scripts/tests/image2ppt.test.mjs`（[6f]）、`scripts/tests/wps-aippt.test.mjs`（[6g]）、`scripts/tests/editable-providers.test.mjs`（[6h]：能力声明 / registry 页数过滤 / 通道能力上限与发起页数门 / JPEG 大套压缩 / 假通道驱动管线与恢复 / 共享文案），由 test-generation.mjs 注入 ctx；开关可见性矩阵在 test-backend.mjs [11]。**禁止真实调用 WPS/Image2PPT/Codia/VLM/生图。**
