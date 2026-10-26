# HTMLPPT 技术方案 v1.0
### HTML → 可编辑 PPTX 的转换管线设计

> 日期：2026-10-19 ｜ 作者：Lead ｜ 依据：`research/01`（工具全景）、`research/02`（映射约束）、`research/03`（编写范式）+ `prototype/` 本机实测
> 配套：`规范-HTMLPPT-HTML契约-v1.0.md`（写 HTML 的人看）、`prototype/README.md`（能跑的代码）

---

## 0. 结论先行

**要做的事只有一件：把 HTML 当成"编译前端"，把 OOXML 当成"目标机器码"，中间加一层可序列化的 IR。**

```
HTML/CSS（受约束子集）
   │  ① 渲染与量测（headless Chrome）
   ▼
IR（JSON：文本行盒 / 形状 / 图片 / 表格 / 降级标记）
   │  ② 映射（确定性，无 AI 参与）
   ▼
PptxGenJS 对象图
   │  ③ 写入 + 后处理（gradFill / custGeom / 字体嵌入 / DEFLATE）
   ▼
deck.pptx
   │  ④ 验收（L0 包合法 / L1 结构断言 / L2 回渲结构差 / L3 像素趋势）
   ▼
报告：可编辑性统计 + 降级清单 + 差异指标
```

**四个不可动摇的设计决策：**

| # | 决策 | 理由 |
|---|---|---|
| 1 | **画布锁 1280×720 px ↔ 13.333×7.5 in ↔ 12192000×6858000 EMU** | 等于 PowerPoint 默认宽屏；px→EMU 整除无舍入；不用 Anthropic 的 720×405pt（那是 PptxGenJS 默认 10in 的副产物） |
| 2 | **只做"受限 HTML 方言"，不做通用 HTML 渲染器** | 所有可编辑导出方案（Anthropic / PPTAgent / Hasasasa / dom-to-pptx / Slidev）都收敛到这条；越早约束越可预测 |
| 3 | **文本走"按视觉行硬断行"**（每视觉行一个独立 `a:p` + `wrap="none"`，行距 `spcPts` 写死，`noAutofit`） | 唯一能把"断行位置"从概率问题变成确定问题的办法；文本仍是真文本 |
| 4 | **降级只做元素级，永不整页截图；降级必须报告** | 整页截图 = L0 可编辑性归零；元素级降级保住文字矢量（Hasasasa 的 deco_snapshot 是正解） |

---

## 1. 目标与非目标

### 1.1 目标（v1.0 承诺）

| 承诺 | 量化验收 |
|---|---|
| 几何精确 | 逐对象 `\|Δx\|,\|Δy\|,\|Δw\|,\|Δh\| ≤ 0.5px`（对量测 IR） |
| 排版精确 | 每个文本块**渲染行数 == 浏览器视觉行数**；行推进误差 ≤1px；行首 x 误差 ≤2px |
| 语义精确（可编辑性 L2） | 每页 `<a:t>` 字符覆盖 HTML 非空白文本 **≥90%**；无整页截图；文字可选中可改；形状可拖动改色；图片可换 |
| 打开即用 | PowerPoint / WPS 打开**无"需要修复"**提示；`sldSz` 正确；zip 全 DEFLATE |

### 1.2 非目标（明确不做，也不做承诺）

- **动画 / 切换效果**：PptxGenJS、python-pptx 均不支持创建（要 Aspose.Slides 等商业授权）
- **SmartArt / WordArt / 公式（OMML）**：同上
- **PowerPoint 母版/版式的完整继承**：v1 只做主题 token → 直接值，不做 `p:sldMaster` 继承（L3 级可编辑性留 v2）
- **PPTX → HTML 反向同步**：无底洞，明确不做
- **逐像素完全一致**：做不到，也不该承诺（字体环境不同 → 度量不同）

---

## 2. 路线选型（为什么是"量测重建"）

