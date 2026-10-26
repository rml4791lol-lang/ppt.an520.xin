# HTML → 可编辑 PPTX 原型（可运行 · 有数字 · 不吹）

把固定 **1280×720** 的 HTML 幻灯片，量测后映射成**原生可编辑** `.pptx`，再用 LibreOffice
回渲成 PNG 与 HTML 截图逐页比对，所有指标落盘可复跑。

> **验收代理声明（重要）**：回渲与像素指标来自 **LibreOffice 26.8**，它只是**验收代理**，
> 不是 PowerPoint 等价物。文中所有像素差都是 "HTML vs LibreOffice 回渲" 的差异，
> 不是 "HTML vs PowerPoint" 的保证。PowerPoint 未在本环境安装，未做真人打开验证；
> 我们用 ①LibreOffice 转 PDF 成功 ②python-pptx 独立解析成功 ③zip/Content-Types 结构断言
> 三条证据代替。字体、基线等细节在下面「已知限制」里逐条量化。

---

## 1. 实测结果（`npm run build`，2026-10-19）

| 验收门槛 | 目标 | 实测 | 结果 |
|---|---|---|---|
| 一条命令跑完 | `npm run build` | 9 步全绿，**9.6s**（含字体对照实验） | ✅ |
| deck.pptx 能打开 | 可解析 | LibreOffice 转 PDF 成功 + python-pptx 解析 5 页/1263 字符 + zip 校验通过 | ✅ |
| 文本字符覆盖率 | ≥90% | **100.0%**（HTML 非空白 1126 字符 → a:t 非空白 1126 字符，含表格单元格） | ✅ |
| 每页无整页截图 | 0 张 | **0 张整页大图**；3 张图片面积占比 0.3% / 26.1% / 0.25% | ✅ |
| 像素差比例 | 给出数字 | **diff>16 = 4.06%**，diff>48 = 2.97%，全页 MAE = **4.25** | ✅（见 §5） |
| 结构差 | 给出数字 | 可编辑性按页统计 + 按对象类型归因 + 文本基线偏移诊断 | ✅（见 §5/§6） |
| Office 打开护栏 | zip 全 DEFLATE | **39/39 条目 DEFLATE (100%)，0 STORE**，无悬空 Override | ✅ |

产物：

```
prototype/out/
├── deck.pptx                 # 交付物：5 页，168 KiB，100% DEFLATE
├── deck.raw.pptx             # PptxGenJS 原始输出（后处理前，对照用）
├── html/slide-1..5.png       # Chrome 截图（1280×720）
├── pptx/slide-1..5.png       # LibreOffice 回渲（1280×720）
├── diff/slide-1..5.png       # 放大的差异图
├── diff/contact-sheet.png    # 每页 HTML | PPTX | diff 三栏拼版
├── metrics.json              # 汇总指标 + gates + 已知限制（README 数字的来源）
├── editability.json          # 每页 a:t/p:pic/p:sp/a:tbl/整页图检测/覆盖率
├── pixel.json                # 像素差 + 按对象类型归因 + 文本纵向偏移直方图
├── zip_stats.json            # 每个 zip 条目的压缩方法统计
├── pptx_validate.json        # python-pptx 独立解析结果
├── render.json / render_fonts.txt   # 回渲引擎、PDF 字体清单
├── font_matrix.json          # 字体可用性对照实验（§4）
└── measure.json              # 量测模型（rect/style/视觉行 box）
```

`out/metrics.json` 里 `gates` 共 12 项，当前全部 `true`，`verdict: "PASS"`。

---

## 2. 一条命令怎么跑

```bash
cd prototype
npm install                     # pptxgenjs / playwright / jszip
npm run build        # 9 步：量测→生成→后处理→自检→回渲→解析→像素差→字验→汇总
```

前置（本机已具备）：

- Node 26（`node -v`），本机 Chrome `/Applications/Google Chrome.app`（Playwright 用 `channel:'chrome'`，不下载浏览器）
- LibreOffice：`/opt/homebrew/bin/soffice`
- poppler：`pdftoppm`、`pdftotext`、`pdffonts`
- Python venv（Pillow/numpy/python-pptx）：`/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python`
  可用 `PYTHON=/path/to/python npm run build` 覆盖

