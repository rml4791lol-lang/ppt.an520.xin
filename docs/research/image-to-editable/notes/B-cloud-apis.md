# B · 国内云厂商 / 开放平台「图片·PDF → 可编辑 PPTX」API 能力调研

- 抓取日期：**2026-10-20**（所有价格均来自当日官方页面原文；标注「未核实」的条目为本次未读到官方原文）
- 调研目的：判断能否把「上传图片/截图/扫描版 PPT → 下载可编辑 PPTX」做成自有网站 SaaS
- 结论先行：**国内主流云厂商（阿里/腾讯/百度/火山/讯飞）没有一家提供「图片 → 可编辑 PPTX」的正式商用 API**。能直接产出 PPTX 的只有 3 条路：① TextIn 的 PDF→PPT（需先图片转 PDF）；② 讯飞「图片文档还原」（能出 pptx，但官方明示体验版、**暂不商用**）；③ 云市场/聚合平台的第三方商品（度慧等，便宜但效果与合规需自测）。其余全部只能出 Word / Excel / Markdown / JSON（含坐标），PPTX 要自己组装。

---

## 0. 一页结论表

| 能力 | 谁能做 | 产物 | 备注 |
|---|---|---|---|
| **图片 → 可编辑 PPTX（正式商用）** | 未发现国内一线云厂商提供 | — | 讯飞有但「暂不商用」；度慧等云市场商品可商用但效果需自测 |
| **PDF → 可编辑 PPTX** | TextIn（PDF转PPT）、Adobe PDF Services（exportpdf） | .pptx | TextIn 为「版式保真」型转换，非重建 |
| **图片 → PPTX（画出每页图片的版式）** | 讯飞 图片文档还原（体验版）、度慧（云市场）、Nutrient DWS Image-to-Office | .pptx | 讯飞明确「暂不商用」 |
| **图片/PDF → Word / Excel（保留版式）** | 阿里 DocMind、百度文档格式转换、TextIn、WPS | .docx/.xlsx | 最成熟的「版式还原」链路，但仍不是 PPT |
| **图片/PDF → Markdown / JSON + 坐标** | 阿里文档解析（大模型版）、腾讯 MultimodalDocParse、百度文档解析、火山 LAS、TextIn xParse | .md/.json/bbox | 做自研 PPTX 组装的**原料层** |

---

## 1. 阿里云

### 1.1 文档智能 DocMind · 文档格式转换
- 官方文档（计费）：https://help.aliyun.com/zh/document-mind/product-overview/pay-as-you-go
- 官方文档（资源包）：https://help.aliyun.com/zh/document-mind/product-overview/resource-plans
- 产品能力：**PDF转Word / 图片转Word / PDF转Excel / 图片转Excel / PDF转图片 / 图片转PDF**。商品列表里**没有 PPT/PPTX 任何一项** —— 阿里云全系（DocMind/OCR/OSS-IMM）都不产出 pptx。
- 输入 → 输出：图片/PDF → **docx / xlsx / png / pdf**（保留版式）
- 计费（按量后付费，元/页，月阶梯）：

| 商品 | ≤1万页 | 1–10万 | 10–50万 | 50–100万 | >100万 |
|---|---|---|---|---|---|
| PDF转Word | 0.10 | 0.08 | 0.06 | 0.05 | 0.04 |
| **图片转Word** | **0.20** | 0.16 | 0.12 | 0.10 | 0.08 |
| 图片转Excel | 0.20 | 0.16 | 0.12 | 0.10 | 0.08 |
| 图片转PDF | 0.10 | 0.08 | 0.06 | 0.05 | 0.04 |

- 资源包（1年有效）：图片转Word 500页 90元（0.18/页）、1000页 150元、1万页 1300元（0.13/页）、10万页 10000元；PDF转Word 1万页 750元（0.075/页）。
- 免费额度：开通「文档格式转换」送**一次性 1000 页**；「文档理解-文档解析（大模型版）」「电子文档解析」**每月 3000 页**。
- 接入：REST + 多语言 SDK（Java/Python/PHP/Go/Node/.NET）；同步接口为主；控制台可视化「轻应用」同价。
- 官方计费页：https://help.aliyun.com/zh/document-mind/product-overview/billing-overview