| 路线 | 代表 | 可编辑性 | 保真度 | 结论 |
|---|---|---|---|---|
| A 整页截图 | Marp `--pptx`、Slidev `--format pptx`（旧）、`nlj626/html-to-pptx` | **L0** | 高 | ❌ 不可编辑，直接出局 |
| B PDF 中转 | Marp `--pptx-editable`（HTML→PDF→LibreOffice Impress） | L1–L2 不可控 | 中 | ❌ 官方自称 experimental、丢备注、复杂主题失败 |
| C 量测重建 | Anthropic html2pptx、Hasasasa、dom-to-pptx、Slidev `pptx-editable`(2026-09)、**本方案** | **L2** | 中高 | ✅ 唯一可行 |
| D 模板槽位 | PPTAgent 研究框架 | L3 | 中 | ⚠️ 版式自由度 = 模板库大小；作为"企业模板模式"备选 |
| E 原生 OOXML 直出 | Manus PowerPoint 模式（2026-07） | L2–L3 | 高 | ⚠️ 不是转换，是"绕过 HTML"。**战略信号**：头部团队宁可放弃 HTML 自由度也要原生 |

**关键判断**：Manus 在 2026-07 把"网页生成 + 导出时转换"推翻，改成"从第一张起就原生生成 .pptx"，官方承认旧路线"可能导致格式问题"。
→ 这说明**"HTML 只是皮、OOXML 才是骨"**。我们的产品若以"可编辑交付"为卖点，**HTML 必须是受约束的中间表示，而不是自由的创作终点**。

**但我们不选路线 E 的原因**：HTML 的价值在"AI 好写、人好看、浏览器里能预览、生态大"。正确姿势是 **HTML 作为 authoring 层 + OOXML 作为交付层**，中间用严格契约和确定性编译器连接 —— 这正是本方案。

---

## 3. 架构：五层，层间只用 JSON 通信

```
┌─ ① 契约层 Contract ────────────────────────────────────────────┐
│ HTML 契约（规范 v1.0）+ Linter + 组件库（每个组件带导出语义）      │
│ 产出：合规 HTML + 组件元数据（data-slide / data-layout / data-ppt-*）│
└───────────────────────────────────────────────────────────────┘
              │ HTML
┌─ ② 量测层 Measure ─────────────────────────────────────────────┐
│ headless Chrome（Playwright，channel=chrome）                   │
│ · 逐页隔离渲染（固定 1280×720 viewport，deviceScaleFactor=2）     │
│ · DOM 遍历：叶子元素 → rect + computedStyle                     │
│ · 文本：Range.getClientRects() 逐字素聚成视觉行（行盒 + 行推进）    │
│ · 资源：img → dataURI；inline SVG → path 归一化；渐变 → 解析      │
│ 产出：IR.json（可序列化、可 diff、可单页重算）                     │
└───────────────────────────────────────────────────────────────┘
              │ IR.json
┌─ ③ 映射层 Map ────────────────────────────────────────────────┐
│ 纯函数：IR → PptxGenJS 调用序列（确定性，无 AI）                  │
│ · px→EMU/pt 换算（唯一真源 px2emu/px2sz/px2spcPts）              │
│ · 文本 → addText（硬断行 run + spcPts + margin0 + fit:none）      │
│ · 盒子 → addShape（rect/roundRect/ellipse/custGeom）             │
│ · 图片 → addImage（含 object-fit→a:srcRect）                     │
│ · 表格 → addTable；图表占位 → addChart                           │
│ · 不安全样式 → 元素级截图垫底 + 文字矢量叠上（deco_snapshot）       │
│ 产出：deck.raw.pptx + directives.json（后处理指令）               │
└───────────────────────────────────────────────────────────────┘
              │
┌─ ④ 写入层 Write & Post-process ───────────────────────────────┐
│ · PptxGenJS 落盘（compression: true）                           │
│ · 解包后处理：prstGeom→custGeom、注入 a:gradFill、删 <p:style>    │
│   （去主题阴影/描边）、字体 subset+嵌入（fntdata）、DEFLATE 重打包  │
│ 产出：deck.pptx                                                 │
└───────────────────────────────────────────────────────────────┘
              │
┌─ ⑤ 验收层 Verify ─────────────────────────────────────────────┐
│ L0 包合法 → L1 结构断言 → L2 回渲结构差 → L3 像素趋势             │
│ 产出：editability.json / metrics.json / diff/*.png / 降级报告     │
└───────────────────────────────────────────────────────────────┘
```

