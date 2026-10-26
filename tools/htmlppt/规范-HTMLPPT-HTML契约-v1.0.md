# HTMLPPT HTML 契约 v1.0
### —— 能"精确"转成"可编辑 PPTX"的 HTML 该怎么写

> 版本：v1.0 ｜ 日期：2026-10-19 ｜ 作者：Lead（综合 `research/01`、`research/02`、`research/03` 与本机原型实测）
> 适用：用 HTML 做幻灯片，最终要交付 `.pptx`，且要求「打开 PowerPoint 还能改字、挪框、换图」。
> 一句话：**这不是风格指南，是转换器的输入契约（input contract）。违反契约不会报错，只会静默变丑或变成图片。**

---

## 0. 先定义清楚：什么叫"精确"，什么叫"可编辑"

行业里这两个词被滥用得最厉害。本文用三个正交的指标，缺一个都不叫"精确转可编辑"。

| 指标 | 定义 | 能不能保证 | 靠什么保证 |
|---|---|---|---|
| **几何精确** | 每个对象的 left/top/width/height 与 HTML 量测值一致，误差 ≤0.5px（=0.375pt=4762 EMU） | ✅ **能，且可以逐对象断言** | 固定画布 + 整数 px + `EMU = px × 9525` 整除 |
| **排版精确** | 同一个文本框里，断行位置、每行基线、字距与浏览器一致 | ⚠️ **能接近，不能 100% 保证** | 硬断行（每个视觉行一个段落）+ 显式行距 + 字体可用性受控 |
| **语义精确** | 文字是 `<a:t>` 文本 run，形状是 `p:sp`/`a:custGeom`，图片是 `p:pic`，不是整页截图 | ✅ **能，且可以逐页统计** | DOM→原生对象的映射规则 + 导出后解包自检 |

**可编辑性用 L0–L3 四级定义**（对外承诺必须写清级别，见 `research/03 §6`）：

| 级别 | 含义 | 用户能做什么 | 典型产物 |
|---|---|---|---|
| **L0** | 整页图片 | 什么都不能改 | Marp `--pptx`、Slidev `--format pptx`（旧）、所有 PDF→PPTX |
| **L1** | 底图 + 原生文本框 | 能改字、挪字框；形状/背景改不了 | Hasasasa 的栅格兜底层、路线 C 的降级页 |
| **L2** | 原生形状 + 原生文本 + 原生图片 | 能改字、能挪/改色形状、能换图 | Anthropic html2pptx、Slidev `pptx-editable`、**本原型** |
| **L3** | L2 + 主题 token / 母版继承 | 还能一键换主题色、套版式 | 需要额外做 `p:sldMaster` 主题投影，v1 不做 |

> **HTMLPPT v1.0 的承诺是 L2**：文字、形状、图片、表格全部原生可编辑。
> **不承诺**：动画、切换、SmartArt、公式（OMML）、母版继承、逐像素完全相同。
> 这四个是 OOXML/库能力的硬天花板（要突破得上 Aspose.Slides 这类商业授权）。

---

## 1. 三条铁律

1. **固定画布 1280×720，一页一个根节点，尺寸显式写死。**
   没有固定画布就没有"页"，量测坐标无处安放。响应式 = 不可精确转换。

2. **所有要编辑的文字，必须是真实文本节点，且只由 `<p>/<h1>-<h6>/<li>` 承载。**
   容器（`<div>`）只负责背景、边框、圆角、阴影。裸文本会被转换器丢弃或变成位图。

3. **装饰只允许用"PPT 有原生原语"的样式；超出范围的必须显式标注降级，禁止静默整页栅格化。**
   渐变、滤镜、混合模式、复杂裁剪要么降级为**元素级**图片（文字仍矢量叠在上面），要么改写法。

---

## 2. 坐标与单位：把账算死

