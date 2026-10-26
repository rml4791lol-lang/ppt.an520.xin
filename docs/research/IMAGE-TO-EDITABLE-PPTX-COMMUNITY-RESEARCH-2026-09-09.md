# 图片转可编辑 PPTX：社区调研、实际效果与成本评估

> 调研日期：2026-09-09
> 适用项目：AnPPT v2 / 图片版 PPT 转可编辑 PPTX
> 调研对象：`ai-image2academic-ppt`、`bggg-creator-image2ppt`、`OCR Arcade`、`SlideSmith`，以及社区中可直接验证的近邻方案
> 结论口径：优先看官方源码、官方文档、作者原文和可复现测试；社区帖子只作为实测证据，不把营销描述当事实。

---

## 0. 结论先行

1. **AnPPT 当前 Codia 路线仍然是生产默认档。** 仓库内已有真实 Codia 产物：一页导航界面被重建为 53 个文本节点、59 个原生形状、61 个图片对象；渲染结果与源图视觉接近。按官方 13 credits/页和 $49/5500 credits 订阅计算，约 **$0.116/页 ≈ ¥0.83/页**。它的优势不是最便宜，而是可交付性、速度和复杂页兜底最稳。
2. **“VLM → HTML → 浏览器 → PPTX”是值得做 beta 的增量路线，但不能直接替换 Codia。** 公开路线里最可复用的是 SlideSmith 的下游：Playwright 负责真实浏览器布局，`dom-to-pptx`/PptxGenJS 负责原生对象导出。上游如果由 Gemini Flash、MiMo、DeepSeek 生成受约束的 HTML/JSON，单页模型成本可做到 **¥0.01～0.2**；但复杂背景、表格、渐变、阴影和叠层会明显掉保真度，需要逐页 QA + Codia/图片版兜底。
3. **成本不能只看 token。** 如果每页再调用 1～4 次 imagegen 做背景/组件重建，按当前 AnPPT 口径 $0.05/张，单页会增加 **¥0.36～1.44**；再叠加多轮修复和人工返工，真实成本很容易超过 Codia。社区中的 agentic 重建方案甚至出现 **10～60 分钟/页、10 页耗尽 5 小时额度** 的情况，不适合作为 SaaS 默认链路。
4. **bggg-creator-image2ppt 适合当 manifest/组件重建参考，不适合直接当浏览器布局引擎。** 它是 MIT，有清晰的 `manifest.json → python-pptx` 结构；但 HTML/SVG 解析器主要面向绝对定位和简单节点。本地实测：CSS Grid/class 布局的 HTML 被压成左上角一坨文本；改成 inline absolute 后，文本和基础形状恢复较好。
5. **`ai-image2academic-ppt` 没有找到可验证的公开仓库、许可证和源码。** 按描述，它的管线与 SlideSmith/截图转代码类方案一致；真实效果只能按同管线能力推断，不能确认“每页 ¥0.01～1”是否包含重试、imagegen、QA 和人工返工。
6. **`OCR Arcade` 同样没有找到公开项目。** 公开互联网里更接近的名字是 **OCR Arena**，但它是 OCR 模型对战/评测平台，不是截图转 PPT 管线。若 `OCR Arcade` 确实是 AGPL-3.0，则用于闭源 SaaS 前必须做许可证合规审查；工程上更安全的近邻是 Apache-2.0 的 PaddleOCR-VL + MIT 的 `image2pptx`/`px-image2pptx` 路线。
7. **建议 AnPPT 的落地顺序：**
   - 保留 Codia 作为默认“完整可编辑”档和失败兜底。
   - 新增 beta 插件：**结构化版面 JSON → 确定性 HTML → Playwright + 最新版 dom-to-pptx/PptxGenJS → 逐页像素 QA → 失败回退 Codia/图片版**。
   - 不直接导入 bggg 的 Python 运行时；只借鉴它的 manifest 契约和组件分层。
   - 不直接接 AGPL/无许可证项目；先以 learn-only spike 验证。

---

## 1. 证据等级

| 等级 | 含义 | 本报告中的例子 |
|---|---|---|
| A | 官方源码、官方文档、官方价格页 | GitHub README/源码、Codia 官方 API 文档、Gemini/DeepSeek/MiMo 官方价格 |
| B | 本地可复现实验 | 本次在 macOS 上运行 SlideSmith/bggg/Codia 产物并导出 PDF/PNG 对比 |
| C | 社区用户实测或作者公开自述 | Linux.do、WPS 社区、知乎、GitHub Issue |
| D | 二手博客、营销文案、无法核验的项目描述 | 未找到源码的 `ai-image2academic-ppt`、`OCR Arcade` 描述 |

> 说明：本报告把作者自己的 README 既当“官方事实来源”，也标注其“自述”属性；不把它当独立第三方质量证明。

---

## 2. 四个候选项目横向对比

