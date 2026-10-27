# pricing（价格表插件）

计费动作 → 星数的唯一查询入口。机制见 `docs/PLUGIN-ARCHITECTURE.md` §5 与手册 §22。

## 负责什么

把「这个动作多少钱」从散落的常量收拢成 ctx 服务；换价格 = 换 profile 里的 pricing 插件，调用方零改动。

## 暴露的服务键

`pricing` → `PricingService`：

- `quote(actionKey): number` — 未定价动作返回 **0**（免费是合法形态，不 throw）
- `table(): Record<string, number>` — 只含已定价动作

## 价格动作

| 动作 key | 含义 | 来源（env.ts creditActionPrices 键） |
|---|---|---|
| `generate.page` | 整页生成 | `deck_page_generate`（10🌟） |
| `edit.page` | 单页改图/微调 | `deck_page_refine`（5🌟） |
| `export.editable` | 可编辑导出（Codia） | `export_editable`（20🌟） |
| `export.editable-text` | 轻量文字可编辑导出 | `export_editable_text`（5🌟） |
| `export.image` | 图片版导出 | `export_image`（0🌟） |
| `outline` | 大纲生成 | `outline`（0🌟） |

价格数字不写在本插件——权威仍是 `src/lib/server/env.ts` 的 `DEFAULT_ACTION_PRICES` 与 `CREDIT_ACTION_PRICES` 环境覆盖，本插件调用时现读，覆盖链自动生效。

## 配置项

无插件级 `config`。平台在 boot 时把 `config` 服务（`src/lib/plugin/contracts/config.ts`）注入 ctx，本插件经 `ctx.use('config').creditActionPrices()` 调用时现读；价格调整走 `CREDIT_ACTION_PRICES` 环境变量。

## 测试

`scripts/tests/plugin-runtime.test.mjs`（由 `scripts/test-generation.mjs` 注入 ctx 调用），含插拔实证（替代实现同键替换）。
