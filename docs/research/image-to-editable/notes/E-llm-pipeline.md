# E · LLM/VLM 在「图片型 PPT → 可编辑 PPTX」管线里到底能干什么

> 抓取日期 **2026-10-20**。全部价格读自官方定价页原文；全部论文数字读自 arXiv HTML/PDF 原文。
> 定位：给要上线这个功能的团队写代码用。**结论优先，能抄的字段和伪代码直接给。**
> 姊妹篇：`A-domestic-sites.md`（产品横评）、`B-cloud-apis.md`（云 API）、`C-open-source.md`（开源）、`D-effects-reviews.md`（口碑）。

---

## 0. 一句话总结

**LLM 不是这个管线的"转换器"，是"语义层"。**它能可靠做的事只有三件：**看懂这一页是什么、把碎块组织成有语义的组、判断渲染结果哪里不对**。它**不可靠**的事是：像素级几何、字符级无损转写、稳定复现同一份输出。所有把 LLM 当"整页 → PPTX"黑盒的方案，公开基准的天花板是 **68–77 / 100**（见 §7），而 token 成本只占售价的 3–5%（见 §4）——**钱不是瓶颈，几何精度和返工才是**。

---

## 1. 八个插入点，逐一判死刑/发通行证

| # | 位置 | 结论 | 用什么 | 单页成本 | 理由（硬依据） |
|---|---|---|---|---|---|
| ① | 页面预检/场景分类 | ✅ **值得，但别用大模型** | 规则 + 小模型（GLM-4.6V-FlashX / qwen3-vl-flash 级） | ¥0.001–0.003 | 分类维度是"矢量渲染 / 截图 / 扫描 / 拍屏 / AI 生图"，这是**低语义、高纹理**任务，CLIP/小 VLM 足够；大模型在这里是纯浪费 |
| ② | 版面元素抽取（bbox+type+text+style） | ⚠️ **只能做一半，且 bbox 必须后处理** | 检测器出框 + OCR/VLM 出字 + VLM 出语义分组 | ¥0.02–0.06 | VLM 文本框 IoU 仅 **0.364**、中心偏移 **53.7px/1600px**（§2），直接用它画的框 → 用户第一眼就是"位置歪了" |
| ③ | 阅读顺序与层级 | ✅ **明确优势，最便宜的高价值点** | 主 VLM，输出 id 排列而非坐标 | ¥0.005 | 幻灯片是非规则版式（卡片、悬浮标注、双栏），XY-cut 必错；但**只要它输出 `["el3","el1","el7"]` 这种 id 序列**，可校验、可回退 |
| ④ | 表格结构还原 | ✅ **强，但专用模型更划算** | PaddleOCR-VL / MinerU2.5；VLM 只做"这是表还是四个文本框"的判断与坏结构修复 | ¥0.002–0.01 | 文档表格已接近解决：PaddleOCR-VL-1.5 在 OmniDocBench v1.5 上 Table TEDS **92.76**、TEDS-S **95.79**；通用 VLM 在这项上不会更好，只会更贵 |
| ⑤ | 公式识别 | 🟡 **只在技术类 deck 开，且不要指望 PPTX 原生** | UniMERNet/PaddleOCR-VL 出 LaTeX；VLM 只做 LaTeX 清洗 | ¥0.003 | Formula CDM **94.21**（同上）；但 PPTX 的 OMML 需要手写 `m:oMath` XML，python-pptx 无 API，LibreOffice 渲染还走形 → **公式建议渲成高分辨率 PNG + alt 文本**，别硬转原生 |
| ⑥ | 底图修补（去文字后的背景） | ❌ **LLM 干不了，VLM 只能"决策"** | LaMa / big-lama / SD-inpaint 做像素；VLM 决定"哪些字属于背景、该不该抹" | ¥0.002 + GPU | 生成模型重绘（slide-alchemy 路线）会**改变原图像素**，导致你的 diff QA 永远过不了；且文字压在照片/人脸上必糊 |
| ⑦ | 质量判定（渲染回图 diff 后定位重修） | ✅✅ **ROI 最高** | SSIM 定位 + VLM 判因（只喂最差的 3 个 tile） | ¥0.005–0.015 | 纯阈值只能告诉你"这里差 0.12"，说不出"字溢出了框"还是"字体被替换"；VLM 说得出，且只在小图上跑，成本可忽略 |
| ⑧ | 整页重构成 PPTX XML | ❌ **主路径上纯属浪费钱** | 确定性 assembler（python-pptx / PptxGenJS） | ¥0 | 让模型写 python-pptx 代码：PPTBench 最好配置 67.80/100、中位数 19.47/100；而且**同一输入两次输出不同**，你没法做回归测试。只有"装饰性自由曲线 → SVG path"这一个子任务值得给模型 |

**一句话派工单：**

```
规则/小模型  → ① 预检
检测器+OCR   → ② 的 bbox 与字符
大 VLM       → ② 的语义分组、③ 阅读顺序、④/⑤ 的疑难、⑦ 判因
LaMa/SD      → ⑥ 像素
代码         → ⑧ 组装
```

---

## 2. 坐标精度：VLM 的 bbox 到底能信到什么程度

### 2.1 有据可查的数字

| 来源 | 任务 | 指标 | 数值 |
|---|---|---|---|
| **Images2Slides**（WWW'26 Companion, arXiv 2602.07645） | 29 张 1600×900 合成信息图，VLM 出区域 JSON | 文本区 **IoU 均值** | **0.364 ± 0.161**（中位 0.388） |
| 同上 | | 文本区 **IoU ≥ 0.5 的比例** | **37.6%** |
| 同上 | | 文本区 **中心偏移** | **53.7 ± 26.9 px**（= 图宽的 3.4%） |
| 同上 | | 图片区 IoU / 偏移 | **0.644 ± 0.131** / **11.0 px** |
| 同上 | | 元素回收率 / CER | 0.989 / **0.033** |
| 同上 | | **VLM 单页耗时** | **55.0 ± 18.3 s** |
| **GroundingME**（arXiv 2512.17495） | 25 个模型，难例 grounding | 最高准确率（Qwen3-VL-235B-A22B） | **45.1%** |
| 同上 | | Seed-1.6-Vision / Qwen3-VL-8B / Gemini-2.5-Pro | 42.6% / 31.0% / **20.7%** |
| 同上 | | Rejection（该说"没有"时） | **绝大多数模型 0%** |

