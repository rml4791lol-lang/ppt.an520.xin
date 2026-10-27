# H · 源码级拆解：图片 → 可编辑 PPTX 的六个开源实现

> 调研时间：2026-10-20
> 方法：`gh api` 拉目录树 + `git clone --filter=blob:none --sparse` 拉全部 .py + 本机 python-pptx 1.0.2 API 实测
> 所有行号对应当前 main/master HEAD

---

## 0. 结论先行（给决策者）

1. **没有任何一个项目是"全自动高质量"的。** 六个项目分成三种范式：
   - **纯文本范式**（px-image2pptx）：只把文字抠出来 + LaMa 补底图，**完全没有元素分类、没有图形重建、没有渲染回环**。约 1100 行 Python。
   - **结构映射范式**（MinerU2PPT、image2editable）：依赖版面分析/OCR 给出结构，再映射成 textbox + 图片块。表格/公式/图表**一律降级为位图裁剪**。
   - **Agent 生成范式**（figedit、slide-alchemy、cell-ppt）：**矢量化不是算法，是 LLM/多模态模型写 SVG 或调付费 API**。开源的部分是"SVG/geometry → 原生 DrawingML"这一层。
2. **真正值得抄的代码只有三块**：figedit 的 `scripts/svg_to_pptx/`（工业级 SVG→DrawingML，190KB）、image2editable 的 `scripts/ppt_assemble.py` + `render_qa.py`（中文安全组装 + "不差于栅格"门禁，57KB）、MinerU2PPT 的 `ir_merge.py` + `ocr_merge.py`（文本行/段落重建，60KB）。
3. **位图→矢量路径的自动 tracer，六个项目里一个都没有。** 想省事只有两条路：卖 API（cell-ppt 的小喵）、或让 VLM 写 SVG（figedit）。
4. MVP 3–5 人日，可用产品 25–35 人日，对齐 image2editable/figedit 级 60–80 人日。

---

## 1. 项目档案

| 项目 | ★ | License | 代码量（Python） | 真实能力边界 |
|---|---|---|---|---|
| JadeLiu-tech/px-image2pptx | 39 | MIT | ~1.1k 行 / 41KB（6 文件） | 只做**文字**。无形状、无图标、无分类、无回环 |
| JuniverseCoder/MinerU2PPT | 199 | **无 LICENSE**（法律上不可商用/不可分发衍生） | ~8.5k 行 / 170KB（7 文件，`ocr_merge.py` 45KB + `generator.py` 42KB 占一半） | MinerU JSON → textbox + 位图裁剪；**需 PyQt GUI 依赖**；表格/公式/图表全降级位图 |
| DSY-Xueai/image2editable | 56 | MIT | ~45k 行 / 1.7MB（`image2editable/` + `scripts/`） | 最完整工程：状态机 + SAM2/LaMa/GroundingDINO + Agent 决策 + LibreOffice 回环 |
| giszzt/figedit | 189 | MIT | ~15k 行 / 600KB（`svg_to_pptx/` 190KB 是核心） | SVG→原生 PPT 转换器质量最高；但"矢量化"= VLM 写 SVG，不是 tracer |
| CodingFeng101/slide-alchemy | 45 | MIT | skills 目录 ~60KB（7 脚本 + 12 文档） | 纯 Agent 工作流规范 + 4 个轻量脚本；`simple_svg_to_pptx.py` 只有 150 行 |
| yrui-cmd/cell-ppt | 61 | MIT | ~2k 行（scripts 90KB） | 开源部分 = **绘制层**；矢量化是**付费云 API**（小喵） |

**关键法务结论**：除 MinerU2PPT 外全部 MIT，可商用可改。MinerU2PPT 无 license → 只能读思路，不能复制代码（默认版权保留）。

---

## 2. 逐项目拆解

### 2.1 px-image2pptx —— 最干净的自研参考（但比宣传的少一半）

**流水线（`px_image2pptx/pipeline.py:image_to_pptx()`，5 步，无分支）**

```
ocr.py:run_ocr()  →  textmask.py:compute_masks()  →  inpaint.py:inpaint()  →  assemble.py:assemble_pptx()
```

| 环节 | 函数 | 干了什么 | 实现细节 / 坑 |
|---|---|---|---|
| OCR | `ocr.py:run_ocr()` / `_get_ocr()` | PaddleOCR 3.x `predict()`，取 `dt_polys/rec_texts/rec_scores`，四点框压成轴对齐 bbox | **不是 PP-OCRv5 显式指定**，只是 `PaddleOCR(lang=..., use_textline_orientation=False, use_doc_orientation_classify=False, use_doc_unwarping=False)`，三个开关全关以提速。`_ocr_cache` 按 lang 缓存实例。lang="auto" 直接退化成 "ch" |
| 文字掩膜 | `textmask.py:detect_text_ink()` | 纯 CV：`adaptiveThreshold` ∩ `Otsu` → 闭运算 → 连通域过滤（面积/密度/大块剔除）→ Canny 边缘回补 → 再过滤 | 6 个魔数（`sensitivity=16`、`block_size=25`、`max_component_pct=2.0`、`density>0.9 且 area>500` 剔除实心块、`edge_neighborhood=15`、`min_final_area=10`）。**对"深色底白字"会漏**（Otsu 反相后文字变背景） |
| 掩膜裁剪 | `textmask.py:clip_mask_to_ocr()` | 把 textmask 与 OCR bbox（padding 15px）做 `np.minimum` | **这是全项目最聪明的一步**：用 OCR 当 mask 的硬约束，避免把插画轮廓/表格线当文字抠掉。README 专门强调这点 |
| 补底图 | `inpaint.py:inpaint()` | `simple-lama-inpainting` 的 TorchScript 模型，`download_model(LAMA_MODEL_URL)` + `torch.jit.load` | 设备优先级 **mps → cuda → cpu**；`max_size` 会先 LANCZOS 缩小再 NEAREST 缩 mask、出结果再放大回原尺寸（大图省显存）。模型全局缓存 `_cached_model` |
| 组装 | `assemble.py:assemble_pptx()` | 见下 | 只调 `add_textbox` + `add_picture`（背景）+ `slide.background.fill`（纯色底） |

**组装层的关键函数**

- `SlideMapper`（`assemble.py:28`）：`ppi = img_w / slide_w`；幻灯片尺寸按图片长宽比自动选 `13.333×7.5`(>1.5) / `10×7.5`(>1.2) / `10×10/aspect`。`to_emu(px) = px / ppi * 914400`。
- `group_text_lines()`：两遍聚类。先按中心 y 聚成行（阈值 `0.6 × 行高`），再按 x 间距切列（阈值 `3.0 × 中位行高`）。**防左右分栏被合并成一个框**。
- `group_to_text()`：行内按 x 排序用 `" "` 拼；多行用 `\n` 拼。注意中文行内也插空格（会造成"字 间 距"伪影）。
- `estimate_text_width_pt()`：**混排度量**——CJK 每字算 `1.0 × font_pt`，Latin 用 PIL `ImageFont.getlength()` 按 `font_pt/72` 缩放。无字体时退化为 0.5em/字。
- `autoscale_font()`：先按行高定初值，再"缩到 ≤94% 宽"、"涨到 ≥90% 宽"各最多 40 轮，步长 1pt。**没有考虑 word_wrap 后的多行**。
- `detect_text_color()`：策略 1 = tight_mask 墨迹像素中位数；若与背景色距离 < 40 则走策略 2 = 取与背景差异最大的 80 分位像素中位数（救白字深底）。**没有 alpha 处理**。
- `detect_bg_color()`：采四边 20px 边框，标准差 < 25 判为纯色底 → 用 `slide.background.fill.solid()`，**不生成底图**（文件更小）。

