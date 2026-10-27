# ADR-0001：插件运行时——继续推进，但设毕业门槛

- **状态**：Accepted（2026-10-27）
- **决策**：推进插件化（选项 A），分期实施，每期有可验收的毕业条件
- **关联**：issue #11
- **被否决选项**：降级为「实验性、暂不推广」（选项 B）——理由见「为什么不是 B」

## 背景（2026-10-27 实测事实）

| 事实 | 度量 | 证据 |
|---|---|---|
| 运行时规模 | src/lib/plugin/ 共 123 行 | ctx / profile / types / default |
| 生产消费点 | **1 处** | credits.ts 经 ctx.use("pricing") 取价 |
| models 插件消费者 | **0**（只在测试里用） | plugin-runtime.test.mjs |
| UI 贡献点落地 | **0%** | src/plugins 下 entries:/slot: 命中 0 |
| 插件依赖方向 | 两个插件都 import 平台内部 | pricing/plugin.ts → getEnv；models/plugin.ts → getGenerationConfig |
| 价格数字归属 | 仍在 env.ts 的 DEFAULT_ACTION_PRICES | pricing 插件只做 key 映射 |
| 启动装配 | 懒装配（首次 getDefaultCtx() 才 boot） | lib/plugin/default.ts |

结论：**「可换实现」目前是想象中的 seam**——换掉 pricing 插件并不会改变价格，换掉 models 插件没有消费者。

## 决策

**继续推进（A）**。理由：插件契约本身（ctx 服务键 + profile 配置单 + fail-fast）已经在生产跑通一条链路（计费估价），沉没成本低；它解决的是「价格 / 模型 / 上游随供应商变化」这个真实痛点。只要把四道门补上，它就是真的。

但**不再为它扩面**：四道门全部达成前，不新增「先锋插件」，新功能一律走模块四件套（src/modules/）。

## 毕业门槛（逐条可验收）

### G1 价格真进插件
- **目标**：价格表的存储与解析归 pricing 插件；平台只认 ctx.pricing.quote(actionKey)。
- **验收**：把一份替代实现（例如从 DB 读价）换进 profile，全站价格随之变化，业务代码零改动。
- **度量**：credits.ts 不再 import 环境里的价格常量；`grep -r DEFAULT_ACTION_PRICES src/lib` 只命中价格源自身。

### G2 UI 贡献点落地
- **目标**：至少一个**有界面**的功能通过 ui.entries 注册入口，壳里该功能的 `if (开关)` 删除。
- **验收**：关闭该功能 flag 时，入口消失、API 404、页面提示「尚未开放」三者同时成立，且无需改壳代码。
- **度量**：src/plugins 下 entries: 命中 ≥1；sidebar / upload-card / template-library 中该功能的硬编码分支 = 0。

### G3 启动期装配
- **目标**：进程启动即装配 profile 并打日志；缺服务键的 fail-fast 发生在启动，而不是首个请求。
- **验收**：故意从 profile 删掉 pricing → 进程启动即失败并报出缺失的键；健康检查能读到装配版本。

### G4 插件自包含（依赖倒置）
- **目标**：插件不 import 平台内部实现，只经 ctx 与 contracts。
- **验收**：`grep -r "from @/lib/server" src/plugins` = 0；lint 增加「插件 → 平台内部」的 zone。

## 时间盒（防止无限期半吊子）

- G1 + G4：两个迭代内
- G2 + G3：再下一个迭代
- 逾期未达成 → 本 ADR 状态改为 **Superseded**，插件降级为实验性，并记录卡在哪道门

## 影响

- **不新增先锋插件**，直到 G1 / G2 达成
- 新功能仍按模块四件套交付，不强制插件化
- PLUGIN-ARCHITECTURE.md §4 冻结清单不变
- 本 ADR 可被后续架构评审直接引用，避免重复讨论「要不要做插件」

## 为什么不是 B（记录被否决的理由，便于将来复核）

B 的问题是**半吊子成本**：运行时 123 行、1 个消费点，却要求所有新代码「考虑插件」；同时文档仍在描述一个不存在的系统，后来者照抄会付双份复杂度。要么补上四道门让它成真，要么彻底降级。选 A 并设时间盒，是把「要不要」变成「什么时候算数」。
