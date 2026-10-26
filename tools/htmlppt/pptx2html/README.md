# pptx2html · 原生 PPTX → 可编辑 HTML（反向技能）

> 用途：把**你已有的原生 PPTX**（国赛稿、模板、底座）转成 HTML，
> 在 HTML 里换背景、换图、换文案、改布局，再走正向管线转回可编辑 PPTX —— 形成闭环。
> 每个 PPT 对象在 HTML 里都有 `data-pptx-id`，可以被程序或 AI 精确定位替换。

---

## 1. 一条命令

```bash
PY="/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python"

# ① PPTX → HTML（含素材抽取、逐对象映射表）
"$PY" pptx2html/pptx2html.py deck.pptx -o out/deck-html

# ② 保真度验收（HTML 截图 vs PPTX 回渲，逐页 MAE）
"$PY" pptx2html/verify.py --pptx deck.pptx --html out/deck-html/deck.html --out out/deck-html/verify

# ③ 闭环：HTML → 可编辑 PPTX（复用正向管线）
cd prototype
HTMLPPT_DECK="../out/deck-html/deck.html" HTMLPPT_OUT="../out/deck-html/roundtrip" node src/run.mjs
```

产物：

```
out/deck-html/
├── deck.html        # 多页 HTML（每页 section.slide，1280×720，绝对定位）
├── assets/          # 抽取/裁剪/降采样后的图片
├── map.json         # 逐对象映射：id / 类型 / 坐标 / 源 / lossy 清单
└── verify/          # compare.png + verify.json（逐页 MAE）
```

---

## 2. 实测：18 页真实国赛级稿（长理科创港推介）

| 阶段 | 结果 |
|---|---|
| 转换 | **18 页 / 931 个对象**（449 自动形状、387 图片、402 文本框、8 组、3 表格） |
| 无法映射（lossy） | **0**（本稿无图表/SmartArt；复杂预设形状以矩形近似） |
| HTML 保真（vs PPTX 回渲） | 平均 **MAE 15.78**（修前 26.19）；**12/18 页 ≤ 15**；最好 6.4（目录）/ 10.4 / 10.8；最差 26.5（p10 Venn 图） |
| 闭环 HTML→PPTX | 18 页 / **509 个原生形状 + 415 图片 + 3 原生表格 / 448 个文本 run**，**字符覆盖率 100%**，zip 全 DEFLATE |
| 闭环唯一未过闸门 | `no_full_page_picture` —— 原稿把整页背景做成图片，转回来仍是整页图片（**语义上正确**，但触发我们的红线） |

> 保真最好的页面是"文字+形状+表格"型（目录 6.4、表格页 10.4）；最差的是"大图叠加 + 渐变蒙版"型
> （p17 137.7：PPT 里用整页位图 + 透明渐变蒙版，HTML 侧蒙版未完全等价）。

### 2.1 原生模板底座也能转（国金版式底座-v1，5 页）

| 指标 | 值 |
|---|---|
| 对象 | 260 个；lossy 28（拓扑图里的预设形状以矩形近似） |
| 保真 | 平均 MAE **27.79**；封面 19.6 / 四卡 19.1 / 结尾 16.5；拓扑图页 66.7（连线与虚线框还原差） |

### 2.2 "替换"实测（重要教训）

对转换出的 HTML 做了一次"换文案 + 换背景"再转回 PPTX，结果暴露两件事：

1. **文案替换不能用字符串 replace**：PPT 里同一句话常被拆成多个 run（`蓝海` / `核卫士` 是两个 `<span>`），
   字符串替换会漏。正确做法是**按 `data-pptx-id` 定位元素、改整个 textFrame 的段落**（或提供槽位 API）。
2. **背景替换要找"最上层背景层"**：原稿的背景往往是一张整页图片（`p:pic`）+ 蒙版，
   改 `section` 的 `background` 会被图片盖住。正确做法是替换那张 `data-pptx-id` 的图片，
   或在其上叠一层半透明色块（HTML 里就是加一个 div）。

> 这两条正是"反向技能"的产品化重点：**输出必须是可寻址的结构（id + 角色 + 槽位），不是一堆 div。**

---

### 2.3 在浏览器里看，不要在文件预览器里看（很关键）

`deck.html` 依赖 `<style>` 的绝对定位与 `assets/` 图片。**如果被当成"文件"在预览器/聊天窗口里打开，
CSS 与相对资源会被剥离**，就会看到一堆竖排文字 + 破图 —— 那是降级渲染，不是转换结果。
两种正确打开方式：