**怎么读这组数：**
- **图片/图标区**：IoU 0.64、偏移 11px，够用（加 2–4px padding 即可）。
- **文本区**：IoU 0.36 意味着**一半以上的文本框只覆盖了真值的一半面积**。原因不是模型"看不见"，而是**文本框宽度依赖字体度量**——同一个字符串，字宽估错 10%，框宽就错 10%，IoU 直接掉到 0.6 以下。Images2Slides 自己也是这么解释的。
- **Rejection = 0%** 是最危险的：模型**几乎不会说"这里没有元素"**。它会给你编一个框。这就是 bbox 幻觉的机制性来源。

### 2.2 三种坐标格式，哪种更准？

这不是"哪种更准"的问题，是**"必须匹配模型训练时的约定"**的问题：

| 格式 | 谁在用 | 量化误差（1920 宽） | 风险 |
|---|---|---|---|
| 归一化 **0–1000** | **Qwen3-VL 全系**（技术报告明确从 Qwen2.5 的绝对坐标改回 0–1000，理由是"对分辨率和长宽比更鲁棒"）、DeepSeek-VL2、多数 GUI agent | 1920/1000 ≈ **1.9 px** | 忘记乘 W/H → 全图缩成左上角一小块 |
| **绝对像素** | **Qwen2.5-VL**（官方 issue #866 确认）、Claude（官方文档建议直接要 pixel） | 受模型内部 patch 网格限制，**±16–32 px**（32px/token） | 你上传前若被 API 缩放（`max_pixels`），坐标空间与你手里的原图**不是同一个** |
| 相对 0–1 浮点 | 少量自研 | <1 px | 模型训练时几乎没见过，精度最差 |

**工程结论（可直接照做）：**
1. **提示词里显式给尺寸**，并要求响应**回显** `"image_px": {"w":1920,"h":1080}`，落库前校验 `0 ≤ x < x+w ≤ W`。
2. **Qwen3-VL 系用 0–1000 归一化**，落库时乘 `W/1000, H/1000`；**Qwen2.5-VL / Doubao 用绝对像素**。混用是线上最常见的 1000 倍事故。
3. **不管哪种，bbox 只当先验**。落库前做一次 **ink-snap**：
   - 在 bbox 四周各扩 3% 图宽，取窗口；
   - 做自适应二值化 → 水平/垂直投影 → 找 ink 的起止；
   - 文本用 ink 的水平极值当左右边界，用行高推字号（见 §3.4）；
   - 若 snap 后与 VLM 框偏差 > 4% 图宽，标记 `needs_review`，不要静默采用。
4. **别指望"高分辨率模式"救小字**：百炼默认 `max_pixels = 2,621,440`，**2560×1440 会被降采样**（3.69M → 2.62M 像素），1920×1080 刚好不被降。要更细就**切 tile**（2×2 或 3×2 重叠 10%），不要盲目调大 `max_pixels`。

### 2.3 幻觉率：公开数据里没有"PPT 专用"的数，但可以推

- **文字编造/漏字**：Images2Slides 在**合成干净图**上 CER 0.033；这个数在真实截图上会显著恶化（PPTBench 显示文本类缺陷是最大罚分项：`unexpected_wrap` 1,591 例、5,002 罚分，见 §7）。
- **元素编造**：GroundingME 的 Rejection ≈ 0% 说明模型**没有"说不"的能力**；落到版面上就是"给空白处编一个装饰框"。
- **可靠的做法不是"测幻觉率"，是"结构上消灭它"**：
  ```
  VLM 文本  vs  PaddleOCR/RapidOCR 文本
    ├─ 完全一致            → 采用，confidence=0.99
    ├─ CER < 0.15          → 采用 VLM 版（VLM 更会处理断行/标点），标 0.8
    └─ VLM 独有 / CER>0.3  → 裁该 bbox 放大 2×，二次提问"逐字转写，不要补全"
                             仍不一致 → 采用 OCR 文本，标 needs_review
  ```
  双通道交叉是唯一在工程上稳定的反幻觉手段，成本只多 ¥0.001/页（OCR 本地跑）。

---

## 3. Schema：可直接落库、直接映射 OOXML 的字段级设计

设计原则（踩过坑的）：
1. **坐标只存一种**：源图像素 `bbox_px`（左上 + 宽高）。EMU/PT 在组装时算，**不要进 JSON**——一旦存了两套单位，必然有人改一套忘另一套。
2. **LLM 只产出"语义字段"**，几何字段由代码测量后回填（下表标了 `[M]`）。
3. **每个元素带 provenance**，QA 才能精确重裁、局部重修。
4. **数组顺序即 z-order**，组内再排序；不要单独维护 z 字段（一定会有重复值）。

### 3.1 顶层

```json
{
  "schema_version": "pptx-recon/1.2",
  "slide": {
    "src_image": { "path": "p03.png", "px": { "w": 1920, "h": 1080 }, "dpi_ref": 144 },
    "canvas":    { "w_pt": 960, "h_pt": 540, "w_emu": 12192000, "h_emu": 6858000 },
    "px_to_emu": 6350,
    "background": { "kind": "solid", "color": "#FFFFFF" }
  },
  "assets": [
    { "id": "img_bg", "path": "assets/p03_bg.png", "sha1": "…", "px": { "w": 1920, "h": 1080 } }
  ],
  "elements": [ /* 见 3.2 */ ]
}
```

> `px_to_emu` 计算：16:9 幻灯片 13.333in × 7.5in = 960pt × 540pt = 12,192,000 × 6,858,000 EMU。
> 源图 1920px 宽 → `12192000 / 1920 = 6350` EMU/px。**一页一个系数，不要全局写死。**

### 3.2 元素（text 示例，全字段）

