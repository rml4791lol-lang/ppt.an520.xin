# Anthropic html2pptx 方法论 → 我们的管线：调研笔记与差距

> 目的：把 Anthropic 官方 `pptx` skill 里 **html2pptx** 的设计思想拆出来，逐条对照我们现在的管线，决定"打磨 HTML 功能"优先补哪几块。
>
> **来源**（只读参考，不拷代码；官方许可为 source-available、禁止衍生）：
> - 官方文档原文（第三方镜像）：`html2pptx-guide-mirror.md`（1210 行）、`html2pptx-skill-mirror.md`（210 行）
> - 官方仓库：<https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md>（现主路径已改为直接写 pptxgenjs）
> - 本地既有调研：`research/01-oss-landscape.md` §①（架构、PT_PER_PX、2% 扩宽、无 autofit）
> - 我们的契约：`规范-HTMLPPT-HTML契约-v1.0.md`
>
> 调研日期：2026-10-20。镜像抓取命令见本目录 `fetch.sh`。

---

## 一、Anthropic 的方法论，剥掉营销话术只剩 10 条

| # | 原则 | 他们的做法 | 证据（文档原文要点） |
|---|---|---|---|
| 1 | **HTML 是"方言"，不是网页** | 只允许固定标签集：块元素 `div/section/...`、文本 `p/h1-h6`、列表 `ul/ol`、媒体 `img`、内联 `b/i/u/br` | "Supported Elements" 一节 |
| 2 | **文本必须有语义标签包裹** | 裸文本在 `div` 里"会被静默忽略" | "ALL text MUST be inside `<p>`, `<h1>`-`<h6>`, `<ul>`, `<ol>`" |
| 3 | **尺寸即版面** | `<body>` 显式宽高必须等于版面（16:9 = 960×540px） | "`<body>` must have explicit width and height matching the presentation layout" |
| 4 | **样式分层** | 背景/边框/阴影只允许挂块元素，文本元素不许带装饰 | "Backgrounds, borders, and shadows only work on block elements" |
| 5 | **排版约束换确定性** | 禁 `white-space: nowrap`；标题框给满宽（920px，左右 20px 内边距） | "NEVER use white-space: nowrap…ensure the text box is wide enough" |
| 6 | **字体白名单** | 只用 web-safe：Arial/Helvetica/Times/Georgia/Courier New/Verdana/Tahoma/Trebuchet/Impact | "ONLY use web-safe fonts that are universally available" |
| 7 | **布局用 `row/col` 类，不用 flex** | 用预置栅格类替代 flexbox | "Use `row` and `col` classes INSTEAD of flexbox" |
| 8 | **占位符留给图表** | `class="placeholder"` 预留区域，返回 `{id,x,y,w,h}` 交给 `addChart()` | "Working with Placeholders" |
| 9 | **转换前先校验，错误一次性报全** | 校验三件事：① HTML 尺寸 vs 版面；② 内容不得溢出 body（带精确测量）；③ 文本元素不许带装饰。所有错误聚合后一起抛 | "Validation" 一节 |
| 10 | **实现层微调** | `PT_PER_PX = 0.75`；单行文本框放宽 2%；不做 autofit；`inset:0` 全幅定位 | 本地调研 §①（解包 `html2pptx.tgz`） |

**一句话总结**：Anthropic 的护城河不是"把 CSS 转成 OOXML"，而是 **把不可控的网页收敛成一个可校验的小方言**——先约束、再测量、后转换，转换前把违规一次报全。

---

## 二、我们的现状 vs 他们的原则

| # | 原则 | 我们有没有 | 差距 |
|---|---|---|---|
| 1 | 固定标签集 | ✅ 有契约（`规范 v1.0` T1/T4） | 只有文档，**没有自动检查** |
| 2 | 文本必须语义包裹 | ⚠️ 部分 | `measure.mjs` 会忽略裸文本，但**不报错**，作者不知道丢了什么 |
| 3 | 尺寸即版面 | ✅ 有（1280×720 锁死） | 无运行时断言 |
| 4 | 样式分层 | ✅ 支持（我们比他们强：shape 可带文本） | 规则不同，需要按我们的方言写 |
| 5 | 禁 nowrap / 框给满 | ⚠️ 部分 | 我们用硬断行（更强），但**没有"单行框 +2%"的安全边距检查** |
| 6 | 字体白名单 | ⚠️ 部分 | 有嵌入能力，但**没有非白名单字体的告警** |
| 7 | row/col 替代 flex | ❌ 无 | 我们直接支持 flex（量测阶段），不需要这条 |
| 8 | placeholder 留给图表 | ❌ 无 | **值得抄**：图表是国赛页型最后一块拼图 |
| 9 | **转换前校验 + 错误聚合** | ❌ **完全没有** | **最大差距**：现在错了要等整条管线跑完、看 pixel diff 才知道 |
| 10 | 2% 扩宽 / 无 autofit | ⚠️ 部分 | 硬断行已规避换行，但没做宽度安全余量 |

**结论：差距不在"转换能力"，在"入口质量闸门"。** 我们已经有 13 项**出口** gates（转换后验收），缺的是 Anthropic 那套**入口** lint（转换前拦截）。

---

## 三、这一轮要补的东西（按 Anthropic 原则映射）

### P0 `htmlppt lint`：入口校验器（对应原则 9，顺带覆盖 1/2/3/5/6）

一条命令、一次报全、带精确测量：

```bash
python3 cli/htmlppt.py lint deck.html          # 人类可读
python3 cli/htmlppt.py lint deck.html --json   # 给 CI / agent 用
```

规则（按我们 `规范 v1.0` 的编号，对齐 Anthropic 的校验三件事）：