1. `open -a "Google Chrome" out/ref3/deck.html`（带 assets 目录）；
2. 用**单文件内嵌版**（图片全部内联为 data URI，双击即可看）：
   `python pptx2html.py deck.pptx -o out/ref-single`（默认 `embed=True`；`--no-embed` 关闭）。

### 2.4 本轮修掉的 5 类映射 bug

| # | 问题 | 影响页 | 修法 |
|---|---|---|---|
| 1 | 组合（group）子坐标未按 `ext/chExt` 缩放（本稿缩放 635 倍） | 组合内文字框宽塌成 0.28px → 每行一字竖排 | 累积变换 `off + (C − chOff) × scale`，字体/内边距不缩放 |
| 2 | 渐变里 `schemeClr` 起始色与 alpha 被丢弃 | p3 照片被不透明色块盖住 | 解析 schemeClr + 任意 alpha（含 0） |
| 3 | 自由曲线/自选图形用 CSS 渐变字符串当 SVG `fill` | p17 三张渐变卡变黑块 | 生成 `<linearGradient>` defs + `fill="url(#…)"` |
| 4 | 曲线路径未按 `path/@w,h` 空间缩放 | 曲线被拉伸成巨块 | SVG `viewBox=0 0 pathW pathH` + `preserveAspectRatio="none"` |
| 5 | 整页图片被当普通 `<img>` | 闭环后触发「整页截图」红线 | 面积 ≥90% 且贴边的图片识别为背景层 → `section` 的 `background-image` |

> 遗留：p10（Venn 图图标层级）、p17（暗底渐变卡）仍有差异；属于"图层/透明度顺序"问题，已记入交接清单。

---

## 2.5 图片分类与替换（v2 核心）

提取时每张图会被自动分成 **4 类 + 1 个提示**：

| 角色 | 判定规则（可调） | HTML 落点 | 能不能换 |
|---|---|---|---|
| **background** | 面积 ≥90% 且贴边（满页底图） | 背景组件 `.pptx-bg` 的 `background-image`，`data-pptx-bg-id="slide-N-bg"` | ✅ 整页背景一起换 |
| **content** | 其余：面积 ≥3%、非透明图标、非宽条带 | `<img data-pptx-role="content" data-pptx-slot="img-N-K">` | ✅ 换内容图 |
| **decoration** | 面积 <3% / 透明背景 >30% / 宽高比≥4:1 的矮条带（logo、页眉页脚、图标） | `<img data-pptx-role="decoration">` | ❌ 保留原样（不算内容槽） |
| **covered** | 被 z 序更靠后的不透明形状完全盖住 | **不输出**（记入 `map.json.skipped`） | —（本来也看不见） |
| **text-image** | 大块 + 不透明 + 浅底≥45% + OCR ≥3 行且 ≥20 字 | 槽位 + OCR 文本 + 建议"重建为文本" | 建议人工转文本 |

> 这份 18 页稿的实测分类：**background 13 / content 50 / decoration 317 / covered 7 / text-image 0**。
> 判定阈值集中在 `pptx2html.py` 的 `_picture_role()` 与 `classify_slide()`，想改"哪些算装饰"只改一处。

### 背景组件长什么样

```html
<section class="slide" data-slide="6" data-pptx-bg-id="slide-6-bg">
  <!-- 背景组件：满页底图 + 大面积无字装饰，整页可替换 -->
  <div class="pptx-bg" data-pptx-role="background" data-pptx-bg-id="slide-6-bg">
    <div class="bg-image" data-pptx-role="background-image"
         style="background-image:url('assets/img6900.png');background-size:100% 100%"></div>
  </div>
  <!-- 内容层 -->
  <img data-pptx-role="content" data-pptx-slot="img-6-1" src="assets/img6001.png">
</section>
```

### 换图 / 换背景命令

```bash
# 1) 看有哪些可替换槽位
python3 cli/htmlppt.py slots pptx2html/out/final

# 2) 换某张内容图（原图自动备份到 assets/_originals/）
python3 cli/htmlppt.py replace pptx2html/out/final --slot img-6-1 --image new.png

# 3) 换整页背景组件
python3 cli/htmlppt.py replace pptx2html/out/final --background-slide 6 --image new-bg.png

# 4) 改完重新生成可编辑 PPTX
python3 cli/htmlppt.py build pptx2html/out/final/deck.html -o pptx2html/out/final/rebuild
```

> 默认输出是**链接式**（`deck.html` + `assets/`），因为换图必须替换文件；
> 要单文件分发加 `--single-file`（图片内联成 data URI，此时换图需重新 extract）。

---

### 2.6 平台能力：原字节拆包（不是重渲染）