```json
{
  "id": "el_007",
  "type": "text",
  "role": "title",
  "bbox_px": { "x": 120, "y": 88, "w": 980, "h": 76 },
  "group_id": null,
  "rot": 0, "flipH": false, "flipV": false,
  "text": {
    "body": {
      "anchor": "t",
      "wrap": "square",
      "autofit": "none",
      "insets_px": { "l": 7, "t": 3, "r": 7, "b": 3 },
      "vert": "horz"
    },
    "paragraphs": [
      {
        "align": "l",
        "level": 0,
        "line_spacing_pct": 110,
        "space_before_pt": 0,
        "space_after_pt": 6,
        "bullet": { "kind": "char", "char": "•", "indent_px": 18 },
        "runs": [
          {
            "t": "第三季度营收同比增长 23.4%",
            "font": {
              "latin": "Arial", "ea": "Noto Sans SC",
              "size_pt": 24, "bold": true, "italic": false,
              "underline": "none", "color": "#1F2937", "spc": 0
            },
            "lang": "zh-CN"
          }
        ]
      }
    ]
  },
  "fill": { "kind": "none" },
  "line": { "kind": "none" },
  "confidence": 0.91,
  "provenance": {
    "bbox_src": "vlm+snap",
    "text_src": "ocr+vlm",
    "size_src": "cap_height",
    "needs_review": false
  }
}
```

### 3.3 其余类型的关键字段

| type | 必填字段 | 说明 |
|---|---|---|
| `shape` | `geometry.preset`（`rect`/`roundRect`/`ellipse`/`triangle`/`chevron`/`pentagon`…）+ `geometry.adj` | 自定义多边形用 `geometry.path_d`（SVG path，坐标已归一化到 bbox 的 0–1） |
| `line` | `line.kind`（`straight`/`elbow`/`curve`）、`from_px`、`to_px`、`arrow:{head,tail}` | **箭头在转换里最容易丢**：ReFigBench 实测所有配置下原生 connector 中位数 = 0 |
| `image` | `asset_id`、`src_rect_px`（裁剪源区）、`shape`（`rect`/`roundRect`/`ellipse`）、`alpha` | 图标/照片/复杂装饰都走这里 |
| `table` | `cols_px[]`、`rows_px[]`、`cells[]` | 见 3.5 |
| `group` | `children[]`（子元素 id） | 只做逻辑分组，**不要嵌套超过 2 层**（PowerPoint 的 group 坐标变换很容易在往返渲染里漂移） |
| `chart` | `chart_kind`、`series[]`、`categories[]`、`style_hint` | 建议：**图表默认不重建**，裁图 + 隐藏数据表。重建柱状图容易"看着像但数据是编的" |
| `formula` | `latex`、`render_png` | 默认渲 PNG；只有用户显式要原生公式才走 OMML |

### 3.4 字号怎么来（**不要让 LLM 猜**）

LLM 给的 `font_size_pt` 基本不可用。用测量：

```python
# 一个纯 CJK 行：字形 em ≈ ink 高度 / 0.86
# 一个纯拉丁大写行：em ≈ cap_height / 0.70
# 混排：取 CJK 行高更稳
def estimate_pt(ink_h_px, dpi, kind="cjk"):
    em_px = ink_h_px / (0.86 if kind == "cjk" else 0.70)
    return em_px * 72.0 / dpi
```
然后**做一次分段线性校准**（Images2Slides 的做法）：在同一页里取 3–5 个已知字号（页脚、正文、标题）拟合 `pt = a*em_px + b`，其余元素按拟合式换算。实测这比逐元素测量稳得多，因为渲染管线（截图 DPI）本身有系统性偏差。

> CJK 陷阱：CJK 字形是**全角 em**，行高通常 1.0–1.2em；拉丁是 1.15–1.2em。用拉丁度量套中文，字号会**偏小 15% 左右**。`px-image2pptx` 的 README 明确写了它用 "fullwidth em metrics for CJK font sizing"。

### 3.5 表格

```json
{
  "type": "table",
  "bbox_px": { "x": 96, "y": 300, "w": 760, "h": 240 },
  "table": {
    "cols_px": [240, 200, 160, 160],
    "rows_px": [44, 49, 49, 49, 49],
    "header_rows": 1,
    "cells": [
      { "r": 0, "c": 0, "text": "区域",
        "fill": "#F3F4F6", "align": "ctr", "valign": "mid",
        "merge": { "rowspan": 1, "colspan": 1 },
        "border": { "w_pt": 0.75, "color": "#D1D5DB" },
        "margins_px": { "l": 6, "t": 3, "r": 6, "b": 3 } }
    ]
  }
}
```

要求模型输出 **HTML `<table>`** 或 OTSL，**不要直接输出这个 JSON**——合并单元格的 JSON 结构模型经常写不合法；HTML 它能写对，你再解析成上面的结构。

### 3.6 字段来源分工表（照着写代码就行）

| 字段 | 谁产出 | 备注 |
|---|---|---|
| `type` / `role` / `group_id` / 阅读顺序 | **VLM** | 语义判断，VLM 唯一明显优于规则的地方 |
| `bbox_px` | 检测器 + **ink-snap** | VLM 值只做初值 |
| `text.runs[].t` | **OCR 主 + VLM 校** | 双通道交叉（§2.3） |
| `font.size_pt` | **[M] 测量 + 校准** | 绝不用 VLM 值 |
| `font.color` | **[M] 采样**（取 ink 像素中位数，排除抗锯齿边缘） | VLM 猜色经常偏亮 |
| `font.ea/latin` | **[M] 字形特征 + VLM 辅助** | 见 §6 |
| `align` | **[M]**：文本框内 ink 重心 vs 框中心 | `|Δ| < 3%` → 居中；否则左/右 |
| `line_spacing_pct` | **[M]**：相邻行基线距 / 字号 | |
| `fill` / `line` | **[M] 采样 + VLM 判 kind** | 渐变要取两端色标 |
| `z` | 数组顺序 | |

---

## 4. 模型选型与真实成本

### 4.1 单价（元 / 百万 token，官方页原文，2026-10-20）