| 规则 | 级别 | 检查内容 | 对应我们的规范 |
|---|---|---|---|
| `dimensions` | error | 画布 ≠ 1280×720 | S1 |
| `bare-text` | error | 非语义标签里的裸文本（会被静默丢弃） | T1 |
| `overflow-canvas` | error | 元素越出画布（硬断行后最容易犯） | S2 |
| `overflow-text` | error | 文本框 `scrollHeight > clientHeight`（字被裁） | S2 |
| `manual-bullets` | error | 段落以 `• - * · ●` 开头（PPT 会双 bullet） | T4 |
| `unit-banned` | error | `vw/vh/em/rem/%` 出现在 width/height/font-size/margin/padding | S3 |
| `line-height-normal` | warning | `line-height: normal`（浏览器与 PPT 行数算法不同） | T6 |
| `letter-spacing-negative` | warning | 中文负字距（会粘连） | D7 |
| `font-not-allowed` | warning | 字体不在白名单/不可嵌入 | F1/F2/F4 |
| `unsupported-effect` | warning | `filter/backdrop-filter/mix-blend-mode/clip-path` 未标 `data-ppt-raster` | D5 |
| `text-decoration` | info | 文本元素带背景/边框/阴影（他们是禁止；我们的方言支持，只提示） | — |

**验收**：`samples/deck.html`、`curves.html`、`bench/corpus/deck.html`、反向导出的 18 页 `deck.html` 全部 lint 干净（0 error）。

### P1 `placeholder` 图表槽位（对应原则 8）

`<div class="placeholder" data-chart="bar">` → 转换时保留空白区域并在 `placeholders[]` 里返回坐标，后续用 PptxGenJS 的 `addChart()` 补原生图表。这是国赛 S12 页型（图表页）的最小可行路径。

### P2 单行文本框 +2% 安全边距（对应原则 10）

硬断行已经保证不重排，但 PowerPoint 的字体度量仍可能让单行多 1–2% 宽度。给"单行"文本框加 2% 宽度余量（不改变视觉），降低真机换行风险。

---

## 四、不照抄的部分（有意为之）

| 他们的做法 | 我们的做法 | 原因 |
|---|---|---|
| web-safe 字体白名单 | 任意字体 + subset/EOT 嵌入 + 白名单告警 | 中文场景 web-safe 不够用，嵌入才是正解（已实现并验证） |
| 渐变预渲染成 PNG | 原生 `a:gradFill` | 我们已验证可行，比栅格化保真且可编辑 |
| 禁 flex，用 row/col | 允许 flex（量测后转绝对定位） | 我们的量测层能处理 flex，硬断行进一步兜底 |
| 720×405pt 画布 | 1280×720px 画布 | 换算后同为 13.333×7.5in，但 1280×720 是浏览器原生坐标，量测无缩放误差 |
| 单文件 HTML | 默认链接式（assets/）+ `--single-file` 可选 | 换图需求要求图片是独立文件 |

---

## 五、本轮交付清单（已完成）

1. ✅ `prototype/src/lint.mjs` —— 入口校验器：13 条规则、聚合报告、`--json`、`--strict`
2. ✅ `cli/htmlppt.py lint <html>` —— CLI 入口（透传退出码）
3. ✅ `prototype/src/run.mjs` 第 0 步 lint（默认只告警，`LINT_STRICT=1` 时阻塞）
4. ✅ `cli/htmlppt.py build` 前自动 lint（`--strict-lint` 可强制失败）
5. ✅ 全部样例 lint 通过（见下表）

### 实测

| 文件 | 页数 | error | warning | info |
|---|---|---|---|---|
| `prototype/samples/deck.html` | 5 | **0** | 1 | 24 |
| `prototype/samples/curves.html` | 3 | **0** | 2 | 34 |
| `bench/corpus/deck.html` | 5 | **0** | 1 | 69 |
| `gold/g1.html` | 1 | **0** | 0 | 10 |
| 反向导出 18 页 `deck.html` | 18 | **0** | 15（出血图） | 0 |
| `samples/lint-broken.html`（负样本） | 1 | **2** | 4 | 10 |

负样本能稳定命中：`overflow-text`（文本被裁 96px>40px）、`manual-bullets`、
`overflow-canvas`、`unit-banned`（vw/rem）、`unsupported-effect`（filter）、`mixed-content`。

### 规则清单（13 条）

| 规则 | 级别 | 说明 |
|---|---|---|
| `dimensions` | error | 画布 ≠ 1280×720 |
| `overflow-canvas` | warning | 元素越出画布（出血是设计意图，仅提示） |
| `overflow-text` | error | 文本被裁（scrollHeight > clientHeight） |
| `manual-bullets` | error | 手打 •/-/* 会与 PPT bullet 重复 |
| `unit-banned` | error | vw/vh/em/rem 用于尺寸/字号 |
| `mixed-content` | warning | 元素同时有直接文本和子元素 |
| `unsupported-effect` | warning | filter/backdrop-filter/mix-blend-mode/clip-path 未标 `data-ppt-raster` |
| `bare-text` | info | 裸文本（本方言支持，建议语义标签） |
| `line-height-normal` | info | 建议写确定值 |
| `letter-spacing-negative` | warning | 中文负字距会粘连 |
| `font-not-allowed` | warning | 未知字体（不可嵌入/可能回退） |
| `text-decoration` | info | 文本元素带背景/边框（本方言支持） |

### 下一批（按 Anthropic 原则继续）

- P1 `class="placeholder"` 图表槽位（原则 8）—— 国赛图表页的最小路径
- P2 单行文本框 +2% 安全边距（原则 10）
- P3 lint 自动修复：`--fix` 补齐语义标签/去手打 bullet
