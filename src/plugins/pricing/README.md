# pricing（价格表插件）

计费动作 → 星数的唯一权威：价格表的**存储、解析与查询**都在本插件，平台与业务代码只经 `ctx.pricing` 取价。
机制见 `docs/PLUGIN-ARCHITECTURE.md` §5、`docs/adr/0001-plugin-runtime-advance.md` G1 与手册 §22。

## 负责什么

把「这个动作多少钱」收拢成 ctx 服务；价格数字只在本插件（`prices.ts`）。
换价 = 换一份实现（例如改从 DB / 远程配置读价）并换进 profile，全站估价与扣费随之变，调用方零改动。

## 暴露的服务键

`pricing` → `PricingService`：

- `quote(actionKey): number` — 未定价动作返回 **0**（免费是合法形态，不 throw）
- `table(): Record<string, number>` — 只含已定价动作；调用方用它判定动作是否有价（不在表内 = 未知动作，估价直接 400）

## 价格动作

| 动作 key | 公开动作键（`/api/credits/estimate`） | 默认 |
|---|---|---|
| `generate.page` | `deck_page_generate` | 10🌟/页 |
| `edit.page` | `deck_page_refine` | 5🌟/页 |
| `export.editable` | `export_editable` | 20🌟/页 |
| `export.editable-text` | `export_editable_text` | 5🌟/页 |
| `export.image` | `export_image` | 0🌟 |
| `outline` | `outline` | 0🌟 |
| `tool.ppt-to-base` | `ppt_to_base` | 5🌟/张 |
| `generate.single-page` | `single_page_generate` | 10🌟/张 |
| `edit.single-page` | `single_page_refine` | 10🌟/张 |

动作键契约（含映射）在平台层 `src/lib/plugin/contracts/pricing.ts`；本插件只填数字。

## 价格源

- 默认表：`prices.ts` 的 `DEFAULT_PRICES`（数字只此一处）
- `CREDIT_ACTION_PRICES`：**整份覆盖**（公开动作键 → 星数）；坏 JSON 回落默认表，出现即不再回落默认价（缺项 = 未定价）
- `ANPPT_V2_SINGLE_PAGE_CREDITS`：单页生成/改图单价，独立旋钮、不受整份覆盖影响

装配期读取一次（boot 时定格）；任务内的扣费/退款按任务启动时拿到的单价快照，不重新读价。

## 测试

- `scripts/tests/plugin-runtime.test.mjs`（套件 [20]）：契约/表、未定价动作、换实现即换价（`estimateCredits` 随替代实现变价）
- `scripts/test-generation.mjs`：真实生成链在替代实现下扣费（整套只读一次价、单页按 ×3 实现报价扣 30），业务代码零改动