| 模型 | 输入 | 输出 | 上下文 | 最大输出 | 坐标能力 | 结构化输出 | 来源 |
|---|---|---|---|---|---|---|---|
| **qwen3-vl-plus** | **1**（≤32K）<br>1.5（32–128K）<br>3（128–256K） | **10** / 15 / 30 | 262,144 | 32,768（思考 81,920 CoT） | ✅ 原生 grounding，**0–1000 归一化** | ✅ JSON mode | 百炼价格页 / 模型页 |
| **qwen-vl-ocr** | 0.3 | 0.5 | 32K 级 | — | 仅 OCR 框 | 半结构化 | 百炼价格页 |
| qwen3-vl-max / flash | **当前官方价目表未列**（可能已下线/更名）。历史/国际区参考：max ≈ 5.871 / 23.486（国际），flash ≈ 0.15 / 1.5（第三方转述，**未核实**） | | | | | | — |
| **doubao-seed-1.6-vision** | **0.8**（≤32K） | **8** | 256K | 64K | ✅ grounding / 点选 / 裁剪 | ✅ JSON | 方舟价格页 + 模型页 |
| doubao-seed-2.1-pro | 6 | 30 | 1,024K | — | ✅ | ✅ | 方舟价格页 |
| doubao-seed-2.1-lite | 0.8（音频 12） | 2.7 | 1,024K | — | ✅ | ✅ | 方舟价格页 |
| doubao-seed-2.0-pro | 3.2 / 4.8 / 9.6（分段） | 16 / 24 / 48 | 256K | — | ✅ | ✅ | 方舟价格页 |
| **glm-4.6v** | **1**（≤32K）<br>2（32–128K） | **3** / 6 | 128K | 32K 级 | ✅ `[[xmin,ymin,xmax,ymax]]` | ✅ | 智谱定价页 |
| **glm-4.6v-flashx** | **0.15** | **1.5** | 128K | — | ✅ | ✅ | 智谱定价页 |
| glm-4.6v-flash | 免费 | 免费 | 128K | — | ✅ | ✅ | 智谱定价页 |
| glm-4.5v | 2 / 4 | 6 / 12 | 64K | — | ✅ | ✅ | 智谱定价页 |

> **qwen3-vl-plus 的 Batch 调用半价**（输入输出都 5 折），离线批处理场景直接砍一半。

### 4.2 一页 16:9 到底多少 input token（**这是最容易算错的一步**）

两家官方口径不同：

| | 规则 | 1920×1080 | 1280×720 | 2560×1440 |
|---|---|---|---|---|
| **Qwen3-VL 系** | **32×32 px / token**，单图上限 16,384 token；默认 `max_pixels = 2,621,440` | 2,073,600/1024 = **2,025** | **900** | 3,686,400 > 2.62M → **被降采样到 2,560**（细节损失！） |
| **Doubao** | **28×28 px / token**（官方 token 计算器口径，620×465 → 368 token 实测吻合） | **2,691** | 1,196 | 4,784 |

加上系统提示 + schema（约 700–1,200 token），**一页的输入量级 = 3,000–4,000 token**。

### 4.3 逐档算钱（含过程）

设：输入 3,200 token，输出 3,000 token（≈25 个元素 × 110 token 的紧凑 JSON）。

```
cost = in/1e6 × p_in + out/1e6 × p_out

qwen3-vl-plus      : 0.0032×1  + 0.0030×10  = 0.0032 + 0.0300 = ¥0.0332
  开思考(输出 6,000): 0.0032    + 0.0600     = ¥0.0632
qwen-vl-ocr(仅取字) : 0.0032×0.3 + 0.0030×0.5 = 0.0010+0.0015 = ¥0.0025
doubao-seed-1.6-v  : 0.0032×0.8 + 0.0030×8   = 0.0026+0.0240 = ¥0.0266
doubao-seed-2.1-pro: 0.0032×6  + 0.0030×30   = 0.0192+0.0900 = ¥0.1092
glm-4.6v           : 0.0032×1  + 0.0030×3    = 0.0032+0.0090 = ¥0.0122
glm-4.6v-flashx    : 0.0032×0.15 + 0.0030×1.5= 0.0005+0.0045 = ¥0.0050
```

### 4.4 真实的"一页总成本"（不是单价 × 1 次）

| 项 | 省钱档 | 均衡档 | 效果优先档 |
|---|---|---|---|
| 主抽取（1 次） | ¥0.0025（本地 OCR） | ¥0.033 | ¥0.063（思考） |
| 重试/补抽（×1.3–1.8） | — | ¥0.010 | ¥0.030（含 2×2 tile 二次看细节） |
| 表格/公式专用模型 | ¥0.002 | ¥0.005 | ¥0.010 |
| QA 判因（只喂 3 个坏 tile） | — | ¥0.004 | ¥0.012 |
| **小计（token）** | **≈¥0.005** | **≈¥0.05** | **≈¥0.12** |
| 渲染（LibreOffice，0.4–1.2 s/页 CPU） | ¥0.001 | ¥0.002 | ¥0.003 |
| **单页 COGS** | **¥0.006–0.01** | **¥0.05–0.07** | **¥0.12–0.15** |

**对比售价**：图可编 ¥0.98/页、image2ppt ¥0.70–1.00/页、PPTBot ¥0.30/页（普通）/ ¥1.5–2.2（高精）。
→ **token 成本只占零售价的 3–8%。定价的约束不是模型钱，是"人工返修分钟数"。**

### 4.5 时延（实测/官方）

| 模型 | 单页时延 | 说明 |
|---|---|---|
| qwen3-vl-plus（短输出） | **3.7–3.9 s** 中位/均值 | 第三方 router 基准；只适合短问答 |
| qwen3-vl-plus（整页 25 元素 JSON） | **25–60 s** | 输出 token 是主因（3,000 token ≈ 30–50 s） |
| Images2Slides + Gemini | **55.0 ± 18.3 s** | 论文实测，29 次 |
| PaddleOCR-VL 0.9B（自建，A10/4090 + vLLM） | **0.8–2 s/页** | 量级估计，需自测 |