**为什么强制层间用 JSON**：单页重算、回归测试、人工修正、并行化都靠它。Design-Arena 的两段式 API（extract_measurements → render_pptx）和 html-native-pptx 的 IR 都是这个思路。**没有 IR 的转换器无法做 QA。**

---

## 4. IR 数据模型（建议 schema）

```jsonc
{
  "canvas": { "w": 1280, "h": 720, "emuW": 12192000, "emuH": 6858000 },
  "slides": [{
    "index": 1,
    "layout": "S01",
    "background": { "type": "solid|gradient|image", "value": "#0B1F3A", "gradient": {...} },
    "notes": "演讲者备注文本",
    "objects": [
      { "id": "o1", "kind": "text",
        "box": { "x": 96, "y": 248, "w": 660, "h": 160 },
        "align": "left", "valign": "top", "rotate": 0,
        "lines": [                                   // ← 视觉行，硬断行的输入
          { "text": "HTML 幻灯片", "top": 248, "height": 78, "width": 412 },
          { "text": "变成可编辑 PPTX", "top": 326, "height": 78, "width": 604 }
        ],
        "runs": [                                    // ← 行内富文本（可选，按行切片）
          { "line": 0, "text": "HTML 幻灯片", "fontFace": "Noto Sans SC", "size": 64,
            "bold": true, "color": "#FFFFFF", "spc": 0 }
        ],
        "degrade": null },

      { "id": "o2", "kind": "shape", "shape": "roundRect",
        "box": { "x": 760, "y": 90, "w": 430, "h": 540 },
        "fill": { "type": "solid", "color": "#FFFFFF", "alpha": 6 },
        "line": { "w": 1, "color": "#FFFFFF", "alpha": 16 },
        "radiusPx": 28, "degrade": null },

      { "id": "o3", "kind": "freeform", "paths": [ { "d": "M4 12h14M12 5l7 7-7 7", "stroke": {...} } ],
        "box": {...}, "degrade": null },

      { "id": "o4", "kind": "image", "src": "assets/logo.png",
        "box": {...}, "fit": "cover", "srcRect": { "l": 0, "r": 0, "t": 0, "b": 0 } },

      { "id": "o5", "kind": "table", "rows": [...], "colWidths": [240,120], "box": {...} },

      { "id": "o6", "kind": "deco-snapshot", "png": "cache/deco-3.png",
        "box": {...}, "reason": "backdrop-filter", "childrenRenderedAsVector": true }
    ]
  }]
}
```

**IR 的硬性要求**：所有几何量以 **CSS px（浮点）** 存储；所有颜色以 `#rrggbb`/`rgba()` 存储；所有文本以**视觉行**存储；每个对象带 `degrade` 字段（`null` = 全原生）。

---

## 5. 关键技术决策与做法

### 5.1 单位换算（唯一真源，写成单测）

```ts
const EMU_PER_PX = 9525, EMU_PER_PT = 12700;
const px2emu    = (px) => Math.round(px * EMU_PER_PX);
const px2sz     = (px) => Math.round(px * 75);        // a:sz   = px*0.75*100
const px2spc    = (px) => Math.round(px * 75);        // a:rPr/@spc
const px2spcPts = (px) => Math.round(px * 75);        // a:lnSpc / spcBef / spcAft
const opacity2alpha = (o) => Math.round(o * 100000);
const deg2rot   = (d) => Math.round(d * 60000);
```

⚠️ 两个易错点：
- **PptxGenJS 的 `charSpacing` API 单位是 pt，不是 px** —— 传值前 `×0.75`。
- **`lineSpacing` API 单位是 pt**（生成 `spcPts`）；`lineSpacingMultiple` 生成 `spcPct`，**不要用**（见下）。