| 量 | 值 | 备注 |
|---|---|---|
| 画布 | **1280 × 720 CSS px** | 16:9 |
| 等价英寸 | **13.3333 × 7.5 in** | `1280/96`、`720/96` |
| 幻灯片尺寸（EMU） | **12 192 000 × 6 858 000** | 必须断言，别用 PptxGenJS 默认的 10in 布局 |
| 等价点 | 960 × 540 pt | PowerPoint「默认宽屏」 |
| **1 CSS px** | **0.75 pt = 9525 EMU** | `914400 ÷ 96` |
| 8px 栅格 | 6 pt = 76 200 EMU | 整数，无舍入 |
| 字号 | `pt = px × 0.75`；DrawingML `sz = pt × 100` | 20px → 15pt → `sz="1500"` |
| 行距 | `a:lnSpc/a:spcPts`，单位 **1/100 pt** | 20px 行高 → `val="1500"` |
| 字距 | `a:rPr/@spc`，单位 **1/100 pt** | 3px → 2.25pt → `spc="225"` |
| 段前/段后 | `a:spcBef/a:spcAft`，单位 **1/100 pt** | |
| 文本框内边距 | `a:bodyPr/@lIns|tIns|rIns|bIns`，单位 **EMU** | 一律写 0 |
| 线宽 | `a:ln/@w`，单位 **EMU** | 1px → 9525 |

**为什么必须锁 1280×720 而不是 Anthropic 的 720×405 pt**
`720×405 pt` = `960×540 px` = 10in 宽，那是 PptxGenJS 默认 `LAYOUT_16x9` 的副产物。用它导出的 deck 在按 13.333in 做的模板/母版里会两边留白。**1280×720 px 才等于 PowerPoint 默认宽屏**，且 px→EMU 整除。（见 `research/03 §4.1`）

**禁止**：`vw`/`vh`/`em`/`rem`/`%` 出现在 `width`/`height`/`font-size`/`margin`/`padding` 上（图片百分比除外）。这些值随视口变化，量测不可复现。

---

## 3. 文档结构契约

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1280px;height:720px;overflow:hidden;background:#fff}
  #stage{position:relative;width:1280px;height:720px}
  section.slide{position:absolute;inset:0;width:1280px;height:720px;overflow:hidden;
                font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}
</style>
</head>
<body>
<div id="stage">
  <section class="slide" data-slide="1" data-layout="S01" data-bg="#0B1F3A">
    <h1 style="position:absolute;left:96px;top:240px;width:660px;font-size:64px;line-height:78px">标题</h1>
    <p  style="position:absolute;left:96px;top:452px;width:600px;font-size:20px;line-height:34px">正文</p>
    <aside class="notes">这一页讲 30 秒，强调成本下降。</aside>
  </section>
  <section class="slide" data-slide="2" data-layout="S07">…</section>