> **架构含义**：整页抽取是"分钟级"操作。产品上必须做成**异步任务 + 进度条 + 先出低清预览**，不要做成同步接口。

### 4.6 开源侧（自建）

| 模型 | 参数 | License | 能干什么 | 单页成本（自建，估） |
|---|---|---|---|---|
| **PaddleOCR-VL** | 0.9B | Apache-2.0 | 版面 + 文本 + 表格 + 公式 + 阅读顺序，109 语种 | ¥0.002–0.005（GPU ¥2–4/h，1–2 s/页） |
| **MinerU2.5** | 1.2B | Apache-2.0 + 附加条款（MAU>1亿 或 月营收>$20M 需授权；**在线服务须标注**） | 两阶段：降采样做全局版面 → 原分辨率裁块做文本/公式/表格 | ¥0.002–0.005 |
| **Qwen3-VL 开源**（2B/4B/8B/32B/A3B/A22B） | 2B–235B | Apache-2.0 | 8B 在 GroundingME 31.0%，32B 39.5%；做"语义分组"够用 | 8B on A10 ≈ ¥0.01/页 |
| **InternVL3** | 1B–78B | 多数 Apache-2.0（按具体权重核） | 通用 VLM，grounding 一般 | 同上 |
| **Florence-2** | 0.23B / 0.77B | **MIT** | OD / region proposal / OCR，**只出框不出语义**，适合当"检测器" | ¥0.001/页，极便宜 |

**建议组合**：`PP-DocLayoutV2 / Florence-2`（框） + `PaddleOCR-VL 0.9B`（字/表/公式） + `qwen3-vl-plus 或 glm-4.6v`（语义分组 + 难例） + `python-pptx`（组装）。这是成本与效果的最优点。

---

## 5. 渲染回环（render-back loop）怎么做才不白做

### 5.1 流水线

```
pptx ──soffice --headless --convert-to pdf──> pdf ──pdftoppm -r {dpi} -png──> render.png
                                                                                │
src.png ────────────── align (同尺寸/同 DPI，必要时 ECC 配准) ──────────────────┤
                                                                                ▼
                                            ┌───────────────┬───────────────┬──────────────┐
                                            │ 全局 SSIM     │ 元素级匹配     │ 文本 CER     │
                                            │ (定位"哪里差")│ (召回/位置/色) │ (是否可编辑) │
                                            └───────┬───────┴───────┬───────┴──────┬───────┘
                                                    ▼               ▼              ▼
                                              生成 tile 热度图 → 取最差 k 块 → VLM 判因 → 局部重修
```

### 5.2 指标怎么选（别只用 SSIM）

| 指标 | 用途 | 实现 | 阈值（建议） |
|---|---|---|---|
| **SSIM**（灰度、缩到 512 宽、先高斯 σ=1） | **定位**，不做判决 | `skimage.metrics.structural_similarity` | 只用于**排序**：取最差 3 个 64×64 tile |
| **元素级匹配**（Design2Code 范式） | 判决主力 | 对 render 与 src 各跑一遍 OCR/检测 → 按文本相似度做**匈牙利匹配**（Jonker-Volgenant）→ 算 block-match / 位置 / 颜色 | block recall ≥ **0.95**；中心偏移 p95 ≤ **1.5% 对角线** |
| **文本 CER** | "可编辑"承诺的唯一硬指标 | 匹配块内 Levenshtein / 字符数 | 全页 CER ≤ **0.02**；单块 ≤ 0.10 |
| **颜色 ΔE00** | 品牌色/主题色 | 取块内 ink 中位色 | ≤ **6**（肉眼可辨阈值约 2–3） |
| **字号比** | 排版观感 | 匹配块 ink 高度比 | 0.9 ≤ r ≤ 1.1 |
| **CLIP / pHash** | 整页风格兜底 | — | 只做趋势监控，不做 gate |

> **不要用绝对 SSIM 阈值**（比如"SSIM<0.9 判失败"）。同一份 pptx 在装了不同字体的容器里渲染，SSIM 能差 0.15；你会把好页判成坏页。**只用它排序找坏块**。

### 5.3 判决 + 局部重修伪代码（可直接抄）

```python
TH = dict(cer_page=0.02, cer_block=0.10, recall=0.95,
          center_p95=0.015, dE=6.0, size_ratio=(0.90, 1.10))

def qa_page(src_png, pptx_path, elements, workdir, max_rounds=2):
    render = render_pptx(pptx_path, dpi=ref_dpi(src_png))     # soffice -> pdf -> pdftoppm
    render = align_to(render, src_png)                        # ECC / 尺寸归一
    blocks_r = detect_blocks(render)                          # OCR + 检测
    blocks_s = detect_blocks(src_png)

    match = hungarian_match(blocks_s, blocks_r, key=text_similarity)
    recall   = len(match) / max(1, len(blocks_s))
    cer      = page_cer(match)
    centers  = [norm_center_delta(s, r, src_png) for s, r in match]
    p95      = percentile(centers, 95)
    dE_max   = max(color_delta(s, r) for s, r in match)

    ok = (cer <= TH['cer_page'] and recall >= TH['recall'] and p95 <= TH['center_p95'])

    # 1) 先按 tile 定位：即使整页 ok，也记录最差块用于报表
    tiles = worst_tiles(src_png, render, k=3, size=64)
    # 2) 只对"元素级失败"重修，不整页重生成
    bad_ids = [el.id for el in elements
               if not element_ok(el, match, TH)]           # CER/偏移/字号/颜色任一越界

    for rnd in range(max_rounds):
        if not bad_ids: break
        for eid in bad_ids[:5]:                                # 一轮最多 5 个，控成本
            el   = get(elements, eid)
            crop = crop_with_pad(src_png, el.bbox_px, pad=0.06)  # 放大 2x 再送
            diff = crop_same_region(render, el.bbox_px)
            fix  = vlm_repair(crop, diff, el.json(), allowed=["text","bbox","size","align","color"])
            # 白名单：只允许改这 5 类字段，防止模型"顺手重画整页"
            apply_patch(elements, eid, fix)
        rebuild_pptx(elements, pptx_path)
        render = align_to(render_pptx(pptx_path, ref_dpi(src_png)), src_png)
        bad_ids = recheck(...)

    # 3) 兜底：修不好的元素降级为图片，并标记人工
    for eid in bad_ids:
        flatten_to_png(elements, eid, src_png)                 # 保视觉、弃可编辑
        elements[eid].provenance.needs_review = True
    return QAReport(cer=cer, recall=recall, p95=p95, dE=dE_max,
                    tiles=tiles, review=bad_ids)
```

