# C｜开源方案调研：图片型 PPT / 截图 / 扫描 PDF → 可编辑 PPTX

> 调研时间：2026-10-20 ｜ 方法：`gh api` 直查仓库元数据 + LICENSE 原文 + README/SKILL.md + PyPI/HuggingFace API + issue 抽样 + web 检索
> 说明：GitHub 搜索 API 对当前账号返回 `User flagged as spammy`，故改用「已知仓库直查 + awesome 清单 + 网页检索」交叉覆盖，下表 Star 数为 `gh api` 实时值。
> 标注 ⚠️ = 未能 100% 落实，需二次确认；其余均为原文核实。

---

## 0. TL;DR（给决策用的 6 句话）

1. **这个品类目前没有「可直接商用的成熟开源转换引擎」**。2026 年爆发的全是 **Agent Skill**（Codex / Claude Code 里跑），不是可 `pip install` 后当 HTTP 服务调用的库。真正的生产级方案需要自研组装。
2. **唯一有工程化含量的纯本地引擎是 `image2editable`**（MIT，SAM2.1-L + big-lama + GroundingDINO + PaddleOCR），有 CLI / Python API / benchmark 门禁，但**图片路径可独立跑，PDF/PPTX 路径必须挂宿主 Agent**（experimental），且"可编辑"= 文字原生 + 元素拆成透明 PNG，**不承诺形状矢量化**。
3. **License 是最大的地雷**：`Edit Banana`(5.5k★) 的 README 徽章写 Apache-2.0，**实际 LICENSE 文件是 AGPL-3.0**；`PPTist`(9.4k★) 是 AGPL-3.0，商用要买授权（**2999 元/年、5999 元永久**，官方明码）；`MinerU2PPT`、`OCRPDF-TO-PPT` **完全没有 LICENSE**（= 保留所有权利，不可商用）。
4. **MinerU 已不是 AGPL**：现为 **Apache-2.0 + 附加条款**，商用免费，但 **MAU > 1 亿 或 月营收 > 2000 万美元**需另购商业授权；**对外提供在线服务必须显著标注使用了 MinerU**。这条直接影响你网站页脚的合规文案。
5. **marker 是「代码 Apache-2.0 / 权重 OpenRAIL-M」的双轨**：权重仅对 **融资或营收 < 500 万美元** 免费，超过要找 datalab 买。只抄代码没问题，**别把权重一起商用**。
6. **能落地的自研主线只有三条**：① MinerU/PaddleOCR-VL 出结构化 JSON → python-pptx 组装（最稳、最可控）② VLM 直接出元素 JSON → 组装（效果上限高、成本与幻觉不可控）③ 位图矢量化重绘（只对图表/线稿有效，照片类必死）。

---

## 1. 主表：25 个项目横向对比

> 排序：先「直接做 image→pptx」的，再「可作为管线零件」的。
> 难度口径：★=改配置即用；★★=需写胶水代码；★★★=需自建服务/改源码；★★★★=需重写核心算法。

### 1.1 直接做「图片/PDF → 可编辑 PPTX」的项目