</div>
</body>
</html>
```

**结构条款**

| # | 规则 | 原因 |
|---|---|---|
| S1 | 每页一个 `<section class="slide" data-slide="N">`，N 从 1 连续递增 | 导出器靠选择器确定性分页；class 名混用（`.page/.view/.screen`）会漏页 |
| S2 | 每页必须是 1280×720，`overflow:hidden` | 溢出内容在 HTML 里被裁掉，在 PPT 里会跑出来 |
| S3 | `html/body` 无 margin/padding，不出现滚动条 | 浏览器默认 8px margin 与滚动条会污染所有量测坐标 |
| S4 | 页序 = DOM 顺序；**不要用 JS 切页/隐藏页** | 依赖运行时状态的显隐会让导出器只拿到一页（中文工具最常见的 bug） |
| S5 | 整页底色用 `data-bg="#RRGGBB"`，**不要**画一个 `inset:0` 的 div | 满页色块在 WPS 里会变成可选中可拖拽的对象 |
| S6 | 演讲者备注放 `<aside class="notes">` | 映射到 pptx notes 槽位；写成页面上的隐形 `<p>` 会丢失或可见 |
| S7 | 所有资源自包含：相对路径且在 HTML 同级或子目录，或 data URI | 导出沙箱通常零出网；`../` 越界资源取不到 |

---

## 4. 文本规则（可编辑性的生命线，最严）

| # | 规则 | ✅ 正例 | ❌ 反例 | 原因 |
|---|---|---|---|---|
| T1 | 文字必须在语义标签里，`<div>` 只做容器 | `<div class="card"><h3>标题</h3><p>正文</p></div>` | `<div class="card">标题<br>正文</div>` | OOXML 文本只能来自 `<a:t>`；裸文本被静默忽略 |
| T2 | 一个语义段落 = 一个文本叶子，不要把一个句子拆成多个绝对定位的碎片 | `<p class="lead">用 HTML 写，导出可编辑的 PPTX。</p>` | 三个 `<div style="position:absolute">` 各放几个字 | 拆开后每片各成一个文本框，编辑时无法整段重排 |
| T3 | 富文本只用行内标签：`<b>/<strong>/<i>/<em>/<u>/<span>`；`<span>` 只给字体/颜色/下划线 | `营收 <b>1.2 亿</b>，同比 <span style="color:#16a34a">+18%</span>` | `<span style="display:block;margin:12px;padding:8px;background:#eee">` | run 级属性只有字体/字号/粗斜/颜色/下划线/字距；盒模型不会被转换 |
| T4 | 列表用 `<ul>/<ol>`；禁止手打 `• - *`；禁止 `::marker` 定制图形 | `<ul><li>要点一</li></ul>` | `<p>• 要点一</p>` | bullet 是 PPT 段落属性；手打会双 bullet |
| T5 | 文本块给显式宽度；不要依赖 auto height | `<p style="width:600px;line-height:34px">…</p>` | 靠 flex 撑开的容器里放长段落 | PPT 的 autofit/溢出行为不可控；量测高度与 PPT 高度不一致会压住下一元素 |
| T6 | `line-height` 必须写**确定值**（px 或倍数），不能是 `normal` | `line-height:34px` | `line-height:normal` | `normal` 由字体度量决定，浏览器与 PPT 算法不同 → 行数不同 |
| T7 | 不要用连续 `<br><br>` 造段距；空段落会回退 18pt 行高 | `<p style="margin-bottom:16px">…</p>` | `<p>…<br><br><br>…</p>` | 空 `<a:p>` 在 PowerPoint 里按默认 18pt 撑高 |
| T8 | 不要 `text-align: justify`；不要 `white-space: nowrap` | 用足够宽的文本框自然单行 | `white-space:nowrap` 求单行 | PowerPoint 不认 `nowrap`，该断还是断；justify 两端对齐算法两家不同 |
| T9 | 字号下限：正文 ≥18px、说明/图注 ≥16px、meta ≥14px；正文行高 1.5–1.7 | `font-size:20px;line-height:1.6` | `font-size:13px;line-height:1.1` | 投影可读性；行高过紧会被 PPT 更松的排版挤溢出 |
| T10 | 需要"精确断行"时用**硬断行模式**（导出器开关）：每视觉行一个 `a:p` + `wrap="none"` | 见 §7 | 依赖 PPT 自己重排 | 浏览器与 PPT 对同一字符串的排版宽度有约 2% 级差异（Slidev 用 2%+4px headroom 对冲）；硬断行把不确定性清零，代价是编辑后不再自动重排 |

---

## 5. 形状 / 装饰 / 颜色

| # | 规则 | 说明 |
|---|---|---|
| D1 | 背景、边框、圆角、阴影只写在 `<div>`（容器）上，**不写在文本元素上** | PPT 里 shape 与 textbox 是两个对象 |
| D2 | 优先：纯色底 / 单边或四边 1px 边框 / 统一圆角 / 单层外阴影 | 这几样有 OOXML 原语（`a:solidFill`、`a:ln`、`a:prstGeom prst="roundRect"`、`a:effectLst/a:outerShdw`） |
| D3 | 渐变：**可以用，但必须能被解析成 `a:gradFill`**；解析不了就加 `data-ppt-raster` | 本原型已做到 `linear-gradient` → 原生 `a:gradFill`（参考实现如 Anthropic/Hasasasa 是栅格化，我们更优）。`conic-gradient`、多重叠加渐变、`repeating-*` 目前仍走栅格 |
| D4 | `box-shadow` 只允许**单层外阴影**；多层/内阴影/硬阴影 → 标注降级 | 多层阴影无原生表达 |
| D5 | `filter` / `backdrop-filter` / `mix-blend-mode` / `outline` / 复杂 `clip-path` → **必须** `data-ppt-raster` | 无 OOXML 原语；不标注会被静默丢弃 |
| D6 | 颜色只用 `#rgb`/`#rrggbb`/`rgba()`；token 的**终值**必须是这三者之一 | `color-mix()`/`oklch()`/嵌套计算可能解析失败 |
| D7 | 中文禁负 `letter-spacing`；大标题字距 0 或轻微正值 | PPT 的 CJK 字距处理与浏览器不同，负值会粘连 |
| D8 | `border-radius` 用统一值；非对称四角走 `custGeom` 或降级 | `prstGeom roundRect` 只有一个 adjust 值 |
| D9 | `transform` 只允许 `rotate(deg)` 与等比 `scale`；skew / 非均匀 scale / matrix3d → 降级 | DrawingML 的 `a:xfrm` 只能表达旋转+翻转+缩放 |