### 5.4 五个必须知道的坑

1. **LibreOffice 字体替换**：容器里没有 Noto Sans SC，LO 会用 DejaVu 顶上 → 所有文字宽度变化 → SSIM 崩、CER 涨。**渲染容器的字体集必须与 pptx 里声明的 `ea` 字体完全一致**，否则你在优化一个用户根本看不到的渲染。
2. **LO 与 PowerPoint 的行分割算法不同**：同一段中文，断行位置可能差 1–2 个字。所以**文字区域不要用像素 diff 判决**，用 CER。
3. **autofit 不一致**：LO 对 `normAutofit` 的缩放比例和 PPT 不同。对策：**生成时禁用 autofit**（`autofit:"none"`），字号由你算好、框留 8–12% 余量。
4. **迭代渲染的收益是有限的**：ReFigBench 的结论原话是 "Perception remains a bottleneck that **iterative rendering only partly repays**"。**最多 2 轮**，第 3 轮开始收益为负（会把对的改错）。
5. **别把"生成式补底图"放进回环**：slide-alchemy 用图像编辑模型重绘底图，每次结果不同 → diff 永远不收敛。底图修补必须用**确定性 inpainting**（LaMa），同一 mask 同一输出。

### 5.5 已有实现参考

- **figedit**（giszzt/figedit）：manifest.json 记录全部决策 → 生成 SVG/PPTX → **与原图做像素级对比、输出差异热力图和分块评分**，自动修复后重新组装。这是最接近本文 §5 的开源实现。
- **AutoPresent**（CVPR'25）：把"执行代码得到的 slide 快照 + 上一版代码"回灌给模型做 refine，是 render-feedback 的学术原型。
- **Design2Code**（NAACL'25）：block-match / 位置 / 颜色 / CLIP 四件套 + 匈牙利匹配，指标定义可直接搬。
- **image2editable**：自带 benchmark 门禁（质量不达标即失败），思路可借。

---

## 6. 中文场景的坑（每条都带解法）

### 6.1 字体：不是"能不能用"，是"能不能嵌入"

我用 fontTools 直接读了本机字体的 `OS/2.fsType`（嵌入许可位）：

| 字体 | fsType | 含义 | 能否嵌进 pptx |
|---|---|---|---|
| **PingFang SC**（苹方） | **4** | Print & Preview | ❌ 只能预览/打印 |
| **Songti SC**（宋体-简） | **2** | Restricted | ❌ 禁止嵌入 |
| **Hiragino Sans GB**（冬青黑） | **8** | Editable | ✅（但不可子集化） |
| **Noto Sans CJK SC**（思源黑体） | **0** | Installable | ✅ 完全可嵌 |
| 微软雅黑 / 中易宋体 | 商业字体，授权禁止再分发 | — | ❌ |

**工程结论：**
- 输出**只用 Noto Sans SC / Source Han Sans / Source Han Serif**（OFL），并把原字体名写进 `descr` 或备注，方便用户手动换回。
- **不要依赖 PowerPoint 的"嵌入字体"**：Mac 版 PowerPoint 直接忽略嵌入字体；Windows 版对 CFF/OTF 支持也差。嵌入 = 心理安慰。
- 你的**渲染 QA 容器必须预装同一套 Noto**，否则 §5 全部指标失真。

### 6.2 标点与全半角

| 现象 | VLM 常见输出 | 处理 |
|---|---|---|
| 中文句读 | `,` `.` `;` `:` `(` `)` | CJK 占比 > 60% 的 run → 转全角 `，。；：（）`；**但** 数字/版本号/百分比/英文缩写白名单内不转（`3.5%`、`v2.0`、`A/B`、`e.g.`） |
| 全角拉丁 | `ＡＢＣ１２３` | `unicodedata.normalize('NFKC')` 只作用于 `[Ａ-Ｚａ-ｚ０-９]`，且**仅当该 run 无 CJK** |
| 中英之间空格 | 有的模型加 `使用 Python 编写`，有的不加 | **不要统一加/删**：按原图 ink 间距判断（> 0.25em 才保留空格） |
| 省略号 | `...` vs `……` | 中文语境统一 `……`（U+2026 ×2） |
| 破折号 | `-` vs `——` | 中文语境 `——`（U+2014 ×2） |

**CER 计算前先去空白**：中文 CER 对空格极敏感，`remove_whitespace` 后再算 Levenshtein，否则你会追一个不存在的 bug。

### 6.3 竖排

- 检测：`h/w > 2.2` **且** 行方向为垂直（对 ink 做垂直投影，找列而非行）**且** 标点位于字格右上/右下。
- 落盘：`<a:bodyPr vert="eaVert"/>`（东亚竖排，从右到左换列）。python-pptx **没有 API**，必须 lxml 直接写。
- 顺序陷阱：竖排的阅读顺序是**从右到左**，VLM 通常按"从左到右"给你 id 序列 → 组内要 `reverse`。
- 渲染陷阱：LibreOffice 对 `eaVert` 支持一般（可能变成横排），**竖排页不要进自动 QA**，直接标人工。

### 6.4 艺术字 / 渐变文字

| 效果 | OOXML | python-pptx | 建议 |
|---|---|---|---|
| 渐变填充文字 | `a:rPr/a:gradFill/a:gsLst` | ❌ 无 API | 检测到字形内部色方差 > 阈值 → **渲 PNG + 透明文本框承载文字**（可搜索、可选中的是图） |
| 文字描边 | `a:rPr/a:ln` | ❌ | 同上，或降级为纯色 |
| 阴影/发光 | `a:rPr/a:effectLst` | ❌ | 降级为纯色（视觉损失小） |
| 文字变形（拱形等） | `a:prstTxWarp` | ❌ | 一律 PNG 化 |
| 艺术字整体 | WordArt | ❌ | **PNG + alt 文本**，不要试图还原 |