**装配 API 清单（全部 python-pptx 原生）**：`add_textbox / add_picture / text_frame.word_wrap / margin_* = 0 / paragraph.font.size / font.color.rgb / prs.slide_width|height / slide_layouts[6]`。

**没有的**：元素分类、形状、图标、custGeom、渲染回环、SVG、多页、PPTX 输入。README 的 "Chart with labels" 只是说图表楔形因为 textmask 不触发而被保留在底图里——**不是把图表重建成图表**。

---

### 2.2 MinerU2PPT —— 架构最值得抄，但无 license

**架构：`MinerU JSON → (MinerUAdapter) → 统一 IR → (ir_merge 行合并) → (ocr_merge OCR 校正) → (PPTGenerator) → PPTX`**

**统一 IR（`converter/ir.py`）只有两种元素**：`TextIR` / `ImageIR`。这点极简，值得抄。

```
TextIR(type, bbox, text, source, order, style{bold,font_size,align},
       is_discarded, is_watermark, group_id, text_runs, lines)
ImageIR(type, bbox, source, order, style, ... text_elements, crop_pixels)
```

**映射规则（`adapters/mineru_adapter.py`）—— 这是最有价值的部分**

| MinerU type | 去向 | 规则 |
|---|---|---|
| `text/title/caption/footnote/footer/header/page_number` | `TextIR` | `title` 强制 `bold=True` |
| `list` | 拆成**多个** `TextIR` | 每个 `blocks[]` 一个文本框，共享 `group_id="mineru-list-{index}"`（保证列表项可单独拖动） |
| `table/figure/formula/chart` | **`ImageIR`** | ⚠️ 全部当图片！从 300dpi 页面栅格里裁像素 |
| `image` | `ImageIR` + caption | `image_body` block 的 bbox 覆盖容器 bbox；`image_caption` 单独出 TextIR |
| `discarded_blocks` | 同上但 `is_discarded=True` | 渲染时跳过（页眉页脚/页码） |
| 未知 type | **当 ImageIR** | 注释原话："保留视觉占位而不是静默丢弃或崩溃" |
| 水印 | `_WATERMARK_TEXT_PATTERNS = {"notebooklm"}` | 硬编码字符串匹配 + `is_watermark` 字段，渲染时剥除 |

**行/段落重建（`converter/ir_merge.py`）** —— 这是"看起来像 PPT 而不是一堆碎框"的关键

- `_split_members_into_lines()`：按 `_bbox_same_line()` 把同 baseline 的碎块分行
- `_merge_lines_by_geometry()`：行内合并 → 产出 `lines[]`（带 bbox）
- `_build_text_runs_from_merged_lines()`：每行 → 一个 run，保留 bbox
- `_merge_overlay_text_fragments_by_base_overlap()`：处理"文字压在图形上"的叠层文本
- `_inherit_overlay_bold_from_base()`：叠层继承底层粗体

**OCR 二次校正（`converter/ocr_merge.py`，45KB，全项目最脏最值钱）**

MinerU 的 bbox 经常和实际墨迹错位，所以它**再跑一遍 PaddleOCR 来校正 MinerU 的 bbox**：
- `OCR_BBOX_PAD_RATIO = 0.2`、`OCR_FONT_DISTANCE_THRESHOLD = 60.0`（lite 版 50）
- `ROW_NON_BG_DISTANCE_THRESHOLD = 55.0`：按行扫描非背景像素定真实字高
- `OCR_REFINE_MIN_PIXEL_RATIO = 0.005`：校正区太小就不动

**字号归一化（`generator.py:_normalize_page_text_font_sizes()`，有专门文档 `docs/core-flow/font-size-normalization-pre-render.md`）**

1. 元素内 `max/min ≤ 1.3` 才 eligible（先把元素内部 run 的字号统一）
2. 按 **bold 分桶**（粗体/常规分开聚类）
3. Stage A：按 `size` 中心距离 ≤ ratio 1.3 聚类；Stage B：以 A 的簇数 K 在 **log-size 空间做 1D K-means**；验证失败回退 A
4. 每簇 ≥2 个元素 → 取**中位数并四舍五入到整数 pt**，写回 `elem.style.font_size` 与所有 run

> 这一招治的是"OCR 出来的字号 17.3/17.5/18.1 混杂，PPT 里看起来像没对齐"。**强烈建议抄。**

**渲染（`generator.py`）**
- `_create_textbox()`：坐标全部 `Pt(x * coords['scale_x'])`，`coords = {scale_x, scale_y, json_w/h, img_w/h}`；slide 尺寸 `Pt(w_pts)`，即 **1 JSON pt = 1 slide pt**，页面多大 slide 多大
- `_render_text_from_data()`：`margin=0`、`word_wrap=True`、`PP_ALIGN.LEFT`；**单行文本把框向右放宽 1.2 倍**防止字体差异导致换行（实用小技巧）；默认字体硬编码 `"Microsoft YaHei"`
- `_add_picture_from_bbox()`：从页面栅格裁 `img_h/json_h` 换算的像素块，存临时 PNG 再 `add_picture`（**不是用 crop**）
- `_cleanup_text_on_image_crop()`：图片块里压着的文字要用背景色抹掉，margin 由 `TEXT_CLEANUP_MIN_MARGIN_PX` 和行高比例算

---

### 2.3 image2editable —— 工程最完整，MIT，最值得整段抄

**`convert()` 就是两段：`prepare_job()` + `run_job()`（`runtime.py:3194`）**。不是一条线性流水线，是**"运行目录 + 状态机 + 证据链"**：

```
run_dir/
  job_manifest.json  run_state.json  page_jobs.json  execution.lock
  pages/<page_id>/
    agent_request.json  screenshot_candidates.json  native_objects.json
    decision.json  page_request.json
    reconstruction/component_state.json  qa.json  ...
  final/output.pptx
```

**模块划分（`image2editable/`，45 个文件）**

| 文件 | 职责 |
|---|---|
| `runtime.py` (121KB) | 门面：`convert/prepare_job/run_job/get_status/retry_page`，性能埋点，流水线编排 |
| `legacy.py` (194KB) | 图片/PDF 的旧版逐页重建主流程（`assemble_legacy_results():4009`） |
| `component_repair.py` (190KB) | **修复循环状态机**（`advance_component_repair():97`） |
| `component_quality.py` (58KB) | **质量门禁**（`validate_component_quality_report():128`） |
| `component_contracts.py` (43KB) | **`MAX_REPAIR_ROUNDS = 5`（第 8 行）**、`MAX_COMPONENT_PROMPT_POINTS = 256` |
| `render_qa.py` (9.6KB) | **渲染回环指标**（`compare_rendered_page():180`） |
| `libreoffice_renderer.py` (6.4KB) | **LibreOffice 渲染**（`discover()` / `render_page()`） |
| `route_execution.py` (25KB) | **原生/栅格路由 + 渲染验收**（`_render_plan():455`、`_evaluate_native_plan():482`） |
| `pptx_input.py` (73KB) | 混合 PPTX 解析：`pic/sp/grpSp/cxnSp/contentPart` 全类型盘存 |
| `agent.py` (19KB) | Agent 决策协议：`REPLACE_CONFIDENCE = 0.92`，8 类 `CATEGORIES` |
| `pdf_input.py` / `inputs.py` / `store.py` / `execution.py` | PDF 光栅化 / 输入识别 / JSON store / 文件锁 |