---

## 6. 媒体 / 图标 / 图表 / 表格

| # | 规则 | 说明 |
|---|---|---|
| M1 | 内容图用 `<img src>` + 显式 `width/height`；**不要**用 `background-image` 承载内容图 | `<img>` 原生嵌入为 `p:pic`；`background-image` 只能整块截图 |
| M2 | `object-fit: cover` 允许：导出器可换算成 `a:srcRect` 原生裁剪 | 需能读到原图尺寸 |
| M3 | 图标用**内联 SVG 的简单路径** → 可转 `a:custGeom` 原生形状（本项目已实现，8/8 成功） | 复杂 SVG（滤镜/渐变网格/大量路径）→ 走 4× PNG 降级 |
| M4 | 图表用「占位容器 + 数据属性」，由导出阶段注入原生图表；不要用 `<canvas>` 截图交付 | `<div class="chart" data-ppt-placeholder="chart" data-chart='{...}' style="width:520px;height:280px">` |
| M5 | 表格只在**真表格数据**时用 `<table>`，`table-layout:fixed`，列宽写在 `<th>/<td>` 上 | OOXML 表格模型与 HTML 不同：`<col width>` 不跟随，`rowspan/colspan` 支持有限 |
| M6 | 不要用 `<table>`/`columns`/`float` 做版面排版 | 与语义表格混淆，且多栏无 OOXML 对应 |

---

## 7. 精确断行模式（`--hard-lines`）：HTMLPPT 的关键差异点

**问题**：同一个字符串，Chrome 与 PowerPoint 的断行位置可能不同（字体度量、标点避头尾、中西混排间距、kerning 都不同）。这是所有 HTML→PPTX 工具"看着差一点"的头号原因。

**做法**（本原型已实现）：

1. 量测阶段用 `Range.getClientRects()` 拿到**每个视觉行**的矩形，记录 `lineBox { x, y, w, h, text }`。
2. 装配阶段不再写"一整段 + 靠 PPT 重排"，而是：
   - `a:bodyPr` 写 `wrap="none"`，`lIns=tIns=rIns=bIns=0`，`anchor="t"`；
   - 每个视觉行 = 一个 `<a:p>`，行距 `a:lnSpc/a:spcPts = 该行高(px)×75`；
   - 文本框 `off/ext` 用整个块的量测矩形。
3. 结果：断行位置、行距、行数在 PowerPoint 里**与浏览器逐行一致**。

**代价（必须写进产品说明）**：
- 用户在 PPT 里改字后，**不会自动重排**，需要手动调框或重跑导出；
- 段落被拆成多个 `a:p`，但仍是**同一个文本框**，选中/改字/换字体都正常（比 Anthropic 的"整段靠 PPT 重排"更准，比"每行一个文本框"更可编辑）。

**可选模式**：`--reflow`（不硬断行，保留 PPT 自动重排能力，接受 2% 级换行差异）。**默认建议 `--hard-lines`**，因为本项目的第一目标是"精确"。

