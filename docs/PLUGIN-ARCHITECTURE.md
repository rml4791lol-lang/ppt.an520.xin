# AnPPT 插件化架构宪法（Plugin Architecture）

> 本文是「插件即功能、插件即 API、插件即商品」路线的权威文档。
> 与 `DEVELOPMENT.md` 的关系：模块制（`src/modules/`）是当前形态，插件制是目标形态；两者共用同一套纪律（四件套、开关板、金字塔分层），插件制把「服务契约」升级为一级概念。
> 最后更新：2026-10-27 ｜ **状态：推进中**（决策见 `docs/adr/0001-plugin-runtime-advance.md`：继续推进，但需通过价格进插件 / UI 贡献点 / 启动期装配 / 依赖倒置四道门，逾期则降级为实验性）

## 0. 第一性原理（为什么这么走）

两条公理：

1. **智力在变便宜**——模型持续变强变便宜，为「当前模型不够聪明」写的补丁会过期。
2. **复杂性不变便宜**——维护「缠在一起的系统」的成本永远不降。

推论（借 DeepSeek Harness 的思想，自研落地）：

- **Model + Harness 分离**：模型负责思考，系统负责传递力量（给它事实、工具、护栏），不替它做它能做的判断。
- **一切皆插件**：系统里唯一确定的事是「什么都会变」——模型、价格、链路、UI。所以没有一个组件享有「内置不可改」的特权。
- **接口是唯一不贬值的资产**：消费者只认服务键（`ctx.pricing`），不认具体实现。换实现 = 换插件，调用方零改动。
- **系统 = 一张配置单（profile）**：一个运行中的 AnPPT 实例，就是「一张有序插件清单 + 每张插件的配置」。看配置单知系统，改配置单变系统。

一句话：**智力归模型，变化归插件，稳定归接口，系统归配置。**

## 1. 三个等式（验收任何插件时逐条问）

| 等式 | 含义 | 反例（不合格） |
|---|---|---|
| **插件即功能** | 装上就在网站里跑得起来：有入口、有开关、有测试 | 只是个工具函数库，装上没有任何可验证的行为 |
| **插件即 API** | 它的能力通过 ctx 服务键暴露，别的插件和未来的 agent 用同一份契约调用 | 能力只藏在页面组件里，别处想用只能复制代码 |
| **插件即商品** | 自包含目录 + 版本号 + README + 价格声明，理论上可以单独打包分发（npm/Git），别人装上即用 | 拆下来带走路径依赖、隐式依赖全局单例 |

## 2. 插件标准件（五件套，缺一不可）

```
src/plugins/<key>/
├── plugin.ts        插件定义：{ key, version, provides, pricing?, config?, register(ctx) }
├── server/          服务端实现（可没有）
├── client/          UI 组件（可没有）
├── README.md        边界说明：负责什么、暴露什么服务键、价格动作、开关
└── 测试             scripts/tests/plugin-<key>.test.mjs
```

- `provides`：本插件注册到 ctx 的服务键清单（如 `pricing`、`models`）。
- `pricing`：本插件涉及的计费动作 key 清单（只声明动作，**不写数字**；数字只在 pricing 插件的价格表里）。
- `config`：本插件的运行参数声明（进 profile，不埋进代码）。
- `ui`（2026-09-06 补）：本插件的 UI 贡献声明——`entries: [{slot, label, href?, component?, order?, flag?}]`。entry 必须是**可静态审计的数据**（VS Code contribution points 的教训：回调时代无法静态分析）；`order` 显式定序（不靠注册顺序）；`flag` 粒度可细到单条 entry（对齐 VS Code `when` 子句）；`component` 存懒加载指令（动态 import / `next/dynamic`），插件 JS 不进首屏 bundle。壳按注册表渲染入口，不 import 插件。
- 插件之间**禁止直接 import**，只能通过 ctx 服务协作。lint 强制。

## 2.5 UI：壳与挂载点（2026-09-06）