**`scripts/` 下的模型层（真正的 CV 重活）**

| 脚本 | 用途 |
|---|---|
| `sam_worker.py` (78KB) | **SAM2 隔离 worker**：`create_sam_generator()` + `generate_mask_candidates()` + `generate_prompted_mask_candidates()`（点/框提示）+ `recheck_visual_element_holes()`（补洞） |
| `visual_segment.py` (90KB) | SAM2 之上的"视觉元素"抽象与掩膜候选合并 |
| `object_detect.py` (11KB) | **GroundingDINO** 文本提示检测（产出 `ObjectProposal`） |
| `lama_inpaint.py` (7.7KB) | **big-lama** 大区域修复（`resolve_runtime_model_path("big_lama")`） |
| `bg_model.py` (43KB) | 底图重建（决定哪块算背景） |
| `fg_extract.py` (48KB) | 前景抠图（透明 PNG 组件） |
| `ppt_assemble.py` (38KB) | **最终组装器**（见 4 节） |
| `text_detect.py` / `ocr_worker.py` / `font_match.py` / `art_text.py` | 文本检测 / OCR / 字体匹配 / 艺术字 |
| `component_underlay.py` (26KB) | 组件垫底层（z 序底图） |
| `worker_pool.py` / `worker_resources.py` | 进程池 + 资源/超时/沙箱 |

**SAM2 用来干什么**：把页面切成**可独立移动的视觉元素**（图标、插画、卡片底座），输出透明 RGBA 组件 + 掩膜候选；配 GroundingDINO 做"我提示某个物体"的框选。
**big-lama 用在哪一步**：组件从底图上"抠走"之后，**回填底图窟窿**（`lama_inpaint.py` 的 docstring 原话："LaMa adapter for repairing large masked image regions"）。注意：它修的是**组件移除后的洞**，不是"去字"。

**修复循环（最多 5 轮）的实现**

- `component_contracts.py:8` `MAX_REPAIR_ROUNDS = 5`
- `component_repair.py:advance_component_repair()`：读 `component_state.json` 的 `repair_round`，`>= 5` 直接进 fallback（`require_parent_fallback()`）
- `record_component_quality():929` 写本轮质量报告；`record_next_component_request():962` 发下一轮请求，内部再次检查 `repair_round >= MAX_REPAIR_ROUNDS` 就抛 "cannot publish round 6 after 5 rounds"
- 每轮必须带 **plan_count / history**（`component_contracts.py:128` 校验 `0 <= plan_count <= 5`，`len(history) <= 5`）→ **方案重复或没改善就提前终止**（README 明确写了"无改善或方案重复时提前停止该路径"）
- 停止后 `status = "preserved_with_warning"`，页面保留原栅格；若输入是图片/PDF 且任何页 warning → `assemble_legacy_results()` **直接拒绝产出 PPTX**（"editable reconstruction incomplete; no PPTX was created"）。这是硬门禁，不是软警告。

**质量门禁指标（`component_quality.py`）**

指标名直接写在 `_QUALITY_METRIC_KEYS`（第 116 行附近）：
```
orphan_residual_pixels        # 无主残留像素（谁都没认领的墨迹）
text_support_pixels           # 文字支撑像素
text_duplicate_ratio          # 文字重复率（同一处文字既在组件里又在文本框里）
component_text_residual_ratio # 组件内残留文字比例 ← "漏字"检查
background_text_residual_ratio# 底图残留文字比例     ← "鬼影"检查
```
辅助：`calibrate_page(source, text_mask)` 算每页的 halo 阈值（`text_halo_px=1`）；`resolve_visual_mask_ownership()` 判定掩膜归属（组件 vs 底图）；`absorbed_leaf_cluster_count()` / `_same_absorbed_entity()` 用 0.8/0.95/0.67 覆盖率做"是否同一实体"判定。

> 三件事对应关系：
> - **残影/鬼影** → `background_text_residual_ratio`（底图上还有字）
> - **漏字** → `text_duplicate_ratio` + OCR 文本集合比对（`render_qa._text_metrics`）
> - **残留** → `orphan_residual_pixels` / `component_text_residual_ratio`

**渲染回环（最值得抄的架构，`route_execution.py`）**

```
1. raster_plan   → assemble → render → 得到 baseline
2. 再渲一次 baseline（同一个 raster plan）→ 得到 repeated
   noise = metrics(baseline, repeated)          # 用"自己跟自己的差异"当噪声容限
3. native_plan   → assemble → render → candidate
4. QA = compare_rendered_page(source, baseline, candidate, repeated, regions, ocr...)
   通过条件：candidate 的每个误差指标 ≤ baseline + noise + 1e-12，且 SSIM ≥ baseline - (1-noise.ssim)
5. 不通过 → failed_object_ids 里的对象降级成 raster → fallback_plan → 重渲 → 再过一次 QA
6. 还不过 → 整页退回 raster（保真但不可编辑）
```

**这才是正确思路：不是"跟原图比有多像"，而是"编辑版能不能不比栅格版更差"**——把不可编辑的栅格当 upper bound。

`render_qa.py` 的指标（`_metrics()`）：`normalized_mae`、`changed_ratio`（Δ>8 的像素占比）、`ssim`（手写全局 SSIM，不是滑窗）、`edge_symmetric_difference_ratio`（Canny 100/200 的对称差/并集）、`largest_error_region_ratio`（最大连通误差块占比）。
文本检查（`_text_metrics()`）：OCR 文本 **NFKC + casefold + 空白折叠**后比多重集合（不等 → `text_mismatch`），再按文本配对算 bbox IoU，`min IoU < 0.8` → `text_alignment_mismatch`。

**渲染器**：`LibreOfficeRenderer` 用 `soffice --headless --convert-to 'pdf:impress_pdf_Export:{"PageRange":...}'` + `pypdfium2` 栅格化；带 `-env:UserInstallation=file:///tmp/...` 隔离 profile；`_run_office()` 用 psutil 监控子进程 CPU/IO，**300 秒无活动判死**并杀进程树。Windows 上另有 `PowerPointRenderer`（COM）备选。

---

### 2.4 figedit —— 原生 PPT 转换质量最高（MIT，189★）

**核心认知纠偏：它不是"矢量化"，是"VLM 写 SVG + 确定性转换"。**

`SKILL.md` 第一原则原话：**"输出画面上的每一块像素只可能有四个来源：SVG 画的 / 从源图切的 crop / AI 生成的 / 整块保留的"**。所以：

- 没有 potrace、没有轮廓追踪、没有颜色量化
- "矢量化" = 多模态模型读图 → 写 `manifest.json`（元素清单：bbox、颜色、字号、`decision: redraw|crop|regenerate|preserve-raster`）→ `build_svg_from_manifest.py` 组装 SVG
- 有**重绘门槛**（明确写在 SKILL.md）："只有用三五笔基础图元能画得像的图形才允许 redraw……有定制轮廓、渐变、阴影、多色细节、品牌或角色身份的对象一律按素材处理"

**SVG→PPT 的两条路**

