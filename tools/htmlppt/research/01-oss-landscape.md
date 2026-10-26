# HTML → 可编辑 PPTX：开源工具与路线全景

> 调研员：oss-scout ｜ 任务：task-1 ｜ 完成时间：2026-10-19
> 目标：为「HTML 做幻灯片、精确导出为可编辑 .pptx」的产品选型提供事实基础。
> 方法：GitHub API 读元数据、raw.githubusercontent 读 README/源码、npm/PyPI registry 读包元数据与 wheel/tarball 内容、官方帮助文档 + 二手评测交叉验证。所有结论附链接；单一来源已标注；抓不到原文的写「未验证」。

---

## TL;DR（5 条）

1. **「HTML → 可编辑 PPTX」事实上只有一种可行架构：受限 HTML 子集 + 无头浏览器量测 + 映射成原生 DrawingML 对象**（不是通用 HTML 渲染器）。Anthropic 官方 `html2pptx`、PPTAgent 的 `html2pptx.js`、Hasasasa、Design-Arena、dom-to-pptx 全是这一条路线，差别只在「量测后写哪一层」和「CSS 表达不了的部分怎么兜底」。参见 [Anthropic html2pptx 指南](https://github.com/anthropics/skills/blob/ef740771/skills/pptx/html2pptx.md) 与 [PPTAgent 的 html2pptx.js 头注释](https://github.com/icip-cas/PPTAgent/blob/v1.1.38/deeppresenter/html2pptx/html2pptx.js)（后者明写 "Originally based on Anthropic Skills"）。

2. **Anthropic 官方 html2pptx 已经死了，而且从来不是开源**：它先把 `html2pptx.tgz` 打进 pptx skill（[commit 4e6907a3，2026-02-04](https://github.com/anthropics/skills/commit/4e6907a3)），同一天又以「Delete deprecated html2pptx.tgz dependency」删掉（[commit a5bcdd7e](https://github.com/anthropics/skills/commit/a5bcdd7e)）。当前 pptx skill 的「创建新 deck」路径已改成**直接写 pptxgenjs 脚本**（[SKILL.md](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md)）。License 在子目录、明确禁止衍生/分发/商用（[LICENSE.txt](https://github.com/anthropics/skills/blob/main/skills/pptx/LICENSE.txt)、[README 自述 source-available, not open source](https://github.com/anthropics/skills#readme)）。

3. **Manus 给出最强的反向信号**：它在 2026-07 把幻灯片从「网页格式生成、导出时转 .pptx」改成「**从第一张起就原生生成 .pptx**」，官方原话是旧方式「可能会导致格式问题」（[Manus 官方博客](https://manus.im/blog/manus-ppt-slides)）。这说明「HTML 只是皮、OOXML 才是骨」的架构判断已被头部团队用产品决策验证。

4. **真正能商用落地的开源实现是 MIT 三件套**：`dom-to-pptx`（[380★，月下载 22.3 万](https://github.com/atharva9167j/dom-to-pptx)）、`Hasasasa/html-to-editable-pptx`（[89★，MIT，五段流水线 + 兜底栅格](https://github.com/Hasasasa/html-to-editable-pptx)）、`Design-Arena/html-to-pptx`（[24★，MIT，python-pptx 渲染](https://github.com/Design-Arena/html-to-pptx)）。三者都可读到全部源码。

5. **PptxGenJS 是事实上的写入层，但不是无痛底座**：月下载 1425 万、MIT、6.3k★，却是「构建器 API」而非转换器；默认 `compression: false` → ZIP 用 STORE 而非 DEFLATE（[源码 L554](https://github.com/gitbrent/PptxGenJS/blob/master/src/pptxgen.ts#L554)），社区已定位这是 Office 报「文件损坏/需修复」的根因之一（[dom-to-pptx PR #40](https://github.com/atharva9167j/dom-to-pptx/pull/40)）；且不支持字体嵌入（[issue #1302 仍 open](https://github.com/gitbrent/PptxGenJS/issues/1302)）、最新版 4.0.1 停在 2025-06。**结论：可作底座，但必须自建「Office 兼容性护栏 + 字体嵌入 + 文本量测」三件事，或者直接自研 OOXML writer。**

---

## 一、路线分类

### 路线 A：自由 HTML 量测 → 原生对象映射（主流）

```
HTML/CSS（受限子集） → 无头 Chromium 渲染 → DOM 遍历 getBoundingClientRect/getComputedStyle
  → 中间记录（text runs / shape / image / deco） → 写入 OOXML（pptxgenjs / python-pptx / 直接 XML）
  → 校验收尾（溢出、重叠、全页图嫌疑、Office 打开测试）
```

- **共同前提**：HTML 必须写成「PPTX 可表达的子集」。Anthropic 的硬规则是最完整的样本：文字必须包在 `<p>/<h1>-<h6>/<ul>/<ol>` 里，背景/边框/阴影只能挂在 `<div>` 上，禁止 CSS 渐变（要预渲染成 PNG），只许用 web-safe 字体，body 尺寸必须等于版面（16:9 = 720×405pt），正文底部留 0.5 英寸（[html2pptx.md](https://github.com/anthropics/skills/blob/ef740771/skills/pptx/html2pptx.md)）。PPTAgent Skill 的 [task-contract.md](https://github.com/icip-cas/PPTAgent/blob/main/skills/pptagent/references/task-contract.md) 几乎照抄了同一套约束，并补了一条很实用的：**文本容器要显式给宽、留余量，因为导出后字体度量会变，贴死的标题会换行压住下一个元素**。
- **写法差异**：
  - 写 **PptxGenJS 对象模型**：Anthropic html2pptx、PPTAgent html2pptx.js、dom-to-pptx、slidesmith、PPTAgent Skill
  - 写 **python-pptx 对象模型**：Design-Arena
  - 直接写 **DrawingML XML**：html-native-pptx（IR → `<a:custGeom>`/`<a:tbl>`/`<a:gradFill>`）
- **兜底策略分水岭**：整页截图（slidesmith `--screenshots`）vs **局部装饰栅格**（Hasasasa：只把 PPT 表达不了的 deco 截成 PNG 垫在矢量文字**下面**）。后者是产品级正解。

### 路线 B：模板槽位填充（Template/Slot）

- 代表：**PPTAgent**（研究框架，EMNLP 2025）。两阶段 edit-based：先分析参考 PPT 抽 slide 功能类型与内容 schema，再为大纲逐页生成「编辑动作」在参考页上改（[论文摘要 arXiv:2501.03936](https://arxiv.org/abs/2501.03936)）。
- 特点：可编辑性天然最高（本质是在真 PPT 上改），但**版式自由度被模板锁死**；换模板=换设计语言。适合「批量、风格统一、企业模板」场景，不适合「HTML 任意排版」。
- 现状：仓库 HEAD 已收缩为 PPTAgent Skill（HTML 优先，见路线 A），研究框架留在 [v1.1.38](https://github.com/icip-cas/PPTAgent/tree/v1.1.38)/v0.2.0 标签。

### 路线 C：生图逆向 / HTML 光栅化包装

- 代表：**AiPPT「图片集 PPT（防修改）」**（每页转成一张图，宣称「防篡改」，[AiPPT 帮助中心](https://www.aippt.cn/plugin/help/article/6)）；以及大量「AI 截图工具」——生成网页后截图塞进 pptx。
- 可编辑性 = 0，只保真不保改。对本产品是**反面参照**，但它的存在说明市场确实有人要「不可编辑」的交付物（安全分发场景），值得作为一个导出选项而非默认。

### 横切：商业产品在走「第四条路」——原生 OOXML 生成

Manus 的 PowerPoint 模式、Kimi 官方 PPT 智能体都声称「默认生成原生可编辑 PPTX（文本框、表格、原生图表），不要图片贴片」（[Manus](https://manus.im/blog/manus-ppt-slides)、[Kimi API 文档](https://platform.kimi.com/docs/hosted-agents/official-ppt-agent)）。这不是 HTML→PPT 转换，而是跳过硬 HTML 直接产出 OOXML。对自研产品的含义见文末判断。

---

## 二、逐项目卡片

### ① Anthropic 官方 pptx skill / `html2pptx.js`（anthropics/skills）

- **仓库**：[anthropics/skills](https://github.com/anthropics/skills)（182k★，2025-09 建，2026-10 仍活跃）
- **架构**：`html2pptx(htmlFile, pres, options)` 返回 `{slide, placeholders}`。Playwright 起 Chromium → 设置 viewport 为 body 尺寸 → 浏览器侧 `ExtractSlideData` 遍历 `document.querySelectorAll("*")`：
  - `SVG`/`CANVAS` → 打 `data-rasterize` 标记后截图（rasterized-image）
  - `P/H1-H6/UL/OL/LI` → 文本节点（含 inline runs：`<b>/<i>/<u>/<span>` 的 weight/italic/underline/color）
  - `.placeholder` class → 只返回坐标矩形，交给调用方 `slide.addChart()` 填原生图表
  - `IMG` → addImage；`DIV/SECTION/HEADER/FOOTER/...` → 背景/边框/圆角/阴影 → shape；非均匀边框拆成 4 条 line 形状
  - 文字写入用实测 `fontSize`（px×0.75）+ `inset: 0` + `valign: top`，**单行文本把宽度放 2%** 防换行；**不做 autofit/shrink**
- **校验（很值得抄）**：body 溢出量、HTML 尺寸 vs `presLayout`、文字元素上不许有背景/边框/阴影、文本框距底边 <0.5" 且字号 >10.5pt 报错、placeholder 过小报错，**所有错误收集完一次性抛出**
- **可编辑度**：高。文本真文本框、形状真形状、图表是原生 chart；但渐变一律预渲染成 PNG，SVG/canvas 一律栅格。
- **限制**：只支持 web-safe 字体（Segoe UI/Roboto 会「rendering issues」）；禁止 CSS 渐变；`div` 里的裸文字会被**静默丢弃**；文本可溢出（无 shrink）。
- **License**：**source-available，非开源**。`skills/pptx/LICENSE.txt` 明确禁止「提取/复制/创作衍生作品/分发/商用」；仓库 README 自述 docx/pdf/pptx/xlsx 四个目录「source-available, not open source」。
- **成熟度**：曾是生产用内部工具；**2026-02-04 打包当天即被标记 deprecated 并删除**（[a5bcdd7e](https://github.com/anthropics/skills/commit/a5bcdd7e)）。当前官方创建路径改为「写 pptxgenjs 脚本」，SKILL.md 里列了 20+ 条 pptxgenjs 脚枪（含图表 XML 会让 PowerPoint 判文件损坏）。

> **对我们的价值**：它是「约束契约 + 校验器」的最佳参考样本，但代码一行都不能进产品。**单一来源说明**：架构细节来自我直接解包 `html2pptx.tgz`（index.mjs + playwright/index.iife.js）阅读，非二手转述。

### ② Hasasasa/html-to-editable-pptx（MIT，89★）

- **仓库**：[Hasasasa/html-to-editable-pptx](https://github.com/Hasasasa/html-to-editable-pptx)（2026-05 建，2026-07 最后 push，Python）
- **架构（五段流水线，最工程化的一套）**：
  `preflight（风险模式扫描）→ measure（Playwright 抽 text/shape/media/deco 记录）→ assemble（写 OOXML：textbox/shape/media/snapshot）→ embed_fonts（按实际用字 subset 并嵌入）→ self_check（结构扫描 + 渲染 PNG）→ visual_audit（HTML/PPT 双栏对比 + contact sheet）`（[README Pipeline](https://github.com/Hasasasa/html-to-editable-pptx#pipeline)）
- **核心设计原则**：「Vector-first，Local fallback」——渐变/box-shadow/filter/backdrop-filter/mix-blend-mode/复杂 transform 走**局部快照**，**文字仍以矢量画在快照之上**；不整页栅格（[README](https://github.com/Hasasasa/html-to-editable-pptx#design-principles)）
- **方法论文档极其值得读**：[references/methodology.md](https://github.com/Hasasasa/html-to-editable-pptx/blob/main/references/methodology.md)
  - 「反假设流水线」：决策只能依赖运行时事实（`getComputedStyle`/`getBoundingClientRect`），不写死 selector/类名
  - 强制进入可测状态：`position:fixed; inset:0`、清祖先 transform、强制 `opacity:1/transform:none`、关 transition
  - 兜底栅格前必须**隐藏**所有将由矢量层重画的元素（inline `!important`），否则「被烘焙进 PNG → 双层」
  - 验证分两层：5a 结构化扫描（全屏 `<p:pic>` 嫌疑 = FULL-PIC、文本框重叠 = LAYOUT）；5b VLM 视觉审计（**明确说「不做像素 diff —— 数字给假信心」**）
- **可编辑度**：高（文字/简单几何原生，deco 栅格）
- **限制**：依赖 Playwright + 渲染器（LibreOffice/Office）做视觉审计；字体嵌入走 Google Fonts 子集，CJK 自动补 Noto Sans/Serif SC；**仍是批量转换器，不是编辑器**
- **License**：MIT（仓库 LICENSE）
- **成熟度**：89★、10 fork、0 open issue；作者自述「每装一次积累 lessons-learned.md，越用越准」——暗示长尾 bug 靠人工审计兜。**单一来源**：以上均来自其仓库文档，未见第三方评测。

### ③ AliceLJY/slidesmith（MIT，1★）

- **仓库**：[AliceLJY/slidesmith](https://github.com/AliceLJY/slidesmith)（1★，0 fork，2026-04 建，2026-09 最后 push）
- **架构**：**薄 CLI wrapper**。起本地 HTTP server 伺服 HTML/资源 → Playwright 渲染 → 调 `dom-to-pptx` 遍历 DOM → PptxGenJS 写盘。双模式：默认 editable；`--screenshots` 整页 2x 截图（不可编辑）；editable 抛错时自动兜底到截图并回报最终模式（[README](https://github.com/AliceLJY/slidesmith)）
- **可编辑度**：取决于 dom-to-pptx；兜底模式为 0
- **限制**：README 自己承认「不发布到 npm，`slidesmith` 这个 npm 包名属于无关项目」；只支持 `class="slide"` + 显式尺寸
- **License**：MIT
- **成熟度**：1★、0 fork。实际上作为「架构参考」价值 > 作为依赖价值。

### ④ dom-to-pptx（MIT，380★，月下载 22.3 万）— 实际最主流的实现

- **仓库**：[atharva9167j/dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx) ｜ [npm](https://www.npmjs.com/package/dom-to-pptx)（v2.1.2，28 个版本）
- **架构**：自称 **"Coordinate Scraper & Style Engine"**，客户端库（浏览器里跑，无需服务端）。遍历 DOM 求 computed style，数学映射到原生 shape/textbox；依赖 `pptxgenjs@^4` 写入、`html2canvas` 处理伪元素、`opentype.js`+`fonteditor-core` 做字体嵌入、`puppeteer` 供 CLI
- **能力亮点**（README 宣称，未逐一实机验证）：CSS 渐变→矢量 SVG、伪元素引擎、阴影笛卡尔→极坐标转换、圆角图片 anti-halo、`filter: blur()`→软边缘、字体自动嵌入、动画/转场转原生 PPT 动画、1920×1080 自动缩放、speaker notes（`data-pptx-notes`）
- **可编辑度**：高（文本/形状/表格原生；复杂伪元素可退化为 canvas 快照）
- **限制/风险**：
  - **Office 兼容性曾翻车**：[PR #40](https://github.com/atharva9167j/dom-to-pptx/pull/40) 标题即 "fix: ensure generated PPTX opens in Microsoft PowerPoint"，根因两条——PptxGenJS 用 STORED 而非 DEFLATE 压缩、`[Content_Types].xml` 声明了不存在的 slideMaster Override；**WPS 能开、Microsoft PowerPoint 报损坏**。该 PR 2026-05-16 已合并。
  - 依赖链长（puppeteer/html2canvas/opentype），客户端 bundle 大；有 1.1.6 回归（表格空白、多页合并损坏）等 issue 记录（[issues](https://github.com/atharva9167j/dom-to-pptx/issues)）
- **License**：MIT
- **成熟度**：**最高**（下载量是第二名的 1000 倍量级），但 v2 才刚加动画、v2.1 仍在修 footer 细节 → 处于「快速迭代 + 偶发回归」阶段

> **`@cwjcharles/dom-to-pptx`（npm，v1.1.9）**：不是独立项目，而是**上游 PR #40 未合并前的临时 fork**，只做「DEFLATE re-zip + 清理悬空 Content_Types Override」两处修复，作者自述 PR 合并后即废弃（[npm 描述](https://www.npmjs.com/package/@cwjcharles/dom-to-pptx)）。上游 PR 已于 2026-05-16 合并 → **这个 fork 现在没有使用价值**，但它的存在证明了 PptxGenJS 的 Office 兼容坑是真实的生产事故。

### ⑤ html-native-pptx（npm，MIT，v0.2.0）

- **仓库**：[Davinsry/html-native-pptx](https://github.com/Davinsry/html-native-pptx)（2026-09-06 建，0★，月下载 179）
- **架构**：**不做 pptxgenjs 依赖，自己写 OOXML**。三阶段：
  `DOM Harvester（headless Chromium，抽 SVG path/table/gradient/computed layout）→ IR Normalizer（强类型 AST，字体/样式/单位归一）→ OpenXML Compiler（<a:custGeom> 自定义矢量、<a:tbl> 原生表、<a:gradFill>、EOT 字体嵌入 .fntdata）→ JSZip 打包`
  （[WALKTHROUGH.md](https://github.com/Davinsry/html-native-pptx/blob/main/WALKTHROUGH.md)、[src 目录](https://github.com/Davinsry/html-native-pptx/tree/main/src)）
- **可编辑度**：理论上最高——SVG path 直接编成 PowerPoint 自定义几何（可 1000% 放大不糊、可改 stroke/fill）、表格是真 `<a:tbl>`、字体嵌入跨机一致
- **限制**：极不成熟（0★、2 个版本、179 下载/月）；未验证真实复杂 deck 的稳定性；SVG 只覆盖 path/circle/rect/line/polyline
- **License**：MIT
- **成熟度**：**实验品**。但**架构方向与我们的目标最接近**：IR 分层 + 直写 DrawingML + 字体嵌入，正是「自研」时该抄的骨架。

### ⑥ html2pptx-cli（npm，MIT CLI，服务闭源）

- **包**：[html2pptx-cli](https://www.npmjs.com/package/html2pptx-cli)（v0.4.1，2026-04 首发 / 2026-06 最后更新，月下载 36）
- **本质**：**SaaS 客户端**。命令 `html2pptx convert slides.html -o out.pptx` 需要先 `html2pptx init` 填 API key，默认请求 `https://html2pptx.app`（`--base-url` 可改）。CLI 本身 MIT，但**转换引擎在服务端、闭源、要账号**。还带本地 visual edit bridge（`html2pptx edit`）与模板市场 MCP 工具，但 CLI 的 publish 命令被禁用（[README](https://www.npmjs.com/package/html2pptx-cli)）。
- **判读**：可作为「闭源服务」类竞品观察，不是可复用代码。README 未说明其引擎技术栈 → **未验证**。

### ⑦ PyPI `html-to-pptx`（Design-Arena/html-to-pptx，MIT，24★）

- **仓库**：[Design-Arena/html-to-pptx](https://github.com/Design-Arena/html-to-pptx) ｜ [PyPI 0.3.0](https://pypi.org/project/html-to-pptx/)（4 个 release，依赖 lxml/Pillow/playwright/python-pptx）
- **架构**：**两段式 API**，很适合嵌产品：`extract_measurements(html)`（Playwright 逐 `.slide` 隔离渲染、清 transform、递归量测→JSON 树）→ `render_pptx(measurements)`（python-pptx 写 text box/picture/rectangle/outline），坐标 CSS px→inch 用 `13.333/1920`
- **特色**：写了很多「PPT 里怎么表达 CSS」的工程细节——web 字体映射到度量兼容的安全字体、单行标题自动缩字号防换行、`line-height`→精确段间距、CSS padding→text frame insets、半透明色按最近祖先背景 flatten、`object-fit:cover` 居中裁切、conic-gradient 栅格化、伪元素造形状、竖排文字、RTL
- **限制（README 自列，诚实度加分）**：**外部图片不抓，必须 base64**；`background-image: url()` 不转；radial/多层渐变退回纯色；动画/转场不表达；复杂 grid/flex 嵌套可能丢精度
- **可编辑度**：高（文本/图片/形状原生）
- **License**：MIT
- **成熟度**：24★ 但**有 CI + PyPI 发布 + [compare 工具](https://github.com/Design-Arena/html-to-pptx#visual-comparison-tool)**（截图 HTML → 转 PPTX → LibreOffice 渲染回来 → 并排出图），工程规范度高于 star 数。适合做 Python 侧参考实现。

### ⑧ PyPI `zconvert`（MIT 客户端 + 闭源 Docker 引擎）

- **包**：[PyPI zconvert 1.5.0](https://pypi.org/project/zconvert/)（8 个 release，唯一依赖 `httpx`；同仓 Node/Rust SDK）
- **本质**：**和 html2pptx-cli 同构的闭源服务客户端**。`ZConvert()` 首次调用会 `docker run` 拉 `yatchiyax/zconvert`（~2.7GB）起本地渲染服务，再走 HTTP 提交 HTML。参数含 `mode="native"（默认，可编辑）| "image"（像素级）`、`embed_fonts`（默认 True）、`real_background`、字体、`timeout_ms`（[wheel 内 METADATA/README](https://pypi.org/project/zconvert/) 及 `_engine.py`）
- **License**：客户端 MIT；**引擎镜像不开源**（wheel 里无引擎源码）
- **成熟度**：v1.5.0，8 个 release，提供 Node/Rust SDK → 商业化意图明显；**未验证**其 native 模式的真实可编辑度（需拉 2.7GB 镜像实测，本次未做）

### ⑨ presenton/presenton（Apache-2.0 主仓 + 闭源导出核心，11.2k★）

- **仓库**：[presenton/presenton](https://github.com/presenton/presenton)（Apache-2.0，11,209★，1,706 fork，TypeScript+FastAPI）
- **架构（两条流水线，值钱的是分层思想）**：
  - **Standard**：LLM 出提纲（prompt 禁止写「这里放柱状图」这类制作指令，只写观众可见文字）→ 从模板布局库选布局 → 逐页产出受 JSON Schema 约束的 JSON
  - **Smart**：让 LLM 直接写 1280×720 的 `<section>` HTML（Tailwind + Chart.js），再上三层防线：sanitize 剥危险标签/事件/javascript: URL、289 行几何审计（负 margin、overflow-hidden 藏文本、绝对定位出界/重叠、禁用 overflow-auto/line-clamp/truncate）、8 次重试预算 + 断点续写
  （来源：独立拆解博客 [「全开源是口号，Presenton 把 PPTX 导出核心藏进了下载包」](https://wangruofeng007.com/blog/2026-09/presenton-ai-presentation-pipeline/)，与我读到的仓库代码互相印证）
- **导出链路（关键发现）**：FastAPI 拼 `/pdf-maker` URL → 起 Node 子进程 `presentation-export/runner.mjs` → puppeteer 打开页面 → 调 `@presenton/export-core`。这个包**不在主仓库**：由 [`scripts/sync-presentation-export.cjs`](https://github.com/presenton/presenton/blob/main/scripts/sync-presentation-export.cjs) 从 **GitHub Releases 下载预编译 tarball**；我拉下 `presenton-export-core-opensource-1.0.51.tgz` 检查，`dist/index.js` 是 **javascript-obfuscator 混淆**过的（变量名 `_0x1f09bd` 之类），devDeps 里就有 `javascript-obfuscator`；[presenton/presenton-export](https://github.com/presenton/presenton-export) 仓库**只有 release 资产、无源码、无 license 文件**。
- **性质**：**「开源外壳 + 闭源导出内核」**。README 首页写「Fully open-source (Apache 2.0)」，但决定 PPTX 可编辑度的那一步（元素坐标 → `slide*.xml`）不可见。主仓唯一碰 PPTX 格式的代码是 `servers/fastapi/templates/pptx_font_utils.py`（只做字体子集化）。
- **License**：主仓 Apache-2.0；导出核心 = 预编译 + 混淆 + 无 license → **按「不可审计、不可改、不可再分发」处理**。
- **成熟度**：产品级（Docker/Electron/API/MCP，v0.9.11-beta），但社区报 Docker 镜像缺内置模板（issue #881）、离线自定义模板不可用（#781）、部分编辑动作失效（#860）（均转引自上文拆解博客，**单一来源**）。

### ⑩ icip-cas/PPTAgent（MIT，5.1k★）

- **仓库**：[icip-cas/PPTAgent](https://github.com/icip-cas/PPTAgent)（MIT；论文 [arXiv:2501.03936](https://arxiv.org/abs/2501.03936) EMNLP 2025；后续 DeepPresenter ACL 2026）
- **两条形态**，别混：
  1. **研究框架 = 路线 B**：edit-based，在参考 PPT 上学习 slide 功能类型 + 内容 schema，再逐页生成编辑动作。产出可编辑但版式被模板锁死。代码在 [v1.1.38](https://github.com/icip-cas/PPTAgent/tree/v1.1.38)/v0.2.0 标签。
  2. **PPTAgent Skill（HEAD 主推）= 路线 A**：宿主 Agent 写 HTML → CLI 渲染 → 转 PPTX → 视觉审查 → `answer.pptx`。运行依赖是 `playwright@1.62 + pptxgenjs@^4 + sharp`（[package.json](https://github.com/icip-cas/PPTAgent/blob/main/skills/pptagent/package.json)）。
- **重要发现**：其运行时 `deeppresenter/html2pptx/html2pptx.js` 是 **2987 行的完整实现，头注释写明 "Originally based on Anthropic Skills, modified and enhanced by PPTAgent team"**，并补了表格支持（[源码](https://github.com/icip-cas/PPTAgent/blob/v1.1.38/deeppresenter/html2pptx/html2pptx.js)）。
- **License 隐患**：Anthropic 原代码是 source-available 且禁止衍生作品；该文件在 MIT 仓库里被再许可 → **许可链有瑕疵**。若我们要复用，必须做法务 review 或重写。**这是本报告里最需要注意的「隐形地雷」。**
- **成熟度**：研究界认可（EMNLP/ACL），工程上是「skill 形态」而非库形态。

### ⑪ singerla/pptxgenjs（任务里提到的仓库）→ 实为 PptxGenJS 的陈旧镜像

- [singerla/pptxgenjs](https://github.com/singerla/pptxgenjs)：0★、0 fork、最后一次 push **2021-03-03** → 是 2021 年的 fork/镜像，**不是真正的 PptxGenJS**。真正上游是 [gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS)。任务清单里出现这个名字，建议直接替换为 gitbrent 版本，避免选错依赖。

---

## 三、PptxGenJS 的能力边界：它能不能当「最终落盘通用底座」？

**结论：能当写入层，不能当转换层，且必须自己补三件事。**

| 维度 | 事实 | 证据 |
|---|---|---|
| 定位 | 构建器 API（addText/addShape/addImage/addChart/addTable），**不是 HTML 转换器**；只有 `tableToSlides()` 把 HTML `<table>` 转成幻灯片 | [README](https://github.com/gitbrent/PptxGenJS#readme) |
| 生态位 | 月下载 **14,250,268**；6,289★；965 fork | npm registry / GitHub API（2026-10-19 抓取） |
| 版本与维护 | 最新 4.0.1 发布于 **2025-06**；master 最后 commit **2025-06-26**；305 个 open issue；2026-08 仍有 PR 活动但无 release | [npm](https://www.npmjs.com/package/pptxgenjs)、[commits](https://github.com/gitbrent/PptxGenJS/commits/master) |
| 压缩默认值 | `compression: false` → JSZip 用 **STORE**；OOXML 规范与 Office 更偏好 DEFLATE | [src/pptxgen.ts L554](https://github.com/gitbrent/PptxGenJS/blob/master/src/pptxgen.ts#L554) |
| Office 兼容地雷 | ① STORED 压缩 ② `[Content_Types].xml` 给不存在的 slideMaster 写 Override → PowerPoint 报「文件损坏/需修复」，WPS 却正常 | [dom-to-pptx PR #40](https://github.com/atharva9167j/dom-to-pptx/pull/40)（**单一来源**：根因诊断来自该 PR 作者，我已在源码侧确认 STORE 默认值，但「Office 强制要求 DEFLATE」未找到规范原文 → 存疑待验） |
| 字体嵌入 | **不支持**。issue #1302 "feat: support embed fonts" 仍 open | [issue #1302](https://github.com/gitbrent/PptxGenJS/issues/1302) |
| 文本量测/自动缩排 | **不做**。调用方必须给 fontSize/宽高；PowerPoint 的 autofit 需要打开时重算 | 由 Anthropic html2pptx 的实现反证：它自己实测 fontSize 并放大 2% 宽度、留 0.5" 底边规避 |
| 其他脚枪 | 会**原地修改 options 对象**（首次使用转 EMU）；图表 axis id 不声明会让 PowerPoint 丢弃该图表并判损坏；`<p:presentation>` 子元素顺序不能动 | [Anthropic 当前 SKILL.md「Creating with pptxgenjs — gotchas」](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md)（**单一来源**，但来自生产使用者） |

**替代写入层**（如果不想被 pptxgenjs 绑死）：
- [html-native-pptx](https://github.com/Davinsry/html-native-pptx)：纯 Node + JSZip 直写 DrawingML，无 pptxgenjs，MIT，但 v0.2 实验品
- [@office-open/pptx](https://www.npmjs.com/package/@office-open/pptx)（MIT，v0.14.6，73 个版本）：typed JSON→OOXML，带 shape/text/table/chart/SmartArt/transitions/animations，**presenton 闭源导出核心就依赖它**（从其 package.json 可读）；可作为「自研写入层」的参考/依赖
- python-pptx（MIT）+ 自己补 alpha/gradient/custGeom 的 XML hack：Design-Arena 就是这条路，2380 行里大量是 XML 细节修补

---

## 四、商业产品导出保真度

| 产品 | 官方口径 | 真实限制（官方文档自己承认的） | 可编辑度 | 来源强度 |
|---|---|---|---|---|
| **Gamma** | PPTX / PDF / PNG / Google Slides 导出；表格导出为**真可编辑表格**（"Editable tables" 开关，默认开，所有套餐） | ① 导出**不含幻灯片母版**，PowerPoint 的母版视图是空白 ② 渐变标题可能变色/退单色 ③ 磨砂背景/高级强调图效果走备用样式 ④ AI 生成图一律导出 PNG（文件变大）⑤ 免费版 PPTX 带 "Made by Gamma" 徽章 ⑥ 导出效果对齐 **Present Mode** 而非 Edit Mode | **较高**（文本/表格原生、字体嵌入） | 官方帮助中心（中英双版一致）[EN](https://help.gamma.app/en/articles/8022861-what-s-the-easiest-way-to-export-my-gamma) / [ZH](https://help.gamma.app/zh-CN/articles/8022861) |
| **Manus Slides** | 2026-07 起新增 **PowerPoint 模式**：原生 `.pptx` 生成，「不是从其他格式转换，不是从网页预览导出」；图表背后有可编辑数据表、表格是真单元格、遵循母版 | 官方 FAQ 直接承认旧做法：**「以前以网页格式生成幻灯片，并在导出时转换为 .pptx，这可能会导致格式问题」**；新模式 Beta，限 1.6/Max 模型 | **高**（原生生成） | 官方博客 [manus.im/blog/manus-ppt-slides](https://manus.im/blog/manus-ppt-slides) |
| **Tome** | — | **已关停幻灯片产品**：2025-04 宣布关闭 Tome Slides，转向销售场景（[百度百科条目](https://baike.baidu.com/item/Tome/62895012)，**单一来源**）；`tome.app` 现已 404（我实测 2026-10-19） | n/a | 弱（单一来源 + 我实测站点 404） |
| **Pitch** | PPTX 导出是**付费功能**；免费版导出带 Pitch 水印（左下角） | 官方列了「支持/不支持」清单：**字体「不能总是嵌入」，可能回退 Calibri**；上传视频/录制/动画**不支持**，导出时只是缩略图；图表「可能看起来不一样」 | **中**（形状/表格/备注保住，字体/动画保不住） | 官方帮助中心 [导出](https://help.pitch.com/en/articles/6713988-export-a-presentation-to-power-point)、[水印](https://help.pitch.com/en/articles/4508816-pitch-branding-for-exported-presentations-and-links) |
| **Beautiful.ai** | 导出「Editable PowerPoint」（.pptx）；**动画与音频不随导出迁移** | 具体版式保真度官方无细节；第三方评测建议「用你自己的模板实测导出再做修订任务」，并指出导出 ≠ 原生创作的编辑体验（[第三方导出说明](https://designerbot.com/blog/how-to-export-to-ppt-and-why-you-shouldnt)、[deckary 评测](https://deckary.com/blog/beautiful-ai-vs-powerpoint)，**均为单一来源/第三方**） | **中—高（未验证）** | 弱 |
| **Canva** | 支持 Share → Download → PowerPoint (.pptx)；第三方教程称「保留文本框和大部分形状可编辑」 | 官方帮助页被 Cloudflare 拦截（`canva.com/help/download-designs/` 返回 JS 挑战页，我实测抓不到正文）→ **未验证官方原文**；第三方提到「文本框会偏移几像素」，建议用系统字体、留 8–12px 内边距 | **中（未验证）** | 弱（第三方 [skywork 教程](https://skywork.ai/blog/export-canva-to-powerpoint?lang=ja)、[mobisystems](https://mobisystems.com/en-au/blog/tutorials/can-a-canva-presentation-be-downloaded-as-pptx)） |
| **AiPPT** | 明确提供两种 PPT 导出：**「导出为PPT（可编辑文件）」** 与 **「图片集PPT（防修改PPT）」**（每页转图、不可选中/编辑、保留翻页动画） | 官方 FAQ：图片集「不能编辑内容，兼具展示效果和安全性」——即官方把「不可编辑」当成卖点 | 可选（用户自选可编辑 or 锁图） | 官方帮助中心 [aippt.cn/plugin/help/article/6](https://www.aippt.cn/plugin/help/article/6) |
| **讯飞智文** | 官网 `zhiwen.xfyun.cn` 可导出 PPT（JS 渲染，抓不到正文）；一份公开教学 PDF 称「导出后可在本地修改」 | **未验证**导出是原生对象还是图片 | **未验证** | 弱 |
| **Kimi PPT / Kimi Slides** | ① C 端 Slides 帮助称「可下载为可编辑的 PPTX」 ② API 侧官方 PPT 智能体的设计原则写死：**默认生成原生可编辑 PPTX（文本框、表格、原生图表），而不是图片贴片或网页截图**，并要求在 prompt 里加「不要图片贴片」降低退化为整页图的风险 | 官方把「退化成整页图片」列为需要 prompt 约束的已知风险（说明模型偶尔会这么干） | **高（官方承诺）/ 实际未验证** | 官方 [Kimi API 文档](https://platform.kimi.com/docs/hosted-agents/official-ppt-agent)、[Kimi Slides 帮助](https://www.kimi.ai/zh/help/slides/ppt-overview) |
| **WPS AI** | WPS 365 SEO 文章称：生成时用标准 PPTX，文本框/图表/图形保持独立可编辑层级，并有「智能解组」打破图层 | 属于厂商营销内容（365.wps.cn SEO 落地页），无独立验证；**「AI 生成 PPT 无法编辑」本身就是一个被 WPS 用来做 SEO 的痛点关键词** | **未验证** | 很弱（[WPS365 页面](http://365.wps.cn/content/067ef5b5a6744bba9381188c9bc5bb64.html)） |
| **Genspark** | 官网称导出的 .pptx「Everything on the slide stays editable」 | 官网被 Cloudflare 拦截，抓不到原文 → **未验证**；日文博客称支持 PDF/PPTX/Google Slides 三种导出 | **未验证** | 弱 |

**跨产品结论（3 条）**

1. **头部产品都已收敛到「原生对象导出」**：Gamma 专门做了「可编辑表格」开关（说明此前表格是非可编辑视觉元素）；Manus 干脆推翻「网页生成 + 导出转换」改成原生生成。→ **「能不能改」已经是这个品类的核心竞争维度，而不是加分项。**
2. **共同的诚实边界是「母版 / 动画 / 字体 / 特效」四件套**：Gamma 承认丢幻灯片母版；Pitch 承认字体可能回退 Calibri、动画变缩略图；Gamma 承认渐变/磨砂效果降级。→ 这不是实现水平问题，是 **OOXML 表达能力 + 字体环境**的硬边界，我们的产品也必须显式声明。
3. **「不可编辑」被产品化成了安全需求**：AiPPT 的「图片集 PPT」、Canva/Pitch 的导出水印，说明「可编辑」和「防篡改」是两个市场；建议把导出策略做成参数（native / hybrid / locked-image）而不是单一模式。

> 行业侧解释（低权威，仅供参考）：[2slides 分析文](https://2slides.com/blog/why-ai-slide-tools-break-powerpoint-export) 把问题归因为「HTML 布局与 OOXML 非 1:1：字体替换、动画丢失、文本框重叠/裁切」，与我们从源码看到的机理一致（**单一来源**，内容站）。

---

## 五、四维评分表

评分口径（1–5，5 最好）：
- **可编辑性**：导出的文字是否原生文本框、形状是否原生形状、图表是否带数据
- **保真度**：视觉还原度（含字体、渐变、阴影、圆角）
- **工程稳定性**：成熟度、失败模式是否可控、是否产出 Office 能直接打开的文件
- **许可风险（5 = 风险最低）**：能否商用、能否改、能否再分发、许可链是否干净

| # | 方案 / 路线 | 可编辑性 | 保真度 | 稳定性 | 许可风险 | 一句话判读 |
|---|---|---|---|---|---|---|
| 1 | Anthropic html2pptx（官方） | 5 | 4 | 3 | **1** | 架构与校验的最佳教材；**代码不可用**（source-available，禁衍生），且已 deprecated |
| 2 | PPTAgent `html2pptx.js`（MIT 再许可） | 4.5 | 4 | 3 | **2.5** | 唯一「完整且能读」的 Anthropic 系实现 + 表格增强；但**许可链有瑕疵**，商用需法务确认 |
| 3 | Hasasasa/html-to-editable-pptx | 4 | 4.5 | 3.5 | 5 | **工程方法论最强**（反假设流水线 + 局部快照 + VLM 审计），适合当自研蓝本 |
| 4 | dom-to-pptx | 4.5 | 4.5 | 3.5 | 5 | **事实标准**（22 万下载/月）；务必设 `compression:true` 并做 Office 打开回归 |
| 5 | Design-Arena/html-to-pptx (PyPI) | 4 | 3.5 | 3 | 5 | Python 侧最规范；外部图片不抓是硬伤，需自己补 |
| 6 | html-native-pptx | 4.5 | 4 | 1.5 | 5 | **架构最接近目标**（IR + 直写 DrawingML + 字体嵌入），但实验品，别直接上生产 |
| 7 | slidesmith | 3.5 | 3 | 2 | 5 | 薄 wrapper，参考价值 > 使用价值 |
| 8 | presenton（主仓 + 闭源 export-core） | 4 | 4 | 4 | **2.5** | 产品化最强，但**导出内核不可审计/不可改**；「Fully open-source」名不副实 |
| 9 | html2pptx-cli（html2pptx.app） | 未验证 | 未验证 | 2 | 3.5 | SaaS 客户端，引擎闭源，需 API key |
| 10 | zconvert | 未验证 | 未验证 | 3 | 3 | 客户端 MIT + 引擎镜像闭源（2.7GB Docker），商业意图明显 |
| 11 | PPTAgent 研究框架（模板编辑） | 5 | 4 | 3 | 4.5 | 可编辑性天花板，但版式自由度=模板库大小 |
| 12 | PptxGenJS（作为底座） | 5 | n/a | 3.5 | 5 | 写入层事实标准；**缺字体嵌入/文本量测，默认压缩有 Office 兼容坑，维护停滞** |
| 13 | AiPPT「图片集 PPT」路线 C | 1 | 4.5 | 4 | 5 | 只保真不保改；作为「锁定版导出」选项可保留 |

---

## 六、矛盾与不确定性

1. **「PptxGenJS 的 STORED 压缩会让 PowerPoint 报损坏」只找到单一来源**（dom-to-pptx PR #40 作者诊断）。我在源码侧确认了默认 `compression: false` → STORE 属实（[L554](https://github.com/gitbrent/PptxGenJS/blob/master/src/pptxgen.ts#L554)），但没有标准原文或 Microsoft 官方声明支持「Office 强制要求 DEFLATE」。**建议实测**：同一 deck 分别用 `compression:true/false` 导出，在 PowerPoint for Mac/Windows 各开一次。
2. **presenton 的「Fully open-source」与「导出核心闭源」冲突**：我以「预编译 tarball + 混淆 + 无 license」为事实基础判断为闭源；官方口径可能主张「opensource edition 也是开源发布」。此处采用事实口径（不可读源码 = 不可审计），但不应表述为「欺骗」。
3. **Kimi / Canva / Genspark / 讯飞智文 的导出可编辑度未获一手验证**：官方承诺 ≠ 实测。前两者官方文档可信度较高，后两者只有 SEO/教学材料。
4. **PPTAgent 的 html2pptx.js 是「基于 Anthropic Skills」的再许可件**——这一点来自其文件头注释（作者自述），我没有做逐行比对。若要判断「是否构成衍生作品」，需要法务比对 2987 行 vs Anthropic 原实现。
5. **star 数与成熟度不总一致**：Design-Arena 24★ 但有 CI/PyPI/对比工具；html-native-pptx 0★ 但架构最先进。本报告评分已尽量以「代码与文档证据」而非 star 为主，但样本有限。

---

## 七、对「自研 HTMLPPT」的 6 条工程判断

1. **别做通用 HTML 渲染器，做「HTML 方言 + 编译器」**。Anthropic、PPTAgent、Hasasasa 三家不约而同地把「哪些 HTML/CSS 允许」写成硬约束（文字必须在 `<p>/<h1-6>/<ul>`、背景边框只能在 `<div>`、禁用渐变/滤镜/复杂 transform、body 尺寸必须等于版面）。**约束越早前移，导出越可预测**——甚至应该在编辑器里对违规写法实时标红。
2. **三层架构：量测层 / 映射层 / 写入层，必须解耦**。量测输出可序列化的中间记录（JSON），才能做单页重算、回归测试和人工修正。Design-Arena 的 `extract_measurements → render_pptx` 两段式 API 和 html-native-pptx 的 IR 都是这个思路。
3. **兜底只做「局部装饰栅格」，永不做整页截图**；栅格前必须隐藏将被矢量层重画的元素，否则会出现「图上有字、上面又叠一层字」的双层 bug（Hasasasa methodology 已把这条写成硬规则）。
4. **Office 兼容性是一等公民**：`compression: true`（DEFLATE）、`[Content_Types].xml` 不留悬空 Override、图表轴的 `valAxes`/`catAxes` 成对声明、`<p:presentation>` 子元素顺序不动。发布前必须在 **Microsoft PowerPoint（不是 WPS、不是 LibreOffice）** 上跑「打开不报修复」的回归——这是 dom-to-pptx 用真实事故换来的教训。
5. **字体必须自己解决**：pptxgenjs 不支持嵌入，PPT 表达不了 web 字体。路线有三条——按实际用字 subset + EOT/fntdata 嵌入（html-native-pptx、Hasasasa）、opentype.js 客户端嵌入（dom-to-pptx）、或直接限制到 web-safe 字体 + 度量兼容映射（Anthropic / Design-Arena）。**CJK 场景建议 subset + Noto 兜底**。
6. **文本是最难的部分，因为它不是「画出来」的**：量测得到的是 fontSize/行高/宽度，但 PowerPoint 的换行算法、字体度量、autofit 行为都不同。Anthropic 的做法是「实测 fontSize + 宽度放宽 2% + 强制留 0.5 英寸底边」，这是**用布局约束换渲染确定性**。我们更该做的是：文本块显式给宽 + 允许自动缩字号（`fit: shrink` 或自算）+ 导出后用 LibreOffice/Office 渲染回来做 diff 回归。

**一句话判断**：这个赛道的护城河不在「HTML 转 PPTX」这个转换动作，而在**「约束契约 + 兜底策略 + Office 打开回归」这套工程流水线**；繁重但确定，谁把回归测试做扎实谁赢。

---

## 八、来源清单

### 一手：源码 / 仓库 / 包注册表（均为 2026-10-19 抓取）

| 来源 | 支撑了什么 |
|---|---|
| [anthropics/skills](https://github.com/anthropics/skills)（182,112★，无根 license） | 仓库元数据；README 的 "source-available, not open source" 自述 |
| [skills/pptx/LICENSE.txt](https://github.com/anthropics/skills/blob/main/skills/pptx/LICENSE.txt) | 禁止提取/复制/衍生/分发/商用 → 许可风险评分 1 |
| [skills/pptx/SKILL.md（当前）](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md) | 当前官方创建路径 = 直接写 pptxgenjs；20+ 条 pptxgenjs 脚枪 |
| [html2pptx.md（ef740771）](https://github.com/anthropics/skills/blob/ef740771/skills/pptx/html2pptx.md) | HTML 子集契约全文（尺寸、标签、禁止项、验证规则） |
| [html2pptx.tgz（4e6907a3）](https://github.com/anthropics/skills/commit/4e6907a3) / [删除 commit a5bcdd7e](https://github.com/anthropics/skills/commit/a5bcdd7e) | 打包当天即 deprecated+删除；证明官方已放弃该路线 |
| 解包的 `html2pptx` npm 包（index.mjs / index.iife.js / index.d.mts） | 架构细节：`PT_PER_PX=0.75`、元素分派规则、`inset:0`、单行扩宽 2%、无 autofit、placeholder 机制 |
| [Hasasasa/html-to-editable-pptx](https://github.com/Hasasasa/html-to-editable-pptx) + [methodology.md](https://github.com/Hasasasa/html-to-editable-pptx/blob/main/references/methodology.md) | 五段流水线；反假设规则；局部快照双层 bug；5a/5b 验证；「不做像素 diff」的判断 |
| [atharva9167j/dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx) + [PR #40](https://github.com/atharva9167j/dom-to-pptx/pull/40) | 架构定位；Office 打开失败的根因；WPS 容忍 vs PowerPoint 拒绝 |
| [@cwjcharles/dom-to-pptx（npm）](https://www.npmjs.com/package/@cwjcharles/dom-to-pptx) | 临时 fork 的存在理由与生命周期（已过时） |
| [Design-Arena/html-to-pptx](https://github.com/Design-Arena/html-to-pptx) + [PyPI](https://pypi.org/project/html-to-pptx/) + [converter.py](https://github.com/Design-Arena/html-to-pptx/blob/main/src/html_to_pptx/converter.py) | 两段式 API；CSS→PPT 映射细节；自列限制；compare 工具 |
| [AliceLJY/slidesmith](https://github.com/AliceLJY/slidesmith) | 薄 wrapper + 截图兜底；npm 包名冲突提示 |
| [Davinsry/html-native-pptx](https://github.com/Davinsry/html-native-pptx) + [WALKTHROUGH.md](https://github.com/Davinsry/html-native-pptx/blob/main/WALKTHROUGH.md) | IR→DrawingML 架构；custGeom/tbl/gradFill/EOT 字体嵌入；无 pptxgenjs 依赖 |
| [html2pptx-cli（npm）](https://www.npmjs.com/package/html2pptx-cli) | SaaS 客户端性质、API key、本地 visual edit bridge |
| [zconvert（PyPI）](https://pypi.org/project/zconvert/) + wheel 内 `_engine.py`/METADATA | Docker 引擎拉取；mode native/image；架构为闭源 HTTP 服务 |
| [presenton/presenton](https://github.com/presenton/presenton) + [sync-presentation-export.cjs](https://github.com/presenton/presenton/blob/main/scripts/sync-presentation-export.cjs) + [presenton-export releases](https://github.com/presenton/presenton-export/releases) | 「开源外壳 + 闭源导出核心」的一手证据 |
| 下载并解包的 `presenton-export-core-opensource-1.0.51.tgz` | `dist/index.js` 混淆（`_0x...` 变量名）；devDeps 含 javascript-obfuscator；依赖 `@office-open/pptx`、puppeteer |
| [icip-cas/PPTAgent](https://github.com/icip-cas/PPTAgent) + [v1.1.38 tree](https://github.com/icip-cas/PPTAgent/tree/v1.1.38) | 研究框架 vs skill 两种形态；[html2pptx.js](https://github.com/icip-cas/PPTAgent/blob/v1.1.38/deeppresenter/html2pptx/html2pptx.js) 的 "Originally based on Anthropic Skills" 自述 |
| [PPTAgent Skill task-contract.md](https://github.com/icip-cas/PPTAgent/blob/main/skills/pptagent/references/task-contract.md) | 与 Anthropic 同源的 HTML 约束；「文本容器留余量」的实战经验 |
| [gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS) + [src/pptxgen.ts](https://github.com/gitbrent/PptxGenJS/blob/master/src/pptxgen.ts) + [issue #1302](https://github.com/gitbrent/PptxGenJS/issues/1302) | 底座能力边界；`compression:false`→STORE；不支持字体嵌入；维护停滞 |
| [@office-open/pptx（npm）](https://www.npmjs.com/package/@office-open/pptx) | 替代写入层；presenton 引擎的实际依赖 |
| npm registry downloads API / GitHub REST API | 全部 star、fork、下载量、时间戳（2026-10-19） |

### 一手：官方帮助文档（商业产品）

| 来源 | 支撑了什么 |
|---|---|
| [Gamma 导出帮助（EN）](https://help.gamma.app/en/articles/8022861-what-s-the-easiest-way-to-export-my-gamma) / [ZH](https://help.gamma.app/zh-CN/articles/8022861) | 母版丢失、渐变/磨砂降级、可编辑表格开关、字体嵌入、免费版水印 |
| [Manus 官方博客：PowerPoint Slides](https://manus.im/blog/manus-ppt-slides) | 从「网页生成+导出转换」转向「原生 .pptx 生成」的官方决策与理由 |
| [Pitch 导出帮助](https://help.pitch.com/en/articles/6713988-export-a-presentation-to-power-point) + [导出水印](https://help.pitch.com/en/articles/4508816-pitch-branding-for-exported-presentations-and-links) | 支持/不支持元素清单；字体回退 Calibri；动画不导出；付费墙 |
| [Kimi API：PPT 生成智能体设计](https://platform.kimi.com/docs/hosted-agents/official-ppt-agent) | 「默认生成原生可编辑 PPTX，不要图片贴片」；退化为整页图是已知风险 |
| [Kimi Slides 帮助](https://www.kimi.ai/zh/help/slides/ppt-overview) | C 端「可下载为可编辑 PPTX」 |
| [AiPPT 导出帮助](https://www.aippt.cn/plugin/help/article/6) | 「可编辑 PPT」与「图片集 PPT（防修改）」双模式 |
| [arXiv:2501.03936 PPTAgent](https://arxiv.org/abs/2501.03936) | 两阶段 edit-based 方法（路线 B 的原理） |

### 二手（已标注可信度）

| 来源 | 支撑了什么 | 可信度 |
|---|---|---|
| [独立拆解：Presenton 把 PPTX 导出核心藏进下载包](https://wangruofeng007.com/blog/2026-09/presenton-ai-presentation-pipeline/) | Standard/Smart 双流水线细节、Smart 的三层防线、issue #881/#781/#860 | 中高（与仓库代码互证） |
| [2slides：Why AI Slide Tools Break on PowerPoint Export](https://2slides.com/blog/why-ai-slide-tools-break-powerpoint-export) | 行业性归因（HTML↔OOXML 非 1:1） | 低（内容站，单一来源） |
| [百度百科 Tome](https://baike.baidu.com/item/Tome/62895012) | 2025-04 关闭 Tome Slides | 中（单一来源，但与我实测 tome.app=404 一致） |
| [deckary：Beautiful.ai vs PowerPoint](https://deckary.com/blog/beautiful-ai-vs-powerpoint) | Beautiful.ai 支持可编辑导出，但需自测 | 低（单一来源） |
| [skywork Canva→PowerPoint](https://skywork.ai/blog/export-canva-to-powerpoint?lang=ja)、[mobisystems](https://mobisystems.com/en-au/blog/tutorials/can-a-canva-presentation-be-downloaded-as-pptx) | Canva 导出 PPTX 的实操与「文本框会偏移几像素」 | 低（第三方教程） |
| [WPS365：AI 生成 PPT 无法编辑的解决方案](http://365.wps.cn/content/067ef5b5a6744bba9381188c9bc5bb64.html) | WPS 声称标准 PPTX + 智能解组 | 很低（厂商 SEO 内容） |
| [Genspark AI PowerPoint](https://www.genspark.ai/tools/ai-powerpoint-generator)（被 Cloudflare 拦截，仅搜索摘要） | 声称导出可编辑 .pptx | 很低（未验证原文） |
| [Canva PPT 转换功能页](https://www.canva.com/features/ppt-to-pptx-converter/)（被 Cloudflare 拦截） | 支持 PPTX 导出 | 很低（未验证原文） |

### 抓取失败 / 未验证清单（诚实披露）
- `canva.com/help/download-designs/`、`canva.com/features/*`：Cloudflare JS 挑战，正文抓不到
- `genspark.ai/tools/ai-powerpoint-generator`：Cloudflare "Just a moment..."
- `zhiwen.xfyun.cn`（讯飞智文）：纯 JS 渲染，只返回标题
- `beautiful.ai/help`：404，未找到官方导出说明页
- `tome.app`：404（与「产品关停」一致）
- `reddit.com`、`old.reddit.com`：搜索 API 返回 HTML 挑战页 / 403，未能取得真实用户吐槽原文
- `r.jina.ai`：本次未使用（任务提示可能被限流），改用 raw.githubusercontent + registry API + 直接 curl 官网