可选命令：

```bash
npm run measure      # 只跑量测
npm run convert      # 量测 -> deck.raw.pptx
npm run postprocess  # gradFill/custGeom 注入 + DEFLATE 重打包
npm run inspect      # 可编辑性 / zip / Content-Types / sldSz 断言
npm run render       # LibreOffice -> PDF -> PNG
npm run diff         # 像素差 + contact sheet
npm run fontprobe    # 字体可用性对照实验（§4）
npm run assets       # 重新生成 samples/assets/*.png
```

`TEXT_Y_OFFSET=<px>` 可整体平移所有文本框（默认 0，未做代理校准，见 §7）。
`SVG_MODE=png` 可强制图标走 4x PNG 降级路径。
`--no-hard-lines` 可切到重排模式（见 §3.2）。

---

## 3. 实现要点

### 3.1 单位与映射

| HTML (CSS px) | PPTX | 规则 |
|---|---|---|
| x / y / w / h | inch | `px ÷ 96`，EMU 由 PptxGenJS 取整（误差 <0.1px） |
| font-size | pt | `px × 0.75` |
| line-height | pt（`a:lnSpc`/`a:spcPts` 精确值） | `px × 0.75` |
| letter-spacing | pt（`spc`） | `px × 0.75` |
| border-width | pt（`a:ln w`） | `px × 0.75`（1px = 0.75pt） |
| border-radius | `roundRect` 的 `adj` | `r / min(w,h) × 100000`，上限 0.5 |
| 阴影 | `a:outerShdw` | blur/dist pt、色值+alpha |
| 文本内边距 | `margin: 0`，`fit:'none'` | 关闭 autofit，显式行距 |

文本容器 = 自身含文本节点、且其子元素全是 inline 的元素；块级子元素各自成对象。
每个文本对象写一个原生文本框（`<p:sp txBox="1">`），**不转图**。

### 3.2 硬断行模式（默认 `--hard-lines`）

- 用 `Range.getClientRects()` 逐字符取行盒，按 top 差 > `lineHeight×0.35` 判定视觉行；
  每个视觉行拆成**独立段落** `<a:p>`（PptxGenJS 侧对应 `breakLine:true`；注意生成的是新段落，**不是** `<a:br/>` 元素），并记录每行的 `x/y/w/h` 到 `measure.json`。
- 文本框写 `wrap="none"`：**不会二次换行**，视觉与 HTML 完全一致；代价是 PowerPoint 里改字后
  不会自动重排（取舍已写明）。`--no-hard-lines` 则把视觉行合并回自然段，允许 PowerPoint 重排。
- 实测：HTML 视觉行 **48 行** = PPTX 段落 **48 段**（35 个文本对象），无一行丢失。
  这正是 slide 1 正文断行在首轮被 Lead 抓到的 bug：早期只按 `<br>` 分段，普通折行被合并成 1 行；
  现在 `convert.mjs` 在硬断行模式下每个视觉行都单独成段。

### 3.3 对象映射