| 路径 | 实现 | 产物 |
|---|---|---|
| **compat（默认）** | `pptx_slide_xml.py:create_slide_xml_with_svg()` | 整页一张 `p:pic`，`a:blip` 主 rel 指 PNG，`extLst` 里塞 `asvg:svgBlip` 指 SVG。**PowerPoint 优先用 SVG，旧版回退 PNG** |
| **native（`use_native_shapes=True`）** | `drawingml_converter.py` → `drawingml_elements.py` | 每个 SVG 元素一个 `p:sp`，直接用 DrawingML 字符串拼 |

**native 路径的模块分工（这就是"能不能抄"的答案）**

| 文件 | 大小 | 内容 |
|---|---|---|
| `drawingml_elements.py` | 68KB | 每种图元一个转换器：`convert_rect:186`、`convert_circle:380`（含 `_is_donut_circle`）、`convert_line:483`、`convert_path:611`、`convert_polygon:689`、`convert_polyline:744`、`convert_text:1014`、`convert_image:1614`、`convert_ellipse:1741`、`convert_nested_svg:1794` |
| `drawingml_paths.py` | 13.8KB | SVG path `d` 解析 → `a:path` 命令 |
| `drawingml_styles.py` | 22KB | 填充/描边/透明度/渐变/effectLst |
| `drawingml_utils.py` | 15.9KB | `parse_font_family():389` 把 CSS font-family 拆成 latin/ea |
| `pptx_builder.py` | 37.7KB | 先用 python-pptx 建空壳 → 解 zip → 替换 slide XML → 重打包（`create_pptx_with_native_svg():330`） |
| `pptx_dimensions.py` | 3.4KB | **`EMU_PER_PIXEL = 914400/96 = 9525`** |
| `pptx_slide_xml.py` | — | svgBlip / 转场 / 动画 |
| `pptx_math.py` | 16.7KB | **OMML 公式注入**（`MML2OMML.XSL` + `Cambria Math`），失败自动回退成矢量 |

**几个直接能抄的硬技术点**

1. **圆角矩形椭圆角 custGeom**（`_build_round_rect_custgeom():94`）：用 `arcTo` 四段拼；四角半径不同也能做。`prstGeom prst="round2SameRect"` 只是两角。
2. **环形/甜甜圈弧段**（`_build_arc_ring_path():278` + `_is_donut_circle():354`）：`custGeom` 双弧 + 内外半径。
3. **文字 XML**（`_build_run_xml():970`）：
   ```xml
   <a:rPr lang="zh-CN" sz="..." b="1" dirty="0">
     <a:latin typeface="..."/><a:ea typeface="..."/><a:cs typeface="..."/>
   </a:rPr>
   ```
   `sz = round(fs_px * 75)`（px → 1/100 pt）。`xml:space="preserve"` 只在首尾空白或双空格时加。
4. **行高/段距**（`convert_text():1206`）：SVG `dy` px → `<a:lnSpc><a:spcPts val="{round(px*75)}"/></a:lnSpc>`；行间额外空隙 → `<a:spcBef><a:spcPts .../></a:spcBef>`。**用 spcPts 而不是 spcPct，能精确复刻像素行高**。
5. **bodyPr 的"该不该 autofit"**（源码注释直接写了坑）：
   - 单行：`wrap="none"` + `<a:spAutoFit/>`（贴合文字）
   - 多段：`wrap="square"` + **绝不加 spAutoFit**，否则"PowerPoint 会把框撑爆到一行"
   - 两者都 `lIns/tIns/rIns/bIns="0" anchor="t"`
6. **图片像素级裁剪**（`_compute_slice_src_rect():1482` / `_resolve_image_src_rect():1528` / `_resolve_image_meet_fit():1563`）：写 `a:srcRect l/t/r/b`（千分之一百分比）+ `a:stretch`，比 python-pptx 的 `crop_*` 精确。
7. **公式**：`pptx_math.py` 把 LaTeX → MathML → OMML 注入 `a14:m`，字体 `Cambria Math`（latin+ea+cs 三处都设）。

**质量门禁（`quality_audit.py`）**：`_crop_window_gate():250`（裁剪窗是否污染）、`_text_math_layout_gate():423`（文字/公式是否重叠）、`_background_plate_gate():474`、`_ai_patchwork_gate():100`、`_raw_detector_import_gate():184`（**禁止用 rembg/GrabCut 等即兴抠图**）、`_ocr_fallback_gate():384`。渲预览用 Chrome headless（`_find_chrome():24`）或 `render_pptx.py`。

---

### 2.5 slide-alchemy —— 分类策略最清晰，代码最薄（MIT，45★）

**组件化三分类（`SKILL.md` 第 5 步，落点在 `references/element-classification.md`）**

| 类别 | 判据（原文要点） | 落地方式 |
|---|---|---|
| `simple_geometry_svg_ooxml` | 非语义布局几何：直线、分隔线、星形、圆、环、圆角矩形、卡片底座、标题条、简单边框、电路线装饰 | 先生成 SVG → `simple_svg_to_pptx.py` 转原生形状 |
| `icon_png` | 独立示意/语义图标：奖杯、花、书、手/心、电脑、链条、组织徽章、App 图标、人、设备、建筑——**即使是简单线稿也留 PNG**（除非是纯图元） | 图像生成模型出"色键版" sheet → 抠图 → 切片 |
| `complex_png_whole` | 拆了就变丑的复合视觉：漩涡、层叠徽章、重渐变、发光组合、插画 | 整块一张 PNG，不拆 |

**底图重绘用哪个模型**：**图像生成/编辑模型（不是 LaMa）**。SKILL.md 把它列为强制项："clean base generation with an image generation/editing model"，并**明令禁止**用本地白块遮罩、inpainting、直接裁源图、PPT 原生形状近似来替代。prompt 模板在 `references/base-prompt-template.md`（保留外圈背景/边缘装饰/环境质感，去掉所有文字、图标、卡片、标题条）。

**合成顺序（硬约束）**：`base PNG → SVG/OOXML 几何 → PNG 图标 → 可编辑文本框`。四个脚本：
- `simple_svg_to_pptx.py`（150 行）——**最小可用 SVG→形状映射器**：`viewBox` → `Inches((x-vb_x)/vb_w*slide_w)`，逐个 `rect/line/ellipse/polygon/polyline` 映射到 `add_shape`，10/11 点的 polygon 识别成星形，线宽用 `Pt(stroke-width)`。没有 path、没有贝塞尔、没有文字。
- `compose_component_pptx.py`（4.9KB）——读 compose spec JSON 按层合成
- `compare_preview.py`（1.4KB）——**纯 PIL**：`ImageChops.difference` → `autocontrast` → `colorize(黑→红)` 热图 + side-by-side。**没有任何数值指标**，靠人眼
- `slice_asset_sheet.py` / `inspect_edges.py` / `build_contact_sheet.py`——色键 sheet 切片 + 触边检查 + 联络表

**两个硬 review gate**：base grouping、base preview。非 unattended 模式下必须停下来等人批。

---

### 2.6 cell-ppt —— Windows COM 与 macOS OOXML 双路（MIT，61★）

**定位**：科研矢量图 → PPT **freeform**。输入是 SVG + manifest（文字清单），不是位图。**矢量化外包给付费云 API**（`xiaomiao.py` / `vectorize_xiaomiao.py`，额度要在小红书/抖音找作者买）。开源的是绘制层。

**两条路（`references/backends.md` 写得很清楚）**