**判决规则**：`装饰度 = f(色方差, 描边宽度, 变形)`。装饰度高于阈值 → 图化，并在产物里给一个"转为可编辑文本"的开关（用户接受降级时才转）。这比"猜一个近似纯色"诚实得多。

### 6.5 其他中文专属坑

- **避头尾**：PowerPoint 和 LibreOffice 的禁则处理不同 → 断行不同 → 别用像素 diff 判文字区。
- **字重**：思源黑体有 7 个字重，`bold:true` 只会映射到 Bold；要精确匹配需选具体字体名（`Noto Sans SC Medium`），否则粗细差一档，SSIM 掉得莫名其妙。
- **字号非整数**：PowerPoint 支持 0.1pt 精度，但 `python-pptx` 的 `Pt()` 是 float，可以；**LibreOffice 会四舍五入到 0.5pt**，回环里会出现系统性 0.5pt 偏差，别当 bug 追。
- **中英混排基线**：同一 run 里中英混排，PowerPoint 用 `ea` 字体渲染 CJK、`latin` 渲染 ASCII，两者的 ascent 不同 → 行高由较大者决定。设 `line_spacing_pct` 时要按 CJK 算。

---

## 7. 学术与工业基准：现在到底能做到几分

| 基准 | 规模/任务 | 指标 | 最好成绩 | 对我们的含义 |
|---|---|---|---|---|
| **ReFigBench**<br>arXiv 2609.18844 | 1,000 张 arXiv overview figure；10 个 (model, harness, workflow) 配置 | 100 分制 rubric：文本 20 + 语义结构 30 + 布局 15 + **可编辑性 25** + 视觉细节 10；另有确定性 artifact gate 和"整页贴图"封顶 50 分 | **77.4**（GPT-5.5 + Codex + 专用 PPTX 工作流）<br>Claude Opus 4.6：69.4（direct）/ 66.4（specialized） | **上限就在 77 分**。而且"专用工作流"在所有配置下**把原生 connector 抹成 0**（direct 是 15–42 个）→ 箭头/连线是结构性损失，不是模型不够强 |
| **PPTBench**<br>arXiv 2609.29718 | 500 张科学流程图；31–36 个配置；46,500 次判定 | 四段式 agentic judge：artifact 有效性 / 流程与连接 / 渲染质量 / 视觉保真 | **67.80**（Kimi K3, high effort）；**中位数 19.47**<br>⚠️ v1 摘要写的是 77.34 / 中位 24.38，HTML 最新版为 67.80 / 19.47；以最新版为准 | 只有 **2.08%** 的样本产不出可用文件，但 **70.43%** 在"已经能看"之后**丢掉了流程语义**。最大罚分项是 `unexpected_wrap`（1,591 例，5,002 分）→ **文字换行是头号缺陷** |
| **Images2Slides**<br>WWW'26 Companion, 2602.07645 | 29 张 1600×900 合成信息图 | 元素回收率 / CER / IoU / 中心偏移 | 回收率 **0.989**、CER **0.033**、文本 IoU **0.364**、图片 IoU **0.644**、耗时 55 s | **"找得到"和"放得准"是两件事**。回收率 99% 会让老板以为成了，IoU 0.36 会让用户骂街 |
| **SlidesGen-Bench**<br>arXiv 2601.09487 | 9 个生成系统、7 类场景 | Content / Aesthetics / **Editability** 三维，渲染域评测 | — | 评测范式可借：**"可编辑度"要单独一维**，不能混进"像不像" |
| **OmniDocBench v1.5**<br>（文档解析，非幻灯片） | 文档 | 文本 Edit↓ / 公式 CDM↑ / 表格 TEDS↑ | PaddleOCR-VL-1.5：文本 **0.035**、公式 **94.21**、表格 **92.76**、TEDS-S **95.79** | **元素级识别已经基本解决**。你的瓶颈不在 OCR，在**版面语义 + 几何 + 结构（连接线/层级）** |

### 这组数字对"能不能上线"意味着什么

1. **不要承诺"一键完美"**。公开 SOTA 在**干净、结构化、单页**的图上只有 68–77 分。真实场景（扫描件、拍屏、AI 生图）再打 7 折。
2. **可以承诺"80% 的元素不用重画"**。元素回收率在干净图上确实能到 0.95+，这是产品的真实卖点。
3. **必须提供"修"的入口**。PPTBench 的 70.43% 语义丢失率说明：用户一定会改。产品价值 = 把"从零画"变成"改 5 分钟"。
4. **连接线/箭头要单独做**。ReFigBench 证明现有工作流会系统性丢 connector；如果你的目标场景是架构图/流程图，**必须自己实现"线检测 + 端点吸附 + 绑定到形状"**，这一块 LLM 帮不上忙（用 LSD/Hough + 形态学）。

---

## 8. 三档配置：成本 vs 可编辑率

| | **省钱档** | **均衡档** | **效果优先档** |
|---|---|---|---|
| **版面/框** | PP-DocLayoutV2 或 Florence-2（本地） | 同上 | 同上 + 2×2 tile 二次检测小元素 |
| **文字** | PaddleOCR-VL 0.9B（本地） | PaddleOCR-VL + qwen3-vl-plus 交叉校验 | 同均衡 + 低置信块 2× 放大重问 |
| **语义分组 / 阅读顺序** | glm-4.6v-flashx（¥0.15/1.5） | **qwen3-vl-plus**（¥1/10） | **qwen3-vl-plus 思考模式** 或 doubao-2.1-pro |
| **表格/公式** | PaddleOCR-VL 内置 | 同左 | 同左 + 人工复核入口 |
| **底图** | LaMa（本地） | LaMa | LaMa + 纹理区域 SD-inpaint 兜底 |
| **QA** | 只做 artifact 校验（能打开、页数对） | 1 轮 render-back（CER + block recall） | 2 轮 render-back + VLM 判因 + 坏块重修 |
| **单页 COGS** | **¥0.006–0.01** | **¥0.05–0.07** | **¥0.12–0.15** |
| **端到端时延/页** | 1.5–3 s | 30–60 s | 60–120 s |
| **预期可编辑率**（原生对象且位置误差 < 1.5% 对角线） | 文字 **55–65%**，形状 40% | 文字 **75–85%**，形状 60–70% | 文字 **85–92%**，形状 70–80% |
| **适用场景** | 大批量、可接受"文字层 + 底图"、内部归档 | **默认上线档**，面向 C 端 | 高价值单页、企业交付、可加价 |
| **定价建议** | ¥0.15–0.25/页 | ¥0.6–1.0/页 | ¥2.5–4/页（含 1 次人工复核） |