PPTX 就是 zip：`ppt/slides/slideN.xml` + `ppt/media/*`。提取器现在：

1. **图片 = 原字节复制**：按 `r:embed` 找到 `ppt/media/imageN.png`，直接写原始字节（不重编码），按 partname 去重；
2. **SVG 图**：Office 2016+ 的 `<asvg:svgBlip>` 扩展优先取 SVG（PNG 回退常是 2×2 像素的灰块）；
3. **主题色修饰符**：`lumMod/lumOff/shade/tint` 在 HSL 空间还原（P17 渐变卡从蓝变回近白）；
4. **连接线**：按 `a:ln@w` 画 SVG 线，而不是把包围盒高度当 border 宽度；
5. 崩溃/未支持元素记录到 `map.json.lossy`，不静默。

> 详细的现象→根因→修法→MAE 变化见 [`POLISH-LOG.md`](POLISH-LOG.md)。

---

## 3. 映射规则（PPT 原语 → HTML）

| PPT 对象 | HTML 落点 | 说明 |
|---|---|---|
| 幻灯片背景（纯色/渐变） | `section[data-pptx-bg]` + `background` | 渐变取 `a:gradFill` 的 stops 与角度 |
| 矩形 / 圆角矩形 / 椭圆 | `<div>` + `background/border/border-radius` | 圆角从 `a:gd adj` 反算 |
| 自由曲线 `a:custGeom` | 内联 `<svg><path d="...">` | M/L/C/Q/Z 全支持 |
| 直线 / 连接线 | `<div>` 或 1px 边框 | 含旋转 |
| 图片（含裁剪） | `<img>` + Pillow 预裁 + 降采样到 2× 展示尺寸 | 大图自动缩放，避免几百 MB |
| 表格 | `<table>`（`colgroup` 列宽 + 单元格底色/边框） | 边框读 `a:lnL/R/T/B` |
| 文本框 / 带文字的形状 | `<div>` + `<p>` + `<span>` 富文本 | 段距、行距、字距、对齐、锚点、项目符号 |
| 组合 | 展平，递归换算 `off/ext/chOff/chExt` | 子元素绝对坐标 |
| 图表 / SmartArt | **跳过并写入 `map.json.lossy`** | v1 不伪造 |

**可替换性（回答"能不能直接换"）**：
- 背景：改 `section` 的 `data-pptx-bg` / `background` 即可，不影响内容；
- 图片：`<img data-pptx-id="31">` 直接换 `src`；
- 文本：`<span>` 内改文案，字体字号由外层样式统一控制；
- 形状：`<div data-pptx-id="45">` 改 `background` / `border-radius`；
- 全部对象都能在 `map.json` 里按 id 查到原始 PPT 的坐标与类型。

---

## 4. 已知限制（v1，按实测）

1. **字体**：原稿用微软雅黑/方正粗黑宋等商业字体，macOS 无此字体 → HTML 侧回退 PingFang，回渲也回退；这是 MAE 的主要来源之一（真机上装字体会明显改善）。
2. **渐变蒙版**：`a:gradFill` 的透明度叠加、多段蒙版、径向渐变只做了线性近似。
3. **文本自动缩放**：`normAutofit` 的字号缩放未反算，长文本可能溢出（需按 `fontScale` 折算）。
4. **项目符号**：只做字符前缀，没有还原悬挂缩进。
5. **组合旋转 / 3D / 艺术字 / 图表 / SmartArt**：跳过或近似，写进 `lossy`。
6. **图片效果**：阴影、柔化边缘、艺术效果未转。

---

## 5. 它在"技能矩阵"里的位置

```
┌─ 提取技能 ────────────────────────────────────────────┐
│ pptx2html   原生 PPTX → HTML（本目录）                  │
│              → 把存量稿/模板变成可编辑 HTML 组件库        │
└───────────────────────────────────────────────────────┘
┌─ 生成技能 ────────────────────────────────────────────┐
│ html2pptx   受约束 HTML → 可编辑 PPTX（prototype/）       │
│              → 固定画布、硬断行、原生形状/表格/渐变         │
└───────────────────────────────────────────────────────┘
┌─ 质检技能 ────────────────────────────────────────────┐
│ bench       跨引擎基准 + 统一评测（bench/）               │
│ verify      单次转换的保真验收（本目录 verify.py）         │
└───────────────────────────────────────────────────────┘
```

**闭环价值**：存量 PPTX（原生、可编辑）→ HTML（AI 好改）→ PPTX（可编辑）。
中间那层 HTML 还能当"组件库"用：把 24 个版式底座批量转成 HTML，就得到与国赛模板一一对应的组件。