| | Windows COM | macOS OOXML |
|---|---|---|
| 入口 | `run_cell_ppt.ps1`（12.5KB） | `run_cell_ppt_ooxml.py`（10KB） |
| ProgID | `PowerPoint.Application`（无版本号）；WPS 试 `KWPP.Application` / `WPP.Application` | 不用 COM |
| 画路径 | `Shapes.BuildFreeform`，**逐条提交**，每条之后 `BringToFront` + 重绘 + **固定 8ms 延时**（让人看见逐笔画出） | 一次性 append 到保存好的 `.pptx`，原子保存 |
| 写文字 | `Shapes.AddTextbox` | 原生 textbox |
| 坐标系 | 直接用 slide 的 points | **`PATH_EXTENT = 100000`**：把所有点归一化到 `a:path w=100000 h=100000`，再靠 `a:xfrm` 的 `off/ext` 定位 |
| 顺序 | 按 SVG paint order（**从后往前**），不按语义分类 | 同 |

**OOXML 路径的核心（`add_freeform()`，40 行，可直接抄）**
```python
mapped = [{"a":…, "l":…, "r":…}]        # 每点：anchor + 左右控制柄（三次贝塞尔）
# 控制柄 == anchor → a:lnTo；否则 a:cubicBezTo
# 每段先算 bbox，再 local(p) 归一化到 0..100000
xml = <p:sp>…<a:custGeom><a:pathLst><a:path w=100000 h=100000>…
slide.shapes._spTree.insert_element_before(parse_xml(xml), "p:extLst")
```
- 填充：`a:solidFill/a:srgbClr` + `a:alpha`（`opacity*1000`，满值不写）
- 描边：`a:ln w=...`（`max(3175, strokeWidth*scale*12700)`，3175 EMU = 0.25pt 下限）
- **`insert_element_before(..., "p:extLst")` 是标准做法**：保证新形状在 `p:extLst` 之前、其他形状之后 → 天然置顶

**其它可抄的小工具**
- `prepare_geometry_cache.py`（32KB）：SVG → `geometry-cache.json`，**按 subpath 级**展开（一个 `<path>` 多个子路径分别成对象）
- `cull_hidden_geometry.py`：只删完全重复的绘制路径，**保留被遮住的非重复路径**
- `merge_live_text.py`：把识别出的文字合并回 SVG `<text>`（先清字再画图，避免文字被当路径）
- `validate_vector_svg.py` / `validate_manifest.py`：拒绝渐变、掩膜、裁剪、外链资源、栅格节点
- 兼容边界（明确写死）：**纯色填充、纯色描边、三次贝塞尔、基本透明度、旋转、文本框**；渐变/掩膜/裁剪/图案/外链/嵌入位图/复合孔洞一律预处理或显式拒绝。**永不把整图当图片塞进去充数**

---

## 3. 模块 → 实现 → 代码位置 → 工作量 映射表

> 工作量 = **自研**所需人日（1 人 = 1 天 = 6 有效小时）。"抄"列给的是可直接复用的代码位置。

| # | 模块 | 最佳参考 | 代码位置 | License | 能直接用？ | 自研人日 | 抄改人日 |
|---|---|---|---|---|---|---|---|
| 1 | 图片/PDF/PPTX 输入与栅格化 | image2editable | `inputs.py`、`pdf_input.py`、`pptx_input.py`(73KB) | MIT | PDF 部分可用；PPTX 盘存太重 | 6–8 | 2–3 |
| 2 | OCR（中英混排） | px-image2pptx | `ocr.py`（120 行） | MIT | **可直接用** | 1–2 | 0.3 |
| 3 | 文本像素掩膜（找墨迹） | px-image2pptx | `textmask.py`（180 行） | MIT | **可直接用** | 2–3 | 0.5 |
| 4 | 掩膜∩OCR 裁剪（防误抠） | px-image2pptx | `textmask.py:clip_mask_to_ocr()` | MIT | **可直接用**，20 行 | 1 | 0 |
| 5 | 去字补底图（LaMa） | px-image2pptx | `inpaint.py`（100 行） | MIT | **可直接用** | 1–2 | 0.5 |
| 6 | 组件级语义分割（SAM2） | image2editable | `scripts/sam_worker.py` + `visual_segment.py` | MIT | 可移植，但依赖权重/GPU | 15–20 | 5–7 |
| 7 | 文本提示检测（GroundingDINO） | image2editable | `scripts/object_detect.py` | MIT | 可选，能省不少 | 5 | 2 |
| 8 | **文本行/段落重建** | **MinerU2PPT** | `ir_merge.py`(15KB) + `ocr_merge.py`(45KB) | **无 license** | **只能读思路，不能抄代码** | 8–10 | 模式重写 4–5 |
| 9 | OCR 二次校正 bbox | MinerU2PPT | `ocr_merge.py` 常量区 | 无 license | 同上 | 5 | 3 |
| 10 | 字号归一化（K-means 聚类） | MinerU2PPT | `generator.py:401` `_normalize_page_text_font_sizes` | 无 license | 思路可抄（非代码） | 2–3 | 1.5 |
| 11 | 字号拟合（PIL 度量） | image2editable / px | `ppt_assemble.py:833` `_fit_ocr_font_size`；`assemble.py:autoscale_font` | MIT | **可直接用** | 2 | 0.5 |
| 12 | **元素分类 / 路由** | slide-alchemy（规则）+ image2editable（Agent 决策） | `SKILL.md` 第 5 步；`agent.py` | MIT | 只有规范，无算法 | 6–8 | 3（写成 prompt） |
| 13 | 位图→矢量路径（tracer） | **无人开源** | — | — | 只能调付费 API（cell-ppt→小喵）或 VLM 写 SVG（figedit） | 15–25 | 接 API 2 |
| 14 | **SVG→原生 DrawingML** | **figedit** | `scripts/svg_to_pptx/`（8 文件 190KB） | MIT | **整目录可移植** | 20–25 | 3–5 |
| 15 | **pptx 组装器（全特性）** | **image2editable** | `scripts/ppt_assemble.py`(38KB) | MIT | **整文件可用** | 10–12 | 2–3 |
| 16 | 中文/东亚字体 fallback | image2editable + figedit | `ppt_assemble.py:1075` `_set_run_font`；`drawingml_elements.py:1007` | MIT | **可直接用** | 2–3 | 0.3 |
| 17 | **渲染回环 + diff 门禁** | **image2editable** | `render_qa.py`(9.6KB) + `libreoffice_renderer.py`(6.4KB) + `route_execution.py:482` | MIT | **可直接用** | 8–10 | 2–3 |
| 18 | 状态机/断点续跑/证据链 | image2editable | `runtime.py` + `store.py` + `execution.py` | MIT | 可抄但多数团队不需要 | 10–12 | 4–5 |
| 19 | 混合 PPTX 保留原生对象 | image2editable | `pptx_input.py` + `pptx_shadow.py` | MIT | 独立价值高 | 10–15 | 5–6 |
| 20 | 基准语料 + 回归门禁 | image2editable | `benchmarks/` + `scripts/release_benchmark.py` | MIT | 可参考组织方式 | 5–8 | 3 |

**汇总**

| 目标 | 模块组合 | 人日 |
|---|---|---|
| **A. 文字可编辑 + 干净底图**（px 级） | 1(图片) + 2 + 3 + 4 + 5 + 11 + 15(精简) | **3–5** |
| **B. 可用产品**（+ 几何形状 + 图标 + 中文排版 + 渲染门禁） | A + 14 + 16 + 12 + 17 | **25–35** |
| **C. 对齐 image2editable / figedit**（+ 语义分割 + Agent 路由 + 混合 PPTX + 基准） | B + 6 + 7 + 19 + 20 + 18 | **60–80** |