| HTML | PPTX 原生对象 | 说明 |
|---|---|---|
| 文本 | `<p:sp txBox="1">` + `a:t` | margin 0 / fit none / 精确行距 / 硬断行；颜色、粗体、字距来自 computed style |
| 纯色块、圆角卡片、细线、半透明层 | `addShape(rect / roundRect)` | `border-radius→adj`，`rgba→a:alpha`，`box-shadow→outerShdw` |
| `<img>` | `addImage` | 按实测 rect 精确放置（3 张） |
| 内联 SVG 图标 | **custGeom 后处理** | 直线 + **全部曲线命令**（C/S/Q/T/A）→ `a:cubicBezTo`；仅 transform/use/clipPath/mask/marker/嵌套 svg/url(#) 渐变/text 降级 PNG |
| `<table>` | `addTable`（`a:tbl`） | 5 行 × 4 列；列宽/行高/单元格底色/边框来自实测 |
| CSS 渐变 | **`a:gradFill` 后处理** | 2 个；linear/radial + 多 stop + stop alpha |
| 半透明文字 | 与实测背景混色为不透明 | PptxGenJS 文本色无 alpha 通道（见限制） |

### 3.4 两个后处理（PptxGenJS 无原生 API）

1. **渐变**：先写一个唯一占位色（`directives.json` 记录），解包后按占位色定位 `<p:sp>`，
   把 `<a:solidFill>` 替换为 `<a:gradFill>`（`gsLst` + `a:lin ang`；CSS 135° → DrawingML 45°）。
2. **custGeom**：量测阶段从 SVG 提取 viewBox 与直线命令（M/L/H/V/Z、polyline/polygon/rect/line），
   后处理把 `<a:prstGeom prst="rect">` 换成 `<a:custGeom>`（path 坐标 ×1000，描边宽度按
   `strokeWidth × rectW / viewBoxW` 反算，`cap="rnd"` + `<a:round/>`）。
3. **DEFLATE 重打包**：用 JSZip 先解压全部条目再重建（JSZip 会保留载入条目的原压缩方式，
   直接 `generateAsync` 会把 PptxGenJS 的 STORE 条目原样留下），最后 `compression:'DEFLATE', level:6`。
4. **清理悬空 Override**：PptxGenJS 会声明 `slideMaster2..N` 的 Content-Type 却只写 `slideMaster1`
   （每页复用同一 master）。后处理按 zip 实际 part 列表裁剪，`editability.json` 断言裁剪后为 0。

---

## 4. 字体结论（Lead 复核问题 #1，已做实）

**现象**：首轮回渲里 "HTML / PPTX" 变成衬线体，中文也不对。
**根因不是 typeface 名写错**：soffice headless 只加载它**自带 fontconfig**（`/Applications/LibreOffice.app/...`），
看不到 macOS 系统字体，于是拉丁回退到自带 `LinuxLibertineG`、CJK 回退到 `NotoSansCJKhk`
（`out/render_fonts.txt` 首轮记录可复现）。pptx 里写的就是合法系统字体名 `PingFang SC`。

**修法**：`render.mjs` 给 soffice 传 `FONTCONFIG_FILE=/opt/homebrew/etc/fonts/fonts.conf`（有候选路径回退）。
修复后 PDF 内嵌字体变为 `PingFangSC-Regular / PingFangSC-Semibold`（见 `render.json.embeddedFonts`），
中文/西文两侧同字，肉眼与像素都明显收敛。

**对照实验**（`npm run fontprobe`，同一串混排文本 30px，Chrome 墨迹宽 vs 回渲墨迹宽）：

| 字体 | HTML 墨迹 px | 回渲墨迹 px | Δ px | Δ % |
|---|---|---|---|---|
| PingFang SC | 557 | 580 | +20 | +3.6% |
| Hiragino Sans GB | 581 | 604 | +20 | +3.4% |
| Heiti SC | 530 | 552 | +19 | +3.6% |
| Noto Sans SC | 528 | 552 | +20 | +3.7% |
| Arial | 538 | 560 | +19 | +3.6% |
| Helvetica Neue | 543 | 565 | +19 | +3.5% |
| Songti SC | 517 | 540 | +22 | +4.3% |
| **control：纯拉丁** | 316 | 317 | **−3** | **−0.9%** |
| **control：纯 CJK** | 178 | 178 | **−2** | **−1.1%** |

结论：**字体可用性已解决（纯拉丁/纯 CJK 误差 <1.2%，且 PDF 内嵌的正是请求的字体）**；
混排残余 +3.4~4.3% 与字体无关，来自 **LibreOffice 在 CJK↔拉丁边界自动加的 ~0.25em 间距**
（样本 3 个边界 × 7.5px ≈ 22.5px，实测 19~22px）。这一条是 LibreOffice 的排版差异，
不该当作 PowerPoint 结论——所以回渲指标里文本区域差异最大（见 §5 归因），README 不掩饰。

---

## 5. 像素差与结构差（真实数字）

逐页（1280×720，阈值指单像素 R/G/B 最大通道差）：

| 页面 | MAE | diff>16 | diff>48 | 文本纵向偏移中位数 |
|---|---|---|---|---|
| slide 1 | 5.35 | 4.26% | 3.35% | 2 px |
| slide 2 | 5.85 | 5.35% | 4.29% | 3 px |
| slide 3 | 3.71 | 4.16% | 2.94% | 2.5 px |
| slide 4 | 2.83 | 3.67% | 2.24% | 2 px |
| slide 5 | 3.53 | 2.88% | 2.05% | 3 px |
| **全页** | **4.25** | **4.06%** | **2.97%** | **3 px** |

按实测对象区域归因（区域内 diff>16 占比）：

| 对象类型 | 覆盖面积 px | 变化像素占比 |
|---|---|---|
| 文本 | 795,584 | **20.3%**（主要来自上述 CJK/拉丁间距 + 基线偏移） |
| 表格 | 301,653 | 6.1% |
| 形状 | 5,704,860 | 4.3%（大都是 1px 描边/阴影/渐变带） |
| SVG 图标 | 4,352 | 7.6%（20~28px 小图标，1px 抗锯齿即可占高比例） |
| 图片 | 249,840 | 1.7% |

文本基线诊断（`pixel.json.textVerticalOffsetPx`）：35 个文本对象，中位数 **+3px**（正 = PPTX 偏下），
分布 1px×2、2px×12、3px×13、4px×5、5px×1、6px×2。即：**文本框顶部 = CSS content-box 顶部**时，
LibreOffice 的首行基线比 Chrome 低 1~6px（随 line-height 变化）。我们**没有偷偷补偿**：
默认偏移为 0，诊断数字原样输出；需要时可 `TEXT_Y_OFFSET=-3` 重新构建。
（补偿会把"代理的基线模型"写进交付物，反而可能偏离 PowerPoint，故不做默认。）

---

## 6. 可编辑性与 Office 护栏（Lead 复核问题 #2/#3）

`out/editability.json` 每页断言：

| 页 | a:t run | 字符(pptx/html) | 覆盖率 | p:sp | p:pic | a:tbl | custGeom | gradFill | 整页图 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 7 | 157 / 157 | 100% | 10 | 1 | 0 | 1 | 1 | 否 |
| 2 | 12 | 251 / 251 | 100% | 17 | 0 | 0 | 3 | 0 | 否 |
| 3 | 16 | 268 / 268 | 100% | 21 | 0 | 0 | 3 | 0 | 否 |
| 4 | 24 | 255 / 255 | 100% | 6 | 0 | 1 | 0 | 0 | 否 |
| 5 | 9 | 195 / 195 | 100% | 12 | 2 | 0 | 1 | 1 | 否 |

- 覆盖率算法：`a:t` 内非空白字符 / 量测到的 HTML 文本+表格单元格非空白字符。逐页 100%。
- 整页大图检测：解析每个 `<p:pic>` 的 `a:ext` 面积 / `12192000×6858000`，阈值 0.9；最大 0.261（slide 5 照片），0 张命中。
- `sldSz` 断言：**12192000 × 6858000 EMU**（= 1280×720 @96dpi），通过。
- zip 压缩：39 个 part **全部 DEFLATE (100%)**，0 个 STORE；未压缩总 286,497B → 成品 172,370B。
- Content-Types：11 个 Default + 20 个 Override，**悬空 Override 0 个，无类型 part 0 个**。
- python-pptx 独立解析：`5 slides / 1263 chars / slide size 12192000×6858000`（`out/pptx_validate.json`）。

---

## 7. 已知限制（按实测写明，不假装）

1. **LibreOffice ≠ PowerPoint**：回渲的文本排版（基线、CJK/拉丁混排间距）与 PowerPoint 不保证一致。
   上表像素差是"代理差"，不是"PowerPoint 差"。
2. **CJK/拉丁混排间距**：LibreOffice 在每处 CJK↔拉丁边界加 ~0.25em，混排行回渲宽 3.4~4.3%；
   PowerPoint 无此行为（本项目未装 PowerPoint，无法实测）。
3. **文本基线**：文本盒顶 = CSS content-box 顶；代理回渲首行低 1~6px（中位 3px），未做默认补偿。
4. **硬断行权衡**：`wrap="none"` + 每视觉行一段，视觉最准、但 PowerPoint 内改字不重排。
5. **custGeom 范围**：支持 `M/L/H/V/C/S/Q/T/A`（含相对、隐式重复、rect 圆角），曲线转原生 `<a:cubicBezTo>`
   （精度 ≤0.1px，见 `src/svgpaths.README.md`）。仍走 PNG 的只有：`transform`/`<use>`/`clipPath`/`mask`/
   `marker`/嵌套 svg/`url(#…)` 渐变/`<text>`。
6. **渐变**：只翻译 linear/radial；conic/repeating 回退首色；元素 opacity 合入填充透明度，
   父级 opacity 叠乘未实现。
7. **半透明文字**：PptxGenJS 文本色无 alpha → 用测量到的背景色混成不透明色（slide 1/5 的白色半透明文本）。
8. **表格**：支持单元格文本/底色/边框/列宽/行高；合并单元格（colspan>1）、嵌套表格未覆盖。
9. **图片**：按 rect 拉伸；CSS `border-radius` 裁切、filter、blend-mode 未实现。
10. **阴影**：只取单一 outer shadow；多重/inset shadow 忽略。
11. 文本 `transform`/旋转、竖排、writing-mode、链接未覆盖（样本未用）。
12. **字体嵌入已可用**：`EMBED_FONTS=1 npm run build` 会调 `tools/font-embed.mjs` 做 subset + EOT 注入
    （Noto/思源等 fsType 允许的字体；PingFang 会被许可检查拒绝，可 `EMBED_FONT_MAP="PingFang SC=Noto Sans SC"` 映射）。
    未在真 PowerPoint 验证，见 `tools/font-embed.README.md`。

---

## 7.1 本轮新增能力

- **SVG 曲线 → 原生 DrawingML 曲线**：`src/svgpaths.mjs`，精度 ≤0.1px；`samples/curves.html` 实测 45 个 `<a:cubicBezTo>`、0 张 PNG。
- **字体嵌入**：`EMBED_FONTS=1 npm run build` → `tools/font-embed.mjs` 做 subset + EOT 注入（`ppt/fonts/*.fntdata` + `p:embeddedFontLst` + rels + Content_Types），PingFang 等不可嵌入字体会被许可检查拒绝（可 `EMBED_FONT_MAP` 映射到 Noto）。
- **门禁**：新增 `noScreenshotOnlySlide`（只有一张整页图且几乎无文本才算截图交付）；闭环模式 `ALLOW_BG_IMAGE=1` 允许背景照片层。

---

## 8. 目录

```
prototype/
├── package.json
├── README.md
├── samples/
│   ├── deck.html                 # 5 页样本：大标题/多行正文/圆角卡片/1px 细线/图片/SVG 图标/表格/渐变/半透明层
│   └── assets/                   # photo-sky.png / logo-mark.png / pixel-probe.png（脚本生成，无外部素材）
└── src/
    ├── run.mjs                   # npm run build 编排（8 步 fail-fast）
    ├── measure.mjs               # Playwright + Chrome：rect/computed style/视觉行盒/SVG 几何/4x 光栅
    ├── convert.mjs               # 量测模型 → PptxGenJS 原生对象（单位换算/硬断行/表格/渐变占位）
    ├── postprocess.mjs           # gradFill / custGeom 注入 + 悬空 Override 清理 + DEFLATE 重打包
    ├── inspect.mjs               # editability/zip/Content-Types/sldSz 断言
    ├── render.mjs                # soffice（FONTCONFIG_FILE 修正）→ PDF → pdftoppm 1280×720
    ├── diffstat.py               # 像素差/归因/差异图/contact sheet
    ├── validate_pptx.py          # python-pptx 独立解析
    ├── fontprobe.mjs / ink_widths.py  # 字体可用性对照实验
    ├── make_assets.py            # 生成样本图片
    └── report.mjs                # 汇总 out/metrics.json + gates + 打印结论
```

## 9. 复跑与核对

```bash
cd prototype && npm run build
cat out/metrics.json | head -40     # 所有数字的来源
open out/diff/contact-sheet.png     # 每页 HTML | PPTX | diff 三栏
open out/deck.pptx                  # 交付物
```

`metrics.json.gates` 任一为 false，`npm run build` 会以非 0 退出码失败（当前 12/12 通过）。