- **壳永不插件化**：导航/侧栏/布局/登录态/设计系统（图标、配色 token、共享组件）是平台层，稳定统一。
- **内容插件化**：功能 UI 全部在插件 `client/` 下；壳只提供挂载点（slot）：`sidebar` 入口、`home-tab`、`template-library-panel` 等。新增功能 = 注册表多一行，不改壳代码。
- **页面薄壳**：Next 硬约束路由留在 `src/app`，页面文件只做 Suspense + 插件组件（成例：`/beautify/page.tsx` 17 行）。
- **开关控生死**：`ui.flag` 指向开关板 key——off 时入口不渲染、API 404、页面显示「功能尚未开放」（成例：四件图片编辑工具、ppt_replicate）。
- **设计约束**：插件 UI 只许用壳的设计 token 与共享组件，不许自带风格（硬编码色值这类违规后续用 lint 拦）。
- 收拢动作：现存散在壳里的 `if (开关)` 接线（upload-card/侧栏/模板库），在 Phase 3 迁移每块时顺手收进该插件的 `ui.entries`，不单独开工程。

## 3. 运行时三件（平台层，src/lib/plugin/）

- `ctx.ts`：服务注册表。`register(key, impl)` / `use(key)`；`use` 一个未注册的键 = 启动期报错（fail fast，不许运行期 undefined）。
- `profile.ts`：配置单加载。profile = 有序插件清单（顺序即依赖序）+ 各插件 config；默认 profile 是生产形态，测试可组合替代实现。
- `types.ts`：`AnPlugin` 接口与冻结数据契约的唯一定义处。

## 4. 冻结清单（改动需开 Issue 拍板）

| 冻结（宪法） | 自由（插件内部随便迭代） |
|---|---|
| Ref / Page / Result 等数据契约 | prompt 措辞、队列策略 |
| ctx 服务键清单与签名（pricing/models/generate…） | 插件内部实现 |
| 计费动作 key 清单 | 价格数字（pricing 插件内部） |
| profile 文件格式 | 各插件 config 取值 |

## 5. 先锋插件与迁移顺序

先锋（验证运行时，纯增量、不改现有调用方）：

1. `pricing` 插件：价格表收拢为插件（读现有 `env.ts` 常量起步），暴露 `ctx.pricing.quote(actionKey)`。**验收：换一份价格配置 = 只换 profile，全站零代码改动。**
2. `models` 插件：模型清单 + 回退链，暴露 `ctx.models.text()/image()`。**验收：下架一个模型 = 改一个数组元素。**

迁移（风险从低到高，每次一块、全量门必绿）：模板库 → 导出中心 → ppt-replicate（复刻流水线五段：接入/内容/提示词/生图/导出，数据契约 Ref/Page/Result 冻结）→ 账户计费（钱最后动）。

## 6. 验收线（插件运行时毕业考）

1. 两个先锋插件经 profile 组合启动，`ctx.use('pricing')` / `ctx.use('models')` 可用。
2. **插拔实证**：替代实现换进 profile，调用方零改动，测试同绿。
3. 未注册服务键 `use` 即报错；插件间 import 被 lint 拦截。
4. 两套既有测试门 + lint + tsc + build 全绿（纯增量证明）。

## 7. 与 DeepSeek Harness 的关系

思想对齐（一切皆插件 / ctx 服务键 / profile 组合），实现自研。不依赖 dsh 预览版代码库——它官方的 breaking-change 节奏不该绑在营收系统上；我们的插件契约自己冻结。dsh 社区插件（图像理解、记忆等）日后可通过适配器插件接入。
有意偏离一条：dsh 的 inject 是持续跟踪（服务缺失则消费方 PENDING 等待、恢复后重挂）；我们选「use 未注册 = 启动期报错」——营收系统要 fail fast。
迁移模式定名：Strangler Fig（绞杀者无花果）小步替换 + Ports & Adapters（内核纯 TS + 双薄壳）。依赖纪律：杜绝跨仓库 file:（npm symlink 语义 + rsync 部署必断）；插件要独立分发时用 vendored copy 或 npm pack tarball 进仓库。