---

## 4. pptx 组装的硬技术点清单

> 全部以 **python-pptx 1.0.2 实测**为准（本机 `import pptx; pptx.__version__ == '1.0.2'`）。

### 4.1 总表

| # | 技术点 | python-pptx 能做？ | 做不了要写什么 XML | 参考实现 |
|---|---|---|---|---|
| 1 | 中文文字（ea 字体） | ⚠️ 半个：`font.name` **只写 `a:latin`** | `<a:ea typeface="微软雅黑"/><a:cs typeface="..."/>` 插进 `a:rPr` | image2editable `ppt_assemble.py:1075`；figedit `drawingml_elements.py:1007` |
| 2 | 自动换行 | ✅ `tf.word_wrap = True/False` | → `a:bodyPr wrap="square"/"none"` | px、MinerU2PPT 都用 |
| 3 | 字号自适应（autofit） | ✅ `tf.auto_size = MSO_AUTO_SIZE.SHAPE_TO_FIT_TEXT / NONE` | → `<a:spAutoFit/>` / `<a:normAutofit/>` | figedit `:1229` 注释写清"段落模式不能加 spAutoFit" |
| 4 | 行高 | ✅ `paragraph.line_spacing = 1.2` 或 `Pt(x)` | 浮点 → `a:lnSpc/a:spcPct`；Length → `a:spcPts` | figedit 用 spcPts 精确复刻像素行高 |
| 5 | 段距 | ✅ `paragraph.space_before/space_after = Pt(x)` | → `a:spcBef/a:spcAft/a:spcPts` | figedit `:1212` |
| 6 | 透明度（填充/线/文字/图片） | ❌ **完全无 API** | `<a:solidFill><a:srgbClr val="..."><a:alpha val="50000"/></a:srgbClr></a:solidFill>`；`val` 是千分之一百分比 | image2editable `ppt_assemble.py:1055` `_set_solid_fill_opacity` |
| 7 | 渐变 | ⚠️ 1.0.x 有 `fill.gradient()` / `gradient_stops` / `gradient_angle`；**0.6.x 完全没有**；**文字渐变一定没 API** | `a:rPr` 里用 `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">…` + `<a:lin ang="..." scaled="0"/>` 替换 `a:solidFill` | image2editable `ppt_assemble.py:975`（文字渐变） |
| 8 | 圆角矩形 | ✅ `MSO_SHAPE.ROUNDED_RECTANGLE` + `shape.adjustments[0] = 0.1`（0–0.5，四角同半径） | 四角不同半径/椭圆角 → `a:custGeom` + 四段 `a:arcTo` | figedit `_build_round_rect_custgeom():94`；`prst="round2SameRect"` 只有两角 |
| 9 | **任意多边形（含曲线）** | ⚠️ **半残**：`shapes.build_freeform()` 只有 `move_to` + `add_line_segments`，**没有任何贝塞尔 API** | 曲线必须手写 `<a:custGeom><a:pathLst><a:path w="100000" h="100000"><a:moveTo/><a:lnTo/><a:cubicBezTo><a:pt/><a:pt/><a:pt/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom>` | **cell-ppt `run_cell_ppt_ooxml.py:add_freeform()`（40 行，最干净的实现）**；figedit `drawingml_paths.py` |
| 10 | 连接线 | ✅ `add_connector(MSO_CONNECTOR.STRAIGHT, x1,y1,x2,y2)`；✅ **`connector.begin_connect(shape, idx)` 能真正粘附**（写 `a:stCxn`） | 肘形拐点、连接线透明度要 XML（`a:ln` 里插 `a:alpha`） | image2editable `ppt_assemble.py:751` |
| 11 | 组合 | ✅ `shapes.add_group_shape()`（1.0.x）；组内 `add_*` 坐标是**组坐标系** | group 的 `a:chOff/a:chExt` 缩放会漂；要精确就自己算 | image2editable `:1022` 用 group 承载"同一文本的多个 run 文本框" |
| 12 | **z-order** | ❌ 无 API（只能 `shapes._spTree` 手排） | 元素顺序即 z 序：`spTree.remove(el); spTree.append(el)` 或 **`insert_element_before(xml, "p:extLst")`**（置顶且不越界） | cell-ppt `add_freeform()` 末尾 |
| 13 | 表格（原生） | ✅ `add_table(rows, cols, left, top, width, height)` + `cell.text` + `cell.merge()` | 默认套 `Medium Style 2 - Accent 1`，要去掉得改 `<a:tblPr firstRow="0" bandRow="0"/>` + 显式 `<a:tblStyleId>`；**单元格边框无 API**，要 `a:lnL/lnR/lnT/lnB`；行高是"最小"不是"固定" | 六项目**全都没有原生表格**（全部降级位图），要自己写 |
| 14 | 内嵌 SVG（`asvg:svgBlip`） | ❌ `add_picture` 不接受 SVG | `<p:pic>` 里 `<a:blip r:embed="{png_rid}"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="{svg_rid}"/></a:ext></a:extLst></a:blip>`；需要 **2 个 media part + 2 条 rel + `[Content_Types]` 加 svg default** | **figedit `pptx_slide_xml.py:46-55`（含 compat 判定，完整可抄）** |
| 15 | 母版/版式 | ⚠️ 只能**选**：`prs.slide_layouts[i]`；**不能新建 layout/master** | 要新 layout 只能改 XML，或 `Presentation("模板.pptx")` 从模板起 | image2editable 走"操作现有 package"路线 |
| 16 | 图片裁剪 | ✅ `pic.crop_left/right/top/bottom`（**比例，非像素**） | 像素级精确 → `a:srcRect l/t/r/b`（千分之一百分比）+ `a:stretch` | figedit `_compute_slice_src_rect():1482` |
| 17 | 阴影/发光 | ❌ 只有 `shape.shadow.inherit = False`（关掉） | `<a:effectLst><a:outerShdw blurRad="..." dist="..." dir="..."><a:srgbClr val="..."><a:alpha val="..."/></a:srgbClr></a:outerShdw></a:effectLst>` | figedit `build_effect_xml()` |
| 18 | 数学公式（OMML） | ❌ | `<a14:m><m:oMath>…</m:oMath></a14:m>` 注入 `a:p`，字体 `Cambria Math` 且 latin/ea/cs 三处都设；LaTeX→MathML→OMML 需 `MML2OMML.XSL` | figedit `pptx_math.py`（含失败回退成矢量） |
| 19 | 字符间距 | ❌ 无 API | `rPr` 上加 `spc="{round(pt*100)}"`（1/100 pt） | image2editable `ppt_assemble.py:962` |
| 20 | 文本描边 | ❌ 无 API | `a:rPr` 里 `<a:ln w="..."><a:solidFill>…</a:solidFill><a:round/></a:ln>` | image2editable `_add_textbox` 内 |
| 21 | 旋转文本 | ✅ `shape.rotation`（度） | 90/270 时要**先交换 width/height 再摆位**，否则框错位 | image2editable `_add_positioned_text():1009` |

### 4.2 必须知道的三个"反直觉"