### 5.2 文本：为什么必须硬断行 + `spcPts`

| 事实 | 后果 |
|---|---|
| `a:spcPct` 规范说是"文本尺寸百分比"，PowerPoint 实现是"字体自然行高的百分比"，LibreOffice 实测是"字号×1.2 的百分比" | 三者互不相等 → **行距三处不一致**。⇒ 一律用 `spcPts` |
| `normAutofit` 的 `fontScale` 由 PowerPoint 在编辑时动态重算，LibreOffice 渲染时自行重算缩小 | 像素保真失效 ⇒ **一律 `noAutofit`** |
| 浏览器与 PPT 对同一字符串的排版宽度差约 2%（Slidev 用 2%+4px headroom 对冲；Slidev 官方也承认长段落可能换行数不同） | 断行位置不可控 ⇒ **按视觉行硬断行** |
| LibreOffice 会**忽略 `wrap="none"`** 并按框宽硬折 | 回渲出现"伪折行"，不是 bug ⇒ 框宽给冗余 + 白名单 |

**硬断行算法**（浏览器侧）：

1. `TreeWalker` 遍历文本节点，`Intl.Segmenter` 按字素切分；
2. 每个字素 `Range.getClientRects()[0]`，按 `|Δtop| < 0.6px` 聚成视觉行；
3. 记录每行 `{ text, left, right, top, bottom, advance }`，`advance` = 下一行 top − 本行 top；
4. 组装时：**每个视觉行一个独立 `a:p`**（PptxGenJS 用 `breakLine: true` 实现；注意它生成的是新段落而不是 `<a:br/>` 元素），行距用首行 `advance × 0.75` 写入该段 `spcPts`；
5. **框宽冗余**：`wTarget = max(CSS框宽, 最宽行宽 × 1.03 + 0.25em × CJK↔Latin边界数 + 2px)`，并按对齐方式补偿 `x`（center/right 要减半/减全）。

> 本原型实测：35 个文本对象 / 60 个 run / 36 个段落 / 986 字符，`wrap="none"` + `lIns=tIns=rIns=bIns=0` + `anchor="t"` + `spcPts` 全部生效。

### 5.3 字体（决定"换台机器会不会全篇错位"）

| 层 | 做法 |
|---|---|
| 白名单 | Noto Sans SC / Noto Serif SC（OFL，可嵌入）；PingFang SC / Microsoft YaHei 仅在"已知目标机有"时使用 |
| 写入 | 同时写 `a:latin` / `a:ea` / `a:cs`。PptxGenJS 的 `fontFace` 三处同写（v4.0.1 `pptxgen.cjs.js:5963`）；**python-pptx 的 `font.name` 只写 `a:latin`**，CJK 会掉到主题 `+mn-ea`（Windows 中文默认「等线」）→ 必须手工补 |
| 嵌入 | OOXML 支持：`p:embeddedFontLst` + `ppt/fonts/*.fntdata` + rels + `[Content_Types]` 的 `application/x-fontdata`。**但 fntdata 是 EOT 容器**（MS-OI29500 §2.1.32），不是裸 TTF/OTF；PptxGenJS / python-pptx 都不支持 ⇒ **自研或后处理** |
| 授权 | 只嵌 fsType 允许嵌入的字体。本机实测 fsType：Noto CJK = 0（可嵌入）、Heiti = 0、**Hiragino Sans GB = 8（不可嵌入）**；苹方/微软雅黑等商业字体同样**不可嵌入** |
| 回退策略 | 不嵌入时：导出报告里列出"目标机缺字体会导致重排"的字体清单 |

⚠️ **v1.0 的现实选择**：先做"白名单 + 三处写全 + 导出报告"，字体嵌入作为 v1.1 的独立里程碑（它需要 EOT 封装 + subset，风险独立）。

### 5.4 CSS → OOXML 映射表（映射层的实现依据）

