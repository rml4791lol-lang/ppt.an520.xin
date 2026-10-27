# models（模型清单插件）

文本/图像模型清单与回退链的只读包装。机制见 `docs/PLUGIN-ARCHITECTURE.md` §5 与手册 §22。

## 负责什么

把「能用哪些模型、挂了之后换谁」收敛成 ctx 服务；下架一个模型 = 改一处配置。本插件**不改**现有生成链行为，权威配置仍在 `src/lib/server/generation/config.ts`（含管理端运行时覆盖）。

## 暴露的服务键

`models` → `ModelsService`：

- `text(): string[]` — 文本链：主模型 → `llmFallbackModels` → 跨站备份（去重）
- `image(): string[]` — 图像链：文生图 / 改图 / 各自跨站灾备（去重、去空）
- `fallback(model): string | null` — 沿链取下一个；文本按链序推进，图像按用途成对（文生图→其灾备、改图→其灾备）；链尾或未知模型返回 `null`

## 价格动作

无（本插件不涉及计费）。

## 配置项

无插件级 `config`。平台在 boot 时把 `config` 服务（`src/lib/plugin/contracts/config.ts`）注入 ctx，本插件经 `ctx.use('config').models()` 调用时现读；模型清单来自 `generation/config.ts` 的环境变量（`ANPPT_V2_LLM_MODEL` / `ANPPT_V2_LLM_FALLBACK_MODELS` / `ANPPT_V2_IMAGE_MODEL` / `ANPPT_V2_IMAGE_EDIT_MODEL` / `*_BACKUP_*`），调用时现读，管理端覆盖自动生效。

## 测试

`scripts/tests/plugin-runtime.test.mjs`（由 `scripts/test-generation.mjs` 注入 ctx 调用），断言清单非空与回退链行为。