1. **`font.name` 不写 `a:ea`** → 中文会 fallback 到主题 minor East Asian 字体（常是宋体），跟你设的"微软雅黑"不一致。**这是中文 PPT 最普遍的翻车点**。
2. **`build_freeform` 只能画直线段**。所有"曲线/圆弧/贝塞尔"必须手写 `a:custGeom`。这条决定了自研曲线路径的工时是 0.5 人日还是 5 人日。
3. **段落模式加 `spAutoFit` 会把框撑爆**（figedit 源码注释亲测踩过）。单行用 `wrap="none"+spAutoFit`，多段用 `wrap="square"+不加 autofit`。

---

## 5. 坐标与单位换算

### 5.1 基本常数
```
1 inch = 914400 EMU = 72 pt
1 pt   = 12700 EMU
1 px@96dpi = 9525 EMU        # figedit: EMU_PER_PIXEL = 914400/96
```
python-pptx 的 `Inches()/Pt()/Emu()` 都是 `Length`（int 子类），混算安全。

### 5.2 三种坐标范式（选一个，别混）

| 范式 | 代表 | 公式 | 适用 |
|---|---|---|---|
| **ppi 归一** | px-image2pptx | `ppi = img_w_px / slide_w_in`；`emu = px / ppi * 914400` | 图片尺寸任意，slide 跟图片比例走 |
| **1:1 像素** | figedit | `slide_w_emu = viewBox_w * 9525`；`emu = px * 9525` | SVG 画布 = 幻灯片画布，**零留白零缩放**，最省心 |
| **pt 直映** | MinerU2PPT | `slide = Pt(json_w, json_h)`；`emu = Pt(x * scale_x)` | PDF 输入（PDF 单位本来就是 pt） |

### 5.3 归一化坐标（0–1000 / 0–1）→ 幻灯片
```python
def norm_to_emu(x_norm, y_norm, w_norm, h_norm, slide_w_emu, slide_h_emu, norm_max=1000):
    return (
        round(x_norm / norm_max * slide_w_emu),
        round(y_norm / norm_max * slide_h_emu),
        round(w_norm / norm_max * slide_w_emu),
        round(h_norm / norm_max * slide_h_emu),
    )
```
**坑**：0–1000 归一化会丢失原始宽高比信息；如果源图和幻灯片比例不同，必须显式做 letterbox（下条），否则会横向拉伸。

### 5.4 缩放与留白（contain / cover）
image2editable 给了完整实现（`scripts/ppt_assemble.py:96` `compute_contain_transform()` + `:53` `compute_slide_transform()`）：
```python
scale = min(slide_w / img_w, slide_h / img_h)     # contain：完整可见，留边
# 或 max(...)                                      # cover：铺满，裁切
offset_x = (slide_w - img_w * scale) / 2           # 居中留白
offset_y = (slide_h - img_h * scale) / 2
```
`_map_bbox()`（`:555`）负责把 bbox 加上 offset 再乘 scale。**所有元素（底图、形状、文字）必须走同一个 transform**，否则错位。

### 5.5 幻灯片尺寸选择
- 16:9：`13.333 × 7.5 in`（`12192000 × 6858000 EMU`），默认
- 4:3：`10 × 7.5 in`
- 非标：px-image2pptx 的 `SlideMapper.__init__`（按 aspect 1.5 / 1.2 分档）
- **自定义**：直接 `prs.slide_width = Emu(...)`，MinerU2PPT 就是让 slide 跟着页面走

### 5.6 字号换算
```
pt = px / ppi * 72                    # px-image2pptx: line_h_pt = (bbox_h_px / ppi) * 72
sz = round(fs_px * 75)                # DrawingML 的 sz 是 1/100 pt，px@96dpi → *0.75*100
spc = round(pt * 100)                 # 字符间距，1/100 pt
alpha val = round(opacity * 1000)     # 透明度，千分比（1.0 → 100000）
```
**字号拟合**：`_fit_ocr_font_size()`（image2editable `:833`）用 PIL `font.getlength()` 在 1000px 字号下测宽，再 `min(font_size, width_pt * 72 * 1000 / measured)` —— **比 `autoscale_font()` 的启发式准得多**。

---

## 6. 渲染回环（哪些项目做了、用什么、指标是什么）

| 项目 | 有回环？ | 渲染器 | 指标 | 是否闭门禁 |
|---|---|---|---|---|
| px-image2pptx | ❌ 完全没有 | — | — | — |
| MinerU2PPT | ❌ | 只输出 debug 叠框图 | — | — |
| **image2editable** | ✅ **最完整** | **LibreOffice**（`soffice --headless --convert-to pdf` + pypdfium2 栅格）；Windows 备选 PowerPoint COM | `normalized_mae`、`changed_ratio`、`ssim`、`edge_symmetric_difference_ratio`、`largest_error_region_ratio`；文本：多重集合一致性 + bbox IoU ≥ 0.8 | ✅ **硬门禁**，且是**路由选择器**（native 不过 → 对象降级 raster → 再不过 → 整页 raster） |
| figedit | ✅ | Chrome headless 渲 SVG 预览；`render_pptx.py` 安全渲 PPTX（检测用户 PowerPoint 是否在跑，避免杀掉） | **规则式 gate**（裁剪窗污染、文字/公式重叠、底板配准、AI 拼补、raw detector 禁用），**不是像素 diff** | ✅ |
| slide-alchemy | ⚠️ 形式上有 | 任意（预览导出） | **纯 PIL 差异热图 + side-by-side，无任何数值** | ❌ 靠人眼 |
| cell-ppt | ⚠️ 结构级 | PowerPoint COM 打开 → 校验对象数/类型 | 结构断言（每个 text run 是原生框、每条子路径是 freeform、无整图栅格兜底） | ✅（结构而非像素） |

**image2editable 的回环为什么值得抄**（`route_execution.py:482`）：
```
noise    = diff(render(raster_plan), render(raster_plan))   # 同一方案渲两遍的差异 = 渲染噪声
baseline = diff(source, render(raster_plan))                # 栅格版的误差 = 上界
pass     = all(candidate_metric <= baseline_metric + noise_metric)
```
**核心洞察：不要问"像不像原图"，要问"会不会比不可编辑的栅格版更差"。** 噪声容限用"自己渲两遍的差异"标定，避免了绝对阈值的脆弱。

---

## 7. 最能省工作量的三个"抄法"

### 抄法 1：`pip install px-image2pptx` + 改 2 个函数 → 半天拿到基线
```bash
pip install "px-image2pptx[ocr,inpaint]"
```
- **改 `assemble.py:estimate_text_width_pt()`**：CJK 的 `1.0 × font_pt` 换成真实字体度量（`ImageFont.truetype("msyh.ttc").getlength(ch)`），中文框宽度立刻准一截。
- **改 `assemble.py` 的段落写入**：`p.font.name = "微软雅黑"` 之后补 `a:ea`（3 行，见 4.1 #1），否则中文实际渲染成宋体。
- **改 `group_to_text()`**：中文行内不要用 `" "` 拼（改成 `""`），否则字间多空格。
- **产出**：文字可编辑 + LaMa 干净底图 + 底色检测。**这就是 MVP 的 60%**，成本 0.5 人日。