| CSS | 落点 | 判定 |
|---|---|---|
| `color` / `background-color` / `rgba()` | `a:solidFill` + `a:alpha` | 原生 |
| `border-{side}` 1px | `a:ln`（`w=px×9525`，`a:prstDash`） | 原生 |
| `border-radius`（统一） | `a:prstGeom prst="roundRect"` + `a:gd adj` | 原生（adj = `r×9525/min(cx,cy)×100000`） |
| `border-radius`（非对称） | `a:custGeom` | 原生（需后处理注入） |
| `linear-gradient`（线性、可解析） | `a:gradFill/a:lin` | **原生（本原型已实现）** |
| `radial-gradient` / `conic` / 多重叠加 | 元素级栅格 | 降级 |
| `box-shadow`（单层外阴影） | `a:effectLst/a:outerShdw` | 原生（模糊核与 PPT 有差异） |
| 多层阴影 / 内阴影 | 元素级栅格 | 降级 |
| `opacity`（元素级） | 各 fill 的 `a:alpha` | 原生 |
| `filter` / `backdrop-filter` / `mix-blend-mode` | 元素级栅格（文字仍矢量叠上） | 降级 |
| `clip-path` | 简单矩形/圆 → `a:prstGeom`；多边形 → `a:custGeom`；复杂 → 栅格 | 混合 |
| `transform: rotate` | `a:xfrm/@rot`（1/60000 度） | 原生 |
| `transform: skew / 非均匀 scale / matrix3d` | 元素级栅格 | 降级 |
| `object-fit: cover` | `a:blipFill` + `a:srcRect` | 原生 |
| `<img>` | `p:pic` | 原生 |
| inline SVG（简单路径） | `a:custGeom` | **原生（本原型 8/8 成功）** |
| 复杂 SVG（滤镜/渐变网格） | 4× PNG | 降级 |
| `<table>` | `a:tbl`（`a:tblGrid` 列宽写死） | 原生（合并单元格有限） |
| `<ul>/<ol>` | `a:buChar` / `a:buAutoNum` | 原生 |
| `<canvas>` / WebGL | 元素级栅格 | 降级 |
| 动画/过渡 | 取终态（导出前 `animation-play-state: paused`） | 丢弃 |

> 完整矩阵与 OOXML 属性细节见 `research/02 §3` 与 `research/02 §6`。

### 5.5 后处理（PptxGenJS 之外必须自己做的四件事）

1. **`prstGeom` → `custGeom`**：SVG 图标/自由路径。`path/@w=ext/@cx`、`path/@h=ext/@cy`，保证缩放系数恒为 1、无舍入。
2. **注入 `a:gradFill`**：PptxGenJS 无渐变 API（issue #102 长期未实现）。做法：先用哨兵色占位，再解包替换。
3. **删除 `<p:style>`**：`add_shape`/`add_connector` 会带 `a:effectRef idx="2"`（主题阴影）与 `lnRef`/`fillRef`。按规范空的 `<a:effectLst/>` 应覆盖它，**PowerPoint 认，LibreOffice 不认**，会渲出投影和多余描边 ⇒ 整个 `<p:style>` 删掉。
4. **重打包必须 DEFLATE + 无悬空 Override**：PptxGenJS 默认 `compression:false` → ZIP 用 STORE，社区有"WPS 能开、PowerPoint 报损坏"的生产事故（dom-to-pptx PR #40）；`[Content_Types].xml` 里指向不存在 part 的 Override 是另一个报损坏根因。

### 5.6 验收（四层，不要只做像素差）

| 层 | 内容 | 阈值 |
|---|---|---|
| **L0 包合法** | zip 可解；必需 part 齐全；XML well-formed；每个 part 在 Content_Types 有登记；每个 `r:id` 可解析；`cNvPr/@id` 页内唯一；python-pptx 能重开 | 0 容忍 |
| **L1 结构断言**（不依赖渲染） | 每个 shape 在页内；`estHeight = Σ行距 + 段距 ≤ ext.cy + 1px`；`sz ≥ 10pt`；**每个文本块行数 == 浏览器视觉行数**；`pPr` 子元素顺序合法；所有度量值为整数 | 溢出 0；行数差 0 |
| **L2 回渲结构差** | `soffice → pdf`，`pdftotext -bbox-layout` 取行盒，与 IR 比：行数 / 行起点 x / 行顶 y / 行推进 / 溢出 / 重叠 / 对齐 / 字号比 / 文本覆盖 | 行数必须相等；x≤2px、y≤2.5px；溢出 0；文本覆盖 100% |
| **L3 像素趋势** | SSIM / pixelmatch，**只做同引擎前后版本回归**（LO vs LO），不做跨引擎门禁 | 回归场景 SSIM ≥0.98 |