---

## 8. 字体规则（决定"换台机器会不会全篇错位"）

| # | 规则 |
|---|---|
| F1 | 只用**静态字体**（不要 variable font）；CSS 写明确 family 名 + fallback，禁止 `-apple-system` / `system-ui` / `BlinkMacSystemFont` 这类别名 |
| F2 | 中文 deck 推荐字体集：**Noto Sans SC / Noto Serif SC（OFL，可嵌入，可分发）**；次选 PingFang SC（macOS 本机）/ Microsoft YaHei（Windows），**但必须提示收件人可能没有** |
| F3 | 导出时**同时写 `a:latin` / `a:ea` / `a:cs`**（PptxGenJS 的 `fontFace` 会自动三处都写；python-pptx 需要手动补 `ea`/`cs`，否则中文回退主题字体） |
| F4 | 字体嵌入只在授权允许时做（OFL/思源/Noto 可以；苹方、微软雅黑等商业字体**不允许嵌入**）；不嵌入就必须接受 fallback |
| F5 | 字重只用 400 / 700（DrawingML 只有 `b="0|1"` 布尔）；500/600/800 会被折叠 |

**字体是"排版精确"的最大变量**：p:pptx 默认只写字体名不嵌字体。目标机器没有该字体 → 度量变化 → 即使硬断行也保不住字宽。**v1.0 的产品结论：默认字体集必须是可嵌入的 OFL 字体，并在导出时做嵌入或至少给强提示。**

---

## 9. 布局与栅格

- **安全区**：主内容距画布边 ≥64px（`inset:64px`），内容区 1152×592。全出血背景/图片不受限。
- **间距刻度**：8px 基准，常用 16/24/32/48/64/96。
- **区域绝对定位 + 组件内 flex**：绝对定位只用于「已预留的区域/组件」，不用于拆散文本流。
- **列布局**：`display:grid/flex` 计算后的位置由量测接管，写法随意；但不要用 `columns`/`float`/`table` 做版面。
- **基线**：正文行高 1.5–1.7（CJK 比拉丁需要更大行距）。

---

## 10. 硬禁止清单（写了就必然出问题）

1. `width/height/font-size/margin/padding` 用 `vw/vh/%/em/rem`
2. 裸文本（文本节点的父级不是 `p/h1-h6/li/td/th` 等语义元素）
3. 手打 bullet 符号 `• - *`
4. `white-space:nowrap`、`text-align:justify`
5. 动画/过渡决定内容可见性（默认 `opacity:0` 靠 JS 显示 → 导出空白）
6. `<canvas>`/WebGL/`<video>`/`<iframe>` 作为内容主体
7. 远程 CSS/字体/图片（导出沙箱零出网）
8. `filter`/`backdrop-filter`/`mix-blend-mode`/`background-clip:text` 未标注 `data-ppt-raster`
9. 满页 `<div style="inset:0">` 当背景
10. 依赖 JS 运行结果才存在的 DOM（导出器读的是静态 DOM + 渲染后样式）

---

## 11. 降级标注协议（让"有损"变成显式的）

```html
<div class="hero" data-ppt-raster="gradient">…</div>   <!-- 元素级栅格：装饰进图片，文字仍矢量 -->
<svg data-ppt-raster="icon">…</svg>                      <!-- 图标栅格化（4x） -->
<div data-ppt-ignore>…</div>                             <!-- 纯装饰，导出时丢弃 -->
<div data-ppt-hard-lines="off">…</div>                   <!-- 本块不硬断行 -->
<div class="chart" data-ppt-placeholder="chart" data-chart='{"labels":["Q1"],"values":[42]}'></div>
<section class="slide" data-slide="1" data-layout="S07" data-bg="#0B1F3A">
```

**规则**：导出器**永远不做整页栅格化**。降级只发生在元素级，且必须写进导出报告的 `fallbacks[]`，让作者知道"这一块在 PPT 里是图片"。

---

## 12. 验收标准（导出后必须自动跑）