### 抄法 2：把 figedit 的 `scripts/svg_to_pptx/` 整个目录搬过来 → 3–5 人日拿到工业级 SVG→原生 PPT
```bash
git clone --depth 1 https://github.com/giszzt/figedit && cp -r figedit/scripts/svg_to_pptx your_project/
# 依赖：python-pptx、lxml（可选 cairosvg 做 PNG fallback）、Pillow
from svg_to_pptx import create_pptx_with_native_svg
create_pptx_with_native_svg([svg_path], out_pptx, use_native_shapes=True)
```
**一次拿到**：custGeom 圆角/弧环、`a:ea` 中文、`spcPts` 行高、`spcBef` 段距、`srcRect` 像素裁剪、`asvg:svgBlip`、OMML 公式、`effectLst` 阴影。
**你要做的**：让上游（VLM 或你自己的算法）产出**符合它约定的 SVG**（`references/svg_authoring.md` 有规范），或直接把你的形状序列化成 SVG 再喂进去。**这是单点杠杆最大的一步**——自研同等能力 20–25 人日。

### 抄法 3：`pip install image2editable`，只偷 3 个文件 → 2–3 人日拿到中文安全组装 + 渲染门禁
```bash
pip install image2editable
# 只复制这三个（MIT，可商用）：
#   scripts/ppt_assemble.py      38KB  全特性组装器
#   image2editable/render_qa.py  9.6KB 指标
#   image2editable/libreoffice_renderer.py 6.4KB 渲染
```
- `ppt_assemble.py` 的 `_add_textbox()` 直接吃 `{box, runs[], font, size, color, align, rotation, characters_spacing, gradient, outline_width}` 这样的 dict —— **把它当成"你的 IR → pptx"的现成后端**，2 人日接完。
- `render_qa.py` + `libreoffice_renderer.py` 是**独立无耦合**的（只依赖 numpy/cv2/pypdfium2/psutil），拿过来就能给自己产出的 pptx 打分。
- 额外白送：`_set_run_font()`（中文 ea）、`_set_solid_fill_opacity()`（透明度）、`add_group_shape` 多 run 定位、`add_connector` 连接线。

**组合最优解**：抄法 2（SVG→形状）+ 抄法 3（组装 + 门禁）+ 抄法 1（OCR/掩膜/LaMa）→ **≈ 6–8 人日**拿到一个覆盖 80% 场景的可用系统骨架。

---

## 8. 自研真实工作量估计

### 8.1 分阶段

| 阶段 | 内容 | 人日 | 累计 |
|---|---|---|---|
| **P0 基线** | 抄法 1 + 抄法 3 的组装器；文字可编辑 + 底图修复；单页 | 3–5 | 5 |
| **P1 形状** | 抄法 2；简单几何（线框/箭头/圆角矩形/圆）走原生形状；图标走 PNG 裁图 | 6–8 | 13 |
| **P2 中文排版** | ea 字体 + 字号拟合 + 行高/段距 + 换行控制；做 20 张真实中文学术/课件页调参 | 5–7 | 20 |
| **P3 渲染门禁** | LibreOffice 回环 + 噪声标定 + 对象级降级路由 | 4–6 | 26 |
| **P4 元素分类** | 规则（面积/连通域/直线检测/文字密度）+ VLM 兜底；三分类（geometry/icon/complex） | 6–8 | 34 |
| **P5 语义分割** | SAM2 + (可选)GroundingDINO；透明组件 + LaMa 回填 | 12–18 | 52 |
| **P6 混合 PPTX** | 只替换截图页、保留原生对象与 z 序 | 8–12 | 64 |
| **P7 工程化** | 状态机/断点续跑/并发/资源限制/基准回归 | 8–12 | 76 |

### 8.2 三档报价

| 档位 | 范围 | 人日 | 现实交付 |
|---|---|---|---|
| **快速验证** | P0–P1 | **10–13** | 单页/少量页，文字+简单几何可编辑，图标位图。可用于内部演示 |
| **可用产品** | P0–P4 | **25–35** | 批量、中文排版过关、有渲染门禁、支持 4 类图（课件/流程图/海报/论文插图） |
| **对标最佳** | P0–P7 | **60–80** | 对齐 image2editable / figedit，含 Agent 路由、混合 PPTX、CI 回归 |

### 8.3 会被低估的四件事

1. **文本行/段落重建**（模块 8）：OCR 出来是碎块，合并成"一个段落一个文本框"要考虑分栏、缩进、项目符号、字号跳变。MinerU2PPT 用了 **60KB 代码**干这事，别按 1 人日估。
2. **字号/字重/颜色的"看起来对"**：单页调 10 次很正常，20 张真实语料就是 3 人日。
3. **渲染回环的稳定性**：LibreOffice 在 CI 里会卡死、会残留 profile、会在 Windows 上弹窗。image2editable 为此写了 psutil 监控 + 300s 无活动判死 + 进程树清理，**这不是过度设计**。
4. **"不差于栅格"的降级链**：native → 对象降级 → 整页降级，每层都要重新渲染验证，逻辑量是表面的 2 倍。

### 8.4 不建议自研的部分

- **位图 → 矢量路径的自动 tracer**（彩色、分层、带文字）：开源没有能打的，自研 15–25 人日且效果不稳定。**要么买 API（cell-ppt 路线），要么让 VLM 写 SVG（figedit 路线），要么直接放弃精度走"图标裁图 + 几何重绘"**。
- **PPTX 母版/版式编辑**：python-pptx 完全不支持，自研等于写半个 OOXML 库。

---

## 9. 坑与风险清单

| 坑 | 表现 | 规避 |
|---|---|---|
| 无 license 仓库 | MinerU2PPT **不能抄代码** | 只读 `ir_merge.py` 的**思路**（分行 → 行内合并 → 生成 lines/runs），自己重写；代码不落地 |
| 付费 API 依赖 | cell-ppt 的矢量化要买额度（`xiaomiao.py`），MIT 只覆盖绘制层 | 自研时把"矢量化"当成外部服务，别把工期压在它上面 |
| python-pptx 版本 | `fill.gradient()` 1.0+ 才有；`add_group_shape` 0.6.22+ 才有 | 锁 `python-pptx>=1.0.2,<2` |
| 中文 fallback | 只设 `font.name` → 实际渲染宋体 | 必写 `a:ea`（+`a:cs`） |
| 单行文本被换行 | 字体度量差异导致多一行，整段错位 | MinerU2PPT 的招：**单行框宽 ×1.2**；figedit 的招：`wrap="none"+spAutoFit` |
| 段落 autofit 撑爆 | 多段文本框加了 `spAutoFit`，PowerPoint 里框变成一行宽 | 段落模式不加 autofit，只给固定 ext |
| LibreOffice 卡死 | CI 里 soffice 挂住不返回 | 隔离 `-env:UserInstallation`，监控子进程活动，超时杀进程树 |
| 掩膜误抠图形 | 插画轮廓/表格线被当文字挖掉 | px-image2pptx 的 `clip_mask_to_ocr()`——**用 OCR bbox 硬约束掩膜** |
| 组件与文字重复 | 同一个字既在 PNG 组件里、又在文本框里 → 双影 | image2editable 的 `text_duplicate_ratio` 门禁 |
| 底图残留鬼影 | LaMa 没修干净，编辑后仍看到旧字 | `background_text_residual_ratio` 门禁 + 组件移除后再修一次 |

---

## 10. 一句话总结

> **想要快，抄 px-image2pptx（文字+底图）+ figedit 的 `svg_to_pptx`（原生形状）+ image2editable 的 `ppt_assemble.py`/`render_qa.py`（组装+门禁），6–8 人日出骨架，25–35 人日出产品。**
> **唯一没有捷径的是"位图→矢量"这一步——六个项目全靠模型或付费 API，没有一个是算法。**