**决策要点：**
- **均衡档就是上线的正确起点**。它的 COGS 是 ¥0.05，卖 ¥0.8，毛利率 90%+；单页失败重跑 3 次也不心疼。
- **不要一开始上"效果优先档"**：多出来的 ¥0.07 买不到对应的体验提升（ReFigBench 的 77 分天花板说明，边际收益在感知层就衰减了）。把这笔钱花在**交互式编辑器**上更值。
- **省钱档不要用于 C 端**：没有 render-back 就没有质量兜底，坏页会直接流到用户手里，退款成本远高于省下的 ¥0.04。

---

## 9. 上线前必须做的 5 个技术决策（Checklist）

- [ ] **坐标契约**：全链路只认 `bbox_px`（源图像素）；Qwen3-VL 走 0–1000 换算，Doubao/Qwen2.5 走绝对像素；响应必须回显 `image_px`。
- [ ] **双通道文本**：OCR 与 VLM 必须交叉，VLM 独有的字符串一律要二次确认，不允许直接落库。
- [ ] **字号测量**：禁用 VLM 的 `font_size`，用 ink 高度 + 分段线性校准；CJK 用全角 em 度量。
- [ ] **字体白名单**：只出 Noto Sans SC / Source Han；渲染容器装同一套；PingFang/宋体/微软雅黑只作为 fallback 名写进 `ea` 的备选链。
- [ ] **QA 门禁**：CER ≤ 0.02、block recall ≥ 0.95、中心偏移 p95 ≤ 1.5% 对角线；不达标 → 局部重修 ≤ 2 轮 → 仍不达标则**降级为图片 + 标记人工**（绝不静默发布）。

---

## 10. 来源

**论文 / 基准**
- ReFigBench: Benchmarking Scientific Figure Reconstruction as Editable PowerPoint Artifacts — https://arxiv.org/abs/2609.18844
- PPTBench: Can Coding Agents Reconstruct the Visual World through Structured, Editable Slides — https://arxiv.org/abs/2609.29718
- From Dead Pixels to Editable Slides (Images2Slides), WWW Companion '26 — https://arxiv.org/abs/2602.07645 ／ DOI 10.1145/3774905.3795609
- SlidesGen-Bench — https://arxiv.org/abs/2601.09487
- GroundingME: Exposing the Visual Grounding Gap in MLLMs — https://arxiv.org/abs/2512.17495
- Qwen3-VL Technical Report（**归一化 0–1000 的官方说明在 §3.2.4**）— https://arxiv.org/abs/2511.21631
- Qwen2.5-VL Technical Report（绝对坐标）— https://arxiv.org/abs/2502.13923
- Design2Code（block-match / 位置 / 颜色 / CLIP 指标定义）— https://arxiv.org/html/2403.03163v3
- AutoPresent（render-feedback refine）— https://openaccess.thecvf.com/content/CVPR2025/papers/Ge_AutoPresent_Designing_Structured_Visuals_from_Scratch_CVPR_2025_paper.pdf
- PaddleOCR-VL — https://arxiv.org/abs/2510.14528 ／ https://huggingface.co/PaddlePaddle/PaddleOCR-VL
- OmniDocBench v1.5 榜单 — https://benchmarklist.com/benchmarks/omnidocbench_1_5/

**官方定价 / 规格（2026-10-20 抓取）**
- 阿里云百炼 模型调用价格 — https://help.aliyun.com/zh/model-studio/model-pricing
- 阿里云百炼 视觉理解（**32×32 px/token、max_pixels 默认 2,621,440**）— https://help.aliyun.com/zh/model-studio/vision
- qwen3-vl-plus 规格（262,144 上下文 / 32,768 输出）— https://www.alibabacloud.com/help/zh/model-studio/qwen3-vl-plus
- 火山方舟 模型价格 — https://www.volcengine.com/docs/82379/1544106
- Doubao-Seed-1.6-vision 模型页（256K 上下文 / 64K 输出 / 0.8-8 元）— https://ark.volcengine.com/region:cn-beijing/model/detail?name=doubao-seed-1-6-vision
- 智谱 BigModel API 定价 — https://docs.bigmodel.cn/cn/guide/start/pricing
- GLM-4.6V 模型文档 — https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v

**参考实现**
- figedit（manifest + 差异热力图 + 分块评分）— https://github.com/giszzt/figedit
- px-image2pptx（OCR + 文本掩膜 + LaMa + 文本框；CJK 全角 em 度量）— https://github.com/JadeLiu-tech/px-image2pptx
- MinerU2PPT（MinerU JSON → pptx）— https://github.com/JuniverseCoder/MinerU2PPT
- image2editable（SAM2.1-L + big-lama + GroundingDINO + PaddleOCR，带 benchmark 门禁）— https://github.com/DSY-Xueai/image2editable
- slide-alchemy（生成式清版底图 + 组件分类）— https://github.com/CodingFeng101/slide-alchemy

**本地核验**
- `fontTools` 读 `OS/2.fsType`：PingFang SC = 4、Songti SC = 2、Hiragino Sans GB = 8、Noto Sans CJK SC = 0（2026-10-20，本机 macOS）。
- `fontTools` / 官方 token 规则交叉验算：1920×1080 → Qwen 2,025 tok / Doubao 2,691 tok。