### 1.2 文档智能 · 文档解析（大模型版）/ 文档智能解析
- 计费：文档解析（大模型版）**0.02 元/页（基础链路）/ 0.04 元/页（增强链路）**；电子文档解析 0.005 元/页；文档智能解析 0.25→0.10 元/页（阶梯）；表格智能解析同价。
- 输出：Markdown / JSON（含版面、表格、阅读顺序、坐标），**不产出任何 Office 文件**。
- 说明：这是「原料层」，要 pptx 必须自研组装。

### 1.3 OCR / OSS 文档处理
- OSS-IMM 文档转换：只能 Office→PDF/图片（https://help.aliyun.com/zh/imm/support/faq-about-document-conversion-and-preview），方向相反，无法出 pptx。
- OCR（通用/表格）：按次计费，仅返回 JSON 文本与坐标，需自建版面+组装。

### 1.4 百炼 Model Studio · Qwen-VL / Qwen-VL-OCR
- 定价页：https://help.aliyun.com/zh/model-studio/model-pricing（更新 2026-10-19）
- 计费：按 token，**元/百万 token**（如 qwen-vl-ocr 约 0.3 元/百万 input 量级，qwen3.x-vl 系列按档位 0.2–12 元/百万 input）。免费额度：开通后 90 天内 100 万 token/模型。
- 输出：自然语言 / JSON（可要求模型返回结构化版面），**不产出 pptx**。
- 定位：做「版面理解 → 结构化 JSON」的脑，配合自研 python-pptx 才能落成 PPTX。多模态调用时图片按 token 折算，单页 1080p 截图约 1–2k token，成本可忽略（<0.01 元/页）。

---

## 2. 腾讯云

### 2.1 多模态文档解析 MultimodalDocParse（主力）
- 接口文档：https://cloud.tencent.com/document/product/866/133224
- 计费文档：https://cloud.tencent.com/document/product/1341/49613
- 输入：PDF / Word / **PPT(.ppt/.pptx)** / Excel / Markdown / TXT / **图片(png/jpg/jpeg…)** / WPS
- 输出：**zip 包（result.md + detail.json + images/）**，`ResultUrl` 有效期 30 分钟；`ResultType` 可选 json / markdown / xml / 三合一。**无 pptx**。
- 限制：PDF/Word/PPT ≤150M 且 ≤300 页；Excel/TXT ≤10M；图片 ≤30M；单次 ≤300 页；默认 **5 页并发**（同步/异步共享），可增购；下载链接 3 秒内可拉取。
- 计费：
  - 后付费 **0.08 元/页**
  - 资源包（1年）：1000页 70元（0.07/页）、1万页 600元（0.06）、10万页 5000元（0.05）、100万页 40000元（0.04）
  - 免费：**1000 页/用户，开通一次性发放，1 年有效**
  - 并发买断：**3000 元/并发/月**（≥5 并发起，不消耗调用量）
- 接入：腾讯云 API 3.0（TC3-HMAC-SHA256），8 语言 SDK（Python/Java/PHP/Go/Node/.NET/C++/Ruby）；同步 + 异步（SubmitMultimodalDocParseJob / 查询任务）。
- 评价：**国内性价比与工程完整度最好的「原料层」**，json 带阅读顺序/层级/图片资源，最适合自研 pptx 组装。

### 2.2 文档抽取（基础版/多模态版/Pro/Agent）
- 计费：基础版 0.40 元/次起；多模态版 0.48 元/次（自适应）；Agent 版 0.34–0.68 元/页；免费 1000 次/月（基础版、多模态版）。
- 输出：结构化字段 JSON（按自定义字段抽取），**不产出 Office**。适合「取数」，不适合「还原版式」。

### 2.3 OCR（通用/表格）与混元视觉
- 通用票据/表格 OCR：按次，返回 JSON + 坐标；表格 OCR 可出 Excel（部分接口）。
- 混元视觉（hunyuan-vision）：按 token 计费，输出文本/JSON，无文件产出。

---

## 3. 百度智能云