| 项目 | Stars | License | 最近更新 | 输入 → 输出 | 纯本地？ | 难度 | 商用风险 |
|---|---|---|---|---|---|---|---|
| [DSY-Xueai/image2editable](https://github.com/DSY-Xueai/image2editable) | 56 | **MIT** | 2026-10-09 | png/jpg/pdf/pptx → pptx（+psd） | ✅ 模型全本地；PDF/PPTX 需宿主 Agent | ★★★ | 低（MIT）。但宿主 Agent 会把诊断图传给模型服务商 |
| [CodingFeng101/slide-alchemy](https://github.com/CodingFeng101/slide-alchemy) | 45 | **MIT** | 2026-07-13 | 截图/图片版 pptx → pptx | ❌ 依赖图像生成/编辑模型做"干净底图" | ★★★★ | 低（代码 MIT），但图像模型调用费 + 生成底图与原图不一致 |
| [yrui-cmd/cell-ppt](https://github.com/yrui-cmd/cell-ppt) | 61 | **MIT** | 2026-09-26 | 科研图 → pptx 原生路径（COM/OOXML） | ❌ **必须买 API Key**（免费额度在抖音群发） | ★★★★ | **高**：闭源付费 API、额度制、含"AI 隐藏水印处理"功能（法律风险） |
| [BIT-DataLab/Edit-Banana](https://github.com/BIT-DataLab/Edit-Banana) | 5,499 | **AGPL-3.0**（README 徽章误写 Apache-2.0） | 2026-10-17 | 图片/pdf → **DrawIO XML**（PPTX 仅网页版） | ⚠️ SAM3 本地 + VLM 可指向 Ollama | ★★★★ | **高**：AGPL 网络传染；开源仓库明确"落后于线上服务"；PPTX 不在开源仓 |
| [ningzimu/image-to-editable-ppt-skill](https://github.com/ningzimu/image-to-editable-ppt-skill) | 3,015 | **MIT** | 2026-09-16 | 图片/pdf/图片版 pptx → pptx | ❌ Codex 内置 image_gen + PaddleOCR-VL 云 API | ★★★★ | 中：MIT 但**强绑 Codex**，10 页可烧完 ChatGPT Pro 5 小时额度 |
| [Morgensonne/EditDeck](https://github.com/Morgensonne/EditDeck) | 1,203 | **MIT** | 2026-04-27 | 图 → 标准/完全可编辑 pptx | ⚠️ 需确认 | ★★★★ | 中低 |
| [icebird1998/scientific-illustrator](https://github.com/icebird1998/scientific-illustrator) | 945 | **MIT** | 2026-09-08 | 科研参考图 → pptx/WPS/draw.io 对象 | ⚠️ Codex plugin | ★★★★ | 中低（科研图强项，通用版式弱） |
| [xiao24bei/xiaobei-skill-image-to-vba](https://github.com/xiao24bei/xiaobei-skill-image-to-vba) | 605 | ⚠️ 未查 | 2026 | 图/截图 → Office shapes + **VBA** | ❌ 需 Windows PowerPoint | ★★★★ | 高（VBA 只适用 Windows 桌面） |
| [Tansuo2021/OCRPDF-TO-PPT](https://github.com/Tansuo2021/OCRPDF-TO-PPT) | 475 | **无 LICENSE** | 2026-03-22 | 图/pdf → pptx（背景图 + OCR 文本框） | ✅ | ★★ | **禁止商用**（无授权=保留所有权利）；且只是"贴文字层"，非真重建 |
| [laihenyi/NBLM2PPTX](https://github.com/laihenyi/NBLM2PPTX) | 347 | ⚠️ 未查 | — | NotebookLM PDF → 背景图 + 文字层 | ✅ | ★★ | 同上，"伪可编辑" |
| [JuniverseCoder/MinerU2PPT](https://github.com/JuniverseCoder/MinerU2PPT) | 199 | **无 LICENSE** | 2026-05-24 | pdf/图 → pptx（走 MinerU 结构） | ✅ | ★★ | **禁止商用**；但**架构最值得抄**（见路线 A） |
| [Lancelot-Xie/img2pptx](https://github.com/Lancelot-Xie/img2pptx) | 169 | **Apache-2.0** | 2026-08-13 | AI 生成图 → 模块化 SVG → pptx | ❌ Codex skill | ★★★★ | 低（License 干净） |
| [ZhiweiWei-NAMI/PPT-Visual-Replica](https://github.com/ZhiweiWei-NAMI/PPT-Visual-Replica) | 135 | **MIT** | 2026-09-16 | 图 → pptx（语义拆素材 + 残差 QA） | ⚠️ | ★★★★ | 低 |
| [soulmujoco/EditableImage2PPTSkill](https://github.com/soulmujoco/EditableImage2PPTSkill) | 66 | ⚠️ | 2026 | 截图 → pptx | ⚠️ | ★★★★ | 待查 |
| [JadeLiu-tech/px-image2pptx](https://github.com/JadeLiu-tech/px-image2pptx) | 39 | **MIT** | 2026-04-12 | 图 → pptx（PP-OCRv5 + LaMa + python-pptx） | ✅ 浏览器 ONNX 亦可 | ★★ | **低，且是自研路线的最佳参考实现** |
| [Daniel-Siae/image2pptx](https://github.com/Daniel-Siae/image2pptx) | 26 | **MIT** | 2026-05-10 | 图 → pptx（PaddleOCR-VL JSON） | ❌ 走百度 AI Studio 云 API | ★★ | 低 License，但数据出境 + 按次计费 |

### 1.2 可作为管线零件的基础设施

| 项目 | Stars | License | 最近更新 | 能做什么 / 不能做什么 | 商用风险 |
|---|---|---|---|---|---|
| [opendatalab/MinerU](https://github.com/opendatalab/MinerU) | 82,077 | **Apache-2.0 + 附加条款** | 2026-10-19 | PDF/Office/图 → md/html/latex/**docx**/epub/pdf/结构化 JSON。**不输出 PPTX** | 低。商用免费，但 MAU>1亿 或 月营收>$20M 需购授权；**在线服务必须标注** |
| [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 91,397 | **Apache-2.0** | 2026-09-16 | 版面/表格/公式/阅读顺序 → JSON、Markdown；PP-StructureV3 全家桶 | 低（最干净的一档） |
| [docling-project/docling](https://github.com/docling-project/docling) | 69,153 | **MIT** | 2026-10-19 | PDF→结构化 JSON/Markdown，表格强 | 低 |
| [datalab-to/marker](https://github.com/datalab-to/marker) | 40,549 | **代码 Apache-2.0 / 权重 OpenRAIL-M** | 2026-10-19 | PDF→md/json，速度快 | **中高**：权重仅 <$5M 融资/营收免费 |
| [Unstructured-IO/unstructured](https://github.com/Unstructured-IO/unstructured) | 15,578 | **Apache-2.0** | 2026-10-19 | PDF/文档 → elements（title/table/figure） | 低；但版面精度弱于 MinerU |
| [opendatalab/PDF-Extract-Kit](https://github.com/opendatalab/PDF-Extract-Kit) | 10,046 | **AGPL-3.0** | 2025-01-03 | 版面+公式+表格模型集合 | **高**（AGPL），且已停更，被 MinerU 吸收 |
| [pipipi-pikachu/PPTist](https://github.com/pipipi-pikachu/PPTist) | 9,409 | **AGPL-3.0** | 2026-10-10 | 在线 PPT 编辑器；**导入 PPTX ~85%、导出 ~95% 保真** | **高**：AGPL 或付费商用（**2999/年、5999/永久**）；官方声明**不提供 API/SDK** |
| [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) | 8,200 | **Apache-2.0** | 2026-10-20 | ONNXRuntime/OpenVINO 的轻量 OCR，CPU 可跑 | 低（CPU 部署首选） |
| [visioncortex/vtracer](https://github.com/visioncortex/vtracer) | 7,338 | **MIT** | 2026-10-17 | 位图→彩色 SVG（PyPI `vtracer` 0.6.15） | 低 |
| [gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS) | 6,291 | **MIT** | 2025-11-28 | JS 生成 PPTX（v4.0.1, 2025-06） | 低；前端/Node 侧组装首选 |
| [scanny/python-pptx](https://github.com/scanny/python-pptx) | 3,558 | **MIT** | **2024-08-07**（1.0.2） | Python 读写 PPTX，事实标准 | 低；**更新已停滞**，新特性靠自己补 XML |
| [unoconv/unoserver](https://github.com/unoconv/unoserver) | 942 | **MIT** | 2026-06-10 | LibreOffice 常驻进程做格式转换（pptx↔pdf），比反复起进程省 50–75% CPU | 低。**不能把位图变可编辑元素** |
| [benouinirachid/svg2pptx](https://github.com/benouinirachid/svg2pptx) | 16 | **无 LICENSE** | 2026-02-02 | SVG → 原生 PPT 形状 | **禁止商用**（无授权）；只能当思路参考 |
| potrace / autotrace | — | **GPL-2+** | — | 位图→单色矢量 | **高**：GPL 传染，闭源商用需隔离进程或换 vtracer |

### 1.3 视觉模型（自研路线要选的底座）

| 模型 | License | 规模/显存 | 用途 | 商用 |
|---|---|---|---|---|
| Qwen2.5-VL / Qwen3-VL | **Apache-2.0** | 3B/7B/72B；7B bf16 ≈16GB，int4 ≈8GB | 整页理解 → 元素 JSON | ✅ 最安全 |
| InternVL | **MIT** | 1B–78B | 同上 | ✅ |
| Florence-2 | **MIT**（仅 HF 权重，GitHub 无官方仓） | 0.23B/0.77B | 检测/区域描述/OCR | ✅ 轻量首选 |
| SAM 2 | **Apache-2.0** | hiera-l 898MB 权重，推理 4–8GB | 元素分割 | ✅ |
| SAM 3 | **SAM License**（Meta 自定义，2025-11-19） | 大 | 开放词表分割（Edit Banana 依赖） | ⚠️ 非 OSI，授予 royalty-free 使用权但需法务复核；再分发须附协议 |
| PaddleOCR-VL | **Apache-2.0** | **0.96B**（约 2GB fp16） | 文档版面/文字/表格/公式 | ✅ 性价比最高 |
| big-lama | Apache-2.0（权重） | 206MB | 去字后背景修补 | ✅ |

---

## 2. 逐条线索核实结果

### 2.1 image2editable（重点）
- **架构**：不是"调 API 的壳"，是完整 Python 包（PyPI `image2editable`，**PyPI 仅 0.2.0、单版本**；仓库已 0.3.0，官方明说"不从滞后的 PyPI 回退"，要装就用 GitHub main）。
- **依赖**：`torch>=2.5`、`sam2>=1.1`、`transformers>=4.57`、`opencv`、`pypdfium2`、`python-pptx`；运行时模型目录 `runtime_model_catalog.json` 固定三个：
  - `sam2.1_hiera_large.pt` **898 MB**
  - `big-lama.pt` **206 MB**
  - `IDEA-Research/grounding-dino-tiny`（HF snapshot）
  - OCR 走 **PaddleOCR**（`from paddleocr import TextDetection`，PaddleX 组件）
- **成本**：模型全本地、**零 API 费**；但 **Skill 模式要宿主 VLM 做组件决策**（`--agent-provider host`，官方标注 `experimental`），Token 由 Codex/Claude 计费。
- **能力边界（原文）**："复杂视觉元素通常会以可移动图片组件保留，不能 100% 保证其内部元素都能恢复为原生 PowerPoint 形状"；"重建组件通常是透明图片对象，不承诺把任意图形转换为原生矢量或 SmartArt"。→ **文字真可编辑，图形是"分层图片"**。
- **工程成熟度**：有 `benchmarks/corpus`、14 页发布门禁、CHANGELOG、tests、doctor、质量报告（residual/ghost/漏字检查）、组件修复最多 5 轮。这在同类里是**唯一像工程的**。
- **集成**：`image2editable` CLI + `convert()/convert_batch()` Python API（**仅图片**）；PDF/PPTX 需 `prepare → run next → decision record → run execute → agent next/record` 的**人机/Agent 循环**。Docker：无官方镜像。
- **真实反馈**：issue 仅 3 条（#2 求 PSD 支持、#1 问参数），**用户基数极小**，无规模化效果证据。

### 2.2 slide-alchemy
- 组件化重建：`底图重绘 → 元素分类 → 几何/Png/文字`；三类元素策略 `simple_geometry_svg_ooxml / icon_png / complex_png_whole`。
- **关键缺陷（自述）**：底图用**图像编辑模型重新生成**，图标也用**生成模型产出再切图**——"不得直接从原图裁剪"。这意味着**像素级不一致**，做"还原原稿"会被投诉；且每页多次图像模型调用，成本与时延高。
- issue 全是作者自己的 hardening PR，**零真实用户反馈**；README 自认"Token/时间基准待测"。
- 集成：Codex Skill，无 CLI/服务化封装。

### 2.3 cell-ppt
- 定位**极窄**：科研图（路径/曲线）→ PowerPoint 原生 freeform 路径 + 文字；Windows 走 COM 实时绘制，macOS 走 OOXML。
- **必须 API Key**，README 写明"免费额度每天抖音群提供，私人额度小红书找木纹"——**闭源 SaaS 额度制**，MIT 只是客户端壳。商用=把命脉交给个人开发者。
- 附带的 `cell_no_ai` 做"AI 隐藏水印处理"——**这是给 AI 生图去水印的功能，商用产品集成有法律与平台条款风险**，建议直接排除。
- 依赖锁死 `python-pptx==1.0.2`、`fonttools`、`shapely`；无 Docker。

### 2.4 Edit Banana
- **License 冲突已核实**：仓库 `LICENSE` 文件正文 = **GNU AGPL-3.0**；README 徽章 = Apache-2.0（错误/过期）；网上多篇中文测评跟着写"Apache-2.0 可商用"——**全部是错的**。
- **开源仓能力被裁剪**：顶层无任何 pptx 相关文件，CLI 只输出 `output/<stem>/` 下的 **DrawIO XML**；README 顶部警告"GitHub 仓库落后于线上服务"。→ 你拿不到网页版那条 PPTX 产线。
- 技术栈：**SAM3**（自定义 SAM License）+ VLM（OpenAI 兼容，可指 Ollama）+ Tesseract/PaddleOCR + Pix2Text（公式→LaTeX）；需手工下 SAM3 权重，GPU 推荐。
- 强项是**图表/流程图/公式**（DrawIO 场景），**不是幻灯片版式**。
- issue 区大量"微信二维码失效"——维护重心在商业站，**开源仓处于半放养**。

### 2.5 PPTist
- 前端能力：Vue3 + Canvas，导入 PPTX ~85%、导出 ~95%（官方口径），支持 JSON schema 给 AI 用。
- **AGPL-3.0**，官方"商用须知"写死：禁止闭源商用；替代方案 = ① 2022 年 Apache-2.0 旧版（**已停止维护**）② 成为重要贡献者 ③ **付费独立授权：2999 元/年，5999 元永久（不含税）** ④ 赞助一年以上换永久授权。
- 官方明确"**不提供任何 API/SDK/在线服务/技术支持/定制开发**"。
- 结论：**可以当"编辑器 UI"嵌，但它是 AGPL**；要闭源商用就老老实实买 5999 永久授权（相对自研编辑器仍是白菜价）。它**不能**把图片变可编辑，只能承接你已经生成好的 PPTX/JSON。

### 2.6 MinerU / magic-pdf
- 现版本 4.0：输入 PDF/图/DOC/PPT/XLS/EPUB/OFD/HTML/CSV；输出 **Markdown、HTML、LaTeX、DOCX、EPUB、PDF、Structured Content、Content List V1/V2**——**九种渲染目标里没有 PPTX**。
- 小模型 ONNX CPU 可跑，VLM 可选 llama.cpp / vLLM / LMDeploy；NVIDIA 卡装 `mineru[full]`。
- License 见 §1.2：**Apache-2.0 + 附加条款**，务必在网站显著位置标注 "Powered by MinerU"。

### 2.7 PaddleOCR / RapidOCR / PP-StructureV3
- Apache-2.0，最干净；PP-StructureV3 出 layout/table/formula/reading-order 的 JSON + Markdown。
- **PaddleOCR-VL 仅 0.96B**（HF `safetensors.total=958,588,736`），单卡 8GB 足够，是同价位最优的"文档理解小模型"。
- RapidOCR 走 ONNXRuntime，**纯 CPU** 可跑，适合"不想买 GPU"的起步阶段。

### 2.8 docling / marker / unstructured
- docling：MIT，最省心；表格结构强，输出 JSON/Markdown。
- marker：快，但**权重 OpenRAIL-M <$5M 限制**，商用要买；代码可放心读/抄。
- unstructured：Apache-2.0，元素粒度粗，适合 RAG 而非版式复刻。
- 三者**都不产出 PPTX**，只能做"上游解析"。

### 2.9 python-pptx / PptxGenJS / pptx-rs / pptxgen
- python-pptx：MIT，事实标准；**最后提交 2024-08、版本停在 1.0.2**，SVG 嵌入、`a:extLst/asvg:svgBlip`、自定义 geometry 等都要自己写 lxml。
- PptxGenJS：MIT，v4.0.1(2025-06)，**前端直接生成**是它相对 Python 的独特优势（可做"浏览器内转换、不上传服务器"）。
- `lispking/pptx-rs`、`prezvious/pptxgen`：**查无此仓**；Rust 侧真实存在的是 [yingkitw/ppt-rs](https://github.com/yingkitw/ppt-rs)（50★，含 MCP），生态很早期，不建议押注。

### 2.10 位图矢量化路线
- vtracer（MIT）：彩色位图→SVG，速度快，**唯一 License 干净的选择**；potrace/autotrace 是 **GPL-2+**，闭源商用需进程隔离或放弃。
- `svg2pptx`(16★) **无 LICENSE**，不能抄进产品；可参考思路：解析 SVG path → `python-pptx` freeform / 直接写 DrawingML `<a:custGeom>`。
- **高杠杆技巧**：PPTX 支持内嵌 SVG（`p:pic` + `a:extLst` 里的 `asvg:svgBlip`，配 PNG 兜底），用户在 PowerPoint 里右键"**转换为形状**"即可得到原生可编辑形状。等于把矢量化难题外包给 PowerPoint，**但 python-pptx 不支持，需手写 XML 关系**。
- **边界**：矢量量化只对**线稿/图表/logo/纯色插画**有效；照片、渐变、阴影、艺术字一律劣化。不要对用户承诺"全页矢量化"。

### 2.11 LibreOffice / unoserver / unoconv
- 能做：pptx↔pdf↔png 渲染、格式互转、批量转 PDF 做**视觉回归比对**（这是自研管线里最有价值的一环）；unoserver 常驻监听省 50–75% CPU。
- **不能做**：把位图拆成可编辑元素。它只是"格式翻译器 + 渲染器"，对"图片型 PPT"无能为力。unoconv 已基本被 unoserver 取代。

### 2.12 视觉大模型方案（VLM → JSON → PPTX）
- 可行性：**成立，且是效果上限最高的路线**，但工程重点不在模型，在 **schema 约束 + 坐标归一化 + 渲染回环校验**。
- 推荐底座：Qwen2.5-VL-7B / InternVL2.5-8B（Apache-2.0 / MIT，可商用）；轻量检测用 Florence-2（MIT）+ SAM2（Apache-2.0）做掩码，VLM 只负责"这是什么元素、文字是什么"。
- 成本量级（自建，7B int4 单卡）：每页 2–5k 输出 token，**≈0.01–0.05 元/页**；商用 API（Qwen-VL-Plus / Gemini Flash）**≈0.05–0.3 元/页**。
- 硬伤：坐标幻觉（bbox 偏移 2–5% 很常见）、文字漏字/多字、表格结构错乱；**必须**用"渲染回图 → 与原图 diff → 局部重修"的闭环，否则可编辑率虚高。

---

## 3. 依赖模型 License 汇总（商用必查）

| 依赖 | License | 结论 |
|---|---|---|
| PaddleOCR / PaddleOCR-VL / PP-StructureV3 | Apache-2.0 | ✅ 可商用 |
| RapidOCR | Apache-2.0 | ✅ |
| Qwen2.5-VL / Qwen3-VL | Apache-2.0 | ✅ |
| InternVL | MIT | ✅ |
| Florence-2 | MIT（HF 权重） | ✅ |
| SAM 2 | Apache-2.0 | ✅ |
| **SAM 3** | **SAM License（自定义）** | ⚠️ 需法务确认；再分发须附协议、含终止/诉讼条款 |
| big-lama | Apache-2.0 | ✅ |
| marker 权重 | **OpenRAIL-M（<$5M）** | ⚠️ 超限需付费 |
| MinerU 代码 | Apache-2.0 + 附加条款 | ⚠️ 大规模/在线服务有义务 |
| potrace / autotrace | GPL-2+ | ❌ 闭源商用高风险 |
| PPTist / Edit Banana / PDF-Extract-Kit | AGPL-3.0 | ❌ 未购授权/未开源整站则违规 |
| 无 LICENSE 的仓库（MinerU2PPT、OCRPDF-TO-PPT、svg2pptx） | 保留所有权利 | ❌ 不可商用、不可抄代码 |

---

## 4. 字体与素材版权（中文场景特有）

- **可安全内置**：思源黑体/宋体（Source Han，SIL OFL）、Noto 系列、Inter、Roboto。
- **不可内置**：微软雅黑、宋体(SimSun)、黑体(SimHei)、方正/汉仪等——**只可在用户本机已安装时"按名字引用"**，绝不能打包进镜像或云端渲染。
- 服务器端渲染（LibreOffice）**必须**装 OFL 字体，否则排版漂移；同时要接受"客户端缺字体 → 回退"的必然损耗。
- 用户上传的截图若含品牌 logo/人物肖像，**产物再分发**的责任在用户，需在条款里写明。

---

## 5. 三条自研路线（按推荐度排序）

### 路线 A（推荐）：结构化解析 → 原生组装
```
图片/PDF
  → 渲染分页 (pypdfium2)
  → PaddleOCR-VL / PP-StructureV3：layout + text + table + formula + reading order → JSON
  → 元素分类器（规则 + 小模型）：文本框 / 表格 / 图片块 / 简单几何 / 装饰
  → 文本遮罩 + LaMa 修补底图（保留原像素，不生成）
  → python-pptx 组装：真文本框 + 原生表格 + 裁剪图块 + freeform 几何
  → LibreOffice 渲染回图 → 与原图 SSIM/diff → 失败页局部重修
```
- **优点**：全本地、成本可控（≈0.005–0.02 元/页）、License 全绿、结果稳定可解释、可逐页重试。
- **缺点**：复杂版式（多栏、图文混排、艺术字）还原一般；工程量大（**4–8 人周**出 MVP）。
- **参考实现**：`px-image2pptx`（MIT，PP-OCRv5+LaMa+python-pptx，最贴近）、`MinerU2PPT`（**无 License，只可读不可抄**）。
- **技术选型**：起步 RapidOCR（CPU）→ 上量换 PaddleOCR-VL（单卡 8GB）；组装 python-pptx；前端可选 PptxGenJS 做"浏览器内转换"。

### 路线 B：VLM 直出 JSON → 组装
```
页面图 → Qwen2.5-VL-7B（JSON schema 强约束）
  → {elements:[{type,bbox,text,style,z}]}
  → 校验器（bbox 越界/重叠/漏字）→ 重试或降级到 OCR
  → 组装 pptx（同路线 A 的组装层）
```
- **优点**：版式理解最好，能处理"A 路线搞不定的语义结构"；开发量小（**2–3 人周**）。
- **缺点**：幻觉（bbox 漂移、编造文字）、单页成本高 5–10 倍、延迟 3–8s/页、**必须做渲染回环**才敢上线。
- **建议**：**A 为主、B 兜底**——A 失败页（低置信/高 diff）再送 B，成本与效果平衡最好。

### 路线 C：矢量化重绘（只做增值功能，不做主线）
```
页面 → vtracer → SVG → 解析 path → DrawingML custGeom / 或内嵌 SVG + "转换为形状"
```
- **适用**：图表、流程图、线稿、logo、纯色插画（科研/咨询场景）。
- **不适用**：照片、渐变、阴影、艺术字。
- **定位**：作为路线 A 的"图形增强"分支，对检测为 `simple_geometry` 的元素启用；**不要对用户宣传"整页可编辑形状"**。

---

## 6. 三个最大的坑

1. **"可编辑"的定义陷阱**：市面上 90% 的方案（含 MinerU2PPT、OCRPDF-TO-PPT、NBLM2PPTX）本质是"**背景图 + OCR 文字层**"。用户点开发现图形还是一张图，退费率极高。**必须在产品文案里区分三档**：文字可编辑 / 元素可分层移动 / 形状可矢量编辑，并按档定价。
2. **License 误判**：Edit Banana README 徽章写 Apache-2.0、实际 AGPL-3.0，中文测评集体传错；PPTist 是 AGPL 且**旧版 Apache 快照已停维护**；MinerU 是"Apache-2.0 + 附加条款"不是纯 Apache；marker 权重有营收门槛；还有一堆**无 LICENSE** 的仓库（默认不可商用）。**上线前逐仓读 LICENSE 原文，不要看徽章、不要看博客。**
3. **成本与时延被低估**：Agent Skill 路线（ningzimu 3k★）**10 页能烧完 ChatGPT Pro 5 小时额度、单页 10 分钟以上**；slide-alchemy 每页多次图像生成调用；这些都不是"网站点击即出"的形态。自建 GPU 管线要按 **并发 × 页数 × 重试轮次** 估显存与队列，别按"单页 5 秒"做容量规划。

---

## 7. 给「网站集成」的落地建议（一句话版）

- **前端编辑器**：预算够就买 **PPTist 永久授权 5999 元**（省 3 个月自研）；不想花钱就自研轻量 Canvas 编辑器（只支持文本框/图片/矩形），别碰 AGPL。
- **转换引擎**：自研 **路线 A（PaddleOCR-VL + LaMa + python-pptx）+ 渲染回环**，MVP 4–6 周；用 `px-image2pptx` 做起点（MIT）。
- **GPU**：起步 1× RTX 4090（24GB）可扛 3–5 并发；CPU-only 用 RapidOCR 做免费档。
- **合规**：页脚标注 MinerU（若用）、不内置微软雅黑、不集成去水印功能、对用户上传内容做版权免责声明。
- **定价**：按"文字可编辑 / 元素可编辑"分档，别承诺 100% 还原。