| 检查 | 阈值 | 方法 |
|---|---|---|
| 幻灯片尺寸 | `sldSz = 12192000 × 6858000` | 解包 `ppt/presentation.xml` |
| 文本字符覆盖率 | pptx 的 `<a:t>` 总字符数 ÷ HTML 非空白文本字符数 **≥ 90%** | 两侧都做 Unicode 归一后比对 |
| 可编辑文本量 | 每页 `<a:t>` run 数 ≥ 该页语义文本块数 × 0.9 | 解包统计 |
| 无整页截图 | 不存在面积 > 90% 页面且覆盖整页的 `p:pic` | 解包统计 |
| 几何误差 | 逐对象 `|Δx|,|Δy|,|Δw|,|Δh| ≤ 0.5px`（对上量测 JSON） | 量测 JSON vs 解包 XML |
| 回渲结构差 | 元素重叠 / 出界 / 文本溢出容器 = 0 | LibreOffice 回渲 + 结构检测 |
| 回渲像素差 | mean-abs ≤ 8、`>64` 的像素占比 ≤ 6%（**参考值，不是及格线**） | HTML 截图 vs PPTX 回渲 |

> ⚠️ 回渲用 LibreOffice 只是**代理验收**，不等于 PowerPoint。字体替换、行距、阴影渲染都有系统性差异。真机验收必须在 PowerPoint（Win/Mac）+ WPS 各跑一次。

---

## 13. 可执行自检（linter 规则，10 条）

1. `section.slide` 数量 = 预期页数；每页 `width/height` 均为 1280/720。
2. `width/height/font-size/margin/padding` 上无 `vw/vh/%/em/rem`。
3. 无裸文本：每个非空文本节点的最近父级是 `p/h1-h6/li/td/th`。
4. 无手打 bullet、无 `::marker` 定制、无 `columns/float`。
5. 无 `background-clip:text`、无渐变文字、无非对称 `border-radius`。
6. 每个 `gradient/filter/backdrop-filter/mix-blend-mode/clip-path` 元素都有 `data-ppt-raster` 或确认可原生映射。
7. `::before/::after` 要么纯装饰（可丢），要么内容已 inline 进 DOM。
8. 字体清单全部为静态字体，不含 `-apple-system/system-ui/BlinkMacSystemFont`。
9. 无 `http(s)://` 外链字体/图片（或已内联）。
10. 每页有 `data-slide`；备注用 `<aside class="notes">`；背景用 `data-bg`。

---

## 14. 最小可用骨架（复制即用）

见 `prototype/samples/deck.html`（5 页，覆盖标题/多行正文/圆角卡片/细线/图片/SVG 图标/表格/渐变/半透明层）。
导出结果与本机实测数字见 `prototype/README.md`。

---

## 附：本契约与已有规范的差异（为什么不是照抄）

| 议题 | Anthropic html2pptx | Hasasasa | Slidev pptx-editable | **本契约** |
|---|---|---|---|---|
| 画布 | 720×405 pt（10in，非 PPT 默认宽屏） | 未强制 | 默认 980×552 | **1280×720 px ↔ 13.333×7.5in** |
| 断行 | 靠 PPT 重排 | 靠 PPT 重排 | 靠 PPT 重排 | **硬断行模式（每视觉行一段 + `wrap="none"`）** |
| 渐变 | 栅格化（Sharp） | 栅格化 | 栅格化 | **原生 `a:gradFill`** |
| SVG 图标 | 栅格化 | 栅格化 | 栅格化 | **原生 `a:custGeom`（8/8 成功）** |
| 文字 | 必须在 p/h1-h6 | 同 | 同 | 同（并加硬断行） |
| 降级 | 无（直接报错/栅格） | 元素级截图，文字仍矢量 | 元素级截图 + 逐页回退 | **元素级降级 + 报告，禁止整页回退** |
| 许可 | proprietary，禁止衍生 | MIT | MIT | 自研（参考思想，不搬代码） |

来源与证据见 `research/01-oss-landscape.md`、`research/02-pptx-mapping-constraints.md`、`research/03-authoring-products.md`。