### 3.1 文档解析
- 价格页：https://cloud.baidu.com/doc/OCR/s/tlrzzplc1
- 计费：**0.05 元/页**（不限量后付费）；资源包 5000页 230元（0.046/页）、1万页 440元、10万页 3800元（0.038/页）、100万页 32000元（0.032/页）；新人活动 9 元/千页。
- 免费：个人认证 200 页、企业认证 200 页（365 天）。
- 能力：支持 16 种格式（pdf/jpg/png/bmp/tif/ofd/ppt/pptx/doc/docx/txt/xls/xlsx/wps…），**单文件 ≤50M、≤1000 页**；输出**版面、表格、阅读顺序、标题层级、旋转角度** JSON。无 pptx。
- 同族另有「文档解析（PaddleOCR-VL）」0.05 元/页。

### 3.2 文档格式转换
- 同页计费：**0.18 元/页**；资源包 100页 18元、1000页 180元、1万页 1600元（0.16/页）、10万页 14000元。
- 输入：整份多页 PDF / **图片** / OFD；输出：**保留原文框版的 Word、Excel**（+ 双层 PDF/OFD）。**无 PPT 输出**（官方原文只列 Word/Excel）。

### 3.3 OCR
- 价格页：https://cloud.baidu.com/doc/OCR/s/9k3h7xuv6
- 通用文字识别（标准版）0.005 元/次起；含位置版 0.01 元/次；高精度版 0.03 元/次；**办公文档识别 0.16 元/次**；表格文字识别 V2 0.12 元/次。免费：个人 1000 次/月、企业 2000 次/月（部分接口 500/1000）。
- 输出 JSON（文本+坐标+表格结构），需自建组装。

### 3.4 文心大模型视觉（ERNIE-VL）
- 按 token 计费，输出文本/JSON；无文件产出。

---

## 4. 合合信息 TextIn（本调研中「最接近可用」的一家）

### 4.1 文档格式转换（含 **PDF转PPT**）
- 产品页：https://www.textin.com/market/detail/pdf-to-ppt
- 覆盖：PDF转Word、**图片转word**、PDF转Excel、**PDF转PPT**、PDF转图片、Word转PDF、Excel转PDF、图片转PDF、Word转图片。
- **注意：没有「图片转PPT」**。图片路线只能是 `图片 →(图片转PDF)→ PDF →(PDF转PPT)→ pptx`，两步计费。
- 计费（次/页，资源包 1 年）：

| 规格 | 价格 | 折合 | QPS |
|---|---|---|---|
| 5次（新客） | 免费 | — | 1 |
| 50次（首购） | 4 元 | 0.08 元/次 | 1 |
| 1千次 | 55 元 | 0.055 元/次 | 2 |
| 5千次 | 250 元 | 0.05 元/次 | 5 |
| 1万次 | 400 元 | 0.04 元/次 | 5 |
| 5万次 | 1750 元 | 0.035 元/次 | 10 |

- 接入（PDF转PPT）：`POST https://api.textin.com/ai/service/v1/file-convert/pdf-to-ppt`
  - Header：`x-ti-app-id` / `x-ti-secret-code`
  - Body：`application/octet-stream`（文件二进制，≤50M）或 `text/plain`（在线 URL）
  - 返回：JSON，`result` 字段为**转换后文件的 base64**
  - 同步接口，无 task_id；错误码 40306 = QPS 超限（**不要重试**，会触发 IP 流控）
  - 文档：https://www.textin.com/document/pdf-to-ppt
- 限制：文件 ≤50M；图像宽高 20–10000px；QPS 1–10（按套餐）。
- 输出质量：官方描述「尽可能保持 PDF 原有格式」，属于**版式保真型**（文本框/图片分层重建），不是「每页贴一张图」。

### 4.2 文档解析 / 版面分析（xParse）
- 支持 PDF/PNG/JPG/BMP/TIFF/WEBP、XLS/XLSX/CSV、DOC/DOCX/PPT/PPTX/TXT/HTML/MHT/RTF/OFD；输出 Markdown / JSON（含表格、公式、坐标）。按页计费（credits），具体单价见 https://www.textin.com/pricing（本次未逐档核实）。
- 私有化/混合云：官网提供商务入口，**价格需商务报价**（未公开刊例价）。

---

## 5. 金山办公 WPS 开放平台 / WPS 365

