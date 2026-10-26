# 03 · HTMLPPT 编写范式与产品实践（HTML 该怎么写）

> 调研：authoring-scout ｜ 共享任务：task-3 ｜ 时间：2026-10-19
> 范围：①现有 HTML 演示框架对 HTML 的约束与「真实导出方式」；②逆向「HTML→可编辑 PPTX」工具的编写规范，提炼 PPT-safe CSS 子集；③中文实践、吐槽与国内产品导出体验；④设计系统视角；⑤**HTMLPPT HTML 规范 v0.1（25 条可执行条款）**。
>
> 证据等级标注：`[官方文档]` `[源码]` `[README]` = 一手材料；`[二手]` = 第三方评测/教程；`[单一来源]` = 只有一个出处，未经交叉验证；`[站点摘要]` = 页面被登录墙/反爬拦截，只拿到搜索引擎摘要。
>
> 与 task-1（OSS 全景）、task-2（DrawingML 映射）分工：本文不重复逐工具许可证与 OOXML 细节，只回答「HTML 写法」。凡涉及导出实现原理，只讲到「截图 / PDF 中转 / 量测重建」这一层。

---

## 0. TL;DR（7 条给 Lead 的结论）

1. **所有能产出「可编辑」pptx 的工具，对 HTML 的硬约束高度一致：固定像素画布 + 每页一个根节点 + 可编辑文字必须是真实文本节点 + 样式只用 PPT 可原生表达的子集。** 差异只在「不支持的样式怎么降级」：整页截图、元件截图、静默丢失。
2. **主流框架的 pptx 导出默认都是截图，不是原生**：Marp `--pptx` 是整页 PNG 当背景图；Slidev `--format pptx` 也是逐页图片（官方原文：文字不可选）。可编辑路线都是后补的：Marp `--pptx-editable` 走 **HTML→PDF→LibreOffice Impress 导入**（官方明确 experimental、保真更低、备注丢失）；Slidev 2026-09 才新增 `--format pptx-editable`（量测 DOM 重建原生形状，SVG/canvas/渐变/filter 等降级为图片）。**结论：把 HTML 精确转 pptx 是行业公认的难事，没有框架把它当默认路径。**
3. **Anthropic 的 `html2pptx.md` 是目前公开资料里最完整的「HTML 编写约束」文档**（720pt×405pt body、文本必须在 `p/h1-h6/ul/ol`、禁用渐变、只用 web-safe 字体、背景/边框/阴影只能在 `div` 上）。但这份文档在 2026-02 被 Anthropic 撤掉，改为直接写 pptxgenjs 脚本生成 deck——**连 Anthropic 自己都把「HTML→pptx」从主路径降级了**。且该 skill 许可为 proprietary（禁止复制/衍生/分发），只能当「规范思想」参考，不能搬代码。
4. **中文生态分成两派且都在增长**：截图派（`nlj626/html-to-pptx` 明确说「每页是一张图片，不可编辑」；Marp 默认路线同）与原生量测派（`Hasasasa/html-to-editable-pptx`、`yuna78/GX-Alex`、`AliceLJY/slidesmith`）。中文「HTML PPT 审美 skill」（`html-ppt`、`guizang-ppt-skill`）大量使用 `vw/vh`、绝对定位、WebGL/动画，**与 PPT-safe 子集直接冲突**——这正是我们产品「约束转换层」的核心价值。
5. **「转完不能改」的根因不是画布，是导出路线**（截图路线天生不可编辑）；**「转完字错位」的根因是文本度量差异 + 字体缺失/替换 + 伪元素与行内布局丢失 + 长段落整体定位**。这四类都能在 HTML 编写阶段用约束规避，但无法 100% 消除（PowerPoint 与浏览器对同一字符串的排版宽度有约 2% 级差异，Slidev 源码用 2% + 4px 的 headroom 对冲）。
6. **固定画布 + 栅格 + token 是「精确转换」的必要条件，不是充分条件**。它解决「位置可复现」；文本度量、字体可用性、样式可表达性要靠「PPT-safe 子集 + 显式降级标注 + 回渲校验」解决。1280×720 CSS px 正好等于 PowerPoint 默认宽屏 13.333×7.5 in / 960×540 pt（1px = 0.75pt = 9525 EMU），这是最值得锁定的基准；Anthropic 的 720×405pt 是 PptxGenJS 默认 10 in 画布的产物，**对应 960×540 CSS px，不是 1280×720**，两者不能混用。
7. **产品上最关键的 3 条编码约束**（详见 §5）：① 固定 1280×720、每页一个 `<section class="slide">`、显式宽高 + `overflow:hidden`；② 所有可编辑文案必须落在真实文本元素里，容器只负责背景/边框；③ 只用纯色/单层边框/圆角矩形/单层阴影/静态图片这些「PPT 可原生表达」的样式，其余一律用 `data-ppt-*` 显式标注降级，不允许静默栅格化整页。

---

## 1. 现有 HTML 演示框架：怎么约束 HTML、到底怎么导 pptx

### 1.1 总表（截至 2026-10，以官方文档/源码为准）

| 框架 | HTML 结构约束 | 画布 | pptx 导出真实方式 | 可编辑性 | 对作者的影响 |
|---|---|---|---|---|---|
| **reveal.js** | 必须是 `.reveal > .slides > section`，一个 `<section>` = 一页；`<section>` 内再套 `<section>` = 垂直页 | 有「normal size」概念，**默认 960×700**，按视口等比缩放；`center` 默认垂直居中 | **没有官方 pptx 导出**。只有 `?print-pdf` 打印成 PDF，或 decktape | 无（PDF/截图） | 页面是 flow 布局、按内容高度居中，不是固定画布；转 PPT 只能靠截图/PDF |
| **impress.js** | 每个 `.step` 元素，用 `data-x/data-y/data-z/data-rotate/data-scale` 定中心点坐标 | **无固定画布**，一个无限 3D 画布，所有 step 共存 | 无官方导出 | 无 | 为「空间叙事」设计，与 PPT「页」模型根本不同，基本排除在精确转换外 |
| **Slidev** | Markdown 一行 `---` 一页；也可写 HTML/Vue；每页有 layout | 默认 `canvasWidth: 980` + `aspectRatio: 16/9`（≈980×552），可配 | `export --format pptx` = **逐页图片**（官方：文字不可选，备注会带过去）；`export --format pptx-editable` = **2026-09 新增**，浏览器量测后重建为原生形状 | 旧路线 0；新路线「大部分可编辑」，SVG/canvas/iframe/video/KaTeX/渐变/filter/backdrop-filter/mix-blend-mode/clip-path 会变图片，整页无法安全重建时逐页回退截图 | 默认画布不是 PPT 尺寸；新导出器会按量测结果重排，作者仍要遵守「真实文本 + 简单样式」 |
| **Marp** | Markdown，`---` 分页；输出 HTML 里每页一个 `<section>`，主题 CSS 作用其上 | 内置主题默认 **16:9 = 1280×720**（另有 4:3 960×720） | `--pptx` = 每页渲染 PNG（默认 2x）当 slide background，**内容不可修改**；`--pptx-editable` = HTML→PDF→**LibreOffice Impress 导入**（`--infilter=impress_pdf_import`）再存 pptx | 默认 0；editable 路线「实验性、复现度更低、不支持备注」，官方不推荐在意外观时使用 | 真正被约束的是「主题能写什么」；正文作者几乎不碰 HTML |
| **Spectacle** | React/JSX，`<Slide>` 组件一页 | 视口自适应 | 无 pptx；只有 PDF（`?exportMode=true` 后浏览器打印，或 `spectacle-renderer` CLI） | 无 | 面向 React 技术分享，不面向 Office 交付 |
| **WebSlides** | 模板式 HTML，`<section>` 一页，`webslides.js` 负责导航/翻页 | 视口自适应（vx/vh 体系） | 无官方导出 | 无 | 营销/编辑型网页演示，与 PPT 无关 |

