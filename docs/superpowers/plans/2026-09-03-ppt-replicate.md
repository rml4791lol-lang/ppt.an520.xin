# 复刻 PPT Implementation Plan

> **For agentic workers:** Execute inline in this session. Do not commit unless the user asks.

**Goal:** 提供可在线使用的单 HTML 复刻试验场：参考壳结构、按新内容真设计、异步转可编辑。

**Architecture:** 新模块 `replicate.ts` 负责结构卡解析与复刻指令；`generateSinglePage` 在 `mode=replicate` 时走 edits；静态页编排现有上传/单页/可编辑 API。不改工作台主路线。

**Tech Stack:** Next.js 16 Route Handlers、现有单页生图与 Codia 导出、vanilla HTML+JS、pdf.js（CDN）拆 PDF。

## Global Constraints

- 新功能开关 `ppt_replicate`，`defaultState: 'beta'`，路由硬门 404。
- 不新造扣费键；生成 10🌟/页，可编辑 20🌟/页。
- 壳上传不按 20 页截断；Codia 仍 20 页/任务，前端切批。
- 测试全 mock，禁止真实 VLM/生图/Codia。
- 用户未要求则不 git commit。

---

### Task 1: 复刻指令模块 + 单页 mode

**Files:**

- Create: `src/lib/server/generation/replicate.ts`
- Modify: `src/lib/server/generation/single-pages.ts`
- Modify: `src/app/api/single-page/generate/route.ts`
- Modify: `src/lib/server/feature-flags.ts`
- Test: `scripts/test-generation.mjs` `[7c]`、`scripts/test-backend.mjs` `[11]`

**Produces:** `parseStructureCard`、`buildReplicateInstruction`、`resolveReplicateColorMode`、`extractSlideStructure`；`generateSinglePage(..., { mode, colorMode })`

- [x] 结构卡解析与两种配色指令可单测
- [x] `mode=replicate` 无壳图校验失败；有壳图走 `/images/edits` 且 prompt 含线框合同
- [x] 开关默认 beta，测试用户可见、普通用户 404

### Task 2: 单 HTML 试验场

**Files:**

- Create: `public/tools/replicate-ppt.html`

- [x] 登录/开关门、上传 PDF 或任意数量图片、配色开关、逐页复刻、切批异步转可编辑

### Task 3: 手册与断言数

**Files:**

- Modify: `docs/DEBUG-HANDBOOK.md` §21
- Modify: `README.md` 测试数

- [x] 机制/路径/失败语义/测试约束写进手册