### 5.1 在线格式转换 API（转 pptx）
- 文档：https://open.wps.cn/documents/app-integration-dev/docs-center/convert/api-docs/online-convert/to-pptx
- 接口：`POST https://openapi.wps.cn/v7/developer/weboffice/office/save/as/pptx`，Header `Authorization: Bearer {access_token}`，Body `{url, filename, password?}`，返回 `task_id`，异步查询结果（下载 URL 半小时有效）。
- **输入仅限「演示」类格式**：.pptm .ppsx .ppsm .pps .potx .potm .dpt .dps .ppt .pptx .pot .dpss .dpso .tpppt。
- **不能吃图片、不能吃 PDF** → 对「截图/扫描件 → pptx」这个场景**完全无用**，只能做「老 PPT 转新版 pptx」。
- 权限点：`kso.format_conversion.readwrite`。

### 5.2 WebOffice 预览/编辑
- 提供 iframe/SDK 嵌入的在线预览与协同编辑（按并发/账号计费），是「打开 pptx 编辑」的壳，不是「生成 pptx」的能力。

### 5.3 价格
- 官方**未公开刊例价**，格式转换按页/次 + 套餐包，需商务报价（本次未在 open.wps.cn 找到公开价格页）。
- 第三方渠道参考（非官方）：万维易源 docsdk「WPS转PPT」标价 **0.30 元/页（散买）/ 0.20（500页包）/ 0.12（2500页）/ 0.10（5000页）**，https://www.docsdk.cn/execute/web/product/code/W92-wps_to_ppt —— 该价格**不能代表 WPS 官方**。

---

## 6. 讯飞开放平台（唯一能「图片直出 pptx」的国内大厂，但不可商用）

### 6.1 图片文档还原（Picture Document Reconstruction）
- 文档：https://www.xfyun.cn/doc/words/picture-document-reconstruction/API.html
- **能力：识别文档/合同类图片，生成保留内容格式的 docx、pptx 或 xlsx**（`result_type`：0=excel，1=doc，2=ppt）。
- **官方原文：「该产品目前为体验版……仅供免费试用，暂不商用。」** → 直接否掉 SaaS 商用。
- 输入：jpg/jpeg/png/bmp，base64 后 ≤10MB；中英文。
- 接入：**WebSocket**（`wss://ws-api.xf-yun.com/v1/private/ma008db16`），HMAC-SHA256 鉴权，请求体 JSON，返回 base64 文件流。同步交互式，工程复杂度高于 REST。
- 价格：体验版免费；无商用报价。
- 意义：证明「端到端图片→pptx」技术路线可行，但这条产品线不能作为商用依赖。

### 6.2 智能 PPT 生成
- 文本/大纲 → PPT（生成式，不是「还原」）；价格「商务咨询」，无公开刊例价。

### 6.3 OCR
- 通用/表格 OCR 按次计费（官方价格页未在本次核实），输出 JSON。

---

## 7. 火山引擎（ByteDance）

### 7.1 LAS · PDF 文档解析（豆包）
- 文档：https://docs.volcengine.com/docs/LakeAIService/PDFDocumentParsingDoubao?lang=zh
- 输入：PDF（≤400 页 / ≤1GB）、Word（DOC/DOCX，≤100MB，先转 PDF）、**图片（PNG/JPEG/BMP/WebP）**
- 输出：`result.md` + `result_preview.md` + `images/` + `detail.json`（逐页 text_blocks，`box` 为 0–1000 归一化坐标）。**无 pptx**。
- 计费：**normal 0.02 元/页；detail（深度思考）0.04 元/页**；按智能分段后的 `billable_pages` 计费；在线体验免费 50 页。
- 限制：最大 RPM 600、最大并发 10；异步 submit/poll，task_id 3 天有效；结果可落 TOS。

### 7.2 OCR / 视觉智能
- 通用 OCR、文档矫正、表格识别；按次计费（本次未逐项核实单价），输出 JSON。

### 7.3 豆包视觉理解 Doubao-vision
- 方舟按 token 计费（输入/输出分开，视觉 token 按图片分辨率折算）；输出文本/JSON。无文件产出。
- 参考：豆包视觉理解曾以「3 厘/千 tokens」定价宣传（2024-12），当前以方舟定价页为准（本次未核实最新单价）。