| 项目 | 公开来源 / 许可证 | 管线 | 可编辑程度 | 实测/社区质量 | 每页成本（不含人工返工） | 生产适配结论 |
|---|---|---|---|---|---|---|
| `ai-image2academic-ppt` | **未找到公开仓库/许可证**；按名称和描述无法核验 | PNG 截图 → 多模态模型分析布局 → HTML → 浏览器算布局 → 16:9 可编辑 PPTX | 按描述应有文本、基础形状可编辑；复杂视觉可能回退图片 | 无公开独立实测；只能按同管线推断 | 纯模型调用约 **¥0.01～0.2/页**；多轮修复或 imagegen 后可达 **¥0.5～1.6/页** | 仅可作为设计参考，不能作为已验收依赖 |
| `bggg-creator-image2ppt` | [GitHub](https://github.com/binggandata/bggg-skills)，MIT | 图片/HTML/SVG → `manifest.json` → `python-pptx` 拼装；图片输入默认依赖 Codex 视觉 + `imagegen` 生成/清理组件 | 文本原生可编辑；矩形/圆角/圆/线等基础形状可编辑；照片、插画、复杂图表、纹理作为独立图片对象 | 作者称单图可拆出 57 个节点；公开 Issue 少，独立质量证据不足。本地实测：flow 布局失败，inline absolute 布局较好 | 脚本本地 0 成本；视觉理解 + imagegen 按 Codex 订阅额度计；按 API 口径 1～4 张图约 **¥0.36～1.44/页** | MIT 可参考 manifest/组件分层；不建议直接作为 AnPPT 运行时 |
| `OCR Arcade` | **未找到公开仓库/许可证**；可能是 OCR Arena 的误写 | 截图/PDF → OCR 拆文本块 → 网页编辑 → PptxGenJS 导出 | 文本可编辑；形状/背景/图表通常不是原生对象；复杂区域靠图片/重绘 | 无公开实测。近邻 `image2pptx` 自述为“可编辑初稿生成器”；`px-image2pptx` 明确列出字体、公式、密集图表等限制 | 本地 OCR 约 **¥0.01～0.1/页**（GPU/电费）；百度 PaddleOCR-VL 资源包约 **¥90/1000 页**；人工返工另计 | 若 AGPL 属实，闭源 SaaS 需合规审查；建议用 PaddleOCR-VL + MIT 方案做 spike |
| `SlideSmith` | [GitHub](https://github.com/AliceLJY/slidesmith)，MIT，v1.1.0 | HTML 幻灯片 → Playwright 真实浏览器渲染 → `dom-to-pptx` 读 computed layout → PptxGenJS 生成 PPTX；复杂 CSS 可 screenshot fallback | 文本、基础形状、图片可原生导出；复杂 CSS 可能整页截图，失去可编辑性 | 仓库本身很新（本次核验时 0 star、0 issue），社区证据少；底层 `dom-to-pptx` 约 345 star、维护活跃但 Issue 暴露了渐变/伪元素/SVG/字体/文本宽度等问题 | 本地 HTML→PPTX **0 API 成本**；上游若用 VLM 生成 HTML，按模型另计 **¥0.01～0.5/页** | 最适合作为 AnPPT 的**下游 HTML→PPTX 引擎**参考；建议使用最新版 `dom-to-pptx`，不要直接沿用 SlideSmith 锁定的 1.1.10 |

### 2.1 社区横向对照（不是用户列表，但影响选型）

| 项目 | 许可证/规模 | 社区实测要点 | 对 AnPPT 的启示 |
|---|---|---|---|
| [image-to-editable-ppt-skill](https://github.com/ningzimu/image-to-editable-ppt-skill) | MIT；核验时约 2,427 star | 作者明确写：10 页可能消耗完 5 小时额度；单页可能 10 分钟以上；成本可能是“生成图片 PPT”的 2～3 倍；不能保证 100% 复刻。Linux.do 用户实测 30～60 分钟/页，35 页约需 23 小时；作者在该帖中建议急用可转 Codia | 适合离线/高价值单页，不适合 SaaS 默认档 |
| [GordenSuperPPTSkills](https://github.com/GordenSun/GordenSuperPPTSkills) | **无 LICENSE**；核验时约 1,925 star | 作者称 1 张图约消耗 Plus 5 小时额度的 10%，约 15 分钟/页；用户反馈出现文字/图标乱飞、元素模糊、多轮返工 | 无许可证 + 高额度 + 高延迟；只能 learn-only |
| WPS AI PPT 图片转 PPT | 商业闭源 | WPS 社区实测：整体可用，但存在文字未识别、字体颜色变化、图层遗漏；另一篇实测给约 80 分 | 商业产品也未做到 100%；AnPPT 应把“可编辑初稿 + 人工修正”作为合理产品承诺 |


### 2.2 图片/截图 → HTML 上游候选（2026-09-09 核验）

> 目标不是直接找“图片转 PPTX”，而是找能接在 SlideSmith / `dom-to-pptx` 前面的 **图片/截图 → 单页 HTML** 上游。AnPPT 需要的输出合约是：一个固定 16:9 画布、禁止响应式重排、文本和形状位置明确、图片资产本地化，随后才能交给下游导出。

| 项目 | 许可证 / 活跃度 | 实际能力与输出 | 接入 AnPPT 的判断 | 结论 |
|---|---|---|---|---|
| [abi/screenshot-to-code](https://github.com/abi/screenshot-to-code) | MIT；约 78.4k star、9.5k fork；默认分支最后提交 2026-07-30，仓库持续更新 | React/Vite + FastAPI；上传截图后由 agent 生成单文件 HTML；支持 HTML+Tailwind、HTML/CSS、React、Vue、Bootstrap、Ionic；官方推荐 Gemini 3 Flash/3.1 Pro；支持 Gemini 抽取截图中的真实资产，安装 Playwright 后可让 agent 自己渲染截图检查；也支持 GPT/Claude | **首选主候选**。工程完整、模型可切换、已有 Playwright 自检，适合包一层 WebSocket 服务或 fork 后改 prompt。默认输出是响应式网页，不是固定 `.slide`；必须额外约束 1920×1080、绝对定位、禁用媒体查询和外部 CDN，并做逐页 QA | 适合自托管 beta；不建议直接原样接入生产 |
| [leigest519/ScreenCoder](https://github.com/leigest519/ScreenCoder) | Apache-2.0；约 3.0k star、321 fork；默认分支最后提交 2025-10-22，2026-08 有文档 PR 但未合并 | 论文/研究型多 agent 管线：VLM 先识别 header/sidebar/navigation/main content，再做 UIED 组件检测、区域 HTML 生成、bbox 映射和原图裁剪替换；支持 Doubao、Qwen、GPT、Gemini；输出 Tailwind CDN + 绝对定位容器 | **结构参考价值最高**。它明确做了“区块定位 + 原图资产裁剪”，比纯截图转代码更接近 PPT 页面复刻。但依赖重（PaddleOCR、TensorFlow、UIED 等）、每页按区域多次调用 VLM、无 Docker，且 open issue 指出 containment 逻辑可能删错框；不适合直接作为 AnPPT 生产运行时 | 适合借鉴结构化布局和资产裁剪；生产化成本高 |
| [zaro/img2html](https://github.com/zaro/img2html) | MIT；核验时 0 star；最后提交 2026-06-21 | Node 24 CLI/库；LangChain agent；支持 OpenAI、Anthropic、OpenRouter、Gemini、MiniMax、Ollama；输出单页 HTML+CSS 或 Tailwind；会保存 token/对话日志 | 轻量、容易改成 AnPPT 的 Node 适配器，也能通过 OpenRouter/OpenAI-compatible 接更多模型。但默认 prompt 是响应式页面、使用 CDN/占位图，仓库无测试，社区验证为零 | 只适合做低成本 spike 或 prompt/模型适配参考，不建议直接上生产 |
| [mostafasadeghi97/design2code](https://github.com/mostafasadeghi97/design2code) | MIT；681 star；默认分支最后提交 2026-07-01，但核心代码仍硬编码旧模型 `gpt-4-vision-preview` | Next.js 上传截图 → OpenAI Vision → 响应式 Tailwind HTML；支持继续编辑/流式输出 | 代码简单但已落后于当前模型，默认输出仍是响应式网页和 CDN；没有固定画布、资产裁剪或浏览器自检 | 只适合读 prompt/做旧方案对照，不建议依赖 |
| [KyrieCheungYep/ky-design-to-html-skill](https://github.com/KyrieCheungYep/ky-design-to-html-skill) | **无 LICENSE**；162 star；最后提交 2026-06-02 | Codex/Claude skill；流程是页面地图 → 代码/资产分离 → 固定设计画布 → HTML/CSS → 浏览器截图 → 视觉误差修正 | 方法论与 AnPPT 的需求高度一致，尤其强调“不要临时画复杂资产”和截图校准；但仓库没有许可证，不能复制代码或直接集成 | **只可学习流程，不可商用复制** |

补充资源：

- [NoviScl/Design2Code](https://github.com/NoviScl/Design2Code)（MIT，约 598 star）是评测集/论文代码，包含 484 个真实网页截图与 HTML，以及 80 个 hard case；适合做 AnPPT 的固定回归集，不是运行时转换器。
- [HuggingFaceM4/VLM_WebSight_finetuned](https://huggingface.co/HuggingFaceM4/VLM_WebSight_finetuned)（Apache-2.0）是本地 VLM 模型，截图组件 → HTML/CSS；模型卡明确标注 alpha，且需要自备 GPU。只适合研究/离线实验，不建议作为首发主模型。
- [Mrxyy/screenshot-to-page](https://github.com/Mrxyy/screenshot-to-page)（无 LICENSE，约 102 star）是早期 `screenshot-to-code` 分支，支持 OpenAI/Gemini/Qwen-VL，但最后提交 2025-02；只可 learn-only。
- [LunarWerxs/ReDesign](https://github.com/LunarWerxs/ReDesign)（MIT，约 23 star）支持一张截图并行跑多个模型并比较 HTML 重设计结果；它偏“重设计”，不是保真复刻，适合做模型横评工具，不适合作为忠实转 HTML 的上游。

**上游选型结论：**

1. **优先用 `abi/screenshot-to-code` 做 beta 外壳。** 先用 Gemini Flash/Pro 跑通，固定 `html_css` 或 `html_tailwind`，在额外 prompt 中强制单页 1920×1080 `.slide`、绝对定位、无响应式、无外部 CDN、资产内嵌/本地化；生成后必须用 Playwright 截图和原图做像素/OCR/bbox 校验。
2. **不要把 ScreenCoder 整个搬进 AnPPT。** 只借鉴它的“区块识别 → 区域生成 → 原图裁剪替换”思路；如果 AnPPT 自己能做版面 JSON，优先走“结构化 JSON → 确定性 HTML”，而不是让模型自由写整页 CSS。
3. **模型成本分两档。** 用 MiMo/DeepSeek Flash 一类便宜模型，单轮约 **¥0.01～0.04/页**；用 Gemini Flash 单轮约 **¥0.14～0.5/页**，3 轮修复约 **¥0.4～0.5/页**；如果触发 imagegen，每张再增加约 **¥0.36**。这些是模型估算，不含 QA、重试和人工返工。
4. **验收标准不是“HTML 能打开”。** 至少检查：单页尺寸是否为 1920×1080、文本是否完整、文本是否溢出、对象是否落在画布内、外部资源是否被拦截、HTML 送入 `dom-to-pptx@2.1.1` 后文本/形状/图片对象数是否合理，以及复杂页是否应回退 Codia。



### 2.3 Presenton：强在“文档/提示词 → 可编辑 PPTX”，不是截图复刻

Presenton 是当前热度很高的开源 AI PPT 项目，但它不属于“图片 → HTML → 可编辑 PPTX”这条上游，更适合放在“文本/文档 → 品牌化 PPTX”路线里比较。

| 维度 | 核验结果 |
|---|---|
| 项目规模/许可 | [presenton/presenton](https://github.com/presenton/presenton) 为 Apache-2.0；核验时约 10.1k star、1,565 fork、50 个 open issue，默认分支 2026-09-09 仍在更新，最新发布为 `v0.9.10-beta` |
| 输入 | 支持 prompt、PDF、Office 文档、表格、文本和图片；API 输入字段是 `content`、`files`、`slides_markdown` 等 |
| 图片处理 | 上传图片会先转成 PNG，再交给 LiteParse 做 OCR/文档解析，得到 Markdown/文本；它不是把截图当作版面参考去重建对象层级 |
| Standard 模式 | 使用预定义/自定义模板和结构化 JSON，在固定 `1280×720` 画布上生成文本、图片、形状、表格、图表和容器，支持拖拽编辑 |
| Smart 模式 | 让 LLM 直接生成 `1280×720` 的 HTML/Tailwind `<section>`，再转成 PPTX/PDF；适合内容驱动、自适应版式，但不是截图复刻 |
| 模板能力 | Template V2 是“已有 PPTX → 渲染幻灯片预览 + 原始元素 JSON → 视觉模型分析 → 可复用布局”；不是“单张截图 → 可复用布局” |
| 结论 | 如果目标是“把一张 PPT 截图尽量原样转成可编辑对象”，Presenton 只能提取文字/数据后重新设计，无法保证原图布局、层级和资产复刻；如果目标是“prompt/文档 → 可编辑 PPTX”，它是强候选 |

**成本口径：**

- 自托管无软件订阅费，按自己的模型、图片搜索/生成和服务器成本计费。
- Standard 路线通常包含大纲、结构选择和逐页内容生成等多轮调用；Smart 路线通常是整副 HTML 生成加校验/重试。具体单页成本必须按模型、页数和输出长度实测，不能直接套 Codia 的每页价格。

**需要重点核验的风险：**

1. open issue [#904](https://github.com/presenton/presenton/issues/904) 报告中文 deck 的 HTML→PPTX 与浏览器预览差异明显，包括字体替换、换行、对象位置和内容丢失；这对中文 AnPPT 是高风险。
2. open issue [#794](https://github.com/presenton/presenton/issues/794) 报告 `pptx-to-json` 在继承字号缺失时失败；历史上也有 CJK 字体导出问题（[#747](https://github.com/presenton/presenton/issues/747) 已关闭）。
3. 导出引擎 `@presenton/export-core` 是单独发布的 tarball；本次下载的 open-source 包内未见独立 LICENSE，且包 README 明确说 open-source edition 只支持 low-quality export。主仓库 Apache-2.0 是否覆盖该导出包、以及 low-quality 的实际限制，需要在接入 AnPPT 前做法务和回归审查。
4. 它不能替代 Codia 的复杂页兜底，也不能替代 `screenshot-to-code → 固定 HTML → dom-to-pptx` 的截图复刻链路。

**对 AnPPT 的建议：** 把 Presenton 当作“prompt/文档 → 可编辑 PPTX”的参考或旁路，不作为图片转可编辑 PPTX 的主链路。它的 Template V2 视觉分析流程值得研究，但不要直接引入其完整运行时。


---

## 3. 实际效果：本地可复现测试

### 3.1 SlideSmith 官方 examples

环境：macOS、Node 26.7.0、系统 Chrome、SlideSmith v1.1.0、`dom-to-pptx` v1.1.10、LibreOffice 渲染。

| 样例 | 页数 | 转换耗时 | 文本节点 | 原生形状 | 图片对象 | 表格/图形 | HTML vs PPTX 像素差 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `minimal.html` | 1 | 1.7s | 2 | 3 | 0 | 0 | MAE 1.54/255；差异像素 1.1% |
| `data-dashboard.html` | 2 | 5.8s | 21 | 27 | 9 | 0 | MAE 1.80/1.38；差异像素 1.3%/0.9% |
| `pitch-deck.html` | 5 | 2.1s | 57 | 33 | 12 | 1 个 graphicFrame | MAE 16.53/4.37/3.54/8.80/13.39；差异像素 8.3%/3.6%/2.7%/6.6%/1.4% |

结论：

- **简单 Flex/Grid、卡片、文字、基础色块：可用度很高。**
- **复杂渐变、模糊光斑、表格底色/边框：会丢失或明显降级。**
- **没有嵌入字体**：PPTX 内未发现字体文件，中文/英文字体最终取决于打开端字体环境。
- SlideSmith 提供 screenshot fallback：可编辑转换失败时可以退回整页图片，但那时视觉保真 ≠ 可编辑。

### 3.2 中文、表格、公式专项样例

构造一张包含中文、CSS Grid、表格、公式、渐变、阴影、圆形装饰的 1920×1080 页面，走 SlideSmith：

- 中文全部保留为文本框。
- 公式 `E = m c²`、下标/上标被拆成普通文本 run，**不是 PowerPoint 公式对象**。
- 表格被导出为 `graphicFrame`（PPT 原生表格），但表头底色和单元格样式丢失。
- 渐变背景、圆形模糊装饰、卡片阴影出现降级。
- 文本、形状、图片对象均存在；中文内容没有乱码。

这类页面适合作为“可编辑初稿”，不适合承诺“像素级复刻”。

### 3.3 bggg-creator-image2ppt 的 HTML 路径

同一张中文复杂页面分别测试：

| 输入形式 | manifest 结果 | 渲染结果 |
|---|---|---|
| 使用 class + CSS Grid 的 HTML | 只识别出 9 个 text，0 shape/image/table | 所有文字挤在左上角，布局基本失效 |
| 使用 inline absolute 定位的简单 HTML | 6 个 text、3 个 shape | 位置、卡片、文字基本正确，接近源图 |

结论：bggg 的 HTML 解析器**不是浏览器布局引擎**，它只对绝对定位、显式坐标的简单 HTML 比较可靠。AnPPT 如果走 HTML 路线，应使用 Playwright 计算真实布局，而不是让 bggg 的解析器推断 Flex/Grid。

### 3.4 Codia 现有真实产物基线

仓库内已有 `output/codia-nav-status/导航与状态-可编辑.pptx`（来源 `source-slide-04.png`）：

- PPTX 结构：53 个文本节点、59 个原生形状、61 个图片对象。
- 渲染与源图视觉非常接近；像素差 MAE 约 10.21/255，差异像素约 7.3%。
- 复杂插画、按钮、卡片、图标基本保留；文本对象数量足够，具备二次编辑空间。
- 代价：13 credits/页；订阅口径约 ¥0.83/页。若按 500 credits/$49.99 的加量包买，约 ¥9.36/页，非常不划算。

**这条基线说明：如果目标是“复杂页也要稳”，Codia 目前仍然很难被纯 HTML 路线全面替代。**

---

## 4. 成本模型

### 4.1 计算公式

```text
每页成本 =
  (输入 tokens × 输入单价 + 输出 tokens × 输出单价) × 调用轮次 / 1,000,000
  + imagegen 次数 × 单张价格
  + OCR/GPU/存储成本
  + 人工返工成本
```

本次估算假设：

- 单页输入约 1.7k tokens（页面图约 1.3k～1.7k + 提示词/上下文）；
- 单页输出约 6k tokens（HTML/JSON/修复指令）；
- 1 USD ≈ ¥7.2；
- `gpt-image-2` 按 AnPPT 当前口径 $0.05/张 ≈ ¥0.36/张；
- 不包含存储、带宽、失败重试和人工审核。

### 4.2 模型调用成本（单页）

| 模型 | 1 轮 | 3 轮修复 | +1 张 imagegen | +4 张 imagegen |
|---|---:|---:|---:|---:|
| MiMo-V2.5 | ¥0.014 | ¥0.041 | ¥0.374 | ¥1.454 |
| MiMo-V2.5-Pro | ¥0.043 | ¥0.129 | ¥0.403 | ¥1.483 |
| DeepSeek V4 Flash | ¥0.014 | ¥0.041 | ¥0.374 | ¥1.454 |
| Gemini 3 Flash Preview | ¥0.136 | ¥0.407 | ¥0.496 | ¥1.576 |
| Gemini 3.8 Flash | ¥0.171 | ¥0.514 | ¥0.531 | ¥1.611 |
| Gemini 3.1 Pro Preview | 约 ¥0.27 起 | 约 ¥0.8 起 | 约 ¥0.6 起 | 约 ¥1.7 起 |

价格来源：

- Gemini 官方价格页：Gemini 3.8 Flash 标准档 $0.75/M 输入、$3.75/M 输出（2026-12-31 前）；Gemini 3 Flash Preview $0.50/M 输入、$3.00/M 输出。
  <https://ai.google.dev/gemini-api/docs/pricing?hl=en>
- MiMo 官方调价公告（价格表图片）：MiMo-V2.5 $0.14/M 输入、$0.28/M 输出；MiMo-V2.5-Pro $0.435/M 输入、$0.87/M 输出。
  <https://mimo.mi.com/docs/zh-CN/news/latest/v2.5-price-update>
- DeepSeek 官方价格页：V4 Flash 输入约 ¥1/M、输出约 ¥2/M（以控制台实时价格为准）。
  <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>

### 4.3 路线级成本

| 路线 | 直接成本 | 延迟/风险 | 适用结论 |
|---|---:|---|---|
| 纯本地 HTML→PPTX（无 VLM） | ¥0 + 服务器 CPU | 快，但要求已有 HTML | 适合作为下游引擎 |
| MiMo/DeepSeek Flash 生成 HTML/JSON | ¥0.01～0.04/页 | 便宜，但布局/叠层质量需抽检 | 成本优先的 beta 可试 |
| Gemini Flash 生成 HTML/JSON | ¥0.14～0.5/页 | 质量更稳，复杂页仍会掉 | 推荐作为主模型候选 |
| Gemini Pro / 多轮修复 | ¥0.3～1/页 | 质量提升但延迟、重试成本上升 | 只用于高价值页 |
| bggg/Gorden 类 imagegen 重建 | ¥0.4～1.6/页 + 订阅额度 | 每页 1～4 张图，15～60 分钟/页常见 | 不适合 SaaS 默认档 |
| 本地 OCR + PptxGenJS | 约 ¥0.01～0.1/页 GPU/电费 | 只解决文字；形状/背景/公式弱 | 适合轻量文字可编辑档 |
| 百度 PaddleOCR-VL API | 免费 1000 页后约 ¥90/1000 页 | 依赖外部 API；结构化结果仍需后处理 | 适合 OCR spike |
| Codia PDF→可编辑 PPT | 订阅口径约 ¥0.83/页 | 速度、复杂页稳定性最好 | 当前生产默认档 |

### 4.4 人工返工才是最大变量

| 返工比例 | 每页返工时间 | 人工单价 | 平均每页增加 |
|---|---:|---:|---:|
| 10% | 5 分钟 | ¥100/小时 | ¥0.83 |
| 20% | 5 分钟 | ¥100/小时 | ¥1.67 |
| 30% | 10 分钟 | ¥100/小时 | ¥5.00 |

所以：

- 如果 HTML 路线能稳定减少 10 页里 1 页的 10 分钟返工，它省下的人工成本就已经接近 Codia 一整套的价格。
- 反过来，如果复杂页频繁需要人工对齐、改字体、补形状，所谓“¥0.01/页”的模型成本没有决策意义。

---

## 5. 按页型看最终效果

| 页型 | HTML 路线（SlideSmith/dom-to-pptx） | OCR + 文本框路线 | Codia 路线 |
|---|---|---|---|
| 标题、正文、项目符号 | 好；文本原生可编辑 | 好～中；文字可编辑，位置/字体可能偏 | 好；文本和布局稳定 |
| 卡片、色块、简单形状 | 好；基础形状可原生 | 弱；通常只有文字可编辑，形状仍是图片 | 好；形状/图片对象多 |
| 表格 | 中；可导出原生表格，但底色/边框/合并单元格易丢 | 中；可尝试原生表格，复杂合并单元格不稳 | 好；复杂样式仍需抽检 |
| 图表 | 中～弱；图表内部元素常被当作图片 | 中～弱；标签/坐标轴难以拆干净 | 好；复杂图表通常能保留 |
| 渐变、阴影、模糊、叠层 | 弱；本地实测会丢失或降级 | 弱；inpaint 可能产生纹理/边缘问题 | 好；视觉接近源图 |
| 公式 | 弱；通常变成普通文本 run，不是公式对象 | 中；文字可识别，公式结构不保证 | 中～好；需抽检公式对象 |
| 中文混排 | 内容可保留；字体不一定嵌入 | 内容可识别；字体匹配弱 | 好；中文场景已实测 |
| 照片、插画、图标 | 建议作为独立图片资产；不要硬拆 | 可裁剪为图片块；复杂背景易脏 | 好；通常作为独立图片对象 |

---

## 6. 对 AnPPT 的推荐方案

### 6.1 产品定位

不要把它包装成“截图无损转完全可编辑 PPT”。更准确的产品承诺是：

> **对象级可编辑初稿：文字、基础形状和图片组件尽量分开；复杂视觉保留为图片对象；不承诺像素级复刻。**

Codia 继续作为“完整可编辑 / 复杂页兜底”档。

### 6.2 推荐架构

```text
页图
  → 版面分析（VLM → SlideLayoutPlan JSON）
  → 受约束 HTML 渲染（确定性模板，不让模型自由写 CSS）
  → Playwright 真实浏览器布局
  → dom-to-pptx 2.1.1 / PptxGenJS 导出
  → 逐页渲染 QA（文本召回、溢出、bbox、像素差）
  → 通过：交付；失败：Codia 或整页图片回退
```

关键决策：

1. **上游输出结构化 JSON，而不是自由 HTML。** 让模型负责识别文本、bbox、字号、颜色、对齐、层级和资产类型；HTML 由确定性模板生成，降低不同模型/不同轮次的漂移。
2. **下游用最新版 `dom-to-pptx`，不要沿用 SlideSmith 锁定的 1.1.10。** 2.x 修了大量字体、SVG、渐变、文本宽度问题，但仍需锁版本 + 回归测试。
3. **模型分工：**
   - Gemini Flash：版面理解、复杂视觉关系；
   - DeepSeek V4 Flash / MiMo-V2.5：文本抽取、JSON/HTML 生成、成本敏感任务；
   - PaddleOCR-VL：文字 bbox/字号校正；
   - imagegen：只在复杂背景/组件无法从原图裁剪时使用，并严格限制次数。
4. **每页必须有 QA 和 fallback。** 不要因为模型返回 200 就直接给用户下载。
5. **bggg 只借 manifest 契约。** 它的组件分层、`text/shape/image/background/table` 元素定义适合作为内部 IR 参考；不要把 Python 脚本作为 AnPPT Node 运行时的一部分。

### 6.3 建议的验收线

以下为产品/工程验收建议，不是本次实测结果：

- 固定 30 页质量集，覆盖中文、表格、图表、渐变、叠层、公式、照片背景。
- 文本召回 ≥98%，无文字丢失；文本框 bbox IoU 中位数 ≥0.8。
- 无文本溢出、无关键对象错位；PPTX 可被 PowerPoint/Keynote/LibreOffice 打开。
- 简单页视觉差 MAE <5/255；复杂页允许回退，回退率 <20%。
- p95 单页处理 <60 秒；单页模型 + 渲染成本目标 <¥0.5。
- 失败页必须进入 Codia/图片版回退，不静默交付坏结果。

### 6.4 计费建议

| 档位 | 能力 | 建议用户价 | 说明 |
|---|---|---:|---|
| 文字可编辑 | 原图 + 文本框 | 5🌟/页（现状） | 成本最低，形状不可编辑 |
| 对象级可编辑 beta | 文本 + 基础形状 + 图片组件 | 5～8🌟/页 | HTML 路线，复杂页回退 |
| 完整可编辑 | Codia 重转换 | 20🌟/页（现状） | 复杂页默认档 |

不要把 HTML 路线定成与 Codia 同价；它的价值是便宜和快，不是复杂页同等保真。

---

## 7. 许可证与合规

| 项目 | 许可证 | 结论 |
|---|---|---|
| bggg-creator-image2ppt | MIT | 可参考/可改造；注意其依赖的 Codex/imagegen 不是可分发能力 |
| SlideSmith | MIT | 可作为下游参考；注意其 `dom-to-pptx` 版本较旧 |
| dom-to-pptx | MIT | 可集成；需锁版本、做回归 |
| image-to-editable-ppt-skill | MIT | 可学习流程；agent 额度/延迟不适合 SaaS 默认 |
| GordenSuperPPTSkills | 未发现 LICENSE | 默认不可商用集成，learn-only |
| OCR Arcade | 宣称 AGPL-3.0，但未找到源码 | 闭源 SaaS 集成前必须做 AGPL 合规审查；当前 learn-only |
| PaddleOCR/PaddleOCR-VL | Apache-2.0 | 比 AGPL 更适合作为 OCR spike 候选 |
| Codia | 商业 API | 当前生产依赖；保留为兜底 |

---

## 8. 最终建议

**短期（1～2 周）**

- 不替换 Codia。
- 做一个离线 spike：Gemini Flash/DeepSeek 生成 `SlideLayoutPlan`，确定性 HTML + Playwright + `dom-to-pptx@2.1.1` 导出。
- 用 AnPPT 固定质量集跑 30 页，记录文本召回、bbox、像素差、耗时、回退率。
- 只对有价值的页型上线 beta：标题页、纯文字页、卡片页、简单表格页；复杂背景/图表先走 Codia。

**中期（验证有效后）**

- 把 `image-to-html-pptx` 做成独立模块/插件，挂 feature flag，默认 beta。
- 引入逐页 QA 和自动回退；把 Codia 从“唯一路径”变成“复杂页兜底”。
- 逐步把 MiMo/DeepSeek 用于文本和低成本页，把 Gemini Flash/Pro 留给复杂页。

**不要做**

- 不要直接导入无许可证的 Gorden 技能包。
- 不要把 AGPL 项目接进闭源 SaaS 主链路。
- 不要把 imagegen 每页跑 4 次当作默认成本模型。
- 不要用“视觉相似”代替“对象可编辑”验收。

---

## 9. 主要来源

### 官方/源码

- bggg-skills 仓库：<https://github.com/binggandata/bggg-skills>
- bggg-creator-image2ppt README：<https://github.com/binggandata/bggg-skills/blob/main/bggg-creator-image2ppt/README.md>
- bggg-creator-image2ppt SKILL：<https://raw.githubusercontent.com/binggandata/bggg-skills/main/bggg-creator-image2ppt/SKILL.md>
- SlideSmith：<https://github.com/AliceLJY/slidesmith>
- SlideSmith package.json：<https://github.com/AliceLJY/slidesmith/blob/main/package.json>
- dom-to-pptx：<https://github.com/atharva9167j/dom-to-pptx>
- image-to-editable-ppt-skill：<https://github.com/ningzimu/image-to-editable-ppt-skill>
- GordenSuperPPTSkills：<https://github.com/GordenSun/GordenSuperPPTSkills>
- PaddleOCR-VL 1.6 文档：<https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PaddleOCR-VL/PaddleOCR-VL-1.6.en.md>
- Daniel-Siae/image2pptx：<https://github.com/Daniel-Siae/image2pptx>
- JadeLiu-tech/px-image2pptx：<https://github.com/JadeLiu-tech/px-image2pptx>

### 图片 → HTML 上游候选

- abi/screenshot-to-code：<https://github.com/abi/screenshot-to-code>
- ScreenCoder：<https://github.com/leigest519/ScreenCoder>
- ScreenCoder 论文：<https://arxiv.org/abs/2507.22827>
- zaro/img2html：<https://github.com/zaro/img2html>
- mostafasadeghi97/design2code：<https://github.com/mostafasadeghi97/design2code>
- ky-design-to-html-skill：<https://github.com/KyrieCheungYep/ky-design-to-html-skill>
- NoviScl/Design2Code benchmark：<https://github.com/NoviScl/Design2Code>
- WebSight VLM-8B 模型卡：<https://huggingface.co/HuggingFaceM4/VLM_WebSight_finetuned>
- Mrxyy/screenshot-to-page：<https://github.com/Mrxyy/screenshot-to-page>
- LunarWerxs/ReDesign：<https://github.com/LunarWerxs/ReDesign>

### Presenton 核验

- Presenton 主仓库：<https://github.com/presenton/presenton>
- Presenton 工作流：<https://docs.presenton.ai/general/how-presenton-works>
- Presenton 文档输入：<https://docs.presenton.ai/user-guide/working-with-content/documents>
- Presenton 图片与媒体：<https://docs.presenton.ai/user-guide/working-with-content/images-and-media>
- Presenton Template V2 架构：<https://github.com/presenton/presenton/blob/main/docs/template-v2.md>
- Presenton 导出运行时发布页：<https://github.com/presenton/presenton-export/releases>
- Presenton 中文 PPTX 导出问题：<https://github.com/presenton/presenton/issues/904>

### 价格/API

- Codia PDF to Editable PPT API：<https://codia.ai/pdf-to-editable-ppt-api>
- Codia Open API 定价：<https://codia.ai/zh-CN/pricing/open_api>
- Gemini API 定价：<https://ai.google.dev/gemini-api/docs/pricing?hl=en>
- MiMo-V2.5 调价公告：<https://mimo.mi.com/docs/zh-CN/news/latest/v2.5-price-update>
- DeepSeek API 定价：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- 百度文档解析（PaddleOCR-VL）：<https://cloud.baidu.com/product/ocr/doc_parser>
- OCR Arena（不是 OCR Arcade）：<https://www.ocrarena.ai/battle>

### 社区实测

- Linux.do：单页 30～60 分钟、35 页约 23 小时、作者建议 Codia：<https://linux.do/t/topic/2324953>
- Linux.do：Gorden 技能 15 分钟/页、1 张图约 10% Plus 5 小时额度、文字/图标乱飞反馈：<https://linux.do/t/topic/2327040>
- WPS 社区：Nano Banana Pro 图片转 PPT 实测，文字/图层/字体颜色问题：<https://bbs.wps.cn/topic/77635>

---

## 10. 本报告未解决的问题

1. `ai-image2academic-ppt` 和 `OCR Arcade` 均未找到可核验的公开源码；如果它们是私有项目，需要提供仓库或部署地址才能做真实验证。
2. Codia 只核验了仓库内已有的一页样例；不同页型、不同语言、不同 PDF 来源的失败率仍需用 AnPPT 固定质量集统计。
3. HTML 路线的实际失败率尚未在生产模型链上跑完；本报告的成本模型是估算，不是账单。
4. 人工返工成本按 ¥100/小时示例计算；实际应以团队成本和返工日志为准。
5. 本次新增的图片 → HTML 候选及 Presenton 只完成源码、许可证、活跃度和接入方式核验，没有调用付费模型跑端到端效果；真实布局保真度、失败率和单页成本仍需用 AnPPT 固定质量集实测。