来源：[reveal.js Markup](https://revealjs.com/markup/)、[reveal.js Presentation Size](https://revealjs.com/presentation-size/)、[reveal.js PDF Export](https://revealjs.com/pdf-export/)；[impress.js repo](https://github.com/impress/impress.js) 及其示例中的 `data-x/data-y/data-z` 语义；[Slidev 导出文档](https://sli.dev/guide/exporting)、[Slidev `pptx-editable` PR #2722](https://github.com/slidevjs/slidev/pull/2722)、[Slidev canvas-size](https://github.com/slidevjs/slidev/blob/main/docs/features/canvas-size.md)；[Marp CLI README](https://github.com/marp-team/marp-cli#convert-to-powerpoint-document---pptx-)、[marp-cli `src/converter.ts`](https://github.com/marp-team/marp-cli/blob/main/src/converter.ts)、[marp-core README（16:9 1280×720）](https://www.npmjs.com/package/@marp-team/marp-core)；[Spectacle FAQ](https://nearform.com/open-source/spectacle/docs/faq/)；[WebSlides README](https://github.com/webslides/WebSlides)。

### 1.2 逐条要点

**reveal.js：有「设计尺寸」，但没有「PPT 画布」，也没有 pptx 导出。**
- 官方定义 `.reveal > .slides > section` 层级，「section 即一页」，嵌套 section 是垂直页 `[官方文档]`。
- `width: 960, height: 700` 是「作者设计时的 normal size」，运行时按视口缩放；但**页面内容仍按文档流排布、按内容高度垂直居中**（`center: true`），所以两页之间高度可以不同，不存在 `1280×720` 那种严格画布 `[官方文档]`。
- pptx：官方只提供 PDF 打印（`?print-pdf`）+ decktape；生态里的 pptx 都是第三方截图方案。也就是说 **reveal.js 对「可编辑 pptx」没有任何承诺**。

**impress.js：不是幻灯片，是「3D 空间里的元素」。**
- step 的 `data-x/y/z` 定义的是**元素中心在画布上的像素坐标**（`[官方示例]`），没有「页」的边界，也没有固定宽高；导出时无法定义「一页截什么」。
- 结论：可作为「自由 HTML 的反例」——一旦允许这种模型，精确转换就无从谈起。

**Slidev：`--format pptx` 确实是截图；可编辑是 2026-09 的新增能力，且仍以「可编辑优先于像素保真」为代价。**
- 中文文档原文：「PPTX 文件中的所有幻灯片将导出为图片，因此文本将不可选择。演讲者备注将按每张幻灯片传递到 PPTX 文件中」`[官方文档]`。英文主分支文档同义 `[官方文档]`。
- 新能力：`slidev export --format pptx-editable`，docs 说「在浏览器中量测幻灯片并重建为 PowerPoint 形状，文字可选可编辑、框可移动改色、备注照常带过去；它不替代 `--format pptx`（后者仍是视觉最保真的）」`[官方文档]`。实现上在 `packages/slidev/node/commands/pptx/`：Playwright 打开 print 视图 → `walker.ts` 收集快照 → `normalize.ts` 归一为 IR → `capture.ts` 栅格化无法表达的元素 → `buildPptx`（pptxgenjs）`[源码]`。
- 官方列出的「仍然是图片」清单（**这就是天然的 PPT-safe 边界**）：SVG（含 Mermaid/图标）、`<canvas>`、`<iframe>`、视频、KaTeX 公式、CSS 渐变、`filter`、`backdrop-filter`、`mix-blend-mode`、`clip-path`。整页无法安全重建时逐页回退回图片并打印原因 `[官方文档]`。
- 官方还列出三条「交付前须知」：pptx **只写字体名不嵌字体**；PowerPoint 度量与浏览器不同，长段落可能换行数不同；普通流里的 `::before/::after` 装饰会被丢弃 `[官方文档]`。
- 时间线：导出器 commit 为 2026-09-16 的 `feat(export): editable PPTX export with native shapes and text (#2722)`，npm 上 `@slidev/cli@53.0.0` 同日发布。**此前所有版本的 `--format pptx` 都是图片** `[源码]`。
- 画布：默认 980×552（`canvasWidth: 980` + 16:9），不是 PPT 原生尺寸；作者应在 headmatter 里改成 1280×720 或由导出器缩放 `[官方文档]`。

**Marp：`--pptx` 是「图片当背景」，`--pptx-editable` 是「PDF 让 LibreOffice 猜」。**
- 源码 `convertFileToPPTX()`：先把每页渲染成 PNG（2x），再 `pptxgenjs` 逐页 `slide.background = { data: base64 }`，仅把 presenter notes 写进去——**没有任何文字对象** `[源码]`。
- `convertFileToEditablePPTX()`：先 `convertFileToPDF()`，然后调 `soffice --headless --infilter=impress_pdf_import --convert-to pptx:Impress Office Open XML` `[源码]`。README 也直说：常规 pptx「由预渲染的背景图片构成，内容无法在 PowerPoint 中修改或复用」；editable 是 **EXPERIMENTAL**，需要浏览器 + LibreOffice Impress，复杂主题（如 `gaia`）可能报错或输出不完整，**复现度更低、不支持演讲者备注**，并明确「如果保持幻灯片外观很重要，不建议导出可编辑 PPTX」 `[官方文档]`。
- 画布：Marp Core 内置主题提供 16:9（1280×720）与 4:3（960×720）预设 `[README]`；Marpit 的「一页一个 `<section>`」是框架级约束 `[官方文档]`。

**Spectacle / WebSlides：**
- Spectacle FAQ：可导出 PDF（URL 加 `?exportMode=true` 后打印，或 `spectacle-renderer` CLI），**没有 pptx** `[官方文档]`；结构上是 React `<Slide>` 组件 `[README]`。
- WebSlides README 只描述导航/翻页/模板，没有导出能力 `[README]`。

### 1.3 三种导出路线 → 三种对 HTML 的约束强度

| 路线 | 代表 | HTML 自由度 | 可编辑性 | 典型缺陷 |
|---|---|---|---|---|
| A. 整页截图 | Marp `--pptx`、Slidev `--format pptx`、`nlj626/html-to-pptx`、所有 PDF→pptx | 几乎不限 | **0**（整页图片） | 不能改一个字，放大模糊，文件大 |
| B. PDF 中转 | Marp `--pptx-editable`、部分商业产品 | 不限（渲染保真） | 半可编辑但不可控：文字块/换行/图层由 LibreOffice 猜 | 字体、换行、透明度、备注丢失；官方标注 experimental |
| C. 量测重建 | Anthropic html2pptx、Hasasasa、slidesmith、yuna78/GX-Alex、Slidev `pptx-editable` | **必须遵守子集** | 高（文字/形状可编辑），受降级策略影响 | 必须逐条约定 HTML 写法；不支持的样式要么变图片要么丢 |

> **对产品最重要的一句话**：路线 C 的「HTML 编写规范」不是风格建议，而是转换器的输入契约（input contract）。我们做 HTMLPPT，等于要把路线 C 的隐式契约显式化、产品化。

---

## 2. 逆向：已有「HTML→可编辑 PPTX」工具的编写规范

### 2.1 Anthropic `html2pptx.md`（2025-12 版本，最完整的官方规范）

文件位置：`anthropics/skills` 仓库 `skills/pptx/html2pptx.md`（2025-12-01 版本仍存在，约 19.8KB）`[官方文档]`；2026-02-04 版本改为 `skills/pptx/html2pptx.tgz`（编译后的 npm 包：`html2pptx(htmlFile, pres, options)`），当前 main 已移除 HTML 路线，创建 deck 改为「写 pptxgenjs 脚本」`[源码/官方文档]`。许可：`LICENSE.txt` 为 Anthropic proprietary，**禁止复制、衍生、分发** `[官方文档]`。

**核心条款（原文摘录/转述）：**

1. **画布**：每个 HTML slide 的 body 必须有明确尺寸；16:9 默认 `width: 720pt; height: 405pt`；4:3 `720pt×540pt`；16:10 `720pt×450pt`。pptx 的 layout 必须与 HTML body 尺寸匹配，否则库报错 `[官方文档]`。
2. **支持的元素**：`<p>`、`<h1>`-`<h6>`、`<ul>/<ol>`、`<b>/<strong>`、`<i>/<em>`、`<u>`、`<span>`（行内样式）、`<br>`、`<div>`（带背景/边框，会变成 shape）、`<img>`、`class="placeholder"`（预留图表插入区域，返回 `{id,x,y,w,h}`）`[官方文档]`。
3. **文本铁律**：**所有文字必须位于 `p/h1-h6/ul/ol` 内**。「Text in `<div>` or `<span>` without a text tag will be silently ignored」——注意是 silent，不报错但会丢。`<span>` 只支持行内格式（font-weight/font-style/text-decoration/color），**不支持 margin/padding**（PowerPoint run 没有这些属性）`[官方文档]`。
4. **列表**：**禁止手打 •、-、* 等 bullet 符号**，必须用 `<ul>/<ol>`；否则会双 bullet 或丢失 `[官方文档]`。
5. **字体**：只用 web-safe 字体（Arial、Helvetica、Times New Roman、Georgia、Courier New、Verdana、Tahoma、Trebuchet MS、Impact、Comic Sans MS）；明确禁用 `Segoe UI`、`SF Pro`、`Roboto`、自定义字体 `[官方文档]`。原因：字体不可嵌入 → 收件人机器替换 → 度量变化 → 重排。
6. **布局**：`body { display:flex }` 防止 margin collapse 破坏溢出校验；用 `margin` 做间距（padding 计入尺寸）；flexbox 可用，因为最终位置来自「渲染后的布局」`[官方文档]`。
7. **形状样式只允许在 `<div>` 上**：背景、边框（支持单边，转成 PPT line shape）、`border-radius`（50% 及以上→圆/椭圆；百分比按短边算）、单层外阴影（inner shadow 忽略）`[官方文档]`。
8. **禁止渐变**：`linear-gradient` / `radial-gradient` 不会转换，必须先用 Sharp 把渐变/图标栅格化成 PNG 再引用 `[官方文档]`。
9. **校验项**：尺寸不匹配、内容溢出 body、CSS 渐变、在文本元素上设置背景/边框/阴影——全部收集后一次性报错 `[官方文档]`。

> **用途判断**：这份规范可直接作为「HTMLPPT 规范 v0.1」的骨架（我们已在 §5 吸收其 8 条硬规则），但其画布基准是 PptxGenJS 的 10 in 默认布局（720×405pt = 960×540 px），**不是 PowerPoint 默认宽屏 13.333 in**。产品必须二选一并全链路统一。

### 2.2 Hasasasa `html-to-editable-pptx`（MIT，最工程化的一套「CSS 覆盖矩阵」）

来源：[README](https://github.com/Hasasasa/html-to-editable-pptx)、[SKILL.md](https://github.com/Hasasasa/html-to-editable-pptx/blob/main/SKILL.md)、[references/supported-css.md](https://github.com/Hasasasa/html-to-editable-pptx/blob/main/references/supported-css.md)、[references/lessons-learned.md.example](https://github.com/Hasasasa/html-to-editable-pptx/blob/main/references/lessons-learned.md.example)（仓库也以 `Hasasasa/claude-skill-html-to-pptx` 分发）。

**它的方法**：不要求作者改写 HTML，而是 Playwright 渲染后读 computed style + bounding rect，把 HTML 分四档处理：

| 档位 | 内容 | 结果 |
|---|---|---|
| 1 矢量保留 | 文字（font-family/size/weight/italic/color/line-height/letter-spacing/text-align/text-transform/underline/text-shadow 第一层/padding/opacity/flex-grid 对齐）、形状（纯色 background、四边 border、border-radius、rotate） | 原生可编辑 |
| 2 栅格兜底 | `background-image` 任何值、`box-shadow`、`outline`、装饰型伪元素、`backdrop-filter`、`filter`、`mix-blend-mode`、skew/非均匀 scale | 元素级截图作为底图，**文字仍矢量叠在上面** |
| 3 已驯化 | `@keyframes`/`animation`/`transition`（导出时 kill，取终止帧）、`scroll-snap`/`translateX(N*100vw)` 翻页、手写 JS counter、canvas 入场动画（等两帧像素一致） | 自动处理 |
| 4/5 媒体与缺口 | SVG/canvas/video 截图；matrix3d、复杂 SVG filter、复杂 clip-path、iframe/audio | 截图或显式忽略 |

**它总结出的「HTML 反模式」（原文表格，直接可用的编写约束）** `[官方文档/项目文档]`：

- **shadow DOM 的 `:host` 声明 font-family**：slot 内文字实际用 `:host` 字体链，测量拿不到 body 声明的 webfont，PPT 回退到 Office 默认字体（甚至打字机字形）。→ 在真正承载内容的 `section.slide` 上**显式再声明一次** font-family。
- **同行 inline flex/grid 只用 `gap` 分隔多个 `<span>`**：两段字符之间没有字面字符，PPT 里直接粘连。→ 合并成单 span 并放字面分隔符（` · `）。
- **弹层/装饰用负坐标**本身没问题（shape 通道支持负 offset），但**同 tag 的装饰 div 可能被误识别成 slide**。→ 装饰不要和 slide 用同一个 class/tag，或明确尺寸。
- 其他在 lessons 里的关键条目：空 `<p>` 必须显式写 `endParaRPr.sz`（否则 PowerPoint 按默认 18pt 撑行高）；`<br>` 多行与自然换行的框高策略不同；`flex + align-items:center` 的文字框高度不能放大；系统字体别名（`-apple-system`/`BlinkMacSystemFont`）会漏过 generic family 过滤；CJK run 不要写 CJK 字体到 `a:ea`（WPS 会用 CJK advance width 渲染 Latin）；rgba 文字要带 alpha（否则弱化文字变全亮）；`×÷°±` 等 EA-ambiguous 码点要 ea 指回 latin 同字体。

**它的「OOXML 边界」表（PPT 表达不了、HTML 必须换写法）** `[项目文档]`：

| HTML/CSS 模式 | OOXML 缺什么 | 建议的 HTML 替代 |
|---|---|---|
| 彩色 emoji | PPT/WPS 不支持 COLR/CPAL 彩色字形 | 换 Twemoji SVG `<img>`（`width:1em`） |
| `background-clip:text` + 渐变文字 | 文字 fill 只有实色/pattern | 换 inline SVG `<text fill="url(#grad)">` |
| `backdrop-filter`/`filter`/`mix-blend-mode`/skew | 无原语 | 接受「只栅格化装饰、文字仍矢量」，或改实色背景 |
| 多层硬 `text-shadow` | 只支持单层 `outerShdw` | 减成单层软阴影 |
| 紧 `line-height`（如 .85） | PPT 排版稳定地更松 | 多行标题拆成每个 `<p>` 单行 |
| CJK 斜体 | CJK 字体通常无真斜体 | 只给 Latin run 标 italic |
| inline flex/grid `gap` 跨 span | 文字层没有 gap | 拆成独立 block/inline-block |
| 含内容的 `<video>` / WebGL canvas | 只能静态帧 | 换 `<img>` 或接受静帧 |
| `::before/::after` 的 `url()/attr()/counter()/open-quote` | walker 只收 string literal | 把内容 inline 到 HTML 或用 `<img>` |
| 非对称 `border-radius`（每角不同） | OOXML 只有正圆/标准圆角 | 换 inline SVG `<path>` |
| Google Fonts 没有的字体 | 解析不到 → 回退 | 换 GF 有的同类字体 / 自托管并接受嵌入 |

**它的设计原则（产品含义）**：vector-first（文字与简单几何保持原生）、local fallback（只把复杂装饰栅格化，不做整页）、portable fonts（按用字 subset + 嵌入）、auditable（每页 HTML/PPT 对比图）、source-preserving（生成 `.audited.html` 工作副本，不改原 HTML）`[README]`。

### 2.3 slidesmith（MIT，HTML contract 最简洁）

来源：[README](https://github.com/AliceLJY/slidesmith)。核心是一个「HTML contract」`[README]`：

```html
<div class="slide" style="width: 1920px; height: 1080px; padding: 80px; ...">
  <h1 style="font-size: 72px;">Your title here</h1>
  <p style="font-size: 28px;">This text is editable in PowerPoint.</p>
</div>
```

- 每页必须 `class="slide"` + **显式宽高**（示例用 1920×1080，说明尺寸可配置而非写死）。
- 支持的 CSS 白名单：`display:flex/grid`、`position:absolute/relative`、`gap`、`background-color`、`linear-gradient()`、`background-image`（URL/base64）、`border`、`border-radius`（含 per-corner）、`box-shadow`（单/多）、font-family/size/weight/color/text-align/line-height/letter-spacing、`rotate()`（**translate/scale 不支持**）、`opacity`、`padding`、`filter: blur()` `[README]`。
- 图片：相对路径/绝对 URL/base64 均可，但相对路径必须**在 HTML 文件目录或以下**（本地服务器只能服务该目录）；`../` 不允许 `[README]`。
- 两种模式：默认 editable；`--screenshots` 整页 2x 截图（不可编辑）；editable 抛错时自动回退 screenshots 并报告最终模式 `[README]`。
- 明确写「Only convert HTML you trust」（会执行脚本、有网络访问）`[README]`。

### 2.4 社区 html2pptx-mcp 的「LLM authoring guidelines」（1280×720 契约的现成版本）

来源：[html2pptx-mcp（himcp 页面收录）](https://himcp.ai/server/html2pptx-mcp)。它基于 html2pptx 思路封装 MCP，并公开了一段专门给 LLM 的输入契约 `[项目文档]`，是目前唯一明确写「1280×720 + 13.333×7.5 in」的开源实现文档：

- 固定 viewport 默认 **1280×720**，映射到 PPT 布局默认 **13.333×7.5 英寸**。
- 推荐 slide shell：

```html
<section class="slide">
  <main class="content"><!-- slide content --></main>
</section>
```
```css
.slide   { width:1280px; height:720px; overflow:hidden; position:relative; }
.content { inset:64px; position:absolute; }
```

- 规则原文要点 `[项目文档]`：每页固定 1280×720；主内容距边至少 64px（全出血背景除外）；先划分命名区域（header/body/left column/right panel/chart area/note area/footer）；主内容用 grid/flex；**绝对定位只用于已经预留好的 frame**；不要重叠主文本/标题/卡片/图表/面板；列间距 32–64px、页边距 64–96px；不要依赖 CSS auto height；文字放不下时优先删文案/拆页/换版式，而不是缩字号；交付前检查重叠、裁切、贴边、边距不平衡。
- 明确「Avoid relying on unsupported CSS when editability matters」：gradients、filters、transforms、shadows、advanced typography、pseudo-element-only content、靠意外重叠成立的布局 `[项目文档]`。
- 提供元素级提示：`data-html2pptx-ignore`、`data-html2pptx-rasterize`；三种模式 hybrid / editable / raster `[项目文档]`。

### 2.5 中文原生派 yuna78/GX-Alex：最贴近中文报告的编写约束

来源：[yuna78/html-to-pptx README](https://github.com/yuna78/html-to-pptx)（GX-Alex/html2pptx 的 vendored fork，MIT）。它的「输入 HTML 长什么样最好」一节可直接抄进我们的规范 `[README]`：

> **固定画布**：一页一个元素，宽高写死。
> ```html
> <section class="slide" style="width:1280px;height:720px">…第 1 页…</section>
> <section class="slide" style="width:1280px;height:720px">…第 2 页…</section>
> ```
> 识别的分页类名：`.deck-slide` / `.slide` / `.cover`。都没有，就按滚动式报告自动分页。
> CSS、图片、字体尽量内联——渲染时没有网络，远程资源不会被加载。
> **别用 `<table>` 排版面**（语义上不是表格数据，转换器要费很大劲才能保住它）。

已知限制（作者自述，等价于我们的「规范必须规避项」）`[README]`：文字按元素整体定位，跨多行折行的正文会作为**一个文本形状**放在元素框位置（长段落会与浏览器略有出入，幻灯片短句不受影响）；密排表格重整不展开 `rowspan`；`<div>` 里 `<b>` 混排会退化成统一字重；动画/转场/视频/iframe 不保留；远程资源不拉取；`<col width>` 列宽不跟过来。上游 GX-Alex 版本「画布尺寸写死 1280×720，其它尺寸的 deck 出 0 页」，fork 改为 `--canvas auto|WxH` `[README]`。

### 2.6 共同约束提炼（跨 5 份规范的交集）

| 约束 | Anthropic | Hasasasa | slidesmith | html2pptx-mcp | yuna78 | 为什么 |
|---|---|---|---|---|---|---|
| 固定像素画布、显式宽高 | ✅ 720×405pt | ✅（读 rect，但需画布） | ✅ 1920×1080 | ✅ 1280×720 | ✅ 1280×720 | PPT 每页有固定尺寸，元素坐标是绝对量 |
| 每页一个根节点 | ✅ 一个 HTML 文件=一页 | ✅ 自动检测 slide | ✅ `.slide` | ✅ `.slide` | ✅ `.slide/.deck-slide/.cover` | 分页边界必须可判定，否则只能猜 |
| 可编辑文字必须是真实文本元素 | ✅ p/h1-h6/ul/ol | ✅ text-leaf 测量 | ✅ 示例用 h1/p（契约未强制） | ✅ 「real text for content that should remain editable」 | ✅ | OOXML 的文本只能来自 `<a:t>`，div 裸文本无对应 |
| 列表用 ul/ol，不手打 bullet | ✅ | ✅（marker 走独立通道） | — | — | — | 手打符号不是 text run 语义，PPT 无法正确做 bullet |
| 容器负责背景/边框，文字元素不承担装饰 | ✅ 背景/边框/阴影只在 div | ✅ 形状分支 | ✅ | ✅ | ✅ | PowerPoint 的 shape 与 textbox 是两个对象 |
| 纯色优先，渐变/filter/阴影降级 | ✅ 禁渐变 | ✅ 元素级栅格兜底 | ⚠️ 支持 gradient 但会转图片/近似 | ✅ avoid | ⚠️ 渐变拍平 | OOXML 无 CSS 渐变/滤镜原语 |
| 字体必须是可用/可嵌入的静态字体 | ✅ web-safe only | ✅ 按需 subset + 嵌入 | ✅ 自动嵌入 | — | ✅ 需装中文字体 | PPT 只写字体名，不嵌字体时收件人机器决定度量 |
| 显式尺寸 + 不依赖 auto height | ✅ 溢出校验 | ✅ 框高按实测 | ✅ 页级 | ✅ | ✅ | PowerPoint 的 autofit 行为不可控，长文会溢出/缩小 |
| 静态终态、动画无意义 | ✅ | ✅ kill 动画取终止帧 | — | — | ✅ | PPT 页是静态的 |
| 资源自包含（内联/同目录） | ✅ img 本地 | ✅ 远程字体下载受限 | ✅ 只服务 HTML 目录 | ✅ local assets | ✅ 零出网 | 导出时常常离线/沙箱 |
| 元素级降级标注 | `class="placeholder"` | decor 自动判定 | ⚠️ 仅整页 `--screenshots` | `data-*` 属性 | 自动分页 | 需要「显式声明哪些允许变图片」 |

### 2.7 「PPT-safe CSS 子集」草案（允许 / 慎用 / 禁止）

> 判定标准：**该 CSS 是否能（a）在 PPT 里找到原生对应物，且（b）在不同机器/渲染器上行为可预测。** 三条都满足 → 允许；只有（a）或需降级 → 慎用；都不满足 → 禁止（或必须显式标注为图片）。

#### ✅ 允许（有原生映射，可放心用）

| CSS / HTML | 映射到 PPT | 备注 |
|---|---|---|
| `color`、`background-color`（含 rgba） | `a:solidFill` + `<a:alpha>` | 文字 alpha 必须显式写，否则弱化文字变不透明 |
| `font-family / font-size / font-weight / font-style / text-decoration` | `a:rFont`、`sz`、`b`、`i`、`u` | weight 只有 regular/bold 两档，300/500/900 会被归一 |
| `line-height`（px 或倍数） | `a:lnSpc`（`spcPts`/`spcPct`） | 用无单位倍数或 px 都行，别用 em 链 |
| `letter-spacing`（正数） | `a:rPr spc` | 中文 deck **禁止负 letter-spacing**（会破坏 CJK 字距） |
| `text-align: left/center/right` | `algn` | 只支持三值；justify 慎用 |
| `<p>/<h1>-<h6>/<ul>/<ol>/<li>/<b>/<i>/<u>/<br>` | text run / paragraph | 语义化标签=可编辑性的前提 |
| `<img>`（PNG/JPEG/WebP，显式 width/height） | `p:pic` | 用 `object-fit` 时优先由容器裁剪，别依赖 CSS 裁切 |
| `<table>`（语义表格） | `a:tbl` 或逐格 textbox + 线 | 只在「真表格数据」时用，别拿 table 排版 |
| `border`（四边等宽，实线） | `a:ln` | 单边 border 也可（转成 line shape），但四边等宽优先合并为一个 shape |
| `border-radius`（px 或 50%） | `prstGeom roundRect` / `ellipse` | 非对称圆角（四角不同）不支持 |
| `opacity`（元素层） | shape/图片透明度 | 文字层 alpha 要落到 run fill 上 |
| `box-shadow`（单层外阴影） | `a:outerShdw` | 多层/inset 丢弃或降级 |
| `transform: rotate()`（小角度、叶子元素） | `a:xfrm rot` | 祖先链旋转会累加，复杂组合不可控 |
| `display:flex/grid` 的**最终几何** | 量测后落到绝对坐标 | 浏览器负责布局，导出的只是结果 |
| `position:absolute`（组件/区域级） | 绝对坐标 | 只用于「已预留的 frame」，不要用于拆散一句话 |
| `padding/margin/border-radius` 等盒模型 | 量测后落入坐标与内边距 | 前提是盒子有确定尺寸 |

#### ⚠️ 慎用（能转，但会降级/变图片/有精度损耗；必须显式标注）

| CSS / HTML | 实际发生什么 | 建议 |
|---|---|---|
| `linear-gradient/radial-gradient`、`background-image` | 无 OOXML 原语 → **元素级截图**（Anthropic 直接禁止；Slidev/Hasasasa 栅格化） | 全出血背景渐变可接受（标注 raster）；渐变文字禁止 |
| `box-shadow` 多层 / 彩色硬阴影 | 只保留第一层外阴影 | 减成单层软阴影 |
| CSS `filter` / `backdrop-filter` / `mix-blend-mode` | 元素截图，文字另叠 | 接受「背景像素化、文字仍可编辑」；或改实色 |
| `clip-path` / 非对称 `border-radius` | 截图；若漏判会显示矩形 | 复杂形状改 inline SVG + 图片 |
| `outline` | 截图或丢失 | 改 `border` |
| 装饰型 `::before/::after`（空 content + 背景/边框） | 可能整块丢失；普通流里的伪元素 Slidev 直接不导出 | 装饰改真实 `<div>`（可栅格化） |
| 文字型 `::before/::after`（`content:"↑"`） | 部分工具支持当 run；不保证 | 直接写进 DOM 文本 |
| SVG 图标 / 简单图形 | 多数工具截图（Slidev 明确 SVG 变图片） | 要么接受图片，要么用「矩形/圆/线」组件重画 |
| `object-fit: cover` 图片裁剪 | 依赖容器裁切，可能只保留原图 | 用 `.img-frame` 容器 + 固定比例，或预裁图 |
| `<canvas>` 图表 | 截图首帧 | 用占位容器 + 导出后注入原生图表（Anthropic `class="placeholder"`） |
| 大字号 + 紧行高（<1.1） | PowerPoint 行距更松，易溢出 | 行高 ≥1.2；标题拆单行 |
| `letter-spacing` 用于大字标题 | PPT 字距渲染与浏览器略不同 | 大标题少用或不用 |

#### ⛔ 禁止（必然丢失/不可控；写了就等于接受转换失败或不可编辑）

| CSS / HTML | 后果 | 替代 |
|---|---|---|
| 文本放在 `<div>/<span>` 里而没有文本标签 | Anthropic：silent ignored（直接消失） | 包进 `<p>/<h1>-<h6>/<li>` |
| 手打 bullet（`• - *`） | 双 bullet / 不是列表语义 | `<ul>/<ol>` |
| CSS 变量占位文字 / `content: attr()` / `counter()` | 没文本节点可抽 | 输出真实文本（token 可以，但最终必须落到文本） |
| emoji 当图标/正文 | 彩色 emoji 丢色/变方框 | Twemoji SVG `<img>` / PNG |
| 渐变文字（`background-clip:text`） | 无对应，变透明/丢字形 | inline SVG `<text>` 或纯色 |
| `transform: matrix3d` / 真 3D / 透视 | PPT 无 3D 原语 | 放弃或整块截图 |
| `transform: translate()` 当布局 | 量测可能取到未位移的位置；多层 transform 不可控 | 用 left/top/margin/grid |
| skew / 非均匀 scale | 无对应，截图 | 接受截图或改设计 |
| `position: fixed` / `vw`/`vh`/`%` 依赖视口的尺寸 | 固定画布下不稳定；导出时视口可能不同 | 全部用 px（1280×720 基准） |
| `@media` 响应式断点改变版式 | 导出取某一个视口，结果不确定 | 不做响应式，固定画布 |
| CSS `columns` 多栏 | 无对应，量测拆行不可控 | grid/flex 分列 |
| `scroll-snap` / `translateX(N*100vw)` 翻页 | 需工具强制归位；导出器容易抓错页 | 每页独立根节点，由导出器切页 |
| `<iframe>` / `<video>` / `<audio>` | 静态页，无播放 | 换 `<img>` 或标注降级 |
| `font-family` 用 `-apple-system`/`system-ui`/`BlinkMacSystemFont` | 度量随机器变，PPT 回退到默认字体 | 明确写具体字体名 + fallback |
| 变量字体（variable font） | PowerPoint 可能匹配不到字重实例 | 用 static 实例（如 Noto Sans SC Regular/Bold） |
| 自建 shadow DOM 包裹整页并继承字体 | 字体链断裂 | 在 `section.slide` 上再声明一次 font-family |
| 在文本元素上设置 background/border/shadow | 不转换或产生错位 | 包一层 div 承担装饰 |
| 用 `<table>` 做版式 | 语义/结构错，转换器难保真 | grid/flex |
| 依赖 JS 运行时才能显示的静态内容 | 导出时可能是空态 | 服务端渲染终态，动画只做增强 |

### 2.8 对任务描述里两个说法的校正（重要）

1. **`class="col"` flexbox 约定**：在 Anthropic 官方 `html2pptx.md`（2025-12 版本）里**不存在**。官方只有「flexbox works，因为位置来自渲染后布局」和 `class="placeholder"`（图表占位）。「划分命名区域、主内容用 grid/flex、绝对定位只用于预留 frame」出自社区 html2pptx-mcp 的 authoring guidelines（§2.4）`[项目文档]`；中文实践里也有人用 `.col`/grid 类命名（如 guizang 的 `grid-2-7-5` 等组件类）。**建议：把 `.col` 当作「我们自己的组件类约定」，而不是引用 Anthropic 规范。**
2. **`text[placeholder]`**：官方文档中没有这个语法。对应概念是 `class="placeholder"` 的元素——转换器测量其位置返回 `{id,x,y,w,h}`，再由图表的 `slide.addChart(..., placeholders[0])` 注入原生图表。若我们要支持「图表占位符」，应定义自己的 `data-ppt-placeholder="chart"` 之类契约（见 §5 H 组）。

---

## 3. 中文实践：怎么做 HTML PPT、转 pptx 为什么被吐槽、国内产品导出体验

> 方法说明：按任务要求先跑 `agent-reach doctor --json`。结果：B站/YouTube/V2EX/RSS/web（Jina）可用；**知乎、小红书、OpenCLI 系（B站浏览器通道）均被登录墙/反爬拦截**（`AUTH_REQUIRED` / 安全验证 / 稿件仅自见）。因此本节中文平台内容以「搜索引擎摘要 + 可访问的 GitHub/第三方文章」为主，**被拦截的页面明确标注 `[站点摘要]`/`[单一来源]`，不作为硬结论**。

### 3.1 中文 HTML PPT 生态地图（可读源码的部分）

| 项目 | 形态 | 画布/单位 | 导出 pptx | 对 HTML 的约束 |
|---|---|---|---|---|
| [lewislulu/html-ppt-skill](https://github.com/lewislulu/html-ppt-skill) | 36 主题 + 15 全 deck 模板 + 36 布局 + 27 CSS 动画 + 20 canvas FX；`assets/base.css` 做 token 体系 | `.deck { width: var(--deck-w,1920px); height: var(--deck-h,1080px); transform: scale(...) }`，运行时按视口缩放；`body[data-fit="fluid"]` 可改 100vw/100vh | **无原生导出**；配套 `nlj626/html-to-pptx` 做整页截图导 pptx | 每页 `<section class="slide">`；「一个 `.slide` 一逻辑页」；`<aside class="notes">` 存逐字稿；模板从 `templates/` 拷贝；图片必须放 `.img-frame`；主题走 CSS 变量；有 headless Chrome 渲染脚本出 PNG `[README/SKILL]` |
| [op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill) | 单文件 HTML 横向翻页 deck + 演讲者模式；Style A 电子杂志 / Style B 瑞士国际主义 | **视口单位**：`.slide { width:100vw; height:100vh; padding:6vh 6vw 10vh }`，`#deck { width:10000vw; display:flex; transform:translateX(...) }`；字号 `vw + max(px, …)` | README 明确：**当前核心交付是 HTML，PPTX 不是主流程**；需要 pptx 建议「把 HTML 当视觉稿再转换」 | 每页 `<section class="slide light/dark/hero ..." data-layout="Sxx" data-slide-id>`；版式必须来自登记的 22 个 Swiss 版式（`references/swiss-layout-lock.md`），禁止临时发明版式；样式用 `:root` 变量 + `--sp-3..13`（8/12/16/24/32/40/48/64/80/96/160px）间距 token；字号下限：正文/说明 18px、卡片/caption 16px、meta/kicker 14px；不写 inline style，类缺失先补到模板 `<style>`；每页必须有 `data-slide-id`；有 `validate-swiss-deck.mjs`/`validate-presenter-mode.mjs` 校验器 `[README/SKILL]` |
| [zarazhangrui/beautiful-html-templates](https://github.com/zarazhangrui/beautiful-html-templates) | 34 套可复用 HTML deck 模板，面向 coding agent 选型 | 模板内自定 | 无；定位是「生成 HTML deck」 | 按 `index.json` 选模板再改内容；`AGENTS.md` 是操作手册 `[README]` |
| [nlj626/html-to-pptx](https://github.com/nlj626/html-to-pptx) | html-ppt 的配套导出工具 | 沿用 html-ppt 的 `#/N` 深链 | **整页截图 → pptxgenjs 铺满**；README 明说「每页是一张图片，不可编辑文字」`[README]` | 需要可靠的「页 URL」，因此强依赖翻页路由（`#/N`） |
| [yuna78/html-to-pptx](https://github.com/yuna78/html-to-pptx) | GX-Alex 引擎的 fork + 中文修补（可编辑） | 固定画布，`--canvas auto\|WxH`，默认实测首页 | 原生形状（文字/表格/图表可编辑） | 见 §2.5 |

**这张表最重要的产品信号**：中文做得最漂亮的 HTML PPT 工具（html-ppt / guizang）**主动不保 pptx**，理由是 HTML 的表达力（vw 缩放、WebGL、动画、演讲者模式）与 PPT 的可编辑约束天然冲突；而做 pptx 的工具（nlj626 / yuna78）反过来要求固定画布、语义标签、内联资源。**HTMLPPT 的产品定位就卡在这个张力中间：既要中文 HTML PPT 的视觉上限，又要可编辑 pptx 的交付下限。**

### 3.2 知乎 / B站 / 小红书 / 公众号：他们在怎么做、怎么评价

- **知乎《7 种 AI PPT 策略：从官方到社区，原来 PPT 还可以用 Skill 这么做？》**：把「HTML 转 PPT / 直接用 HTML 思路」列为一条独立路线（「先让 AI 生成精美的 HTML 页面，然后要么转为 .pptx，要么直接用浏览器演示」「HTML → .pptx（通过 PptxGenJS 等工具转换）」）`[站点摘要]`（原文被 403 拦截，仅搜索摘要可读，**单一来源**）。→ 说明「HTML 作为中间表示」在中文 AI PPT 圈已是共识选项，且 PptxGenJS 是常被点名的转换件。
- **知乎回答（问题「在做 PPT 的 AI 工具里，你觉得体验最好的是哪一个？」）**：答主评价 html-ppt 类 skill——「这个 skill 所编写的 ppt 是运行在浏览器中的，并不会生成 .pptx 文件，所以如果你需要保存这个格式，它就不适合你」「html-ppt 通过 web 三件套…对当前 AI Agent 的友好程度远高于 .pptx 这种包含一堆 xml 文件的 zip 包」`[站点摘要]`（登录/安全验证拦截，**单一来源**）。→ 这正是我们的机会：**保留 HTML 的「AI 可编辑性」，补上 .pptx 的交付能力。**
- **B站《HTML Slides 全面实战教学，从工具选型到美学规范再到打造专属 AI Skill》**：简介称横向对比 Slidev、Reveal.js、Byeslide、Marp、OpenSlides 五款工具，给出「场景选型决策口诀」与「经过实战验证的美学规范」，并教观众封装成个人 AI Skill；推荐 GitHub 上的 Slidev 官方 skill、revealjs-skill、OpenSlides、PPT Master，覆盖「技术分享 / 极致视觉 / 纯 Markdown / PPTX 输出四条路线」`[站点摘要]`（视频页当前「仅自见」，**单一来源**）。→ 「四条路线」的划分与本文 §1.3 的三种导出路线互相印证。
- **小红书**：直接检索被登录墙拦截（`AUTH_REQUIRED`）。可间接观察到两类实践：①「小红书图文」模板把画布改成 **3:4 竖版 810×1080**（如 `html-ppt-xhs-post` skill 描述）`[项目文档，单一来源]`；② 有中文 html-ppt 生成器宣称「每页严格 1017×720px 对齐 PPT 画布」`[二手，单一来源]`。→ 说明中文用户已把「画布尺寸 = 交付格式尺寸」当成常识，但具体数值五花八门（1280×720 / 1017×720 / 810×1080 / 1920×1080），**更说明产品必须把画布基准写死并解释换算**。
- **公众号**：本轮未能抓到可引用的原文（微信生态对抓取不友好）。可用的替代证据是 WPS/腾讯云等厂商内容页（见 §3.4），不强行凑公众号来源。

### 3.3 「转 pptx 后不能改 / 字错位」：症状 → 根因 → 规避写法

| 症状 | 直接原因 | 根因 | 规避写法（可写进规范） | 出处 |
|---|---|---|---|---|
| 整页不能改、放大模糊 | 导出器把每页渲染成图片 | 截图路线（Marp 默认、Slidev 旧版、nlj626） | 选量测重建路线；验收时解包统计 `a:t` 字符数 | Marp README、Slidev 文档、nlj626 README |
| 标题/正文换行位置变了、文字溢出框 | 浏览器与 PowerPoint 对同一字符串的度量不同（约 2% 级） | 字体度量 + 断行算法不同；PPT 的 autofit 会二次缩放 | 文本块给足 2–4% 宽度余量；长段落拆页；不要依赖 auto height；行高 ≥1.2 | Slidev docs（「long paragraph may wrap onto a different number of lines」）、Slidev `normalize.ts`（`WRAP_HEADROOM=0.02`、`WRAP_HEADROOM_MIN_PX=4`） |
| 字体全变了/变宋体/变方框 | 收件人机器没有该字体，或字体名匹配失败 | pptx 只写字体名不嵌字体；变量字体/系统别名/字重槽不匹配 | 只用「可嵌入或目标机器必装」的静态字体；CSS 写明确 family 名；中文字体同时声明；导出前跑字体检查 | Slidev docs（「A .pptx names fonts, it does not embed them」）、open-design `font-discipline.md`（变量字体陷阱、latin/ea/cs 三槽）、Hasasasa lessons（GF 字体 wght 解析、`-apple-system` 别名） |
| 一段话被拆成多个框/多个词粘在一起 | 行内 flex/grid 的 `gap` 在文本层不存在；或量测把 inline 元素当独立块 | HTML 布局与 OOXML 文本模型的差异 | 同一句话只用一个文本叶子；需要间距就写字面分隔符；不要把一句话拆成多个绝对定位 span | Hasasasa supported-css + lessons（gap 粘连、text-leaf 识别） |
| 中文标点/字距变丑、负字距标题散架 | PowerPoint 不认 CSS `letter-spacing` 的负值语义；CJK 有避头尾 | OOXML 字距与 CJK 排版规则不同 | 中文 deck 不用负 letter-spacing；标题少用 tracking | archforge README（positive letter-spacing wrecks CJK）、open-design `font-discipline.md` |
| 渐变/阴影/毛玻璃整块消失或变成矩形 | CSS 渐变/filter/backdrop-filter 无 OOXML 原语 | 未命中降级规则 → 被丢弃 | 渐变/滤镜元素显式标注 `data-ppt-raster`；关键文字不要压在渐变上 | Anthropic html2pptx.md、Slidev docs、Hasasasa supported-css |
| 卡片/徽章/装饰线丢了 | 由 `::before/::after` 或空 div 实现 | 伪元素在普通流里无 box，导出器不采集 | 装饰用真实 `<div>`（可给固定尺寸）；伪元素只做纯色小装饰且接受丢失 | Slidev docs（in-flow pseudo dropped）、Hasasasa lessons（空 content 伪元素） |
| 列表 bullet 变双点或没有 | 手打 `•` 或 `::marker` 定制 | PPT 的 bullet 是段落属性，不是字符 | `<ul>/<ol>` + 原生 `list-style-type`；不要定制 marker 图形 | Anthropic html2pptx.md |
| 多行文本整体错位/长报告全挤在框里 | 文本被当成「一个元素整体定位」 | 导出器按元素 box 放 textbox，不做逐行折行 | 每页短句；长段落拆成多段/多页；框宽给足 | yuna78 README（已知限制第一条） |
| 表格列宽走形、单元格多行并成一段 | `<col width>`/rowspan/密排表格无对应 | OOXML 表格模型差异 | 列宽写单元格上；避免 rowspan；密排表格用组件化表格 | yuna78 README |
| 空行把后面内容挤出框 | 空段落没有显式字号，PowerPoint 回退 18pt | OOXML 空 `<a:p>` 需要 `endParaRPr.sz` | HTML 里不要用连续 `<br><br>` 造间距；用 margin/padding | Hasasasa lessons |
| WPS 里中文字重/宽度异常 | Latin run 被写了 CJK 字体到 `a:ea` 槽 | WPS 的 ea 槽 advance width 行为不同 | 纯 Latin run 不写 CJK ea；中英混排分 run | Hasasasa lessons |
| 满页背景色块在 WPS 里能选中、干扰编辑 | 背景被导出成普通 shape | 背景填充应走 slide background | 导出器把整页底色写 `slide.background`；HTML 提供 `data-ppt-background` | Hasasasa lessons |
| emoji 变黑白/方框 | 彩色字体不受支持 | OOXML 文字填充只有实色 | emoji 换 SVG/PNG 图片 | Hasasasa OOXML 边界表 |
| 导出后动画/视频/交互全没 | PPT 页是静态的 | 模型差异 | 设计时就把终态作为唯一可见状态 | 各家文档共识 |

> 一句话总结根因链：**「不可编辑」= 导出路线问题；「错位」= 度量/字体/换行问题；「丢东西」= 可表达性问题。** 三者对应三种产品机制：量测重建、字体策略、显式降级标注。

### 3.4 国内 AI PPT 产品的导出体验（可核实部分）

| 产品 | 生成形态 | 导出/可编辑性 | 收费与限制 | 证据 |
|---|---|---|---|---|
| **AiPPT** | 模板 + AI 生成；有「标准版 / 自由画布版」，模板广场 | 在线可改；导出 PPTX/PDF/图片；官方站有「导出为 PPTX/PDF/P…」文案 | 36氪测评：生成后可在里面修改，**但导出需要收费**；模板在线编辑/下载需要会员 | [36氪 AI 测评](https://36aidianping.com/note-detail/3568010593718398) `[二手]`；[AiPPT 官网](https://www.aippt.cn) `[官方]`；App Store 评论区有「开会员仍不能用/导出要付费」的抱怨 `[二手，观点]` |
| **讯飞智文** | 文案整理 + PPT 生成一体；支持文档转 PPT | 生成后右上角「导出」保存到本地，再在本地继续修改；文本转 PPT 中文排版较稳，但**图转 PPT 不还原原图布局**（按内置模板重组） | 导出流程可用；深度定制受模板限制 | [创泽案例 PDF](http://www.chuangze.cn/attached/file/20250506/20250506145252725272.pdf) `[二手]`；[腾讯云 5 工具对比](https://cloud.tencent.com.cn/developer/article/2718873) `[二手]`；[CSDN 图转 PPT 测评](https://blog.csdn.net/daxiongbaodian24/article/details/166964171) `[二手]` |
| **Kimi PPT** | 内置 12 类风格模板生成 | 可导出 pptx；**不支持上传自定义 .potx/母版**，只能用内置风格 | 模板自由度低；风格约束强 | 内容农场教程（php.cn）`[二手，低可信]`，仅作旁证 |
| **WPS AI** | 文档/主题 → PPT，在 WPS 生态内编辑 | 生成后直接在 WPS 演示里改；PPT 生成支持导出 **PPTX / PDF / 图片 / HTML** | 与 WPS 办公链短；HTML 导出支持在线预览/嵌入 | [WPS 365 内容页](http://365.wps.cn/content/789084aeeb6c49948e49629b3301bf07.html) `[官方/厂商内容]`；[腾讯云对比](https://cloud.tencent.com.cn/developer/article/2718873) `[二手]` |
| **秒出PPT** | 文档导入（Word/PDF/Notion/飞书）→ 结构化 PPT | 多格式导出：**PPTX / PDF / 图片**，支持分享链接 | 免费版有限制 | [第三方下载页](https://wap.ali213.net/down/41816.html) `[二手，低可信]` |
| **Gamma**（海外对照） | 卡片式在线演示 | 可导出 PPT，但**部分在线特效导出时被替换成其他样式**，字体与排版需在本地再检查 | 在线观感优先 | [腾讯云对比](https://cloud.tencent.com.cn/developer/article/2718873) `[二手]` |

**模式观察**（对我们的定价/功能设计有用）：
1. 国内产品的共同点是「**在线编辑器先行、导出是付费闸门**」——导出被当成变现点（AiPPT 最典型）`[二手]`。反向机会：把「导出可编辑 pptx」做成免费/透明的核心能力，用模板/协作/品牌库变现。
2. 生成路线几乎都是「模板槽位填充」，而不是「自由 HTML → 量测重建」。前者的可编辑性来自模板本身（拿到的就是原生占位符），后者才需要 HTML 编写规范。**AiPPT/Kimi/讯飞智文 的「可编辑」本质是「模板本来就是 PPT 结构」，不是 HTML 转换能力。**
3. 用户对「导出后能不能改」的判断标准非常具体：双击能不能改字、图表能不能改数据、字体是否一致、有没有整页图片。验收脚本应该直接测这些（解包统计 `<a:t>` 字符覆盖、`p:pic` 占比、单页是否有整页大图）。

### 3.5 证据限制（诚实声明）

- 知乎两篇、B站视频、小红书检索均被登录墙/反爬拦截，只拿到搜索摘要；已标 `[站点摘要]`/`[单一来源]`，未作为硬结论。
- Kimi、秒出PPT 的导出能力只有内容农场/下载站来源，可信度低；建议 Lead 若要在产品文档里引用，补一次实测。
- 微信生态（公众号）未取得可引用原文，本节未使用。

---

## 4. 设计系统视角：固定画布 + 栅格 + token + 组件化，是不是精确转换的前提？

### 4.1 先把单位账算清楚（这是所有争论的起点）

| 量 | 值 | 说明 |
|---|---|---|
| PowerPoint 默认宽屏 | **13.333 in × 7.5 in** = **960 pt × 540 pt** | `.pptx` 的 sldSz；pptxgenjs 的 `LAYOUT_WIDE` 也是 13.3×7.5 |
| 对应 CSS 像素（96 dpi） | **1280 × 720 px** | 1280/96 = 13.333 in；720/96 = 7.5 in |
| 换算 | **1 CSS px = 0.75 pt = 9525 EMU**；1 pt = 4/3 px | 914400 EMU/in ÷ 96 px/in = 9525 EMU/px |
| 8px 栅格 | 8 px = **6 pt** = 76200 EMU（整数） | 任何整数 px 都能精确落到 EMU |
| Anthropic html2pptx 画布 | 720 pt × 405 pt | = **10 in × 5.625 in** = **960 × 540 px**（pptxgenjs `LAYOUT_16x9` 默认），**不是 PowerPoint 默认宽屏** |
| Marp 默认 | 1280 × 720 px（16:9） | 与 PowerPoint 默认宽屏一致 |
| reveal.js 默认 | 960 × 700 px | 不是 16:9（1.371） |
| Slidev 默认 | 980 × 552 px | 可改 |

**结论**：如果产品要「导出后用 PowerPoint 打开就是满屏 16:9、且 px→EMU 无舍入」，唯一正确基准是 **1280×720 CSS px ↔ 13.333×7.5 in**。Anthropic 的 720×405pt 是 PptxGenJS 默认布局的副产物；若照抄，生成的 deck 打开是 10 in 宽（很多模板/母版按 13.333 in 做，会显得「两边留白」）。**建议 Lead 在最终规范里明确写死 1280×720 px，并在测试里断言 pptx 的 sldSz = 12192000×6858000 EMU。**

### 4.2 为什么「固定画布」是前提，而不是最佳实践

1. **PPT 的页是有限画布，HTML 的页是流**。量测重建路线要把 DOM 元素的 rect 映射到 slide 坐标；没有固定画布，就必须先猜「这一页到哪里结束」（滚动报告自动分页、`scroll-snap` 归位、`#/N` 深链），分页错误是中文工具最常见的 bug 之一（yuna78 README 明确把「只出了 1 页/分页类名」列为排障第一项）`[README]`。
2. **所有可编辑导出器的输入契约都要求显式尺寸**：Anthropic 720×405pt、slidesmith `width:1920px;height:1080px`、html2pptx-mcp 1280×720、yuna78 1280×720。**没有一个允许「响应式 = 正确」** `[见 §2]`。
3. **只有固定画布，才能让「同一份 HTML」既是预览又是导出源**（所见即所得），否则预览尺寸、导出尺寸、PPT 尺寸三者不一致，验收无从谈起。

### 4.3 栅格与 rails：不是玄学，是「可复现的对齐」

- **页边距**：html2pptx-mcp 要求主内容距边 ≥64px；guizang 用 `padding:6vh 6vw 10vh`（在 1280×720 上约等于 43×77×72px，不整齐——这是 vw/vh 体系的代价）`[项目文档]`。建议：**统一 64px 外边距（或 48px 紧凑版），所有主内容落在 1152×592 的内容区内**。
- **列间距**：32–64px（html2pptx-mcp）`[项目文档]`；guizang 的 token 是 8/12/16/24/32/40/48/64/80/96/160px `[SKILL]`。建议：**8px 基准 + 主要间距用 16/24/32/48/64/96**。
- **12 列**：1280 − 2×64（边距）= 1152；1152 = 12×96，即列宽 96px、gutter 0；若 12 列 + 11×gutter(24px)，列宽 = (1152−264)/12 = 74px（不整）。**建议改用「内容区 1152 + 12 列 + 24px gutter」的分数宽度，或直接 8 列 × 144px**。不需要为「12 列」教条化——PPT 里最重要的是左右轴对齐与重复元素的等距。
- **基线网格**：行高建议 1.2–1.6 倍字号，正文 1.5–1.7（CJK 需要更大行距，见 open-design `font-discipline.md` 的 per-script 行高表）`[项目文档]`。

### 4.4 设计 token：可行，但有三个前提

1. **token 必须在 computed style 层可解析**：导出器读的是渲染后的 computed style，所以 `:root { --ink: #0B1F3A }` 完全没问题；**问题出在 token 指向不可表达的值**（渐变、变量字体、vw 单位、filter 预设）。规范应要求「token 的终值必须是 PPT-safe 值」。
2. **字体 token 必须映射到静态、可嵌入/可安装的 family**：open-design `font-discipline.md` 的教训——变量字体（`Noto Serif TC` variable）在 PowerPoint 里匹配不到，要换 static 家族（`Noto Serif CJK TC`）；Google Fonts 的 `wght@400` 有时指向 Medium 文件，PPT 匹配不上会回退 `[项目文档]`。中文 deck 建议只用 `Noto Sans SC` / `Noto Serif SC` / `Source Han Sans` / `PingFang SC`（macOS 本机）/ `Microsoft YaHei`（Windows）这类确定存在的静态字体，并在产品里提供字体打包/安装提示。
3. **token 要覆盖「导出语义」**：除了颜色/字号/间距，还应有 `--slide-w/h`、`--content-inset`、`--radius`、`--shadow`、`--font-*`，并且**组件不允许绕过 token 写任意值**——否则导出时的降级规则无法枚举。

### 4.5 组件化 vs 自由 HTML：取舍与产品含义

| 维度 | 自由 HTML（现状的 HTML PPT skill） | 受约束组件（HTMLPPT 的推荐形态） |
|---|---|---|
| 视觉上限 | 高（vw 缩放、WebGL、动画、任意 CSS） | 中高（在 token/组件内可组合，但有白名单） |
| 转 pptx 保真度 | 低且不可预测（每次都可能踩新边界） | 高且可回归（组件→固定原语，可自动化测试） |
| 可编辑性 | 取决于导出器运气 | 可承诺（文本/形状/图片/表格数量可度量） |
| AI 生成友好度 | 高（HTML 是文本，Agent 容易写） | 高（组件有 schema/示例，生成更稳） |
| 评审/协作 | 改一处可能影响全局 | 组件级变更，影响可控 |
| 工程成本 | 低（不用建组件库） | 高（组件库 + 校验器 + 导出映射） |
| 品牌一致性 | 靠作者自觉 | 由 token/组件强制 |
| 失败模式 | 静默丢样式/整页截图 | 显式降级（元素级图片 + 警告） |

**产品含义**：
- 如果卖点是「HTML 的自由度」→ 就永远无法承诺「精确可编辑 pptx」，只能做截图导出（Marp/Slidev 旧路线）。
- 如果卖点是「可编辑 pptx」→ 必须收窄 HTML，把自由度换成**组件 + token + 契约**；自由 CSS 只作为「高级模式」，并强制走「逐元素降级标注 + 导出报告」。
- 最佳折中：**双层模型**——
  - **编辑层**：用户/AI 写「组件 DSL 或受约束 HTML」（语义标签 + token class + `data-ppt-*` 标注）；
  - **导出层**：一个确定性的量测器 + 映射器（HTML/CSS→IR→DrawingML），对白名单外样式逐元素降级，并输出「哪些元素变成了图片」的报告；
  - **验收层**：结构差指标（文本框数、字符覆盖率、形状数、整页图片检测、字体命中）+ 回渲对比图（LibreOffice/真 PowerPoint）。
- 组件化的落地参考：guizang 的「22 个登记版式 + `data-layout` + 校验脚本」`[SKILL]`、html-ppt 的「36 layouts + 15 full decks + tokens」`[README]`、Anthropic 的 `class="placeholder"`（图表占位）`[官方文档]`。核心不是「组件多」，而是**每个组件都有明确的导出语义**（哪些节点是文本、哪些是形状、哪些允许变图片）。

### 4.6 对 HTMLPPT 的架构建议（一句话版）

> **固定 1280×720 画布 + 8px 基准栅格 + token 化样式 + 组件注册表（带导出语义）+ 逐元素降级标注 + 导出前后双重校验。** 自由 HTML 不是不能支持，但必须走「高级模式 + 显式 lossy 同意」；默认路径应是受约束组件。

---

## 5. HTMLPPT HTML 规范 v0.1（25 条可执行条款）

> 使用方式：每条含「规则 / ✅ 正例 / ❌ 反例 / 原因」。条款编号供 Lead 合成最终规范时引用、裁剪、重排。
> 术语：`画布` = 1280×720 CSS px（= 13.333×7.5 in = 960×540 pt）；`页` = 一个 `<section class="slide">`；`导出器` = HTML→PPTX 转换管线。

### A. 文档结构与画布

**A1. 每页一个根节点，固定 1280×720，显式宽高 + `overflow:hidden`。**
✅
```html
<section class="slide" data-slide="1" style="width:1280px;height:720px;overflow:hidden;position:relative">
  …
</section>
```
❌
```html
<section class="slide" style="width:100vw;height:100vh">…</section>
```
原因：PPT 每页尺寸固定；`vw/vh` 随导出视口变化，量测结果不可复现（guizang/html-ppt 的 vw 体系正是无法直接精确转 pptx 的主因）。

**A2. `html/body` 零污染；页根按 DOM 顺序堆叠；页序由 DOM 决定，不靠 JS 显隐切页。**
✅
```css
html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden;background:#fff}
#stage{position:relative;width:1280px;height:720px}
section.slide{position:absolute;inset:0;width:1280px;height:720px;overflow:hidden}
```
```html
<section class="slide" data-slide="1">…</section>
<section class="slide" data-slide="2">…</section>
```
❌ `body { margin:8px; overflow:auto }` + 多页纵向滚动；❌ `<div class="slide is-active">…</div>` + JS 动态 `display:none` 切页（导出时可能只剩一页）。
原因：浏览器默认 8px margin 和滚动条会污染量测；导出器静态遍历页根节点取 rect，滚动容器会错页，依赖 JS 状态的显隐会漏页（中文工具「只出了 1 页」的常见原因）。

### B. 文本（可编辑性的生命线）

**B1. 所有可编辑文案必须落在 `<p>/<h1>-<h6>/<ul>/<ol>/<li>` 内；`<div>` 只做容器。**
✅ `<div class="card"><h3>标题</h3><p>正文 <b>加粗</b></p></div>`
❌ `<div class="card">标题<br>正文</div>`（Anthropic 原话：silently ignored）
原因：OOXML 文本只能来自 `<a:t>`，转换器靠文本标签识别 text run；裸文本会被丢弃或变成不可编辑位图。

**B2. 一个语义段落 = 一个文本叶子；不要把一句话拆成多个绝对定位的 `<span>`/`<div>`。**
✅ `<p class="lead">用 HTML 写，导出可编辑的 PPTX。</p>`
❌ `<div style="position:absolute;left:96px">用</div><div style="position:absolute;left:140px">HTML</div>…`
原因：PPT 的一个 textbox 承载一段文字；拆开后每个碎片各成文本框，编辑体验崩溃，且换行/字距不可控（yuna78 的「文字按元素整体定位」限制）。

**B3. 富文本只用行内语义标签：`<b>/<strong>/<i>/<em>/<u>/<span>`；`<span>` 只给 font-weight/style/color/text-decoration。**
✅ `<p>营收 <b>1.2 亿</b>，同比 <span style="color:#16a34a">+18%</span></p>`
❌ `<span style="display:block;margin:12px;padding:8px;background:#eee">…</span>`
原因：PPT 的 text run 只有字体/字号/粗斜/颜色/下划线/字距；`span` 上的盒模型属性不会被转换（Anthropic 明确 span 不支持 margin/padding）。

**B4. 列表用 `<ul>/<ol>`，禁止手打 bullet 符号，禁止用 `::marker` 定制图形。**
✅ `<ul><li>要点一</li><li>要点二</li></ul>`
❌ `<p>• 要点一</p><p>• 要点二</p>`
原因：bullet 是 PPT 段落属性；手打符号会双 bullet 或丢失（Anthropic 硬规则）。

**B5. 文本块必须有显式宽度（或明确的容器宽度），不依赖 auto height 撑开；不要用连续 `<br><br>` 造间距，长文拆页。**
✅ `<p style="width:520px;line-height:1.6;margin-bottom:16px">…</p>`
❌ `<div class="flex-1"><p>很长很长的段落…</p></div>`（容器高度由内容撑开）；❌ `<p>…<br><br><br>…</p>`。
原因：PowerPoint 的 autofit/溢出行为不可控；量测高度与 PPT 渲染高度不一致会压住下一元素；空 `<a:p>` 会回退默认 18pt 行高（Hasasasa lessons：空段 18pt、`<br>` 框高问题）。

### C. 布局与栅格

**C1. 使用「固定画布 + 区域绝对定位 / 组件内 flex」；绝对定位只用于已预留的区域/组件，不用于拆散文本流。**
✅
```html
<div class="region" style="position:absolute;left:64px;top:160px;width:560px">
  <div class="stack" style="display:flex;flex-direction:column;gap:16px">…</div>
</div>
```
❌ `<p style="position:absolute;left:64px;top:160px">…</p><p style="position:absolute;left:64px;top:190px">…</p>`（每行一个绝对定位段落）
原因：html2pptx-mcp 的原文规则——绝对定位仅用于已预留 frame；区域级绝对定位可精确映射，文本级绝对定位破坏可编辑性与换行。另：不要用 CSS `columns`、`float`、`table` 做版式（多栏/浮动无 OOXML 对应；用 `<table>` 排版会与「语义表格」混淆，转换器难以区分——yuna78 明确建议别用 table 排版面），版式一律用 flex/grid 或显式定位。

**C2. 主内容安全区：距画布边缘 ≥64px（全出血背景/图片除外）；列间距 32–64px。**
✅ `.content{position:absolute;inset:64px}`
❌ 标题贴到 `left:0`、正文压到 `bottom:0`。
原因：PPT 播放/投影会裁边；同时给文本框留出度量误差余量（Slidev 用 2%+4px headroom 对冲换行差异）。

**C3. 间距用 8px 的整数倍（16/24/32/48/64/96），不要用 `vw/vh/em` 链式尺寸。**
✅ `margin-bottom:24px; gap:16px; padding:32px`
❌ `margin-bottom:2.5vh; font-size:1.8vw`
原因：1280×720 下 8px=6pt 可精确落 EMU；vw/vh 随视口变化，导出不可复现。

### D. 形状、装饰与颜色

**D1. 背景/边框/圆角/阴影只写在 `div`（或组件容器）上，不写在文本元素上。**
✅ `<div class="card" style="background:#fff;border:1px solid #e5e7eb;border-radius:16px"><p>…</p></div>`
❌ `<p style="background:#fff;border:1px solid #ddd">…</p>`
原因：PPT 里 shape 与 textbox 是两个对象；文本元素上的装饰属性不被转换（Anthropic 校验项之一）。

**D2. 优先纯色/单层边框/标准圆角/单层软阴影；渐变、多层阴影、滤镜、非对称圆角必须显式标注降级。**
✅ `<div style="background:#0B1F3A;border-radius:24px;box-shadow:0 8px 24px rgba(0,0,0,.18)">…</div>`
❌ `<div style="background:linear-gradient(...);box-shadow:0 0 0 2px #fff,0 8px 24px #000;border-radius:40% 60% 70% 30%">…</div>`
原因：渐变/filter/多层阴影/非对称圆角无 OOXML 原语；不标注就会被静默丢弃，标注后走元素级截图（见 H2）。

**D3. 中文 deck 禁止负 `letter-spacing`；大标题字距保持 0 或轻微正值。**
✅ `h1{letter-spacing:0}`
❌ `h1{letter-spacing:-0.04em}`（中文会被压成粘连）
原因：PowerPoint 对 CJK 字距的处理与浏览器不同；archforge 专门把「positive letter-spacing 破坏 CJK 字距」列为检测项，反向的负字距问题更严重。

**D4. 颜色只用 `#rgb/#rrggbb/rgba()`；不要用 `color-mix()`、`oklch()`、CSS 变量嵌套计算等导出器可能解析不了的形式（token 的最终值必须是上述之一）。**
✅ `color:#0B1F3A; background:rgba(255,255,255,.08)`
❌ `color:color-mix(in oklab, var(--ink) 80%, white)`
原因：导出器解析 computed color 时可能遇到不认识的函数并丢弃（Slidev 会把 `unparsedColors` 报出来；这说明解析器是有边界的）。

### E. 媒体、图表与表格

**E1. 图片只用 `<img>` + 显式 width/height（可选 `object-fit`），不要用 `background-image` 承载内容图。**
✅ `<img src="assets/photo.jpg" width="480" height="320" style="object-fit:cover;border-radius:12px">`
❌ `<div style="width:480px;height:320px;background:url(photo.jpg) center/cover">`
原因：`<img>` 能原生嵌入为 `p:pic`；`background-image` 只能整块截图（Hasasasa 第 2 档）。图必须可在线/本地解析，导出时通常离线。

**E2. 图表/可视化用「占位容器 + 数据属性」，由导出阶段注入原生图表；不要把 canvas 截图当交付。**
✅ `<div class="chart" data-ppt-placeholder="chart" data-chart-type="bar" data-chart='{"labels":["Q1"],"values":[42]}' style="width:520px;height:280px"></div>`
❌ `<canvas id="chart"></canvas>` + JS 渲染后导出（只能截首帧）。
原因：Anthropic 的 `class="placeholder"` 机制证明「预留区域 + 后注入」是可行路线；canvas/WebGL 无法转原生图表（Slidev 明确 canvas 变图片）。

**E3. 表格只在「真表格数据」时用 `<table>`；列宽写在单元格/`<th>` 上，避免 `rowspan/colspan` 与 `<col width>`。**
✅ `<table style="table-layout:fixed;border-collapse:collapse"><tr><th style="width:240px">指标</th><th style="width:120px">数值</th></tr>…</table>`
❌ 用 `<table>` 摆两栏图文、用 `<col width>` 定列宽、大量 rowspan 合并。
原因：OOXML 表格模型与 HTML 不同；`<col width>` 不跟过来、rowspan 不展开（yuna78 已知限制）。

### F. 字体与排版

**F1. 只用「静态、可嵌入或目标机器必装」的字体；CSS 写明确 family 名 + fallback；中文同时给出 CJK 字体。**
✅
```css
:root{--font-sans:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}
:root{--font-display:"Noto Serif SC","Source Han Serif SC",serif}
```
❌ `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`
原因：pptx 只写字体名不嵌字体（Slidev 文档）；变量字体/系统别名/字重槽会导致 PowerPoint 回退（open-design font-discipline；Hasasasa lessons）。中文 deck 的字体必须能被收件人机器解析，否则全篇重排。

**F2. 字号/行高下限：正文 ≥18px、说明/图注 ≥16px、meta/kicker ≥14px；行高 ≥1.2（正文 1.5–1.7）。**
✅ `p{font-size:20px;line-height:1.6}`
❌ `p{font-size:13px;line-height:1.1}`
原因：投影可读性 + PowerPoint 度量误差；行高过紧会被 PPT 的更松排版挤溢出（Hasasasa lessons「紧 line-height」、guizang 的字号下限表）。

### G. 交互、动画与资源

**G1. 动画/过渡只能作为增强，导出的静态终态必须自洽；不要依赖交互后才出现的内容。**
✅ CSS `@keyframes fadeIn` + `animation-fill-mode:both`，默认终态可见。
❌ 内容默认 `opacity:0`，靠 JS 滚动/点击才显示（导出时可能空白）。
原因：PPT 页是静态的；Slidev 导出时直接 `animation-play-state:paused` 取终态，取不到就是空白。

**G2. 资源自包含：图片/字体走相对路径且位于 HTML 同级或子目录；远程 CSS/字体/图片要内联或预下载。**
✅ `<img src="assets/logo.png">`、`<style>@font-face{src:url("fonts/NotoSansSC-Regular.woff2")}</style>`
❌ `<link href="https://fonts.googleapis.com/...">`、`<img src="https://cdn...">`（导出沙箱通常零出网）
原因：yuna78「渲染时零出网」、Hasasasa 字体自动解析/缓存；slidesmith 只服务 HTML 目录，`../` 资源不可用。

### H. 导出契约（HTMLPPT 专有）

**H1. 页面必须可被机器识别：`<section class="slide" data-slide="N">`，N 从 1 连续递增；可加 `data-layout` 标记版式。**
✅ `<section class="slide" data-slide="3" data-layout="S07">…</section>`
❌ 用不同 class 名混用（`.page/.screen/.view`）或页序依赖 DOM 之外的排序。
原因：导出器需要确定的分页选择器；参考 yuna78 的 `.slide/.deck-slide/.cover` 与 guizang 的 `data-layout` 校验。

**H2. 需要降级为图片的元素必须显式标注，且禁止默认整页降级。**
✅ `<div class="hero-bg" data-ppt-raster="gradient">…</div>`、`<svg data-ppt-raster="icon">…</svg>`、`<div data-ppt-ignore>…</div>`
❌ 一个 `filter` 容器覆盖全页却不标注，导出器只能猜（要么丢效果、要么整页截图）。
原因：Slidev 的 per-element raster + 每页 fallback 报告、Hasasasa 的 deco_snapshot、html2pptx-mcp 的 `data-html2pptx-rasterize` 都证明「逐元素降级 + 报告」比「整页截图」体验好得多。

**H3. 演讲者备注放 `<aside class="notes">`（或 `data-notes`），不放在页面上；导出时映射到 pptx notes。**
✅
```html
<section class="slide" data-slide="1">
  <h1>标题</h1>
  <p>正文</p>
  <aside class="notes">这里讲 30 秒，强调成本下降。</aside>
</section>
```
❌ 把逐字稿写成页面上 `display:none` 的 `<p>`（导出后仍在页面里/丢失）。
原因：Marp/Slidev 都支持 notes 传递；PPT 有原生 notes 槽位。html-ppt 也用 `<aside class="notes">`。

**H4. 每页可包含一个「背景层」标记；整页底色不要画成一个覆盖全页的 `div`。**
✅ `<section class="slide" data-slide="4" data-ppt-background="#0B1F3A">…</section>`（或 `<body data-ppt-background="...">`），导出器写 `slide.background`
❌ `<div style="position:absolute;inset:0;background:#0B1F3A"></div>`（在 WPS 里会变成可选中色块）
原因：Hasasasa lessons 明确记录「满页背景色应通过 slide 背景填充实现，否则 WPS 里成为可选可拖对象」。

---

### 附：v0.1 条款速查表（供 Lead 合成）

| 组 | 条款 | 一句话 |
|---|---|---|
| A 结构 | A1–A2 | 1280×720、每页一个 section、文档/页面无污染、页序静态 |
| B 文本 | B1–B5 | 文本进语义标签、一段一叶子、列表用 ul/ol、显式宽度、不靠 br 造间距 |
| C 布局 | C1–C3 | 区域绝对/组件内 flex、64px 安全区、8px 栅格、禁 table/columns 排版 |
| D 形状 | D1–D4 | 装饰只上 div、纯色优先、禁负字距、颜色用 hex/rgba |
| E 媒体 | E1–E3 | img 显式尺寸、图表占位、表格语义化 |
| F 字体 | F1–F2 | 静态可嵌入字体、字号行高下限 |
| G 交互 | G1–G2 | 静态终态、资源自包含 |
| H 契约 | H1–H4 | slide/data-slide、data-ppt-raster、notes、背景层 |

### 附：导出前自检清单（10 项，可直接做成 linter 规则）

1. 每页 `<section class="slide">` 的数量 = 预期页数；每页 `width/height` 均为 1280/720。
2. 无 `vw/vh/%` 出现在 `width/height/font-size/margin/padding`（除图片百分比）。
3. 无裸文本：每个非空文本节点的最近父级是 `p/h1-h6/li/td/th`（或白名单）。
4. 无手打 bullet、无 `::marker` 定制、无 `columns/float`。
5. 无 `background-clip:text`、无渐变文字、无非对称 `border-radius`。
6. 每个 `gradient/filter/backdrop-filter/mix-blend-mode/clip-path` 元素都有 `data-ppt-raster`。
7. 每个 `::before/::after` 要么是纯装饰（可接受丢失），要么内容已 inline 到 DOM。
8. 字体清单：全部为静态字体，且不包含 `-apple-system/system-ui/BlinkMacSystemFont`。
9. 资源清单：无 `http(s)://` 的外链字体/图片（或已内联）。
10. 每页有 `data-slide`、notes 用 `<aside class="notes">`、背景用 `data-ppt-background`。

---

## 6. 矛盾、分歧与待 Lead 决策

| # | 分歧/不确定 | 各方说法 | 建议 |
|---|---|---|---|
| 1 | **画布基准**：720×405pt 还是 1280×720px？ | Anthropic 用 720×405pt（=960×540px，PptxGenJS 默认 10in）；html2pptx-mcp/Marp/yuna78 用 1280×720（=960×540pt=PowerPoint 默认宽屏） | 选 **1280×720 px ↔ 13.333×7.5 in**（PowerPoint 默认），并在测试里断言 `sldSz`。不要混用两套基准 |
| 2 | **`.col` 约定是否存在** | 任务描述提到 Anthropic 的 `.col` flexbox；官方 html2pptx.md 中不存在，只有 `class="placeholder"` 与「flexbox works」 | 把 `.col`/`.grid-*` 作为**我们自己的组件约定**，不要写成「Anthropic 规范」 |
| 3 | **Anthropic 路线的可用性** | 2025-12 有 `html2pptx.md`；2026-02 改为 npm 包；当前 main 改为「直接写 pptxgenjs 脚本」；许可证 proprietary，禁止复制/衍生 | 只借鉴其规范思想；**不要引用/搬运代码**，产品实现自己写 |
| 4 | **Slidev 文档与源码不一致** | docs 仍说 PPTX 是图片；main 分支已有 `pptx-editable`（53.0.0，2026-09-16） | 报告中按「发布版本 vs main」分开写；引用时注明版本 |
| 5 | **Marp editable 的可行性** | 官方 README 明确 experimental、低复现、丢备注、复杂主题会失败 | 不能作为产品依赖；仅作「PDF 中转路线」的参照 |
| 6 | **自由 HTML vs 受约束** | 中文审美 skill 用 vw/WebGL/动画，不做 pptx；ppt 工具要求固定画布 | 产品走「受约束默认 + 自由高级模式（显式 lossy）」，不要试图两全 |
| 7 | **字体嵌入的合规性** | 微软雅黑/苹方等商业字体不可嵌入；思源/Noto（OFL）可嵌入 | 默认字体集只放 OFL 字体；商业字体走「本机已安装」策略并提示风险 |
| 8 | **中文平台证据不足** | 知乎/小红书/B站被登录墙拦截，只有摘要；Kimi/秒出PPT 来源可信度低 | 报告中已标注；建议 Lead 若需产品文案引用，补实测或换官方文档 |
| 9 | **「可编辑」的定义** | 有人指「文字可选可改」，有人指「图表数据可改」，有人指「版式可重排」 | 产品需定义三级：L1 文字可编辑 / L2 形状图表可编辑 / L3 版式可重排；对外承诺写清楚级别 |

---

## 7. 来源清单

### 框架与导出机制（一手）
- https://revealjs.com/markup/ — reveal.js `.reveal > .slides > section` 结构、section 即一页、嵌套=垂直页。
- https://revealjs.com/presentation-size/ — 默认 `width:960,height:700`、等比缩放、center。
- https://revealjs.com/pdf-export/ — 只有 `?print-pdf` 打印 PDF；无 pptx。
- https://github.com/impress/impress.js — step + `data-x/data-y/data-z` 3D 坐标模型。
- https://sli.dev/guide/exporting — Slidev 导出文档：`pptx` 为图片；`pptx-editable` 为新原生导出及其限制清单。
- https://github.com/slidevjs/slidev/pull/2722 — `feat(export): editable PPTX export with native shapes and text`（2026-09-16，@slidev/cli 53.0.0）。
- https://github.com/slidevjs/slidev/tree/main/packages/slidev/node/commands/pptx — 源码：walker/normalize/capture/build；`WRAP_HEADROOM=0.02`、`RASTER_AREA_LIMIT=0.6`。
- https://github.com/slidevjs/slidev/blob/main/docs/features/canvas-size.md — 默认 `canvasWidth:980` + 16:9。
- https://github.com/marp-team/marp-cli — `--pptx` 预渲染背景图、`--pptx-editable` experimental + LibreOffice 依赖 + 丢备注。
- https://github.com/marp-team/marp-cli/blob/main/src/converter.ts — `convertFileToPPTX()` 用 pptxgenjs 塞图片；editable 走 `soffice --infilter=impress_pdf_import`。
- https://www.npmjs.com/package/@marp-team/marp-core — 内置主题 16:9（1280×720）/ 4:3（960×720）。
- https://marpit.marp.app/theme-css — Marpit `section` 即一页、`:root` 指 section。
- https://nearform.com/open-source/spectacle/docs/faq/ — Spectacle 仅 PDF 导出（`?exportMode=true`）。
- https://github.com/webslides/WebSlides — WebSlides 能力范围（无导出）。

### HTML→可编辑 PPTX 的编写规范（一手/项目文档）
- https://github.com/anthropics/skills/blob/ef740771/skills/pptx/html2pptx.md — Anthropic html2pptx 编写规范全文（720×405pt、文本标签铁律、web-safe 字体、禁渐变、div-only 装饰、占位符、校验项）。
- https://github.com/anthropics/skills/tree/main/skills/pptx — 当前版本（已改为 pptxgenjs 脚本 + editing.md），说明路线变更。
- https://raw.githubusercontent.com/anthropics/skills/ef740771/skills/pptx/LICENSE.txt — proprietary 许可（禁止复制/衍生/分发）。
- https://github.com/Hasasasa/html-to-editable-pptx — README（vector-first、四档 CSS 处理、字体 subset/嵌入）。
- https://github.com/Hasasasa/html-to-editable-pptx/blob/main/references/supported-css.md — CSS 四档覆盖矩阵、deco_snapshot 机制、已有缺口。
- https://github.com/Hasasasa/html-to-editable-pptx/blob/main/references/lessons-learned.md.example — HTML 反模式 / OOXML 边界 / regression checkpoint（最实用的踩坑表）。
- https://github.com/AliceLJY/slidesmith — HTML contract、supported CSS 白名单、截图回退模式。
- https://himcp.ai/server/html2pptx-mcp — 1280×720→13.333×7.5in、`.slide/.content` shell、64px 安全区、region/flex/绝对定位规则、avoid 列表、`data-*` 提示。
- https://github.com/yuna78/html-to-pptx — 中文 fork：固定画布、分页类名、内联资源、已知限制。
- https://github.com/GX-Alex/html2pptx — 上游引擎（DOM→可编辑图元→DrawingML）。
- https://github.com/nlj626/html-to-pptx — 截图式中文导出（明确「不可编辑」），可作为反例。

### 设计/字体/质量（项目文档）
- https://github.com/laihenyi/open-design/tree/main/skills/pptx-html-fidelity-audit — `font-discipline.md`（变量字体陷阱、latin/ea/cs 三槽、CJK 不斜体、per-script 行高）；`layout-discipline.md`（13.333×7.5 in 画布、rails、cursor 溢出校验）。
- https://pypi.org/project/archforge/ — AI 生成 PPT 的 preflight linter：字体回退、CJK 字距、文本碰撞、出画布、小字号。
- https://deckary.com/blog/html-presentations — 独立横向对比：Slidev PPTX=图片、Reveal=PDF、三条交付路线（2026-08 校验）。

### 中文生态与实践（可访问部分）
- https://github.com/lewislulu/html-ppt-skill — 中文 HTML PPT skill：36 主题/15 全 deck/36 布局/token base.css/`--deck-w:1920px`/`.slide` 一页/notes。
- https://github.com/op7418/guizang-ppt-skill — 单文件横向 deck；vw/vh；明确「PPTX 不是主流程」；22 个登记版式 + `data-layout` + 校验器；字号下限；8–160px 间距 token。
- https://github.com/zarazhangrui/beautiful-html-templates — 34 套 agent 可复用 HTML 模板。
- https://zhuanlan.zhihu.com/p/2047321893670331312 — 知乎《7 种 AI PPT 策略》（HTML→pptx 路线；页面被 403，摘要引用，单一来源）。
- https://www.zhihu.com/question/2061477776406927019/answer/2061582589056627738 — 知乎回答：html-ppt 类 skill 不产 pptx（安全验证拦截，摘要引用，单一来源）。
- https://www.bilibili.com/video/BV1F7V86nEGe/ — B站《HTML Slides 全面实战教学》（工具对比/美学规范/AI Skill；当前仅自见，摘要引用，单一来源）。
- https://skillsmp.com/zh/creators/onfire7777/universal-ai-skills-library/skills-html-ppt-xhs-post — 小红书 3:4 竖版 810×1080 模板（单一来源）。
- https://skillhub.cn/skills/clawhub_panhongwei/html-ppt-generator — 宣称「每页严格 1017×720px 对齐 PPT 画布」（单一来源，二手）。

### 产品导出体验（二手/厂商）
- https://36aidianping.com/note-detail/3568010593718398 — 36氪 AI 测评：AiPPT 生成可改、导出收费、模板需会员。
- https://www.aippt.cn — AiPPT 官网（导出 PPTX/PDF/图片文案）。
- https://cloud.tencent.com.cn/developer/article/2718873 — 腾讯云：5 款 AI PPT 工具在文档解析/结构/可编辑性上的差异（WPS AI/博思/二狗/讯飞智文/Gamma）。
- http://365.wps.cn/content/789084aeeb6c49948e49629b3301bf07.html — WPS：智能 PPT 支持 PPTX/PDF/图片/HTML 导出。
- http://www.chuangze.cn/attached/file/20250506/20250506145252725272.pdf — 讯飞智文案例：生成后「导出」到本地再编辑。
- https://blog.csdn.net/daxiongbaodian24/article/details/166964171 — 讯飞智文文本转 PPT 稳、图转 PPT 不还原布局（二手）。
- https://m.php.cn/faq/2899149.html — Kimi 不支持 .potx 上传、仅内置模板（内容农场，低可信，仅旁证）。
- https://wap.ali213.net/down/41816.html — 秒出PPT 支持 PPTX/PDF/图片导出（下载站，低可信）。
- https://apps.apple.com/cn/app/aippt-ppt%E5%88%B6%E4%BD%9C-ppt%E6%A8%A1%E7%89%88/id6744651694?see-all=reviews — AiPPT 用户评论（付费/会员抱怨，观点类证据）。

---

*本文只写文件 `research/03-authoring-products.md`。§5 的 25 条为候选条款，供 Lead 与 task-1/2/4 的结论合成最终规范；§6 的 9 个分歧点建议在最终规范里显式决策。*