---

## 8. 有道智云

- 平台：https://ai.youdao.com/ ；价格中心：http://aitest.youdao.com/price-center.s（测试域，正式以 ai.youdao.com 为准）
- 能力：通用文字识别（0.007 元/次，阶梯降至 0.0045）、表格识别、文档翻译（PDF/Word → 译文文档）、OCR 结构化。
- **无「文档转 PPT/Office」产品线**：文档相关只有「翻译」与「OCR」，输出为译文文档或 JSON。
- 免费：注册赠 10 元体验金，实名后再 40 元。
- 结论：不适合本场景，仅可作 OCR 备选。

---

## 9. 国外对照（能力 + 价格）

| 产品 | 输入 → 输出 | 是否能出可编辑 PPTX | 价格（官方，2026-10-20） |
|---|---|---|---|
| **Adobe PDF Services（exportpdf）** | PDF → DOCX/XLSX/**PPTX**/图片 | ✅ 能（PDF→PPTX，版式级） | 免费 **500 Document Transactions/月**；付费需销售/按量，官网未列单价 https://developer.adobe.com/document-services/pricing/ |
| **TextIn（国内，见 §4）** | PDF → PPTX | ✅ | 0.035–0.08 元/次 |
| **Nutrient DWS（原 PSPDFKit）Image-to-Office** | 图片 → DOCX/XLSX/**PPTX** | ✅ 能（图片逐页生成 Office） | credit 制，**50 credits/月免费**（带水印），https://www.nutrient.io/api/image-to-office-api/ |
| **Mathpix** | 图片/PDF/DOCX/PPTX → Markdown/LaTeX/DOCX/HTML/JSON | ❌ 无 pptx | **$0.005/页**（0–1M 页）；Files API $1.50/1000 页 https://mathpix.com/pricing/api |
| **Azure AI Document Intelligence** | 图片/PDF → JSON（Read/Layout/Prebuilt） | ❌ 只有 JSON | Read **$1.50/1000 页**；Layout/Prebuilt **$10/1000 页**；免费 500 页/月 https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/ |
| **Google Document AI** | 图片/PDF → JSON | ❌ 只有 JSON | Enterprise OCR **$1.50/1000 页**（前 1000 页免费）；Layout Parser **$10/1000 页** https://cloud.google.com/products/document-ai/pricing |
| **ConvertAPI** | 200+ 格式互转（含 Office/图片） | ⚠️ 格式级，图片→pptx 未核实具体 converter | 约 **¥0.116–0.205/次**（年付/月付档），免费 250 次 https://www.convertapi.com/prices |
| **CloudConvert** | 200+ 格式互转（含 PPTX） | ⚠️ 格式级，非版面重建；扫描件效果需自测 | 按分钟/额度订阅（本次未核实单价）https://cloudconvert.com/document-converter |
| **Aspose.Slides** | 编程库：可把图片逐页 add_picture 生成 pptx；也可 pptx→pdf/图片 | ⚠️ 能「生成」pptx，但不是「版式重建」 | 商业 License（开发者/站点/计量），本次未核实 |
| **Microsoft Graph / PDF Reflow** | PDF → DOCX（Word 的 PDF 重排） | ❌ 无公开 PPTX API | 随 M365/Graph 计费 |

> 结论：国外也只有 **Adobe / Nutrient** 提供 PDF→PPTX 或 图片→PPTX 的正式 API，且都不是「扫描版 PPT 高保真还原」的强能力；Azure/Google/Mathpix 全是 JSON/Markdown 原料层。

---

## 10. 一站式「图片转 PPT」API（聚合平台 / 云市场）

| 服务 | 接口 | 价格 | 说明 |
|---|---|---|---|
| **【度慧】图片转Word/PPT/Excel/TXT/OFD/MD**（百度 API 商城 / 云市场） | `POST/GET https://img2doc.api.bdymkt.com/v1/convert`，参数 `url[]`、`type`（docx/ppt/…）、`clean`、`language`、`a4`、`callbackurl` | **6000次 100元 ≈ 0.0167元/次**；30万次1000元、100万次3000元（**0.003元/次**）；50次 0 元试用 | 上海度慧科技；「自动矫正倾斜文字、复原图片原有样式」；10页1080p 平均15秒；REST + 回调；**无 SLA 承诺，效果必须自测** |
| **image2ppt**（Python client，商业 API） | `Image2PPTClient(api_key=...)`，≤35MB/文件、单请求 ≤90MB、≤50 页/job | 未公开（需注册看价） | 专做 image→pptx，接口设计最贴合本场景 https://pypi.org/project/image2ppt/0.6.0/ |
| **万维易源 docsdk** WPS转PPT / 图片转文档 | REST，签名 + 回调，返回 ppt URL / base64 | 0.10–0.30 元/页 | 聚合层，底层能力来源不透明 |
| **PPTBot** | — | — | 本次未找到官方开放 API 文档（以产品/客户端为主），**不能作为可集成依赖** |
| 阿里云市场「图片转PPT」类目 | 多家 ISV | 0.005–0.05 元/次居多 | 质量方差极大，务必 POC |

> 商用风险提示：云市场第三方商品的《云市场用户服务协议》通常**明确禁止转售**（如腾讯云云市场协议 5.1/6.6：「不得转售或以其他方式转让本使用服务以牟取商业利益」）。要把这类 API 包进自家 SaaS 收费，必须拿到 ISV 的书面授权（OEM/白标），否则是违约。

---

## 11. 数据合规与「能否转售 / SaaS 二次分发」

| 事项 | 结论 | 依据 |
|---|---|---|
| 数据出境 | 上述国内厂商均提供**中国内地地域**，数据默认境内存储；阿里/腾讯/百度/火山/讯飞均满足「数据不出境」的常规要求（需在控制台选内地 region，勿选国际站） | 各家 region 文档 |
| API 转售 | **不允许转售裸 API**。阿里云 API Term of Use：授予的是「royalty-free, non-transferable, **non-sublicensable**, non-exclusive」许可 | https://www.alibabacloud.com/help/en/legal/latest/api-term-of-use |
| 封装成 SaaS | **允许**（把你的产品作为整体服务卖），但不得把 API 能力单独包装成「API 市场/转售」；不得逆向、不得绕过计量 | 同上 + 各家《服务协议》 |
| 云市场 ISV 商品 | **明确禁止转售**，需单独商务授权 | 腾讯云云市场协议 5.1/6.6 |
| 实名认证 | 阿里/腾讯/百度/火山/讯飞均需**实名**（个人可，但企业认证才给更高免费额度与发票）；云市场商品部分要求企业 | 各家控制台 |
| 生成物版权 | 用户上传的扫描件可能含他人版权内容；SaaS 需在 ToS 中加入「用户保证拥有处理权」+ 删除机制 | 通用合规 |
| 内容安全 | 面向公众的网站需接入内容审核（图片/文本），否则有下架风险 | 通用合规 |

---

## 12. 工程难度与效果预期（关键判断）

| 路线 | 工作量 | 效果上限 | 风险 |
|---|---|---|---|
| **A. 直接用「图片→pptx」第三方 API**（度慧/TextIn 两步/Nutrient） | 2–4 人日接完 | 中：文字可编辑、位置基本对，复杂图表/艺术字会散 | 供应商稳定性、涨价、禁转售条款 |
| **B. 解析 API（md+json/bbox）→ 自研 python-pptx 组装** | 25–45 人日（v1 可上线） | 高：可控（标题/正文/图片/表格/多栏分别建形状） | 版式算法是核心竞争力，也是最大坑 |
| **C. VLM 直接「看懂页面 → 输出 PPTX 结构 JSON」→ 组装** | 15–30 人日 | 中高：对非常规版式更鲁棒，但坐标精度差、易幻觉 | token 成本、幻觉、稳定性 |
| **D. 每页贴图 + 隐藏文本框（伪可编辑）** | 3–5 人日 | 低：用户一眼看穿「不可编辑」，差评 | 不建议做主打 |

**效果预期（真实）**：
- 纯文字页（标题+要点）：A/B/C 都能做到 90%+ 可用；
- 表格页：需要表格结构识别（腾讯 json / 百度表格 OCR / TextIn），否则垮；
- 图表页（柱状/饼图）：**没有一家 API 能还原成可编辑图表**，只能贴图 + 数据表；
- 艺术字/渐变/阴影：基本丢失，只能近似；
- SmartArt/组合图形：100% 退化为图片。

---

## 13. 组合方案（成本 + 工时）

### 方案 1：腾讯 MultimodalDocParse + 自研组装（推荐做主链路）
- 链路：图片/PDF → `MultimodalDocParse`（0.08 元/页，包年 0.04–0.07）→ `detail.json`（阅读顺序/层级/bbox）→ 自研 `layout→pptx` 引擎（python-pptx）→ 可编辑 pptx
- 单页成本：解析 0.04–0.08 + 对象存储/带宽 ~0.01 + 计算 ~0.02 ≈ **0.07–0.12 元/页**
- 工时：解析对接 4 人日 + 组装引擎 25–35 人日 + 前端/计费 8 人日 + 测试 6 人日 ≈ **45–55 人日**（1.5 人 × 6–8 周）
- 优点：json 结构最适合还原；国内合规；免费 1000 页够 POC
- 缺点：要自己养版式算法

### 方案 2：TextIn PDF转PPT 直出 + 兜底（最快上线）
- 链路：图片 →（TextIn 图片转PDF，0.1 元/页）→ PDF →（PDF转PPT，0.035–0.08 元/次）→ pptx
- 单页成本：**0.14–0.18 元/页**；5 万次包 1750 元，量大后 ~0.135 元/页
- 工时：**5–8 人日**（两个同步 REST，base64 返回，无需异步任务）
- 优点：一周可上线，pptx 直接可下载
- 缺点：两步误差叠加；只支持 PDF 版式，扫描件文字识别质量取决于前置；QPS 只有 1–10，需要排队

### 方案 3：度慧（云市场）+ 自研质检（最低成本试水）
- 链路：图片 → `img2doc` → ppt（0.003–0.017 元/次）
- 成本：**1000 页约 3–17 元**，几乎为零
- 工时：2–3 人日
- 缺点：无 SLA、无坐标、不可控；**转售条款风险最高**，只适合内部工具或先验证需求

### 方案 4（进阶）：双引擎路由
- 先用「解析 API」判断页面类型：纯文字页走自研组装（质量高），复杂页走 TextIn 直出或整页贴图（保底不崩）
- 成本：0.1–0.2 元/页；工时 +10 人日
- 这是**上线 6 个月后**最该做的优化

### 定价建议
- 成本 0.1–0.2 元/页，市场同类（iSlide/AI PPT 工具）定价 1–3 元/页或 19–49 元/月订阅，**毛利 80%+**；
- 建议「免费 3 页 → 9.9 元/10 页 → 39 元/月 50 页」阶梯，按页计量 + 失败不计费。

---

## 14. 明确否掉的选项（省时间）

| 选项 | 否掉原因 |
|---|---|
| 阿里云 DocMind 出 pptx | 商品清单里没有 PPT 任何项，只有 Word/Excel/图片/PDF |
| 百度文档格式转换出 pptx | 官方只列 Word/Excel（+双层 PDF/OFD） |
| 腾讯文档解析出 pptx | 输出固定为 md/json/xml + images |
| 火山 LAS 出 pptx | 输出 md + detail.json |
| WPS 转换 API 做图片→pptx | 输入仅演示格式，不吃图片/PDF |
| 讯飞图片文档还原商用 | 官方明示「体验版，暂不商用」 |
| 有道智云 | 无文档转 Office 产品线 |
| Azure/Google/Mathpix | 只出 JSON/Markdown，若用它们仍要自研组装，且数据出境 |

---

## 15. 待补核实（下次补）

1. TextIn xParse 文档解析按页单价（官网 pricing 需登录/JS 渲染）
2. TextIn / 腾讯 / 阿里的**私有化部署**报价（均需商务）
3. WPS 官方格式转换刊例价（未公开）
4. 火山 OCR / 豆包视觉理解最新 token 单价
5. 阿里云文档智能「文档解析（大模型版）」单文件页数上限（控制台限制页）
6. 讯飞 OCR 单价
7. image2ppt（PyPI 客户端）背后的服务商与报价

> 抓取方式：web_search + 官方文档页 web_fetch 原文核对；所有价格均来自官方页面正文，第三方渠道价已单独标注。
