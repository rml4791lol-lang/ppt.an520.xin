# HTML/CSS → OOXML DrawingML 映射规则与保真约束（可执行版）

> 调研员：spec-scout（task-2）｜日期：2026-10-19｜环境：macOS (Darwin/aarch64)、LibreOffice 26.8.0.3、python-pptx 1.0.2、PptxGenJS 4.0.1、Node 26、Chrome（headless 实测）、pdftotext (poppler)、fontTools
> 定位：本文是 HTMLPPT 转换器的技术地基。所有换算公式、元素名、属性名可直接抄进实现；凡标 **【实测】** 的结论都在本机复现过（实验脚本与产物在 `/tmp/scout-exp/`），标 **【未验证】** 的表示本机无 PowerPoint/Keynote，未能闭环验证。
> 规范缩写：ISO/IEC 29500-1:2012 = ECMA-376 Part 1（下文 `§x.y` 为该标准章节号）。本机已下载完整标准 PDF 用于核对原文（`/tmp/scout-exp/iso29500.txt`）。

---

## 0. TL;DR（给 Lead 的 8 条硬结论）

1. **单位换算只有一条主线**：`1 CSS px = 9525 EMU = 0.75 pt`；幻灯片 1280×720 px → 12192000×6858000 EMU（13.333×7.5 in）。字号 `sz = px×75`，字距 `spc = px×75`，固定行距 `spcPts = px×75`，段距同理。
2. **行距一律用 `a:spcPts`（绝对值），不要用 `a:spcPct`**：标准说 `spcPct` 是"文本尺寸的百分比"（§21.1.2.2.11），但 PowerPoint 实现是"字体自然行高（ascent+descent+lineGap）的百分比"（[pom#260](https://github.com/hirokisakabe/pom/issues/260)），LibreOffice 26.8 实测是"字号 ×1.2 的百分比"【实测】——三者互不相等，唯一可控的是 `spcPts`。
3. **CJK 字体必须同时写 `a:latin` / `a:ea` / `a:cs`**。python-pptx 的 `font.name` **只写 `a:latin`**（源码 `pptx/text/text.py:351-369`），CJK 会掉到主题 `+mn-ea`（Windows 中文默认「等线」）→ 换机器必变。PptxGenJS v4.0.1 会把三者写成**同一个** `fontFace`（`dist/pptxgen.cjs.js:5963`），**没有** latin≠ea 的 API。
4. **文本保真主线 = 浏览器内按视觉行硬断行**：用 `Range.getClientRects()` 逐字素测出视觉行与行推进，写 `<a:br/>` + `spcPts` 固定行距 + `noAutofit`。换行位置因此可控；代价是文本不再随框重排、目标机缺字体时会崩坏（见 §2.3）。
5. **`autofit` 全部关掉**：`<a:noAutofit/>`。`normAutofit` 的 `fontScale` 由 PowerPoint 在编辑/重排时动态算（PptxGenJS 明确不写、源码注释在 `pptxgen.cjs.js:6066`），而 LibreOffice 会在渲染时自行重算缩小【实测】——两种行为都会让像素保真失效。
6. **降级判据**：能落到 `a:solidFill / a:gradFill / a:ln / a:prstGeom / a:custGeom / a:effectLst(outerShdw) / a:blipFill+a:srcRect / a:tbl / a:bodyPr(numCol)` 的走原生；涉及**组透明叠加、任意 clip-path、blur/混合模式、文字渐变、复杂多阴影、图标字体、emoji** 的块整体栅格化为 PNG（可编辑性让位于保真）。
7. **字体嵌入在 OOXML 里是可行的**（`p:embeddedFontLst` + `ppt/fonts/*.fntdata` + `relationships/font` + `[Content_Types]` 的 `application/x-fontdata`），但 fntdata 是 **EOT 容器**而非裸 TTF/OTF（[MS-OI29500 §2.1.32](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/ea097c57-5794-4624-b08e-017b47051b1d)、[genoffice embedded-fonts.ts](https://github.com/genspark-ai/genoffice/blob/main/packages/pptx-engine/src/embedded-fonts.ts)、PptxGenJS PR [#1302](https://github.com/gitbrent/PptxGenJS/pull/1302)），PptxGenJS/python-pptx **都不支持**，且**本机无 PowerPoint 无法闭环验证**。
8. **验收不要做像素差**：LibreOffice 回渲存在一批确定性偏差（忽略 `wrap="none"`、`spcPct` 基准不同、CJK↔拉丁边界自动加 ≈0.24em、字距只加 n−1 次、字体重解析），必须用"结构差"（行数/行位置/溢出/重叠/对齐/字号）+ 已知偏差白名单（§5）。

---

## 1. 单位与坐标系（可直接实现的换算）

### 1.1 基准常量

| 量 | 值 | 规范/来源 |
|---|---|---|
| 1 inch | 914400 EMU | DrawingML 坐标单位（EMU = 1/914400 in） |
| 1 pt | 12700 EMU | ISO 29500 通用度量 |
| 1 CSS px（96 dpi） | 9525 EMU = 0.75 pt | `914400/96` |
| 幻灯片 1280×720 px | 12192000 × 6858000 EMU = 13.3333×7.5 in | 【实测】python-pptx `prs.slide_width=Emu(12192000)` 输出原样 |
| 幻灯片 1920×1080 px | 18288000 × 10287000 EMU = 20×11.25 in | 同上换算 |
| `a:sz`（字号） | 1/100 pt | §20.1.10.73 ST_TextPoint：*"a measurement in hundredths of a point"* |
| `a:spc`（字距） | 1/100 pt | §21.1.2.3 属性表：*"Whole points are specified in increments of 100 starting with 100 being a point size of 1"* |
| `a:spcPts/@val` | 1/100 pt（段距/行距绝对值） | §21.1.2.2.12 |
| `a:spcPct/@val` | 1/1000 %（100000 = 100%） | §21.1.2.2.11 |
| `a:alpha/@val` | 1/1000 %（100000 = 不透明） | 【实测】PptxGenJS `fill.transparency:30` → `<a:alpha val="70000"/>` |
| `a:xfrm/@rot` | 1/60000 度 | 【实测】`rotate:15` → `rot="900000"` |
| `a:srcRect` l/r/t/b | 1/1000 %（裁剪比例） | 【实测】`sizing:{type:'cover'}` → `<a:srcRect l="25000" r="25000"/>` |
| `a:ln/@w`、`bodyPr` 的 lIns/tIns/rIns/bIns | EMU | 1px 边框 = 9525 EMU；【实测】PptxGenJS `line.width:2`(pt) → `w="25400"` |
| `a:gd fmla="val N"`（roundRect adj） | 1/100000，半径 = `N/100000 × min(cx,cy)` | §20.1.9 presetShapeDefinitions；【实测】4×1 in 框 `adj=25000` 渲染圆角 ≈0.25 in |
| `normAutofit/@fontScale`、`@lnSpcReduction` | 1/1000 %（也允许 `"20.000%"` 字符串） | §21.1.2.1.3 示例 `<a:normAutofit fontScale="20.000%" lnSpcReduction="20.000%"/>` |

### 1.2 换算公式（唯一真源）

```ts
// 输入：CSS px（96dpi 布局）/ pt / in；输出 EMU 与 OOXML 属性值
const EMU_PER_IN = 914400, EMU_PER_PT = 12700, EMU_PER_PX = 9525;
const px2emu = (px: number) => Math.round(px * EMU_PER_PX);
const px2pt  = (px: number) => px * 0.75;
const px2sz  = (px: number) => Math.round(px * 75);        // a:sz   = px*0.75*100
const px2spc = (px: number) => Math.round(px * 75);        // a:spc  = px*0.75*100
const px2spcPts = (px: number) => Math.round(px * 75);     // a:spcPts val = px*0.75*100
const ratio2spcPct = (r: number) => Math.round(r * 100000); // 1.4 → 140000
const opacity2alpha = (o: number) => Math.round(o * 100000); // 0.7 → 70000
const deg2rot = (d: number) => Math.round(d * 60000);
const pct2srcRect = (p: number) => Math.round(p * 1000);    // 25% → 25000
// 反算：emu2px = emu/9525；pt2px = pt*4/3；emu2pt = emu/12700
```

**正/反向校验（【实测】，可当单测用例）**

| CSS 输入 | OOXML 输出 | 实测命令/来源 |
|---|---|---|
| `left:0.5in` | `<a:off x="457200" y="365760"/>` | PptxGenJS `x:0.5,y:0.4` |
| `width:4.2in` | `<a:ext cx="3840480"/>` | 同上 |
| `font-size:24px` | `sz="1800"` | python-pptx `Pt(18)`，另测 24pt→`sz="2400"` |
| `line-height:24px` | `<a:spcPts val="1800"/>` | 【实测】PDF 行距 = 24.0 pt，误差 <0.01 pt |
| `line-height:1.4` | `<a:spcPct val="140000"/>` | PptxGenJS `lineSpacingMultiple:1.4` |
| `letter-spacing:2px` | `spc="150"`（并同时 `kern="0"`） | PptxGenJS `charSpacing:2`(pt)→`spc="200"`；注意 API 单位是 pt，转换层要自行 ×0.75 |
| `margin-bottom:12px` | `<a:spcAft><a:spcPts val="900"/></a:spcAft>` | 【实测】spcPts 精确生效 |
| `border:2px solid #f00` | `<a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/>…` | 2px→1.5pt→19050 EMU |
| `border-radius:8px` | roundRect `adj = 8*9525/min(cx,cy)*100000` | 【实测】adj 与短边成正比 |

### 1.3 字号

- HTML 字号可能是 px / rem / em / pt / %：先在浏览器里 **computed style 归一为 px**（`getComputedStyle(el).fontSize`），再 `sz = round(px*75)`。
- `a:rPr` 的 `sz` 是 run 级；段落默认走 `a:defRPr`（`pPr` 内）或 `a:lstStyle`。转换器建议**每个 run 都写死 `sz`**，不依赖继承。
- 最小字号：PowerPoint 支持 `sz="100"`（1pt）；但可读性与飞书/Keynote 兼容建议 ≥ `sz="800"`。

### 1.4 行高 / 行距（本文件最重要的一节）

**规范原文（§21.1.2.2.5 lnSpc）**：
> *"This element specifies the vertical line spacing that is to be used within a paragraph. This can be specified in two different ways, percentage spacing and font point spacing. **If this element is omitted then the spacing between two lines of text should be determined by the point size of the largest piece of text within a line.**"*

**`spcPct` 规范原文（§21.1.2.2.11）**：
> *"…in the form of a percentage of the text size. The text size that is used to calculate the spacing here is the text for each run, with the largest text size having precedence."*

**规范 vs 实现（不一致，必须按实现来设计）**：

| 引擎 | `spcPct 100%` 的基准 | 证据 |
|---|---|---|
| ISO 29500 文字 | 最大 run 的**字号** | §21.1.2.2.5 / §21.1.2.2.11 原文（本机 PDF 核对） |
| PowerPoint | 字体**自然行高**（ascent+descent+lineGap）× 倍数；Noto Sans JP ≈1.2–1.4×字号 | [pom#260](https://github.com/hirokisakabe/pom/issues/260)（PPTX 库作者实测复现） |
| LibreOffice 26.8 | **字号 × 1.2**，与字体无关；CJK/西文同值 | 【实测】24pt 文本：无 lnSpc = `spcPct 100%` = 28.8 pt/行；`spcPct 200%` = 57.6 pt/行；12pt 文本 = 14.4 pt/行 |
| CSS（浏览器） | `line-height:<number>` = **number × font-size**；`normal` = 字体 hhea/OS2 行高 | [CSS2.1 §10.8.1](https://www.w3.org/TR/CSS22/visudet.html#leading)；【实测】Chrome：32px Noto Sans CJK SC `line-height:normal` 行推进 46px（=1.4375em），`line-height:1.4` 行推进 44.8px |

**可执行规则（转换器决策树）**：

```
若 computed line-height 是 <length>px  → <a:lnSpc><a:spcPts val="round(px*75)"/>
若 computed line-height 是无单位数 N  → <a:spcPts val="round(N*fontSizePx*75)"/>   // 绝不用 spcPct
若 computed line-height:normal        → 用测量值：spcPts = round((rects[i+1].y - rects[i].y)*75)
混合字号段落                          → 每个视觉行单独一段（或按行距变化处切段），各自写 spcPts
不要省略 lnSpc                        → 省略时基准由"最大字号"决定（规范）/字体行高（PPT 实现），不可控
```

> `compatLnSpc`（§21.1.2.1.1 bodyPr 属性）只是"用字体场景简化计算行距"的开关，PowerPoint 里极少用；转换器**不要**依赖它来对齐浏览器行距。

### 1.5 字距（`letter-spacing`）

- CSS `letter-spacing: Lpx` → `<a:rPr spc="{round(L*75)}" kern="0">`。
- **必须同时写 `kern="0"`**：PptxGenJS 源码注释明确 *"Also disable kerning; otherwise text won't actually expand"*（`pptxgen.cjs.js:5946`）。
- **尾部差异（【实测】）**：CSS 在每个字符后加间距（n 个间隙），OOXML `spc` 只在字符之间加（n−1 个）。实测 Chrome vs LibreOffice 同一 10 字符 Arial 串、`letter-spacing:10pt`：Chrome 336.03px，LO 322.60px，差值恰为 1×13.33px。
  → **测量视觉行宽度时必须减去 1×letter-spacing**，否则行宽系统性偏大。
- 负字距允许（PptxGenJS 实测 `charSpacing:-1.5` → `spc="-150"`）。
- `text-rendering: optimizeLegibility` / `font-kerning` / `font-feature-settings` 在 DrawingML 无对应：`kern="0"` 关掉的是 PowerPoint 的字距调整，与浏览器 OpenType kern 不是同一层，宽度会小幅漂移（通常 <1%）。

### 1.6 段前 / 段后（`spcBef` / `spcAft`）

- CSS `margin-top/bottom` → `a:spcBef/a:spcAft`，单位 `spcPts`（1/100 pt）：`val = round(marginPx*75)`。
- **schema 顺序强制**：`a:pPr` 子元素必须 `lnSpc → spcBef → spcAft →（bullet/defRPr）`，乱序会被 PowerPoint/PPT for Mac 忽略（PptxGenJS 源码注释 `pptxgen.cjs.js:5903`；datypic [CT_TextParagraphProperties](https://www.datypic.com/sc/ooxml/t-a_CT_TextParagraphProperties.html)）。
- **CSS 外边距折叠 vs OOXML 相加（【实测】）**：LibreOffice 中 `spcAft=12pt` + 下一段 `spcBef=6pt` → 段间基线距 = 24（行距）+12+6 = **42 pt（相加，不折叠）**；CSS 下同级 margin 会折叠成 12pt。→ 转换器要**自己算折叠后的间距**，只写到一侧（推荐写下一段的 `spcBef`），另一侧写 0（注意 PptxGenJS 传 0 时不会输出该元素，需后处理或改用 `spcPts` 极小值）。
- `spcFirstLastPara`（bodyPr 属性）：控制首/末段是否应用段距，默认为 true；转换器算好间距后建议显式 `spcFirstLastPara="0"`。
- 没有"段距"的视觉间距（如 `<br>` 造出的空行）应显式换成 `spcPts` 或空段落 + 精确行距，不能靠字体行高。

### 1.7 文本框内边距 / 锚点 / 换行（HTML 盒子的直接对应）

| CSS | OOXML | 备注 |
|---|---|---|
| `padding-left` | `bodyPr/@lIns` (EMU) | 默认 `91440`（0.1 in）——**必须显式覆盖**，HTML 一般没有这个内边距 |
| `padding-top` | `bodyPr/@tIns` | 默认 `45720`（0.05 in） |
| `padding-right/bottom` | `rIns` / `bIns` | 同上 |
| 文本垂直起点 | `bodyPr/@anchor="t"` | 默认是 `ctr`（垂直居中）；PptxGenJS 默认 `anchor="ctr"`，转换必须显式 `valign:'top'` |
| `overflow-wrap/white-space` | `bodyPr/@wrap="square"`（换行）/`"none"`（不换行） | 只有两个值；`wrap="none"` 在 PPT 是收缩包裹，在 LO 会被忽略并按框宽硬折行（【实测】+ [ppt-master#199](https://github.com/hugohe3/ppt-master/issues/199)） |
| `overflow:hidden` | `bodyPr/@vertOverflow="clip"` / `horzOverflow="clip"` | 文本溢出裁剪；**不是**形状级裁切 |
| 盒子裁切（子元素超出圆角框） | 无原生对应 | 降级为图片，或把子元素按裁切后几何重建 |

### 1.8 取整与合法性（避免 PowerPoint 弹"修复"）

- `sz/spc/spcPts/alpha/rot/srcRect/adj` 等整型属性**必须输出整数**：`Math.round`。PptxGenJS 注释：*"Use round so sizes like '7.5' wont cause corrupt presentations"*（`pptxgen.cjs.js:5925`）。
- `a:off/@x,y` 允许负数（PowerPoint 会接受，元素可出画布）；但验收阶段应报"出血/超界"。
- 空元素陷阱：`<a:ln></a:ln>`（PptxGenJS 在无边框时会输出）不是 schema 合法的最小形态，建议后处理删掉空 `a:ln`/空 `a:t`。
- `cNvPr/@id` 在同一 slide 内必须唯一（PptxGenJS 表格会把 table 的 id 又从 2 开始，实测 slide1.xml 中 `id="2"` 出现两次）——本机 LibreOffice 容忍，PowerPoint 严格模式可能报错，**后处理需要重排 id**。

---

## 2. 文本布局差异（核心）

### 2.1 "同字体同字号仍然跳行/行高不同"的 5 个根因

| # | 根因 | 机制 | 量化/证据 | 转换器对策 |
|---|---|---|---|---|
| 1 | **行距基准不同** | CSS number × font-size；PPT × 字体自然行高；LO × 1.2×font-size | 【实测】24pt 纯 CJK 三行：无 lnSpc = `spcPct 100%` = 28.8pt/行，`spcPct 200%` = 57.6pt/行（= 1.2em×倍数）；同条件下 CSS `line-height:1.4` = 44.8px = 33.6pt；PPT 按 Noto 自然行高 1.448em 推算 = 48.6pt | 永远写 `spcPts`（§1.4） |
| 2 | **字体解析（fallback）不同** | 目标机没有 HTML 用的字体时，PPT/LO/Keynote 各选各的替代字体 | 【实测】把 `Hiragino Sans GB` 写进 pptx：LO 在 macOS 上**换成了 Noto Sans CJK HK**（`pdffonts` 可见），同串渲染宽 347pt = 462.8px，而 Chrome 用真字体 528.3px（≈−12%） | ① 只用双方都装/可嵌入的字体；② 硬断行 + 行宽冗余；③ P1 做字体嵌入 |
| 3 | **断行规则不同（CJK）** | PowerPoint 的 kinsoku（`eaLnBrk`/`hangingPunct`）、CJK↔拉丁边界处理；CSS 的 `line-break/word-break/hanging-punctuation` 默认值不同 | 规范定义见 §21.1.2.2.7（`eaLnBrk` 默认 true=允许东亚词内断行；`hangingPunct` 默认 false） | 硬断行（§2.3）绕开全部断行规则差异 |
| 4 | **LO 额外插入 CJK↔拉丁间距** | LibreOffice 在 CJK↔Latin 边界自动加间距，PowerPoint 不加 | 【实测】`中文ABC` 32px Noto：Chrome 124.91px vs LO 132.50px，差 7.59px = **0.237em/边界**；与 [ppt-master#293](https://github.com/hugohe3/ppt-master/issues/293) 报告的 ≈0.24em/处一致 | 属 LO 回渲伪差异 → 进白名单，不改 PPTX |
| 5 | **字距/shaping 细节** | CSS letter-spacing 加 n 次 vs `spc` n−1 次；LO/HarfBuzz 与 DirectWrite/CoreText 的连字、字偶距、数字替换不同 | 【实测】n−1 vs n（§1.5）；标点全角宽度估算差异见 [ppt-master#293](https://github.com/hugohe3/ppt-master/issues/293) | 行宽测量按 n−1 修正 + 行宽冗余 2–3% |

补充：**首行位置**。PPT 文本框 `anchor="t"` 时首行 ink-top = `tIns` + 行盒半间距 + (ascent−capHeight) 等，浏览器同理但公式不同。**做法**：不要解析字体度量去推算，改用「首屏标定」——同一字体渲染一次，记录 PPT 首行 ink-top 与浏览器首行 ink-top 的差 Δ，全篇统一加 Δ 到 `y`（同一字体 Δ 稳定在 ±1px 内）。

### 2.2 autofit 的坑（必须关掉）

- `bodyPr` 的 autofit 子元素是**三选一**：`<a:noAutofit/>` | `<a:normAutofit fontScale lnSpcReduction/>` | `<a:spAutoFit/>`（§21.1.2.1.3/21.1.2.1.4，datypic [a:bodyPr](https://www.datypic.com/sc/ooxml/e-a_bodyPr-1.html)）。
- `fontScale` 是**结果值不是配置值**：规范示例 `fontScale="20.000%"`，实际由渲染器在"文本溢出 + 编辑/重排"时计算写回。
  - PptxGenJS `fit:'shrink'` 只输出裸 `<a:normAutofit/>`，源码里 `fontScale="85000" lnSpcReduction="20000"` 那行被注释掉（`pptxgen.cjs.js:6066`），官方类型注释也说明 *"'shrink' and 'resize' only take effect after editing text/resize shape… There is no way for this library to trigger that behavior"*（`types/index.d.ts` fit 字段）。
  - LibreOffice 26.8 **会在渲染时自行缩排**【实测】：2in×0.45in 框内 32pt 文本 + `<a:normAutofit/>`，LO 把字号缩到约 11–12pt 才放进框（图片/PDF 实测）；显式 `fontScale="60000"` 也会应用。
  - python-pptx 使用者反馈同上：需要"手动触发渲染引擎"才会写回 `fontScale`（[python-pptx#969](https://github.com/scanny/python-pptx/issues/969)）。
- **结论**：转换器一律输出 `<a:noAutofit/>`；需要缩小时**自己在测量阶段算**（缩小字号或减少行距），并把最终值写死。绝不能让"打开时自动缩排"参与保真。
- PptxGenJS 没有生成 `noAutofit` 的入口（`fit:'none'` 是**不输出**任何 autofit 子元素）→ 用 PptxGenJS 时需 JSZip 后处理注入 `<a:noAutofit/>`，或改自研 XML 生成。

### 2.3 「按测量视觉行硬断行」方案（推荐主线）

**收益**

1. 断行位置 100% 由我们决定（不受 kinsoku/CJK 边界/引擎行距影响）；
2. 行距用 `spcPts` 写死 → 行节奏与 CSS 完全一致（PPT/LO 都精确，【实测】误差 <0.01pt）；
3. 溢出可确定性检测（行盒高 × 行数 vs 框高），不依赖 autofit；
4. 文本仍是**真文本**（可选中、可编辑、可搜索），不是图片；每行以 `<a:br/>` 软换行组织在同一段落里，编辑体验优于"每行一个文本框"。

**代价 / 风险**

| 代价 | 说明 | 缓解 |
|---|---|---|
| 不再自动重排 | 用户改字/改框宽不会重排（除非删掉硬换行） | 可接受：产品定位是"精确导出"；另提供"松散模式" |
| 依赖目标机字体 | 字体替换后字宽变化 → 硬断行反而造成**错误断行**（原本不折的行被折） | 行宽冗余 + 字体收敛（§4）；或 P1 嵌入字体 |
| 测量成本 | 每页需要 headless 浏览器测量（约 0.3–1s/页） | 与截图流水线合并，一次渲染多头复用 |
| 特殊排版退化 | `text-align:justify`（每行两端对齐）在硬断行下等价于 `algn="just"` 但末尾行不会拉伸；竖排/竖中横排需另测 | 分别处理或降级 |

**算法（可直接实现）**

```ts
// 1) 浏览器侧：对每个文本块，逐字素测 rect，按 top 聚成视觉行
function measureVisualLines(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const lines: { text: string; left: number; right: number; top: number; bottom: number; advance: number }[] = [];
  const range = document.createRange();
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    for (const { segment, index } of seg.segment(node.data)) {
      range.setStart(node, index); range.setEnd(node, index + segment.length);
      const r = range.getClientRects()[0]; if (!r) continue;
      const cur = lines[lines.length - 1];
      if (cur && Math.abs(r.top - cur.top) < 0.6) {           // 同一视觉行
        cur.text += segment; cur.right = Math.max(cur.right, r.right);
        cur.bottom = Math.max(cur.bottom, r.bottom);
      } else {
        lines.push({ text: segment, left: r.left, right: r.right, top: r.top, bottom: r.bottom, advance: 0 });
      }
    }
  }
  for (let i = 1; i < lines.length; i++) lines[i - 1].advance = lines[i].top - lines[i - 1].top;
  if (lines.length) lines[lines.length - 1].advance = /* computed line-height px */ parseFloat(getComputedStyle(el).lineHeight) || (lines[lines.length-1].bottom - lines[lines.length-1].top);
  return lines; // + 每行字符数、行首标点、行宽 = right-left（letter-spacing 需按 §1.5 校正）
}
```

```ts
// 2) 生成侧：一个文本框 + 每视觉行一个 run + softBreakBefore 造 <a:br/>
// PptxGenJS：同一段落数组里，第 2 个 run 起加 options.softBreakBefore=true（全库唯一生成 a:br 的路径）
const runs = lines.map((ln, i) => ({
  text: ln.text,
  options: { softBreakBefore: i > 0, fontFace, fontSize, charSpacing: lsPt, color }
}));
slide.addText(runs, {
  x, y, w: boxW, h: boxH,
  margin: 0, valign: 'top', wrap: 'square', fit: 'none',   // fit:'none' → 不写 autofit；仍需后处理注入 <a:noAutofit/>
  lineSpacing: lines[0].advance * 0.75                    // pt; 行距不一致时按变化处切段
});
```

**行宽冗余与几何规则（保真 vs LO 伪折行的平衡）**

- 目标宽度 `wTarget = max(CSS 框宽, 最宽视觉行宽 × 1.03 + 0.25em × CJK↔拉丁边界数 + 2px)`；`0.25em×边界数` 用来抵消 LO 的自动间距（§2.1 #4），否则 LO 会把最后 1–2 字挤到下一行（[ppt-master#199](https://github.com/hugohe3/ppt-master/issues/199)/[#293](https://github.com/hugohe3/ppt-master/issues/293) 的实际翻车形态）。
- **加宽必须补偿对齐锚点**，否则居中/右对齐文本会平移：
  - `left`：`x` 不变，`w = wTarget`；
  - `center`：`x = x - (wTarget - wCSS)/2`；
  - `right`：`x = x - (wTarget - wCSS)`。
- 若某元素是 `wrap="none"` 的 CSS 单行且左对齐：PPTX 可写 `wrap="none"` + `spAutoFit`（PPT 收缩包裹）；但 **LO 会忽略 `wrap="none"` 并按框宽硬折**（【实测】+ [ppt-master#199](https://github.com/hugohe3/ppt-master/issues/199)），所以框宽仍要 ≥ 渲染宽 + 冗余。
- `white-space:pre` / `pre-wrap` 下的连续空格：OOXML 会保留 `<a:t>` 内空格（`xml:space` 由 `a:t` 语义保证），但**行首空格**在 PowerPoint 里可能被压缩；安全做法是把行首空格转成 `&nbsp;`(U+00A0) 或留白 shape。

**编辑性说明（写进产品文案）**：硬断行后文本仍是单个文本框内的多行（`a:br`），用户可整段选中改字；但改长后会按框宽自动重排（`wrap="square"`），或超出框（`wrap="none"`）。不提供"自动回到 CSS 排版"的能力。

### 2.4 CJK 字体：latin / ea / cs 三处设置

- **schema 顺序**：`a:rPr` 的子元素顺序为 … `a:ln`(可选填充) → `a:latin` → `a:ea` → `a:cs` → `a:sym` → `a:hlinkClick` …（datypic [CT_TextCharacterProperties](https://www.datypic.com/sc/ooxml/t-a_CT_TextCharacterProperties.html)；ISO 29500 §21.1.2.3）。写错顺序会被忽略。
- 语义：`a:latin` 管拉丁、`a:ea` 管东亚（Han/Hiragana/Katakana/Hangul/Bopomofo）、`a:cs` 管复杂文种（阿拉伯/希伯来等）。
- **不写 `a:ea` 的后果**：回落到主题 `<a:ea typeface="+mn-ea"/>`，最终由 `<a:fontScheme>` 的 script 映射决定——PptxGenJS 生成的 Office 主题里就是 `<a:font script="Hans" typeface="等线"/>`（【实测】`theme1.xml`），即 Windows 中文 PowerPoint 默认「等线」，与设计字体完全不同。
- **python-pptx 的坑（源码级证据）**：`Font.name` 的 getter/setter 只操作 `self._rPr.latin`（`pptx/text/text.py:351-369`）。设 `run.font.name='Noto Sans SC'` 只写 `a:latin`，CJK 仍走主题 ea。必须手写：
  ```python
  from pptx.oxml.ns import qn
  from lxml import etree
  rPr = run._r.get_or_add_rPr()
  for tag, face in (('a:latin', latin), ('a:ea', ea), ('a:cs', cs)):
      el = rPr.find(qn(tag)) or etree.SubElement(rPr, qn(tag))
      el.set('typeface', face)
  ```
- **PptxGenJS 的现状（v4.0.1 源码）**：`fontFace` 一处同时写三个元素，值相同：
  ```xml
  <a:latin typeface="X" pitchFamily="34" charset="0"/><a:ea typeface="X" pitchFamily="34" charset="-122"/><a:cs typeface="X" pitchFamily="34" charset="-120"/>
  ```
  （`dist/pptxgen.cjs.js:5963`；`charset="-122"`(ea)/`"-120"`(cs) 的取值来自 [issue #174](https://github.com/gitbrent/PptxGenJS/issues/174)）。**没有**独立 ea/cs 选项（[#916](https://github.com/gitbrent/PptxGenJS/issues/916) closed 无实现；[#1288](https://github.com/gitbrent/PptxGenJS/issues/1288) 主题 ea 至今不可设）。
- **实践建议**：
  1. 设计规范上尽量"中西文同族"（如 Noto Sans SC / 思源黑体一个 family 覆盖拉丁+CJK），则 PptxGenJS 的"三处同值"够用；
  2. 若 HTML 确实是「Inter + 思源黑体」两族混排：按 script 把文本**拆成 run**，然后 **JSZip 后处理**把 `a:ea` 改成 CJK 字体（PptxGenJS 无法在 API 层做到）；
  3. 主题层也建议写 `<a:ea typeface="..."/>`（并保留 `<a:font script="Hans">` 映射）作为兜底；PptxGenJS 做不到，需要后处理 theme1.xml。

### 2.5 断行/标点规则速查（写进 QA 白名单用）

| 机制 | OOXML | 默认 | 备注 |
|---|---|---|---|
| 东亚词内可断 | `a:pPr/@eaLnBrk` | true | *"whether an East Asian word can be broken in half and wrapped onto the next line without a hyphen… presentation application would use the kinsoku settings"*（§21.1.2.2.7） |
| 拉丁词内可断 | `a:pPr/@latinLnBrk` | false | 与 CSS `word-break:break-all` 相对 |
| 悬挂标点 | `a:pPr/@hangingPunct` | false | true = 强制标点留在行尾不换行（§21.1.2.2.7） |
| 简化行距 | `a:bodyPr/@compatLnSpc` | false | *"line spacing … decided in a simplistic manner using the font scene"* |
| 段落水平溢出 | `a:bodyPr/@horzOverflow` | overflow | `clip` 可裁切 |
| CSS 侧 | `line-break` / `word-break` / `overflow-wrap` / `hanging-punctuation` / `text-wrap:balance|pretty` | — | 与上表无一一映射；`text-wrap:balance` 只能靠硬断行还原 |

---

## 3. CSS → DrawingML 原语映射矩阵（逐条结论）

**判据总则**
- **原生**：语义/几何一致，跨 PowerPoint 版本稳定；
- **半原生**：OOXML 有元素但表达力/参数不完全等价（要近似、拆形状、或后处理 XML）；
- **图片**：整块栅格化为 PNG（`p:pic`），保留一个"可编辑文本副本"放在备注或隐藏层（推荐：把文字放 `p:sp` 但设置透明/移出画布，用户仍可复制文本）。

| CSS 原语 | 结论 | OOXML 元素/属性 | 换算与参数 | 坑 / 判据 |
|---|---|---|---|---|
| `background-color` | 原生 | 形状 `a:solidFill>a:srgbClr`；整页 `p:bg>p:bgPr` | `#RRGGBB` → `srgbClr val`；`rgba` → `srgbClr>a:alpha` | 页面背景用 `p:bg`，元素背景用 shape fill |
| 径向/线性渐变背景 | 半原生 | `a:gradFill>a:gsLst>a:gs@pos`+`a:lin@ang`/`a:path` | `pos`=1/1000 %；`ang`=1/60000 度（CSS `to bottom`=90°→5400000） | PptxGenJS **无 API**（[#102](https://github.com/gitbrent/PptxGenJS/issues/102)，4 个 PR 仍 open）→ 后处理注入；多色标/重复渐变可原生 |
| `background-image` | 原生 | `a:blipFill>a:blip r:embed` + `a:stretch`/`a:tile` | 需 slides rels + media part | `background-attachment:fixed` 无对应（本来就静态） |
| `background-size:cover/contain` | 原生 | `a:srcRect` + `a:stretch` | 按 §1.2 `pct2srcRect` 算裁剪；PptxGenJS `sizing:{type:'cover'}` 已实现 | `background-repeat:repeat` → `a:tile` |
| `border`（四边同） | 原生 | `a:ln@w` + `a:solidFill` + `a:prstDash` | `w=px*9525`；dash 映射 `solid/dash/dot/sysDash/lgDash` | 圆角框的 border 会随 `prstGeom` 圆角走 |
| 单边/不同边框 | 半原生 | 拆成 4 条 `a:ln` 无法表达 → 用 4 个细长 `p:sp`（rect 无填充）或 `a:custGeom` | 位置按盒模型算 | 圆角 + 单边边框 → 只能用 custGeom 或图片 |
| `border-radius`（四角同值） | 原生 | `prstGeom prst="roundRect"` + `a:gd name="adj"` | `adj = round(radius_px*9525 / min(cx,cy) * 100000)`；`radius ≥ min/2` → `adj=50000`（胶囊） | 【实测】adj 与短边成比例；PptxGenJS `rectRadius` 单位是**英寸**（不是 0–1） |
| `border-radius`（各角不同） | 图片 或 custGeom | `a:custGeom>a:pathLst`（arcTo/lnTo） | 需自写路径；圆角矩形 4 段 arcTo | 纯色/纯渐变背景时 custGeom 足够；含子元素裁切 → 图片 |
| `box-shadow`（单层外阴影） | 原生 | `a:effectLst>a:outerShdw` | `blurRad=blurPt*12700`、`dist=offsetPt*12700`、`dir=angle*60000`、颜色 `a:alpha` | CSS blur radius 与 OOXML `blurRad` 的模糊核不同（LO/PPT 也互不相同）→ 视觉近似，可标定 |
| 多层 `box-shadow` | 半原生→图片 | 只能保留 1 个 `outerShdw`（+1 个 `innerShdw`） | 取最显著一层；或用 `a:effectDag`（兼容性差） | 设计规范里禁止多层阴影最省事 |
| `box-shadow:inset` | 半原生 | `a:effectLst>a:innerShdw` | 同上参数 | **PptxGenJS bug**：shape 分支硬编码 `</a:outerShdw>` 闭合（`pptxgen.cjs.js:5508`，[#1293](https://github.com/gitbrent/PptxGenJS/issues/1293))→ 坏 XML，禁用 |
| `opacity`（单元素单填充） | 原生 | 各填充/线条颜色内的 `a:alpha` | `alpha = opacity*100000` | 背景/边框/文字各自一份 alpha，不会"整体降透明" |
| `opacity`（容器带动画/重叠子元素） | 图片 | — | — | 组透明下重叠处不会二次变暗，与 CSS 不同 → 栅格化 |
| `filter:blur()` | 半原生 | `a:effectLst>a:blur@rad`（EMU） | `rad = px*9525` 起步，需与 CSS blur 标定（CSS 用高斯标准差语义） | 【实测】LO 能渲染 blur；PPT 效果半径偏小/偏大属系统性差异 |
| `filter:drop-shadow()` | 半原生 | `a:outerShdw` | 同 box-shadow | 对 PNG（含 alpha）的投影效果一致 |
| `filter:grayscale/sepia/hue-rotate/contrast/saturate` | 图片 | — | — | `a:duotone`/`a:lum` 只能模拟部分亮度/双色效果，不做 |
| `backdrop-filter` | 图片 | — | — | 必须在浏览器里把毛玻璃结果烘焙进背景图 |
| `clip-path`（inset/圆角） | 半原生 | 用 `prstGeom`（rect/roundRect/ellipse）+ 几何换算 | inset 圆角矩形 = roundRect 收缩 | 裁切的是"元素+子元素"，只有纯背景时等价 |
| `clip-path:polygon()` | 半原生 | `a:custGeom`（lnTo/moveTo/close） | 顶点 px→EMU | 裁切内容若含子元素/文本 → 图片 |
| `clip-path:path()` / `url(#svg)` | 图片 | — | — | 任意贝塞尔裁切 + 内容 → 图片（或 `custGeom` 仅当内容是纯色） |
| `transform:translate()` | 原生 | `a:xfrm>a:off` | `off += translate*9525` | 不要用 `a:xfrm` 之外的"动画位移" |
| `transform:rotate()` | 半原生 | `a:xfrm@rot` | `rot=deg*60000`；**DrawingML 只绕形状中心旋转** | `transform-origin` 不是中心时，要先把原点平移到中心：`off' = C_center - R(θ)·(C_center - P_origin)`；旋转后轴对齐包围盒 != 原包围盒（验收时按旋转后 bbox 算） |
| `transform:scale()`（纯色/图片，均匀） | 半原生 | 缩放 `a:ext`；图片也可用 `a:srcRect` 反向裁 | 文字随缩放 = 同时改 `sz` 和框 | 非均匀 scale 对文本（会变成挤压字形）→ 图片 |
| `transform:skew()/matrix3d/rotateX/Y` | 图片 | — | — | DrawingML 无 skew；3D 只能烘焙 |
| `z-index` | 原生 | `p:spTree` 子元素**书写顺序**（后者在上） | 按计算后的 z 排序输出 | 不能用 `a:xfrm` 表达层级；注意 `p:grpSp` 组内独立层级 |
| `object-fit:cover/contain/fill/none` | 原生 | `a:blipFill>a:srcRect` + `a:stretch` | cover：按比例裁 `l/r/t/b`；contain：图片 xfrm 内缩并居中；fill：拉伸 | 【实测】PptxGenJS `sizing` 三种模式都走 `srcRect`；`object-position` 通过偏移合并进 srcRect |
| `img`（位图） | 原生 | `p:pic>p:blipFill>a:blip r:embed` | PNG/JPEG/GIF(首帧)/BMP；WebP/AVIF **不要直接塞**（老 PPT 不认）→ 预转 PNG | 大图先按目标 DPI 降采样（`目标px = 显示px × 1.5~2`），否则文件爆炸 |
| `<img src="*.svg">` / inline SVG | 半原生 | `p:pic` + `a:blip` 内 `a:extLst>a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">asvg:svgBlip` + **PNG 兜底 blip** | 命名空间 `http://schemas.microsoft.com/office/drawing/2016/SVG/main`（[MS-ODRAWXML §5.24](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/cc083f6d-bc38-4ff4-b32a-5bc97df8addc)） | **PptxGenJS 在 Node 端把 PNG 兜底写成破图占位**（`pptxgen.cjs.js:4961-4968`，[#401](https://github.com/gitbrent/PptxGenJS/issues/401)/[#963](https://github.com/gitbrent/PptxGenJS/issues/963)/[#1344](https://github.com/gitbrent/PptxGenJS/issues/1344)）→ 服务端必须自备光栅化（resvg/sharp）再手写 XML |
| SVG 内文字 | 半原生 | 保留 SVG（字体随 SVG 走） | SVG 内 `<text>` 用系统字体，跨平台同样会 fallback | 关键标题不要放 SVG 文字；或 `text→path` |
| `column-count` 多栏 | 原生 | `a:bodyPr@numCol` + `@spcCol` | `spcCol=gapPx*9525` | §21.1.2.1.1：溢出后自动流入下一栏；【实测】LO 正确渲染 2 栏（列距=spcCol）；PptxGenJS 无 API → 后处理 |
| `<table>` | 半原生 | `p:graphicFrame>a:graphicData(uri=.../table)>a:tbl` | `a:tblGrid>a:gridCol@w`；`a:tr@h`；`a:tcPr>lnL/lnR/lnT/lnB`、fill、`marL/marR/marT/marB`；合并 `gridSpan`/`rowSpan`/`hMerge`/`vMerge` | 单元格行高是"最小值"，文本多会自动长高（PPT/LO 都是）→ 行高必须按内容测量后写死；嵌套表格/单元格内多块布局 → 图片；`border-collapse` 等价于只画内部边框（用相邻单元格的单侧 ln 去重） |
| `<ul>/<ol>` | 半原生 | `a:pPr` 的 `a:buChar@char` / `a:buAutoNum@type` + `marL`/`indent` + `lvl` | `marL = 文本左缩进`，`indent = -marker 宽度`（悬挂缩进）；`buAutoNum type="arabicPeriod"` 等 | 浏览器 marker 由 `::marker` 绘制，位置算法与 PPT 不同 → 建议**自定义 marker 时手动画 shape + 文本**；`list-style:none` 要写 `a:buNone` |
| `<ol start=…>` / 多级列表 | 半原生 | `a:buAutoNum@startAt`、`lvl="0..8"` | 层级缩进 0.25 in 递增（继承主题） | 跨段连续编号要用 `buAutoNum`（PPT 自动编号在编辑时会重排，与 CSS 计数器可能不一致） |
| `font-weight/bold` | 原生 | `a:rPr@b="1"` | — | 无对应字重时 PowerPoint 合成加粗（视觉不同） |
| `font-style:italic` | 原生 | `a:rPr@i="1"` | — | 无斜体时合成斜体 |
| `text-decoration` | 原生 | `a:rPr@u`/`@strike` | `u="sng|dbl|wavy…"` | 下划线颜色用 `a:uFill`（PptxGenJS 支持） |
| `text-shadow` | 原生 | `a:rPr>a:effectLst>a:outerShdw` | 同 box-shadow | 文本阴影的多层同样受限 |
| `-webkit-text-stroke` | 原生 | `a:rPr>a:ln@w` + `a:solidFill`（文字描边） | `w=px*9525` | 【实测】PptxGenJS `outline:{color,size}` 已实现 |
| 文字渐变（`background-clip:text`） | 图片 | — | — | 只能栅格化该行/该块 |
| `writing-mode:vertical-*` | 原生 | `a:bodyPr@vert="eaVert|vert|vert270"` | — | 竖排的标点位置规则不同，需实测 |
| emoji | 图片 | — | — | Apple Color Emoji / Segoe UI Emoji / Noto Color Emoji 三平台不同 → 关键 emoji 转 PNG |
| 图标字体（Font Awesome 等） | 图片 或 字体嵌入 | `a:rPr` 用私有区码点 + 嵌入字体 | 见 §4 | 不嵌字体 = 方块；建议图标一律 SVG/PNG |
| CSS 变量 / `calc()` / 继承 | 原生 | 无对应——在测量阶段全部展开为计算值 | `getComputedStyle` 拿最终值 | 不要试图把 CSS 语义带进 PPTX |
| 伪元素 `::before/::after` 装饰 | 半原生 | 拆成独立 `p:sp` | 位置由 `getBoundingClientRect` 取 | 伪元素文本（如计数器）要并入正文或转 shape |
| CSS 动画 / `transition` / `@keyframes` | 无 | — | — | 第一期不做；PPT 动画需另写 `p:timing`（建议直接忽略，静态取首帧） |
| `overflow:hidden` 圆角裁切 | 图片 | — | — | 子元素被裁切的部分要"烘焙"进图片 |

**能复用的一小组 OOXML 骨架（自研生成器直接用）**

```xml
<!-- 形状：位置/几何/填充/线/效果 -->
<p:sp><p:nvSpPr><p:cNvPr id="2" name="box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
 <p:spPr>
  <a:xfrm rot="0"><a:off x="457200" y="365760"/><a:ext cx="3840480" cy="914400"/></a:xfrm>
  <a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 8000"/></a:avLst></a:prstGeom>
  <a:solidFill><a:srgbClr val="4472C4"><a:alpha val="70000"/></a:srgbClr></a:solidFill>
  <a:ln w="19050" cap="flat" cmpd="sng"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="dash"/></a:ln>
  <a:effectLst><a:outerShdw blurRad="38100" dist="25400" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst>
 </p:spPr>
 <p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" spcFirstLastPara="0"><a:noAutofit/></a:bodyPr>
  <a:lstStyle/>
  <a:p><a:pPr algn="l"><a:lnSpc><a:spcPts val="1800"/></a:lnSpc><a:buNone/></a:pPr>
    <a:r><a:rPr lang="zh-CN" altLang="en-US" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>
      <a:latin typeface="Noto Sans SC" pitchFamily="34" charset="0"/><a:ea typeface="Noto Sans SC" pitchFamily="34" charset="-122"/><a:cs typeface="Noto Sans SC" pitchFamily="34" charset="-120"/>
    </a:rPr><a:t>第一行</a:t></a:r>
    <a:br><a:rPr lang="zh-CN" altLang="en-US" sz="1800" dirty="0"/></a:br>
    <a:r><a:rPr lang="zh-CN" altLang="en-US" sz="1800" dirty="0">…</a:rPr><a:t>第二行</a:t></a:r>
    <a:endParaRPr lang="zh-CN" altLang="en-US" sz="1800" dirty="0"/>
  </a:p></p:txBody></p:sp>
```

---

## 4. 字体嵌入（fntdata）：结构、许可、库支持度

### 4.1 OOXML 结构（PowerPoint 读这个）

**规范依据**
- §19.2.1.10 `embeddedFontLst`：*"specifies a list of fonts that are embedded within the corresponding presentation. The font data for these fonts is stored alongside the other document parts within the document container. The actual font data is referenced within the embeddedFont element."*
- 结构顺序（datypic [p:embeddedFont](https://www.datypic.com/sc/ooxml/e-p_embeddedFont-1.html)）：`p:embeddedFont > p:font[1] + p:regular? + p:bold? + p:italic? + p:boldItalic?`，每个样式子元素只带 `r:id`。

**最小可用包（实现清单）**

```
ppt/presentation.xml
  <p:presentation … embedTrueTypeFonts="1" saveSubsetFonts="1">
    …
    <p:embeddedFontLst>
      <p:embeddedFont>
        <p:font typeface="Noto Sans SC" panose="020B0604020202020204" pitchFamily="34" charset="-122"/>
        <p:regular r:id="rId21"/>
        <p:bold    r:id="rId22"/>
      </p:embeddedFont>
    </p:embeddedFontLst>
  </p:presentation>

ppt/_rels/presentation.xml.rels
  <Relationship Id="rId21"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
    Target="fonts/font1.fntdata"/>

ppt/fonts/font1.fntdata        ← 字体数据（EOT 容器，见 4.2）
[Content_Types].xml
  <Default Extension="fntdata" ContentType="application/x-fontdata"/>
```

要点：
- `embedTrueTypeFonts` / `saveSubsetFonts` 是 **presentation 级开关**；`saveSubsetFonts="1"` 表示只嵌"用到的字符"子集（PowerPoint 会按每个样式文件各自子集化）。子集化的代价：用户编辑时新增字符无法用嵌入字体渲染（会 fallback）。
- 一个 typeface 可以有 regular/bold/italic/boldItalic 四个独立字体 part；缺某个样式时 PowerPoint 会用 regular 合成（synthetic bold/italic），视觉会变（genoffice 的 `staleEmbeddedTypefaces` 逻辑也基于这一点）。
- 部件命名无强制规范，惯例 `ppt/fonts/fontN.fntdata`；Content_Types 用 **Default（按扩展名）**，不是 Override。

### 4.2 fntdata 到底是什么格式（关键风险点）

| 证据 | 结论 |
|---|---|
| [MS-OI29500 §2.1.32](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/ea097c57-5794-4624-b08e-017b47051b1d)：*"The standard states that application/x-fontdata specifies that the font shall be stored as a bitmapped font… PowerPoint stores TrueType and OpenType fonts in parts of this type."* | PowerPoint 在 fntdata 里存 TrueType/OpenType 数据 |
| [genoffice `embedded-fonts.ts`](https://github.com/genspark-ai/genoffice/blob/main/packages/pptx-engine/src/embedded-fonts.ts) 头注释：*"fntdata parts are EOT containers"*；其 `eotToSfnt()` 解析 EOT 头（`eotSize/fontDataSize/flags`，`flags&0x10000000` = 载荷逐字节 XOR 0x50，`flags&0x4` = MicroType Express 压缩），并注明 *"Some producers (LibreOffice) store the bare sfnt without an EOT wrapper"* | 实测生态里两种都存在：**EOT 容器**（PowerPoint/LO 都能读）与**裸 sfnt**（LO 读得懂，PowerPoint 未验证） |
| PptxGenJS [PR #1302](https://github.com/gitbrent/PptxGenJS/pull/1302)（`addFonts`，未合并）讨论：只接受 PowerPoint 另存出来的 `.fntdata`，**直接塞 TTF/OTF 会导致 PPT 打不开** | 生产实现不能"把 TTF 改名为 .fntdata" |
| [SUSE OOXML 报告](http://osb-alliance.de/fileadmin/Working_Groups/OfficeInteroperability/Project1/suse-ooxml-tender-use-case-5.2-report.pdf)：pptx 里的嵌入字体是 EOT 格式 | 与上一致（单一来源，但方向一致） |

**EOT 格式参考**：W3C 提交的 [Embedded OpenType (EOT)](https://www.w3.org/Submission/EOT/)。实现路径：
1. 取授权允许的 TTF/OTF + 子集化（pyftsubset/fontTools）；
2. 包 EOT 头（`EOTSize/FontDataSize/Flags` 等，可选 XOR/MTX）—— **本机无现成 JS/Python 库，需要自研**；
3. 写入 `ppt/fonts/*.fntdata` + rels + Content_Types + `embeddedFontLst`。

> **【未验证】** 本机无 PowerPoint/Keynote，无法验证"自研 EOT 包 + 嵌入"在真 PowerPoint 里是否被接受；LibreOffice 26.8 实测能读带 `fntdata` 的包（不报错），但 LO 本身**保存 pptx 时不写嵌入字体**（[LibreOffice Bug 106771](https://bugs.documentfoundation.org/show_bug.cgi?id=106771)、[META 108226](https://bugs.documentfoundation.org/show_bug.cgi?id=108226)）。因此字体嵌入应作为 **P1 实验项**，不要阻塞 P0。

### 4.3 许可边界（fsType）

OpenType `OS/2.fsType` 的位含义（[Microsoft OpenType 规范 OS/2 #fsType](https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype)）与 PowerPoint 的 UI 口径（[Microsoft 支持：某些字体无法保存](https://support.microsoft.com/en-us/topic/2ba26947-5d18-4eb3-b5a9-67a58629e1b8)）：

| fsType | PowerPoint "Font embeddability" | 可否嵌入 |
|---|---|---|
| 0 | Installable | 可嵌入、可编辑 |
| 2 | Restricted License | **不可嵌入** |
| 4 | Preview/Print | 可嵌入，但缺字体的机器只能查看/打印，**不能编辑** |
| 8 | Editable | 可嵌入、可编辑 |

**本机实测（fontTools 读 OS/2）**：

| 字体 | fsType | 结论 |
|---|---|---|
| Noto Sans CJK（本机 `~/Library/Fonts/NotoSansCJK-Regular.ttc`） | **0** | Installable，可嵌入（OFL/Apache 系） |
| Hiragino Sans GB（macOS 系统） | **8** | Editable，可嵌入 |
| Heiti SC / Heiti TC（macOS 系统） | **0** | Installable（但 Apple 系统字体授权另有约束，实际商用需自查 EULA） |
| PingFang（苹方） | **未读取到**（本机未暴露文件） | 业界普遍认为不可嵌入（`fsType=2`）；**单一来源，未验证** |
| Microsoft YaHei（微软雅黑） | 未测（Windows 字体） | 公开资料普遍标注 Restricted；**未验证** |

**工程建议**
- 建立 **白名单**：优先 `Noto Sans SC/TC`、`Source Han Sans/Serif`（OFL，fsType=0）、`Inter`/`Roboto`（OFL/Apache）；命中 fsType∈{0,8} 才允许进嵌入流水线；
- `fsType=4`（Preview/Print）**不要用于编辑器产品**（用户打开即不可编辑，与产品目标冲突）；
- 字体嵌入前先做权限检测：`fontTools.ttLib.TTFont(path)['OS/2'].fsType`；
- 跨平台现实：PowerPoint for Mac 的嵌入支持存在版本差异（支持页写明 "The ability to embed fonts is only available to Microsoft 365 subscribers and in PowerPoint 2019 for Mac"，而 Microsoft Q&A 里又有"Mac 版不能使用 PC 嵌入的字体"的说法）——**两个来源冲突，标注不确定**；Keynote 导入 pptx 是否使用 fntdata **未验证**。

### 4.4 各库支持度（决定实现路线）

| 方案 | 支持嵌入 | 证据 |
|---|---|---|
| PptxGenJS 4.0.1 | ❌ 完全没有（源码 grep `fntdata/embeddedFont/embedFont/addFonts` 0 命中） | 源码审计；[#176](https://github.com/gitbrent/PptxGenJS/issues/176)、[#1378](https://github.com/gitbrent/PptxGenJS/issues/1378)、PR [#1302](https://github.com/gitbrent/PptxGenJS/pull/1302) open 且被项目列 non-target |
| python-pptx 1.0.2 | ❌ 无 API（只能自己拼 XML/part） | 官方 API 无相关方法 |
| LibreOffice | ❌ 保存 pptx 不嵌字体 | Bug 106771 / META 108226 |
| 社区扩展 `pptx-embed-fonts`（PptxGenJS）+ `pptxgenjs-plus` fork | ⚠️ 存在但未审计（成熟度/许可未知） | [#1378](https://github.com/gitbrent/PptxGenJS/issues/1378) 评论 |
| 自研后处理 | ✅ 可行（JSZip 注入 part + XML） | 本文 §4.1/4.2 清单 |

**推荐的字体策略（按优先级）**
1. **P0**：字体收敛 —— 设计侧限制在"目标平台高概率存在或可嵌入"的字体内；转换时检测目标字体是否命中白名单，未命中则**在 PPTX 里加一个可见的告警徽标**（或在导出报告里标红）。
2. **P0**：硬断行 + 行宽冗余 2–3%，让字体替换的最坏情况仍不折行（不影响 PPT 中的观感）。
3. **P1**：自研 fntdata(EOT) 打包 + 真 PowerPoint 验收；先只对 1–2 个标题字体做，跑通再全量。
4. **兜底**：极端重要的视觉块（封面大字、渐变标题）允许"图片 + 隐藏可编辑文本副本"。

---

## 5. 回渲验收：LibreOffice vs PowerPoint，以及"结构差"指标设计

### 5.1 LibreOffice 回渲的已知系统性差异（先建白名单，再谈 bug）

以下均为【实测】（LibreOffice 26.8.0.3 / macOS）或可复现的社区报告：

| # | 差异 | 量化/证据 | 判定 | 处置 |
|---|---|---|---|---|
| 1 | **忽略 `wrap="none"`**，按框宽硬折行 | 1.5in 框内单行文本被折成 4 行【实测】；[ppt-master#199](https://github.com/hugohe3/ppt-master/issues/199) 同现象 | LO 伪差异（PPT 正确） | 白名单；PPTX 侧仍按"框宽 ≥ 渲染宽 + 冗余"加固 |
| 2 | **`spcPct` 基准 = 1.2×字号**（与字体无关） | 24pt：`spcPct 100%`→28.8pt/行，`200%`→57.6pt；12pt→14.4pt【实测】 | 系统性（PPT 用字体行高，二者不同） | 白名单；转换器统一用 `spcPts` 后该差异消失 |
| 3 | **CJK↔Latin 边界自动加 ≈0.24em/处** | `中文ABC` 32px：Chrome 124.91px vs LO 132.50px（+7.59px=0.237em）【实测】；[ppt-master#293](https://github.com/hugohe3/ppt-master/issues/293) 报 ≈0.24em/处 | LO 伪差异 | 白名单；行宽预留 0.25em×边界数 |
| 4 | **`letter-spacing` 只加 n−1 次** | 10 字符 Arial + 10pt 字距：Chrome 336.03px vs LO 322.60px（差 1×13.33px）【实测】 | 系统性（CSS 末尾也加） | 白名单；测量时按 n−1 校正 |
| 5 | **渲染时自行重算 autofit** | 2in×0.45in 框 + 32pt + `<a:normAutofit/>`：LO 缩到 ≈11–12pt【实测】；显式 `fontScale=60000` 也生效 | LO 行为与 PPT 可能不同（PPT 的时机是编辑/重排） | 转换器统一 `noAutofit` 后差异消失 |
| 6 | **字体解析/替换不同** | `Hiragino Sans GB`（.ttc）在 LO 里被换成 `NotoSansCJKhk`（`pdffonts` 实测），同串渲染宽 462.8px vs Chrome 528.3px（≈−12%）【实测】 | 环境差异 | 字体收敛/嵌入；测量与回渲用同一字体清单 |
| 7 | 全角标点宽度与悬挂行为 | [ppt-master#293](https://github.com/hugohe3/ppt-master/issues/293)：`—`/`“”` 等按 1.0–1.08em 渲染，估算模型按 0.55em 会低估 | 双方都可能"对" | 硬断行后仅影响 LO 的框宽判定 → 白名单 |
| 8 | 表格默认样式、阴影模糊核、渐变插值、emoji 字体（Noto Color Emoji vs Apple/Segoe） | 视觉差异，本机目视确认（梯度/阴影/圆角均能渲染）【实测】 | 系统性 | 像素差只做趋势，不做门禁 |

**结论**：LibreOffice 适合做"**包完整性 + 结构一致性 + 明显崩坏**"的守门员，**不适合**做"与 PowerPoint 逐像素一致"的裁判；也不适合被当作"像素真值"去反向修正 PPTX。

### 5.2 结构差指标（推荐的四层验收）

**L0 — 包/XML 合法性（每份产物必跑）**
- zip 可解、必需 part 齐全（`[Content_Types].xml`、`_rels/.rels`、`ppt/presentation.xml`、`ppt/slides/slideN.xml`、每 slide 的 rels）；
- 所有 XML well-formed（`lxml`/`xml.etree`）；
- 每个 part 都能在 Content_Types 里找到（Default 或 Override）；每个 `r:id` 都能在 rels 里解析；
- `cNvPr/@id` 在 slide 内唯一（PptxGenJS 表格有重复 id 的实测问题）；
- 用 [Open XML SDK 的 validator](https://learn.microsoft.com/en-us/office/open-xml/how-to-validate-a-word-processing-document)（.NET）或 `python-pptx` 重开所有 slide 作为 smoke test（重开失败 = 必挂）。
- 断言阈值：0 容忍。

**L1 — 内在结构断言（不依赖渲染，直接从生成的 XML 判定）**
- 每个 shape 的 `a:off/a:ext` 在幻灯片范围内（或显式标记为"出血"）；
- 文本块：`estHeight = Σ(行距) + spcBef/Aft`，要求 `estHeight ≤ ext.cy - tIns - bIns + ε`（ε=1px）；超出即"溢出风险"；
- `sz ≥ minFontSize`（产品可读性门槛，建议 10pt）；
- 每个文本块行数 == 浏览器测量视觉行数（硬断行方案的直接不变量）；
- 段落 `pPr` 子元素顺序合法（`lnSpc→spcBef→spcAft`）；
- 所有 `sz/spc/spcPts/alpha/rot` 为整数。
- 断言阈值：溢出 0；行数差 0；字号差 0。

**L2 — 回渲结构差（LO PDF vs 浏览器 DOM，核心指标）**
流程：
```
soffice --headless --convert-to pdf deck.pptx --outdir /tmp/qa      # 回渲
pdftotext -bbox-layout deck.pdf deck.xhtml                          # 行/词 bbox（pt，原点左上）
mutool draw -o page-%d.png -r 110 deck.pdf                          # 需要像素时（趋势用）
```
坐标：`px = pt × 4/3`（96/72）；`pdftotext -bbox` 输出已是左上原点（与 CSS 一致），无需翻转。
期望框：从 **pptx 自身**（python-pptx 读 shape xfrm）或从浏览器 DOM 的 `getBoundingClientRect` 取（推荐后者，因为那才是"要复现的目标"）。

| 指标 | 定义 | 建议阈值 |
|---|---|---|
| 行数一致 | 每个文本块的渲染行数 vs 测量视觉行数 | **必须相等**（硬断行方案下不等 = 折行 bug） |
| 行起点 X 偏差 | 每行 `xMin` vs 浏览器 `rect.left` | ≤ 2px（CJK 边界多的行放宽到 3px） |
| 行顶 Y 偏差 | 每行 `yMin` vs 浏览器 `rect.top` | ≤ 2.5px（首行 ≤ 3px） |
| 行推进偏差 | 相邻行 Δy vs CSS 行高 | ≤ 1px |
| 溢出 | 文本 bbox 超出所属 shape 的 xfrm 矩形 | **0**（允许 1px 反锯齿余量） |
| 重叠 | 任意两个"非父子"文本块 bbox 相交且 `IoU>0` / 交面积 > 4px² | 0（设计上允许的重叠进白名单） |
| 对齐 | 同一设计分组内（左/中/右对齐）的边线极差 | ≤ 2px |
| 字号 | 渲染字高（`yMax-yMin`）比值 | 0.98–1.02（LO 有小字渲染差异时放宽到 0.97–1.03） |
| 文本覆盖 | 设计文本 vs PDF 抽取文本（去空白后的字符集合） | **100%**，缺字 = 硬失败 |
| 顺序 | 阅读顺序（按 y 分行、x 排序）vs DOM 顺序 | 允许块级重排，行内必须一致 |

报告 JSON 建议：
```json
{ "slide": 3,
  "blocks": [{ "id": "title", "expected": {"x":96,"y":72,"w":800,"h":120},
               "rendered": {"lines":2,"firstLineTop":75.2,"maxRight":877.1},
               "metrics": {"lineCountDiff":0,"startXErr":1.2,"topErr":1.8,"overflowPx":0,"fontRatio":1.01},
               "status": "pass" }],
  "whitelistHits": ["lo-cjk-latin-gap:1.9px","lo-nminus1-letterspacing:2.7px"],
  "verdict": "pass" }
```

**L3 — 像素差（只做趋势/回归，不做门禁）**
- 用 `SSIM` 或 `pixelmatch` 做**同引擎前后版本对比**（同一浏览器/同一 LO 版本），而不是"LO vs PPT"；
- 阈值只在回归场景有意义（如 SSIM ≥ 0.98）；跨引擎比较会因为 §5.1 的系统性差异永远失败。

### 5.3 验收流水线（建议命令化）

```bash
# 1) 生成
node build/deck.js --html deck/slide-01.html --out out/deck.pptx
# 2) 包/结构（L0/L1）
python qa/l0_package.py out/deck.pptx
python qa/l1_structure.py out/deck.pptx --layout out/layout.json   # 浏览器测量结果
# 3) 回渲（L2）
soffice --headless --convert-to pdf out/deck.pptx --outdir out/
pdftotext -bbox-layout out/deck.pdf out/deck.xhtml
python qa/l2_structural_diff.py --pptx out/deck.pptx --xhtml out/deck.xhtml --layout out/layout.json
# 4) 趋势（L3，本地回归）
mutool draw -o out/page-%d.png -r 110 out/deck.pdf
```

---

## 6. 映射能力矩阵（Lead 可直接引用）

**图例**：✅ 原生（OOXML 直接表达）｜🟡 半原生（近似/需后处理/需自研 XML）｜🖼 只能图片（栅格化）｜❌ 无
**PptxGenJS 列**：4.0.1 是否有开箱 API。

| # | HTML/CSS 特性 | 结论 | OOXML | PptxGenJS | 备注（一句话） |
|---|---|---|---|---|---|
| 1 | 纯色背景/填充 | ✅ | `a:solidFill>a:srgbClr(+a:alpha)` | ✅ `fill{color,transparency}` | alpha=透明度反向 |
| 2 | 线性/径向渐变 | 🟡 | `a:gradFill>a:gsLst/a:lin|a:path` | ❌（PR 全 open） | 需 JSZip 后处理注入 |
| 3 | 背景图/`background-size` | ✅ | `a:blipFill`+`a:srcRect`+`a:stretch` | ✅ `sizing{cover/crop}` | 图片资源要进 media+rels |
| 4 | 边框（同值） | ✅ | `a:ln@w`+`a:solidFill`+`a:prstDash` | ✅ `line{color,width,dashType}` | 1px=9525 EMU |
| 5 | 单边/不同边框 | 🟡 | 拆 shape 或 `a:custGeom` | 🟡（拆 shape 自行实现） | 圆角+单边 → custGeom/图片 |
| 6 | 圆角（统一） | ✅ | `prstGeom roundRect`+`adj` | ✅ `rectRadius`（单位英寸） | `adj=r/min(cx,cy)*100000` |
| 7 | 圆角（各角不同） | 🟡/🖼 | `a:custGeom` | ✅ `custGeom`+points | 内容复杂时栅格化 |
| 8 | 单层外阴影 | ✅ | `a:effectLst>a:outerShdw` | ✅ `shadow{type:'outer'}` | blur/offset 单位 pt |
| 9 | 内阴影 | 🟡 | `a:innerShdw` | ❌（bug #1293） | 手写 XML，勿用库 |
| 10 | 多层阴影 | 🖼 | — | ❌ | 取一层或栅格化 |
| 11 | `opacity`（单色） | ✅ | 颜色内 `a:alpha` | ✅ `transparency` | — |
| 12 | `opacity`（容器/组） | 🖼 | — | ❌ | 重叠处语义不同 |
| 13 | `filter:blur` | 🟡 | `a:effectLst>a:blur@rad` | ❌ | 需标定；复杂滤镜栅格化 |
| 14 | 其他 filter/混合模式 | 🖼 | — | ❌ | 浏览器里烘焙 |
| 15 | `clip-path`（inset/圆角） | 🟡 | `prstGeom` 几何换算 | ✅ 形状 | 内容含子元素 → 图片 |
| 16 | `clip-path`（polygon/path） | 🟡/🖼 | `a:custGeom` | ✅ `custGeom` | 任意曲线 + 内容 → 图片 |
| 17 | `transform:rotate` | 🟡 | `a:xfrm@rot`（绕中心） | ✅ `rotate` | 非中心原点要换算 off |
| 18 | `transform:translate/scale` | 🟡 | `a:off`/`a:ext`（+字号） | ✅（位置/尺寸） | 非均匀缩放文本 → 图片 |
| 19 | `skew`/3D/matrix | 🖼 | — | ❌ | 栅格化 |
| 20 | `z-index` | ✅ | `p:spTree` 顺序 | ✅（添加顺序） | 后添加在上 |
| 21 | `object-fit` | ✅ | `a:srcRect` | ✅ `sizing` | cover/contain/crop |
| 22 | `<img>`（PNG/JPEG/GIF） | ✅ | `p:pic>a:blipFill` | ✅ `addImage` | GIF 仅首帧；WebP/AVIF 先转 |
| 23 | SVG | 🟡 | `p:pic`+`svgBlip`+PNG 兜底 | ⚠️ Node 兜底是破图 | 服务端自备光栅化 |
| 24 | `<table>` | 🟡 | `a:tbl`（gridSpan/rowSpan/tcPr ln*） | ✅ `addTable`（无 cell autofit） | 行高按内容测量写死 |
| 25 | `<ul>/<ol>` | 🟡 | `a:buChar`/`a:buAutoNum`+`marL/indent/lvl` | ✅ `bullet` | 自定义 marker 建议手画 |
| 26 | 多栏文本 | ✅ | `bodyPr@numCol/@spcCol` | ❌ | 后处理注入；LO 支持【实测】 |
| 27 | 文本框内边距/锚点 | ✅ | `lIns/tIns/rIns/bIns`+`anchor` | ✅ `margin/valign` | 必须显式归零+top |
| 28 | 行距 | ✅（用 spcPts） | `a:lnSpc>a:spcPts` | ✅ `lineSpacing`(pt) | 禁用 spcPct 路线 |
| 29 | 字距 | ✅ | `a:rPr@spc`+`kern="0"` | ✅ `charSpacing`(pt) | 注意 n−1 语义 |
| 30 | 段前/段后 | ✅ | `a:spcBef/a:spcAft>spcPts` | ✅ `paraSpaceBefore/After` | 无折叠，需自行算 |
| 31 | 粗体/斜体/下划线/删除线 | ✅ | `b/i/u/strike` | ✅ | 无字重时合成 |
| 32 | 文字描边/发光/阴影 | ✅ | `rPr>a:ln`/`a:glow`/`a:effectLst` | ✅ `outline/glow/shadow` | 文本渐变除外 |
| 33 | 文字渐变 | 🖼 | — | ❌ | 栅格化 |
| 34 | CJK 中西文分字体 | 🟡 | `a:latin`≠`a:ea` | ❌（三处同值） | 需后处理/自研 |
| 35 | 字体嵌入 | 🟡 | `p:embeddedFontLst`+`fntdata`(EOT) | ❌ | P1 自研，未闭环验证 |
| 36 | emoji / 图标字体 | 🖼 | — | ❌ | 转 PNG，避免平台差异 |
| 37 | 动画/过渡 | ❌ | `p:timing`（另做） | ❌ | 第一期忽略 |
| 38 | 竖排 | ✅ | `bodyPr@vert` | ✅ `vert` | 标点规则需实测 |

---

## 7. 不确定 / 未验证（写代码时按"防御性"处理）

1. **PowerPoint 真机行为全部未闭环**：本机无 PowerPoint/Keynote，所有"PPT 会怎样"的结论来自规范 + 库源码 + 社区实证（已尽量给多来源）。建议 Lead 安排一次 Windows/PPT 冒烟测试（重点：硬断行 + `noAutofit` + 圆角/阴影 + 表格行高 + fntdata）。
2. **fntdata/EOT 自研打包**：格式链路由二手证据支撑（genoffice 源码、PR #1302、SUSE 报告），未在真 PowerPoint 验证；EOT 的 XOR/MTX 细节需自行实现/找库。
3. **PowerPoint for Mac 与字体嵌入**：官方支持页与 Q&A 口径冲突（能否嵌、能否用 PC 嵌入的字体）。
4. **Keynote 导入 pptx** 对 fntdata、`wrap`、`spcPts`、`numCol` 的支持程度未验证。
5. **`a:spcPct` 在 PowerPoint 里的精确基准**（字体自然行高 vs 规范"最大字号"）：pom#260 是库作者实测（单一来源，但方向与 python-pptx 文档一致）。
6. **字体替换表**：PowerPoint 的 font substitution 规则（无字体时选谁）没有公开完整规范，跨机器 fallback 不可控——这是"必须嵌入或收敛字体"的根本原因。
7. **`fit:'shrink'` 无 `fontScale` 时 PowerPoint 打开是否立即缩排**：社区存在两种说法（PptxGenJS 注释说不会自动，python-pptx #969 说需触发渲染）；LO 会立即缩（实测）。→ 直接 `noAutofit` 规避。
8. **LO 的 CJK↔Latin 0.24em** 只在 macOS + 26.8 + Noto Sans CJK 上量到；Windows/Linux 版 LO、其他字体的系数未验证。
9. **旋转后 bbox / 多形状重叠阈值的具体数值**：本文给的是建议阈值，需在真实 deck 上标定（建议先用 20 页样本回归）。

---

## 8. 来源清单（按支撑内容分组）

**规范 / 官方**
- ISO/IEC 29500-1:2012（=ECMA-376 Part 1）原文 PDF（本机核对 §20.1.10.73 ST_TextPoint、§21.1.2.2.5 lnSpc、§21.1.2.2.11/12 spcPct/spcPts、§21.1.2.2.7 pPr 的 eaLnBrk/hangingPunct、§21.1.2.1.3 normAutofit、§21.1.2.1.1 bodyPr numCol/compatLnSpc、§19.2.1.10 embeddedFontLst）：<https://raw.githubusercontent.com/python-openxml/python-docx/master/ref/ISO-IEC-29500-1.pdf>
- Microsoft Learn（Open XML SDK，转引 ISO 29500 原文）：[SpacingPercent a:spcPct](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.spacingpercent?view=openxml-3.0.1)、[TextCharacterPropertiesType（a:rPr 子元素顺序/属性表）](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.textcharacterpropertiestype?view=openxml-3.0.1)
- datypic OOXML schema 参考：[a:bodyPr](https://www.datypic.com/sc/ooxml/e-a_bodyPr-1.html)、[a:CT_TextParagraphProperties](https://www.datypic.com/sc/ooxml/t-a_CT_TextParagraphProperties.html)、[p:embeddedFont](https://www.datypic.com/sc/ooxml/e-p_embeddedFont-1.html)
- [MS-OI29500 §2.1.32 Font Part](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/ea097c57-5794-4624-b08e-017b47051b1d)、[MS-OE376 §15.2.12](https://learn.microsoft.com/en-ie/openspecs/office_standards/ms-oe376/1663dabc-5d98-463f-889e-bcd9b77c3d34)
- [MS-ODRAWXML §5.24 SVG Schema（svgBlip）](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/cc083f6d-bc38-4ff4-b32a-5bc97df8addc)、[CT_SVGBlip](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/68e0150d-6a01-4ba5-ac4d-5a18d685229b)
- [Microsoft 支持：某些字体无法保存（fsType/嵌入限制）](https://support.microsoft.com/en-us/topic/2ba26947-5d18-4eb3-b5a9-67a58629e1b8)、[OpenType OS/2 fsType](https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype)、[W3C EOT 提交](https://www.w3.org/Submission/EOT/)
- [CSS2.1 §10.8.1 line-height](https://www.w3.org/TR/CSS22/visudet.html#leading)、[MDN Range.getClientRects](https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects)

**源码（本机可复现）**
- PptxGenJS 4.0.1：`/opt/homebrew/lib/node_modules/pptxgenjs/dist/pptxgen.cjs.js`（rPr 5963、charSpacing 5946、lnSpc 5834/5837、段距 5844-5849、autofit 6062-6072、SVG 4954-4968、shadow bug 5508、图片 srcRect 5056-5088、alphaModFix 5547）、`types/index.d.ts`
- python-pptx 1.0.2：`pptx/text/text.py:351-369`（Font.name 只写 a:latin）、`pptx/oxml/text.py`（lnSpc/spcPts/spcPct、normAutofit）
- [genoffice `embedded-fonts.ts`（fntdata=EOT 容器、eotToSfnt、embeddedFontLst 解析）](https://github.com/genspark-ai/genoffice/blob/main/packages/pptx-engine/src/embedded-fonts.ts)

**Issue / 实测报告**
- [PptxGenJS #174（ea 字体与 charset）](https://github.com/gitbrent/PptxGenJS/issues/174)、[#916](https://github.com/gitbrent/PptxGenJS/issues/916)、[#1288（主题 ea 不可设）](https://github.com/gitbrent/PptxGenJS/issues/1288)、[#176（字体嵌入）](https://github.com/gitbrent/PptxGenJS/issues/176)、[PR #1302](https://github.com/gitbrent/PptxGenJS/pull/1302)、[#1378](https://github.com/gitbrent/PptxGenJS/issues/1378)、[#1146（margin 顺序）](https://github.com/gitbrent/PptxGenJS/issues/1146)、[#1293（inner shadow 坏 XML）](https://github.com/gitbrent/PptxGenJS/issues/1293)、[#401](https://github.com/gitbrent/PptxGenJS/issues/401)/[#963](https://github.com/gitbrent/PptxGenJS/issues/963)/[#1344（Node SVG）](https://github.com/gitbrent/PptxGenJS/issues/1344)、[#102（gradient）](https://github.com/gitbrent/PptxGenJS/issues/102)、[#368（\n 变多段落）](https://github.com/gitbrent/PptxGenJS/issues/368)
- [python-pptx #969（autofit 需触发渲染才写 fontScale）](https://github.com/scanny/python-pptx/issues/969)
- [pom #260（PowerPoint lineSpacingMultiple 基准 = 字体 ascent+descent+lineGap）](https://github.com/hirokisakabe/pom/issues/260)
- [ppt-master #199（LO 忽略 wrap="none"、字距/衬线宽度低估）](https://github.com/hugohe3/ppt-master/issues/199)、[#293（全角标点宽度、LO CJK↔拉丁 ≈0.24em/处）](https://github.com/hugohe3/ppt-master/issues/293)
- [LibreOffice Bug 106771（保存 PPT 不嵌字体）](https://bugs.documentfoundation.org/show_bug.cgi?id=106771)、[META 108226（PPTX 问题总表）](https://bugs.documentfoundation.org/show_bug.cgi?id=108226)
- [SUSE OOXML 互操作报告（pptx 嵌入字体为 EOT）](http://osb-alliance.de/fileadmin/Working_Groups/OfficeInteroperability/Project1/suse-ooxml-tender-use-case-5.2-report.pdf)

**本机实测证据（`/tmp/scout-exp/`）**
- `t1.py`/`t1.pptx`：python-pptx 基础单位与 `spcPct 140000`、`spcBef 600`、`spcAft 1200` 的 XML 输出
- `spc.py`/`spc.pdf`：`spcPct 100%/200%` = 1.2em×倍数、`spcPts` 精确（LibreOffice 26.8）
- `pspc.pptx`：`spcAft 12pt + spcBef 6pt` = 相加（42pt），非 CSS 折叠
- `gen.js`/`gen.pptx`：PptxGenJS 的 rPr 三字体、charSpacing、lineSpacing*、roundRect adj、outerShdw、表格 XML
- `ctrl.pptx`/`ctrl.pdf` + `measure.html`：同串在 Chrome 与 LO 的宽度差（字体替换 ≈12%）
- `spc2.pptx` + `mspc2.html`：letter-spacing n−1 vs n；CJK↔拉丁 LO 额外 0.237em
- `feat.pptx`/`feat.pdf`/`feat.png`：normAutofit 被 LO 自动缩排、`wrap="none"` 被折行、numCol 生效、gradFill/blur/outerShdw/roundRect 渲染