**LibreOffice 的 8 条系统性偏差必须先建白名单**（否则会拿"伪差异"当真 bug 修）：
① 忽略 `wrap="none"` 按框宽硬折；② `spcPct` 基准 = 1.2×字号；③ CJK↔Latin 边界自动加 ≈0.24em/处；④ `letter-spacing` 只加 n−1 次；⑤ 渲染时自行重算 autofit；⑥ 字体解析/替换不同（.ttc 尤其）；⑦ 全角标点宽度与悬挂行为不同；⑧ 表格默认样式/阴影模糊核/渐变插值/emoji 字体不同。

> **LibreOffice 是"包完整性 + 结构一致性 + 明显崩坏"的守门员，不是"与 PowerPoint 逐像素一致"的裁判。**
> 发布前必须在**真 PowerPoint**（Win/Mac）跑"打开不报修复"回归。

---

## 6. 与已有资产的关系

| 已有资产（`/Users/an/Desktop/Atlas/PPT/PPT 复刻/`） | 在新管线里的位置 |
|---|---|
| `tools/svg2shapes.py`（SVG→custGeom 原生形状，含 A 指令转贝塞尔、渐变映射、`<p:style>` 删除经验） | **直接复用为"自由路径 → custGeom"模块**；本原型的 SVG 图标路径与此同源 |
| `tools/verify_pptx.py`（解包统计 custGeom/pic/effectLst/形状名） | **扩写成 L0+L1 验收器**（加行数断言、Content_Types 检查、DEFLATE 断言） |
| `tools/retint.py`（主题换色） | v2 的"一键换主题"实现参考（token → `a:srgbClr` 批量替换） |
| `tools/compose_page.py`（SVG 排版层） | 被 HTML 取代；但"页面 chrome 统一处理"的思路保留 |
| `.venv`（python-pptx 1.0.2 / Pillow / lxml / fontTools） | 验收与后处理脚本直接可用；fontTools 是字体 subset 的关键 |
| 交付过的 24 页型 / 728 槽位模板体系 | **HTMLPPT 的组件库起点**：把页型翻译成 HTML 组件 + 导出语义标注 |

> 一句话：**你已经有"SVG → 原生形状"的后半段；HTMLPPT 要补的是"HTML → IR"的前半段和"L2 结构验收"的闭环。**

---

## 7. 里程碑

| 阶段 | 内容 | 验收 | 本原型状态 |
|---|---|---|---|
| **M0** | IR schema + 单位换算单测 + 最小 HTML→pptx | 3 页样本，几何误差 ≤0.5px | ✅ 已完成（5 页） |
| **M1** | 硬断行 + 视觉行量测 + 溢出检测 | 行数与浏览器一致；无溢出 | ✅ 已完成 |
| **M2** | 降级协议（元素级栅格 + 报告）+ custGeom + gradFill | 降级清单可读；SVG/渐变原生 | ✅ 已完成（8/8 SVG、5 处渐变原生） |
| **M3** | L0–L2 验收流水线 + Office 兼容护栏（DEFLATE/Content_Types） | 一条命令出报告 | 🟡 进行中 |
| **M4** | 字体白名单 + subset 嵌入（fntdata/EOT） | 目标机无字体也能对齐 | ⬜ 待做 |
| **M5** | 组件库 + Linter + 编辑器实时标红 | 违规写法写不出来 | ⬜ 待做 |
| **M6** | 真 PowerPoint / WPS 打开回归矩阵 | 无"需要修复"；结构差达标 | ⬜ 待做 |

---

## 8. 风险登记册

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | 目标机缺字体 → 硬断行变成**错误断行** | 比不硬断行更糟 | 白名单 + 嵌入 + 行宽冗余；报告里显式警告 |
| R2 | 复杂 CSS 被静默丢弃 | 用户以为"转坏了" | 降级协议 + 导出报告；linter 提前拦 |
| R3 | PptxGenJS 维护停滞（4.0.1 停在 2025-06）、不支持字体嵌入、默认 STORE | 长期受制于人 | 写入层做适配层隔离；预留"直写 DrawingML"替换路径（参考 html-native-pptx / @office-open/pptx） |
| R4 | 许可风险 | 法务 | 不引用 Anthropic html2pptx 代码（proprietary）；PPTAgent 的 html2pptx.js 虽 MIT 但自称衍生自 Anthropic，**存在许可链瑕疵，不复用** |
| R5 | 把 LibreOffice 的伪差异当真 bug 修 | 白干 | 先建 8 条偏差白名单；真机回归才定性 |
| R6 | "可编辑"承诺过度 | 用户预期落差 | 对外只说 **L2**，并且说清"动画/母版/公式不做"；文案见 §1.2 |
| R7 | 硬断行牺牲"改完自动重排" | 编辑体验降级 | 提供 `--reflow` 松散模式；产品里说明两种模式的取舍 |

---

## 9. 原型实测数据（本机 2026-10-19）

见 `prototype/README.md`。核心数字：

| 指标 | 值 |
|---|---|
| 样本 | 5 页 / 1280×720 |
| 幻灯片尺寸 | `12192000 × 6858000` ✅ |
| 形状 | 66 个 `p:sp` + 1 个原生表格（`p:graphicFrame`/`a:tbl`）+ 3 个 `p:pic`（3 张都是 HTML 里的真实图片） |
| 文本 | 68 个 `<a:t>` run / 48 个段落 / **字符覆盖率 100%**（逐页均 100%） |
| SVG → 原生几何 | 8/8 成功（`a:custGeom`），0 个 PNG 降级 |
| 渐变 → 原生 | 2 处 `a:gradFill`（参考实现此处多为栅格化） |
| 硬断行 | 35/35 文本框 `wrap="none"` + 四边 inset 0 + `anchor="t"` + `a:spcPts`；**HTML 视觉行 48 == PPTX 段落 48** |
| 字体三处写全 | `a:latin` 88 / `a:ea` 88 |
| ZIP / 包 | 39/39 DEFLATE（0 STORE）；无悬空 Override；python-pptx 可重开 |
| 回渲 | LibreOffice 26.8 → PDF → PNG，5 页全部成功 |
| 像素差 | MAE **4.25**；`diff>16` **4.06%**；`diff>48` 2.97% |
| 差异归因 | 文本区域 20.3%（字形边缘 + 基线偏移）/ 形状 4.3% / 图片 1.7% |

**量化后的两条系统性偏差**（不是 bug，进白名单）：
1. **CJK↔拉丁边界**：7 字体对照实验显示，纯拉丁 −0.9%、纯 CJK −1.1%，而**中英混排一律 +3.4%~4.3%**（3 边界 × ≈7.5px）——这是 LibreOffice 自动加 ≈0.25em 的行为；
2. **首行基线下移 1–6px（中位 3px）**，随 `line-height` 变化。原型**不做补偿**（`TEXT_Y_OFFSET=0`），因为在 LibreOffice 上补偿到"对"，到真 PowerPoint 上可能"错"。

---

## 10. 一页纸总结

> **HTML 是可编辑 PPT 的最好的"作者界面"，但必须降级为受约束的中间表示。**
> 护栏有四道：**契约**（能写什么）、**量测**（实际落在哪）、**映射**（怎么变成原生对象）、**验收**（是不是真的成了）。
> 决定成败的不是"能不能转"，而是：**视觉行量测准不准、字体在目标机在不在、降级是不是显式的、Office 打开会不会报修复。**
