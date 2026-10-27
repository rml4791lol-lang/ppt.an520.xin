# 深度调研：把「图片 → 可编辑 PPTX」做成产品

> **对象**：ComPDF 这类商业 API 的契约细节 ｜ LLM 在管线里的真实作用 ｜ Agent+Skill 能否产品化 ｜ 自研源码级工作量
> **日期**：2026-10-20　｜　**上游报告**：[`调研报告-图片PPT转可编辑PPT-20261020.md`](调研报告-图片PPT转可编辑PPT-20261020.md)
> **配套工具**：[`audit_pptx.py`](audit_pptx.py)（审计任何供应商输出的可编辑度）、[`comppdf_client.py`](comppdf_client.py)（ComPDF 参考客户端，改 Key 即跑）
> **一手核实**：ComPDF 定价从页面 HTML 抽取（非搜索摘要）；`api-server.compdf.cn` 实测 403=鉴权拒绝，服务在线；`codex exec` / `claude -p` 本机实跑；pptx 审计脚本已用 L0/L2 样本验证

---

## 0. 结论先行：三条路的真实定位变了

上一份报告说"能接的只有 4 条 API"。这一轮挖到契约层之后，结论要改得更锋利：

| 路线 | 单页成本 | 单页时延 | 可编辑质量 | 工程投入 | 正确用法 |
|---|---|---|---|---|---|
| **商业 API（ComPDF / image2ppt）** | **¥0.02–1.00** | 2–3 min（异步） | L2，有天花板 | **3–7 天** | **主力生产线** |
| **LLM 自研管线**（OCR + VLM + python-pptx + 渲染回环） | **¥0.05–0.07**（COGS） | **秒级** | L2，可控可调 | 10–35 人日 | **上量后的降本与差异化** |
| **Agent + Skill**（Codex/Claude 跑 image2editable 类 skill） | **¥12–40** | **12–60 min** | L2+（长尾最强） | 15–25 人日 | **只做疑难页救援，不做主力** |

> 最反直觉的一条：**Agent + Skill 是商业 API 的 15–40 倍成本、6–30 倍时延**。这不是调优问题，是结构性差距（详见 §3）。你们已经有 Agent 和 Skill，这是优势，但**别把它当转换主力**——那是拿最贵的资源干最标准的活。

**一个已经用实测量出来的答案**（本轮最有价值的一条）：

我下载并拆了 **image2ppt 的 4 个官方成品样本**（市面上唯一提供可下载成品的一家），用 `audit_pptx.py` 得到硬数字：
- ✅ 确实是 **L2 真元素还原**：每页 11–47 个原生文本框 + 4–14 个 AutoShape/Freeform；
- ⚠️ 但 **3/4 页面 z0 是一张覆盖全幅的背景图**——"底图保真 + 上层可编辑"是行业主流形态，**不等于不合格**；
- ❌ **4 个样本原生表格数 = 0**，而官网宣称"36 页里 15 页有真实可编辑表格"——**表格页必须自己 POC**；
- ❌ 中文字体全用 **微软雅黑 / 黑体**（fsType=4/2，法律上不可嵌入），用户没装就 fallback 宋体。

👉 也就是说：**市场上的"最好"也就是 L2 + 底图 + 无表格 + 雅黑**。你的差异化空间极其明确：**表格原生 + 字体合规 + 可选"无底图"模式**。

**如果只记三句话**：
1. **ComPDF 是"最正规"的一家**：三档请求模式、完整错误码体系、国内域名、版面分析单独可买——但**效果没有任何公开验证**，必须用 `audit_pptx.py` 自己测。
2. **LLM 只该干三件事**：语义分组、阅读顺序、渲染差异判因。让它直接吐整页 PPTX 是浪费（PPTBench 最好 67.8/100，中位 19.47，且不可复现）。
3. **"真正的可编辑"只有一条判据**：`audit_pptx.py` 报出的**非图片对象数**。所有宣传都要落到这个数字上。

---

## 1. ComPDF 深度拆解（你点名要看的那家）

### 1.1 产品矩阵：它不只卖"图片转 PPT"

ComPDF 把「文档智能」拆成两套可独立计费的产品线（`api-overview` / `tool-list`）：

**A. 转换 API（Conversion）** — 按**文档数**计费

| 能力 | tool type | 说明 |
|---|---|---|
| **图片 → 幻灯片** | `img/pptx` | 你要的核心 ✅ |
| **PDF → 幻灯片** | `pdf/pptx` | PDF 场景走这个，别图片转 PDF 再转（误差叠加） |
| 图片 → Word / Excel / JSON / TXT / HTML / RTF / CSV / PDF | `img/docx` 等 | 结构化原料 |
| PDF → Word / Excel / HTML / CSV / TXT / JSON / **Markdown** | `pdf/docx` 等 | Markdown 输出对 RAG 有用 |
| **版面分析** | `documentAI/layoutAnalysis` | **单独接口**！输出文本块/表格/图片区域 → 可做自研组装的原料层 |
| OCR / 表格识别 / 印章检测 / 图像纠偏 / 图像增强 | `documentAI/*` | 预处理零件 |

**B. AI API（IDP）** — 按**页数**计费，另一套配额

| 能力 | tool type | 说明 |
|---|---|---|
| 智能全文解析 | `idp/documentParsing` | 输出 JSON / tagged Markdown + bbox |
| 智能字段抽取 | `idp/documentExtract` | layout / vision 两种模式 |

> **关键点**：转换（按文档）和 AI（按页）是**独立计费、独立配额**的。这意味着你可以"转换走低价档 + 版面分析走 AI 页包"混搭，也可能踩到"以为买一个套餐全包"的坑。

### 1.2 三档请求模式：选错会一直调不通

这是 ComPDF 相对同类最工程化的地方（`request-workflow`）：

| 维度 | 同步 Sync | 异步 Async | 预签名 Pre-signed |
|---|---|---|---|
| 上传方式 | multipart 直传网关 | multipart 直传网关 | **客户端直传对象存储，不经业务网关** |
| 文件数 | 单文件（merge 类接口除外） | 单 / 多 | 单 / 多 |
| 阻塞 | 是（处理完才返回） | 否，立即给 taskId | 否，给 taskId + 上传地址 |
| 取结果 | 响应里直接有 `downloadUrl` | 轮询 task / Webhook | 轮询 / Webhook |
| **推荐文件大小** | **≤10MB** | **10–50MB** | **大文件 / 批量 / 浏览器直传** |
| 服务端带宽 | 高（双向过网关） | 高（上传仍过网关） | **低（走对象存储 CDN）** |
| 实现复杂度 | ★ | ★★ | ★★★ |

**官方建议的新手路径**：先同步跑通 → 再升级异步 → 大文件才上预签名。
**对你在网站里用的建议**：
- 用户上传后立刻要结果 → 其实**同步会超时**（图片转 PPT 单页很慢），**必须用异步**；
- 如果你要支撑「浏览器直传 + 大文件」，预签名是唯一不压垮自己带宽的方案；
- **异步轮询间隔官方建议 ≥3 秒**，别 200ms 轮一次。

### 1.3 `img/pptx` 的 11 个业务参数：每一个都会影响质量

字段名已对照官方文档核实（`multipart/form-data`）：

| 参数 | 取值 | 默认 | 含义与建议 |
|---|---|---|---|
| `file` | File | 必填 | 源图片（png/jpg…；不支持会报 `02003 Unsupported image format`）。**图片端点一次只允许 1 个文件**（`04007`） |
| `language` | int | 1 | ⚠️ **报错信息语言**（1=EN，2=中文）——**不是 OCR 语言**，很多人填错 |
| `enableOcr` | 0/1 | **0** | 是否开 OCR。纯截图可关，**扫描件/图片版必须开 1** |
| `ocrRecognitionLang` | string | — | OCR 语言码（见 `parameter-description#ocr-language-codes`） |
| `ocrRecognitionScope` | enum | `ALL` | `INVALID_CHARACTER`（乱码页）/ `SCAN_PAGE`（扫描页）/ `INVALID_CHARACTER_AND_SCAN_PAGE` / `ALL` |
| `enableAiLayout` | 0/1 | **1** | **「结构还原」总开关**。关掉基本退化成贴图 ← 最关键的一个 |
| `preserveImages` | 0/1 | 1 | 保留原图里的图片元素 |
| `preserveAnnotations` | 0/1 | 1 | 保留批注 |
| `pageBackground` | 0/1 | 1 | 是否输出整页背景图（**仅 OCR 开启时生效**）。**设 0 = 更"原生"，但视觉更不像原图** |
| `formulaToImage` | 0/1 | **0** | 0=公式保持**可编辑**（罕见能力，默认），1=公式转图片 |
| `pageLayoutMode` | enum | `e_Flow` | `e_Flow`（流式，可编辑性好）/ `e_Box`（绝对定位，视觉更准） |

PDF→pptx 端点额外字段：`pagePassword`、`pageRanges`（如 `1-3,6`）、`separateFile`（每页单独出文件）。

> **两套预设（这是我的核心建议）**
> - **要"尽量原生可编辑"** → `enableAiLayout=1, pageBackground=0, formulaToImage=0`
> - **要"视觉 1:1 保真"** → `pageBackground=1`（代价：整页底图，PPT 里背景改不动）
>
> 这两套是**两个不同的产品卖点**，不是"设置对不对"的问题。`comppdf_client.py` 里已内置为 `--native` 开关与 `PRESET_NATIVE` / `PRESET_FIDELITY`。

### 1.4 响应结构：HTTP 200 不等于成功

响应体固定 18 个字段，做集成时真正要看的是 5 个：

```
code            业务状态码（"200" 才是成功）—— HTTP 200 不代表业务成功
data.taskId     异步任务的唯一标识
data.downloadUrl 结果下载地址（延迟删除，24h 内必须下载）
data.convertTime 单文件转换耗时（ms）—— 用来做性能基线
data.failureCode / failureReason  ← 失败时看这里，不是看 msg
```

**必须遵守的三条**：
1. **判 `code`，不判 HTTP status**；
2. `downloadUrl` **短期失效**（官方两处表述略有差异：`request-workflow` 说"次日 24:00 删除"，`image-to-ppt` 说"下载有效期 24 小时"）→ **按 24h 上限设计**，必须落盘到你自己的对象存储，不能把它的 URL 透给用户；
3. **单文件限制存疑**：错误码 `04007` 明确「Only one file is allowed for this endpoint」，但官方 curl 示例又传了两个文件——**接入前实测一次**，多图场景建议按"一次一文件 + 多次提交"设计，最稳。

### 1.5 错误码体系：可以照着写重试策略

ComPDF 的错误码分**两套**：服务框架码（01xxx–06xxx）+ 转换业务码（100xxx–190xxx）。这套设计在同类里算规范的——你可以直接映射成自己的重试/提示策略：

| 码段 | 含义 | 是否重试 | 处理 |
|---|---|---|---|
| `01xxx` | 系统错误（上传/下载/存储） | ❌ | 排查 |
| `02xxx` | 文件格式错误（`02209` 文件过大、`02201` 加密） | ❌ | 提示用户换文件/解密 |
| `03xxx` | 参数校验 | ❌ | 修代码 |
| `04xxx` | 文件/业务（`04007` 只允许一个文件） | ❌ | 修调用 |
| `05xxx` | 任务状态（`05004` 任务过期） | 视情况 | 重新提交 |
| `06001` | **配额用尽**（402） | ❌ | 充值/降级提示 |
| **`190001`–`190010`** | **转换失败 / OCR 失败 / 超时 / OOM** | ✅ **建议退避重试 max 3** | 重试；仍失败则整页降级为图片 |
| `190999` | 内部错误 | ✅ | 退避重试 |
| `130004` | 幂等键处理中 | ✅ | 等一会儿 |

**注意 `190006 JOB_TIMEOUT`（408）和 `190008 OUT_OF_MEMORY`（500）**：这两个说明"这页太难/太大"，重试大概还是失败，**应该直接走降级路径**（输出整页高清图 + 标记人工），而不是傻重试。

### 1.6 定价：从页面 HTML 里挖出来的真实档位

官方 pricing 页是表单式的，但**价格卡片写在 HTML 里**（我直接抽取，不是搜索摘要）：

| 档位 | 月付 | 年付 | 包含 | **折算单文档成本** |
|---|---|---|---|---|
| 免费 | ¥0 | ¥0 | **200 文档/月** | 0 |
| Basic | ¥20/月 | **¥240/年** | **1,000 文档/月** | **¥0.02** |
| Pro（最受欢迎） | ¥558.25/月 | **¥6,699/年** | **5,000 文档/月** | **¥0.112** |
| Business | ¥999/月 | **¥11,988/年** | **10,000 文档/月** | **¥0.100** |
| 企业版 | 定制 | 定制 | 更多文档 + 灵活部署 + 全套工具 API + 高安全性 + 24h 邮件支持 + **并行任务不限 + 文件大小不限** | 询价（页面写"简单用例低至 $1,300"） |

**一个反直觉现象**：Basic 档（¥0.02/文档）比 Pro 档（¥0.112）**单价便宜 5.6 倍**。合理推测是 **Basic 只含基础工具，不含 AI 版面分析/高级转换**；而容器/并行/文件大小限制在低档更严（企业版明确列了"并行任务不限、文件大小不限"）。
👉 **签约前必须书面确认三件事**：① 你买的档能不能调 `img/pptx`？② 含不含 `isAiLayout=1` 的 AI 版面识别？③ 并行任务数与单文件大小上限是多少？

### 1.7 国内接入与合规：这点比大多数海外 API 好

- **国内域名**：`https://api-server.compdf.cn`（把所有 `api-server.compdf.com` 换掉即可）。我实测该域名在线（伪造 Key 返回 403 鉴权拒绝），**数据可不出境**。
- **数据留存**：上传后临时文件"任务完成立即删除"；对象存储里的源文件/结果文件**保留 2 天**自动删除；下载链接 24h 内有效。
- **公司主体**：PDF Technologies, Inc.（2010 年成立，新加坡 / 台北 / **长沙**）——国内团队，出海品牌 ComPDFKit，可开发票。
- **转售**：未见公开的 ToS 转售条款（不像阿里/腾讯明确写 non-sublicensable 或禁止转售）。**但商用前要书面确认 OEM/白标授权**。

### 1.8 集成代码骨架（已写好，改 Key 即跑）

我按生产可用的方式封装了 [`comppdf_client.py`](comppdf_client.py)，覆盖：同步 / 异步轮询 / 预签名骨架 / 错误码分类与重试 / 国内域名切换 / Webhook 验签骨架 / 原子落盘。核心用法：

```bash
export COMPDF_KEY=your_key
# 同步（单文件，≤10MB）
python3 comppdf_client.py --sync slide1.png -o out.pptx

# 异步（多文件合并，自动轮询）
python3 comppdf_client.py img_dir/ -o out.pptx --async-mode

# 只做版面分析，拿 JSON 原料（自研组装用）
python3 comppdf_client.py slide1.png -o layout.json --layout

# 关键参数
--flow e_Flow|e_Box     # 可编辑性 vs 版式还原的权衡
--no-ai-layout          # 关掉 AI 版面识别（不推荐）
--formula-as-image      # 公式转图片（默认保留可编辑）
--region cn|intl        # 国内/国际域名
```

拿到 `out.pptx` 后**立刻跑审计**：
```bash
python3 audit_pptx.py out.pptx
```

### 1.9 ComPDF 的六个坑（按踩到概率排序）

1. **同步会超时**：单页转换经常 >60s，同步模式基本不可用于线上，**必须异步**。
2. **HTTP 200 ≠ 成功**：必须判 `code`。
3. **下载链接 24h 失效**：不落盘就丢，别把他们的 URL 给用户。
4. **一请求一文件**：多图要多次提交（或走异步批量），`04007` 会挡住。
5. **低价档可能不含 AI 版面分析**：这是质量分水岭，签约前书面确认。
6. **`e_Flow` vs `e_Box` 选错会挨骂**：用户说"不像原图"就换 `e_Box`，说"改不动"就换 `e_Flow`——**这是两个不同的产品卖点，不是 bug**。
7. **`language` 不是 OCR 语言**：它是**报错信息语言**（1=EN/2=中文）。OCR 语言是 `ocrRecognitionLang`。这个参数名坑会让人白调半天。
8. **`pageBackground` 是"像不像"与"能不能改"的总闸**：设 1（默认）→ 整页底图，视觉保真但背景改不动；设 0 → 更原生但观感会"散"。**上线前一定要两组参数各跑一批真实图做 A/B。**

### 1.10 对 ComPDF 的总体判断

| 维度 | 评价 |
|---|---|
| 接口设计 | ★★★★★ 三档请求模式 + 完整错误码 + 独立版面分析，是同类里最"给开发者用"的 |
| 文档 | ★★★★☆ 参数/响应/错误码齐全；但 pricing 页要挖 HTML，Webhook 签名文档过简 |
| 国内合规 | ★★★★☆ 有 .cn 域名、可开发票、文件 2 天删除；主体是新加坡公司 |
| 定价透明度 | ★★★☆☆ 价格能查到，但低价档的功能边界不清楚 |
| **效果** | **？？？ 零公开验证** ← 唯一但致命的空白。同类里只有 image2ppt 提供成品样本（实测见 §1.12），ComPDF 连样本都没有 → **必须自测** |

👉 **行动建议**：免费档 200 文档/月足够你跑一批 A/B。用 `comppdf_client.py` 跑 20 张真实业务图，再用 `audit_pptx.py` 出数字，**一天就能得到"值不值得买"的答案**。

### 1.11 同类 API 横向速查（11 家）

| 产品 | 端点 | 同步/异步 | 价格 | 真出 pptx | 数据地区 |
|---|---|---|---|---|---|
| **ComPDF Cloud** | `POST /server/v2/process/img/pptx` | 同步/异步/预签名 | **¥0.02/张起** | ✅（未见样本，预期 L2） | `.com` 全球 / **`.cn` 大陆** |
| **Nutrient DWS** | `POST api.nutrient.io/build` | 同步（流回） | $75/1k credits，1.5 cr/张 ≈ **$0.08–0.135/张** | ✅ 官方称"提取 text+structure，非整页贴图" | US / EU（SOC2/HIPAA） |
| **Adobe PDF Services** | `POST /operation/exportpdf` | 异步 job（**无 webhook**） | 无公开单价；**免费 500 次/月** | ✅ 但**只吃 PDF**，图片要先 createpdf | US 默认 / EU |
| **image2ppt** | `POST /api/v1/jobs` | **纯异步 + 签名 webhook** | **¥0.70–1.00/页** | ✅ **唯一有公开成品样本** | 新加坡 |
| **TextIn** | `POST api.textin.com/ai/service/v1/file-convert/pdf-to-ppt` | **同步 base64** | **¥0.055–0.1/次** | ✅ 但只吃 PDF、**1 QPS** | 中国大陆 |
| **度慧 img2doc** | `POST img2doc.api.bdymkt.com/v1/convert` | 异步 token + 回调 | **¥0.003–0.017/次**（一次 ≤50 图） | ⚠️ "尽量还原" → **L1–L2** | 中国大陆 |
| **ConvertAPI** | `/convert/jpg/to/pptx` | 同步 + JobId | ~$35/12k 次 | ⚠️ **只有边距/纸张/OCR 旋钮 = L1 贴图+文字层** | 可选不出境 |
| **CloudConvert** | `POST /v2/jobs` | 异步 job | PDF→Office 4 cr ≈ $0.036–0.068 | ❌ **jpg→pptx 404**，只有 pdf→pptx | 多区 |
| **Aspose.Slides Cloud** | `PUT /v3.0/slides/convert/{fmt}` | 同步 | 自建 $999 / OEM $2,997 | ❌ **不接受图片输入** → 直接排除 | 多区/自建 |
| **讯飞 图片文档还原** | `wss://ws-api.xfyun.cn/...` | WebSocket 分帧 | 免费 | ✅ `result_type=2` 出 ppt | 中国大陆 |
| **WPS 开放平台** | 未公开（OCR 通道） | 异步任务 | 按页，**不公开** | ✅ 能力已列，契约需入驻 | 中国大陆 |

**三条硬结论**：
1. **"输出 .pptx" ≠ "原生可编辑"**。没有任何一家敢承诺 L3（全矢量、表格原生）。ConvertAPI 的参数表（只有边距/纸张/OCR）就是"L1 贴图"的铁证。
2. **只有 image2ppt 提供可公开下载的成品样本**——其余 10 家只有输入样例。**这是选型信号：敢让人验货的，通常质量有底**。
3. **异步契约最工程化的不是大厂，是 image2ppt**：Idempotency-Key（24h/账号级，同 key 异体 422）+ Standard Webhooks 验签（HMAC-SHA256 over `id.ts.rawbody`，base64 secret，300s，6 次重试，双签轮换）+ 逐页账本 + 失败退点。**ComPDF 有 `130004 IDEMPOTENCY_IN_PROGRESS` 但键名未公开**；Adobe/度慧/ComPDF 的 webhook 都应"只当敲门、回查为准"。

### 1.12 实测：拆了 image2ppt 的官方成品样本（这是本轮最硬的证据）

image2ppt 官网提供 4 个可下载的成品 pptx（`https://image2ppt.com/samples/pptx/*.pptx`，本地副本在 `notes/samples-image2ppt/`）。我用 [`audit_pptx.py`](audit_pptx.py) 拆了这 4 个样本：

| 样本 | 判定 | 非图片对象 | 文本框 | 几何对象 | 字数 | 全幅底图(z0) | 风险字体 |
|---|---|---|---|---|---|---|---|
| `zh-saas-revenue-expansion` | **L2 元素还原** | 60 | 47 | 13 | 201 | ❌ 无 | ⚠️ Microsoft YaHei ×96 |
| `en-saas-revenue-expansion` | **L2 元素还原** | 49 | 36 | 13 | 662 | ✅ 有（100%） | — |
| `zh-ai-growth-command` | **L2 元素还原** | 37 | 23 | 14 | 91 | ✅ 有（100%） | ⚠️ Microsoft YaHei |
| `zh-product-launch-day` | **L2 元素还原** | 15 | 11 | 4 | 70 | ✅ 有（100%） | ⚠️ SimHei + Microsoft YaHei |

**四个结论，每个都会影响你的产品决策**：

1. **它确实是 L2，不是 L0/L1**：每页 11–47 个原生文本框 + 4–14 个 AutoShape/Freeform，Ctrl+A 能选中四五十个独立对象。**这是真可编辑**。
2. **但 3/4 的页面 z0 是一张覆盖全幅的背景图**——这是**行业主流形态**：底图保真 + 上层可编辑。所以"背景是一整张图"**不等于**不合格，你要看的是上层有多少原生对象。**这也是为什么我的审计脚本一开始判错，必须专门修正判定逻辑**——这个坑所有买家都会踩。
3. **4 个样本里原生表格数 = 0**。官网宣称"36 页测试里 15 页出现真实可编辑表格"——**在自己的营销样本里都没能复现**。👉 **表格页必须自己 POC，不要相信任何一家的表格宣传**。
4. **中文字体全用微软雅黑 / 黑体**：fsType=4/2，**法律上不可嵌入**，用户机器没装就 fallback 宋体、换行全崩。**这是它输出的真实隐患，也是你可以做得更好的地方**（统一输出 Noto / 思源）。

> 📌 **这四条合起来说明一件事**：市场上的"最好"也只是 **L2 + 底图 + 无表格 + 雅黑**。你的差异化空间非常明确：**表格原生 + 字体合规 + 可选"无底图"模式**。

---

## 2. LLM 在管线里的正确用法

你们能调 LLM，这是真优势——但**优势在"判断"而不在"生成"**。

### 2.1 只该给 LLM 花钱的三个位置

| 位置 | 为什么值得 | 推荐模型档 |
|---|---|---|
| **① 语义分组** | "这三个卡片是一组"、"这个悬浮标注属于标题"——规则写不出来，小模型也差 | 中档 VLM（qwen3-vl-plus / glm-4.6v） |
| **② 阅读顺序** | 多栏、图文混排、跨栏标题，OCR 给不出正确顺序 | 中档 VLM |
| **③ 渲染差异的"判因"** | 回渲后哪块坏了、为什么坏（字号？颜色？错位？），决定重修策略 | 中档 VLM |
| ~~整页生成 PPTX XML~~ | **别做**：PPTBench 最好配置 67.80/100、中位 19.47，2.08% 直接产不出文件，70.43% 丢掉流程语义，**且同输入两次输出不同 → 无法回归测试** | — |
| ~~底图修补~~ | LLM 干不了，用 **LaMa**（图像修复模型）；LLM 只负责"决定抹哪些字" | — |

### 2.2 坐标：三个坐标系混用 = 1000 倍事故

这是最容易翻车、也最少人讲的技术点：

| 模型 | bbox 坐标约定 | 坑 |
|---|---|---|
| **Qwen3-VL** | **0–1000 归一化**（官方技术报告明说更鲁棒） | 按像素解析 → 坐标全部错 |
| **Qwen2.5-VL / 豆包** | **绝对像素** | 按 0–1000 解析 → 坐标缩成一条线 |

> **没有"哪种更准"，只有"必须匹配模型训练约定"。**

**更重要的**：**VLM 的 bbox 只能当先验，落库前必须做 ink-snap**（墨水边界吸附）：用投影法在 bbox 附近找真实墨迹边界，把框修到像素级。原因看下面这组硬数据。

**精度实测（Images2Slides, WWW'26）**：

| 指标 | 数值 | 含义 |
|---|---|---|
| 文本区布局 IoU | **0.364** | **位置只对三分之一** |
| IoU ≥ 0.5 的比例 | 37.6% | 六成文本区位置不合格 |
| 文本区中心偏移 | **53.7 px / 1600 px** | 平均偏 3.4% 页宽 |
| 图片区 IoU / 偏移 | 0.644 / 11 px | 图片比文本准得多 |
| 元素回收率 | 0.989 | **元素基本不会漏** |
| 文字 CER | 0.033 | 文字准确率 96.7% |
| VLM 单页耗时 | 55 s | — |

**GroundingME**：最强模型 Qwen3-VL-235B 的 grounding 准确率仅 **45.1%**，且 **Rejection 类几乎全 0%**——**模型永远不会说"这里没有东西"，它必然编框**。

👉 **工程结论**：元素识别已基本解决（回收率 0.989），**瓶颈在几何**。所以正确姿势是：
```
VLM 给 bbox 先验 → 检测器（PaddleOCR/PaddleOCR-VL/Florence-2）给精确框 → ink-snap 吸附 → 落库
```
只信 VLM 的框，产品会被"位置偏一点"的投诉淹死。

### 2.3 字段级 JSON schema（可直接用）

```jsonc
{
  "page": {
    "width_px": 1920, "height_px": 1080,
    "px_to_emu": 9525,                       // 1px = 9525 EMU @96dpi，一页只算一次
    "bg": { "type": "image|solid", "color": "#0B1230", "image_ref": "bg.png" }
  },
  "elements": [                               // 数组顺序 = z-order（底→顶）
    {
      "id": "e1",
      "type": "text|shape|line|image|table|group|chart|formula",
      "bbox_px": [x, y, w, h],                // ★ 只存源图像素，EMU/PT 组装时算
      "rotation": 0,
      "opacity": 1.0,

      // type=text
      "text": { "content": "季度营收增长 32%", "font": "Noto Sans CJK SC",
                "size_pt": 18,                 // ★ 不要用 VLM 给的字号，见下
                "bold": true, "italic": false, "color": "#FFFFFF",
                "align": "left", "anchor": "middle",
                "line_spacing": 1.2, "space_before_pt": 0,
                "auto_fit": "none|shrink|resize" },

      // type=shape
      "shape": { "preset": "roundRect|rect|ellipse|path",
                 "fill": "#1F5FAF", "stroke": { "color": "#FFFFFF", "width_pt": 1.5 },
                 "radius_adj": 0.12, "arrow": null },

      // type=line
      "line": { "from": [x1,y1], "to": [x2,y2], "style": "solid|dash",
                "width_pt": 2, "color": "#5B8DEF", "head": "none", "tail": "triangle" },

      // type=image
      "image": { "src_ref": "crop_3.png", "crop_px": [x,y,w,h],
                 "role": "photo|icon|chart|decor|logo" },

      // type=table
      "table": { "rows": 4, "cols": 3,
                 "cells": [[{"text":"指标","header":true}, ...], ...],
                 "borders": {...} },

      // type=group
      "group": { "children": ["e2","e3"], "reason": "卡片组（LLM 判定）" },

      // 溯源（务必保留，做 QA 与人工复核的依据）
      "provenance": {
        "bbox_src": "detector|vlm|snap",
        "text_src": "ocr|vlm|merge",
        "size_src": "ink_height|vlm",
        "needs_review": false
      }
    }
  ]
}
```

**两个字段级铁律**：
1. **只存源图像素 `bbox_px`**，EMU/PT 在组装时一次性换算。存多种单位一定会对不上。
2. **字号绝对不用 VLM 给的**——用**墨迹高度反推**：CJK 用全角 em（字高 ≈ 字号），拉丁用 cap-height 比例；再做**页级分段线性校准**（同一页里字号通常只有 3–5 档，聚类后取中位数更稳）。

### 2.4 模型选型与真实成本（1920×1080 一页）

**一页图的 token 数**（不是猜的）：
- Qwen 系列：**2,025 image token**（32×32 px/token；**默认 max_pixels 2.62M → 2560×1440 会被降采样**，别以为传大图更准）
- 豆包系列：**2,691**（28×28 px/token）
- 加 prompt ≈ **3,200 输入 token**

| 模型 | 单价（入/出，元/百万 token） | 一页 token 成本 | 适用位置 |
|---|---|---|---|
| **glm-4.6v-flashx** | 0.15 / 1.5 | **¥0.005** | 预检、批量粗抽 |
| **glm-4.6v** | 1 / 3 | **¥0.012** | 性价比主力 |
| **qwen-vl-ocr** | 0.3 / 0.5 | ¥0.0025 | 纯取字（不当主模型） |
| **qwen3-vl-plus** | 1 / 10 | **¥0.033**（思考模式 ¥0.063） | 语义分组、阅读顺序、判因（**主选**） |
| **doubao-seed-1.6-vision** | 0.8 / 8 | ¥0.027 | 同上，256K 上下文 |
| doubao-seed-2.1-pro | 6 / 30 | ¥0.117 | 难页兜底 |
| PaddleOCR-VL 0.9B（自建） | — | **¥0.002–0.005** | 文本/表格/公式/顺序 |

> ⚠️ **qwen3-vl-max / flash 在百炼当前价目表未列**（只列了 plus 与 ocr），别引用未经核实的单价。

**含重试与 QA 的真实 COGS**（这才是做毛利模型该用的数）：

| 档 | 配置 | 单页 COGS | 预期可编辑率 | 建议零售价 |
|---|---|---|---|---|
| 省钱 | PaddleOCR-VL + glm-4.6v-flashx | **¥0.006–0.01** | 55–65% | 仅内部/归档 |
| **均衡（推荐上线档）** | **qwen3-vl-plus + PaddleOCR 交叉 + 1 轮渲染回环** | **¥0.05–0.07** | **75–85%** | **¥0.6–1.0/页** |
| 效果优先 | plus 思考模式 + 2×2 切片 + VLM 判因 + 2 轮 | **¥0.12–0.15** | 85–92% | ¥2.5–4/页 |

**一个必须纠正的认知**：token 成本只占零售价的 **3–8%**。**真正的成本是"返修分钟数"**——所以优化方向不是换更便宜的模型，而是**提高一次通过率**。

### 2.5 渲染回环：不是"像不像原图"，而是"有没有比栅格版更差"

这是整套方案里**最值钱的工程细节**，来自 `image2editable` 的 `route_execution.py:482`：

```
1. 把这一页的"栅格版"（整页图当作背景）渲染两遍 → 两次渲染的差异 = 系统噪声 noise
2. 以"栅格版的误差"作为 baseline（栅格版是"绝对保真但不可编辑"的下限）
3. 要求 native 候选（真可编辑版）满足：candidate_error ≤ baseline_error + noise
4. 不满足 → 对象级降级（把这个对象换回图片）→ 再渲一次
5. 还不满足 → 整页降级为高清图 + 标记需要人工
```

**为什么这么设计**：如果直接跟原图比"像不像"，你永远无法判断"这个差异是模型不够好，还是本来就不可能完美"。**用栅格版当 baseline，问的才是正确的问题："我把它做成可编辑之后，是不是比直接贴图更差？"** 这是唯一能防止"越编辑越丑"的机制。

**判决指标**（不要只用 SSIM）：
- **SSIM 只用来排序找坏块，绝不设绝对阈值**——LibreOffice 换个字体就能让 SSIM 差 0.15
- 真正的判决用四件套 + 匈牙利匹配：
  - block-match recall ≥ **0.95**
  - 文字 CER ≤ **0.02**
  - 元素中心偏移 p95 ≤ **1.5% 页面对角线**
  - 色差 ΔE00 ≤ **6**
- **局部重修最多 2 轮**（ReFigBench 证明迭代收益有限），修不好就降级
- 可抄的实现：`figedit`（差异热力图 + 分块评分）、`AutoPresent`、`image2editable`

### 2.6 中文场景的四个硬约束

1. **字体不能随便嵌**（我本地用 fontTools 读了 `OS/2.fsType`）：

| 字体 | fsType | 能否嵌入 |
|---|---|---|
| 苹方 PingFang SC | 4 | ❌ **法律上不可嵌入** |
| 宋体 Songti SC | 2 | ❌ 不可嵌入 |
| **Noto Sans CJK SC / 思源黑体** | **0** | ✅ 可嵌 |
| 冬青黑体 Hiragino Sans GB | 8 | ✅ 可嵌（受限） |

👉 **产物只出 Noto / 思源**，原字体名写进备注。而且 **Mac 版 PowerPoint 会直接忽略嵌入字体**——别指望"嵌字体"解决问题。

2. **中文 run 必须写 `a:ea`**：`python-pptx` 的 `font.name` 只写 `a:latin`，**中文会 fallback 成宋体**。这是最高频的隐性质量事故（`audit_pptx.py` 会直接报出来）。

3. **中文字号要用全角 em 量**，否则算出来会小约 15%。

4. **标点按上下文转全角**，但保留白名单（`3.5%`、`v2.0` 这类不要转）。

---

## 3. Agent + Skill 能不能产品化：能跑，但不能当主力

你们已经有 Agent 和 Skill，这条路我做了**实机验证**，不是读文档。

### 3.1 硬结论：确实能无人值守跑

本机实测（2026-10-20）：

```bash
$ codex exec -s read-only --skip-git-repo-check --json "Reply with exactly: OK"
{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":79187,"cached_input_tokens":12032,"output_tokens":2}}

$ claude -p "Reply with exactly: OK" --output-format json --max-budget-usd 0.05
... "terminal_reason":"budget_exhausted","subtype":"error_max_budget_usd","is_error":true
```

两家都**不需要 TTY、不阻塞等审批、输出结构化 JSON、自带精确用量**（可直接用于计费）。`claude -p` 的 `--max-budget-usd` 是有效硬熔断；**Codex 没有内建预算上限**，必须外层 timeout / k8s `activeDeadlineSeconds`。

### 3.2 但有四个坑会直接让你上线失败

1. **订阅额度禁止转售**：`image_to_editable_ppt` 类 skill 默认图片后端是 Codex 内置 `image_gen.imagegen` → Codex OAuth → API 三级降级。**前两级绑 ChatGPT 订阅额度，ToS 禁止转售**——SaaS 必须只保留自有 API Key 的那一级，成本要重算。
2. **`--bare` 会跳过 skill 发现**（Claude 文档明确）→ 别用它求启动速度，改用干净 `CLAUDE_CONFIG_DIR`。
3. **无 TTY 时权限默认 Manual**：`claude -p` 里没进 `--allowedTools` / `--permission-mode` 的 Bash/写文件请求会被**静默拒绝**，表现为"跑了一半没产物"。Codex 侧对应 `approval_policy = "never"`。
4. **`$skill` 显式点名是 TUI 能力**：`codex exec` 里要靠 description 隐式命中，或把 SKILL.md 路径写进 prompt。而且 Codex 初始 skill 列表只占上下文 2% 或 8000 字符，**技能多时它会截短甚至不列出你的 skill**。

> ⚠️ 实测还暴露了成本主因：**一句 "OK" 就消耗 79,187 input token**——因为这台机器装了约 80 个 skill 和 MCP。**生产环境必须 `--ignore-user-config` + 隔离 `CODEX_HOME`**，否则你在为别人的配置付费。

### 3.3 成本与时延：结构性差距，调优追不平

| 项 | 低 | 高 |
|---|---|---|
| LLM（2.5–3.5M tokens/页，90% 缓存读） | $1.50 | $3.00 |
| 图像生成（3–8 次 × $0.05–0.15） | $0.15 | $1.20 |
| 容器/CPU | $0.02 | $0.06 |
| **合计** | **$1.67 ≈ ¥12** | **$4.26 ≈ ¥30** |
| 含重试（×1.3） | **¥16** | **¥40** |

**对照实测**：issue #8 里 12 页消耗 $50 额度 / 40M tokens / 约 1 小时 → **$4.17/页**；官方 README 自述"10 页可能烧完 5 小时额度、单页 10min+"（已核对原文）；社区实测单张 30–60 分钟、35 页 >23 小时。

**时延**：单页 p50 **12–20 min**、p90 **30–60 min**；12 页 deck（6 路并发）**40–90 min**。
**对比 image2ppt：¥0.70–1.00/页、约 2 分钟/页** → **贵 15–40 倍、慢 6–30 倍**。

### 3.4 一个必须知道的真相：慢的主因不是 token

`image2editable` 的 `BASELINE.json`（14 页、CPU、**计划回放、不含 LLM**）显示总耗时 **2.95 小时，单张图 9–16 分钟**。

👉 **"慢"的主因是 SAM2.1-large + GroundingDINO 的 CPU 推理，不是大模型调用。** 想提速得上 GPU，而这些 skill 大多明文拒绝替换轻量分割模型（换了效果就变）。这是它们的设计选择，不是 bug。

### 3.5 最小生产架构

```
上传(presigned) → 对象存储 → jobs/pages 表 → 队列 → Dispatcher(租户配额)
      → K8s Job / Firecracker：1 job = 1 容器（4vCPU / 8GiB）
           Agent 会话（codex exec | claude -p）
             → 页内 3–6 并发 page worker
             → editppt CLI 确定性构建 + 逐页 validation 门禁
      → 产物回对象存储 → 回调/轮询 → 计费账本 / OTel 审计
```

关键参数：
- **一 job 一容器**（Agent 会污染全局状态）
- **页内并发 3–6**（skill 默认 6）
- **三层超时**：job 45min / page 25min / tool 级
- **取消**：SIGINT 正常收尾 → 60s → SIGTERM（exit 143），**不要 SIGKILL**
- **熔断**：`--max-budget-usd`
- **幂等键** = `sha256(输入) + skill 版本 + 后端配置`；页级缓存能把 12 页重跑成本降到 1 页
- **多租户隔离**：每个 job 独立 `cwd` + `CLAUDE_CONFIG_DIR` + `setting_sources=[]` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` + 出口 allowlist
- **计费**：按页冻结 → 结算 → 失败退款，每页一行 `page_results`（既是账单也是质量数据）

> **最重要的一条设计约束**：deck 级全通过率 ≈ 0.8¹² ≈ **7%**。所以**绝不能让一页失败卡死整个 deck**——必须**逐页门禁 + 逐页降级**，任何情况下都要能交付（最差降级为整页高清图）。

### 3.6 分流策略：Agent 买的是长尾，不是成本

```
Tier 0  确定性管线（OCR + OOXML 组装）   5–30 s     ¥0.1–1/页    覆盖 60–70%
Tier 1  本地 CV 重建（SAM/LaMa，无 LLM） 2–10 min   ¥0.5–2/页    覆盖 20–30%
Tier 2  Agent + Skill                   12–40 min  ¥12–40/页    覆盖 5–15%
Tier 3  商业 API / 整页图兜底            2–3 min    ¥0.7–3/页    永远成功
```

**升级到 Tier 2 的可编码判据**（任一条命中）：
- OCR 文本覆盖率 **< 85%**
- 组件置信度 **< 0.9**
- 出现 `retry_with_points` / 未知组件 > 3
- 含渐变、发光、艺术字、手绘
- **单页业务价值 > ¥30**

**该用 Agent 的场景**：一次性高价值 deck；AI 生成的海报式/科研图/设计稿；需要"判断哪个是图标、文字要不要拆行"的页面；第一版坏了能自己看 preview 修（**这是它唯一的硬优势**）；夜间批处理可排队。

**不该用的场景**：数字原生 PDF/PPTX（有文字层，直接解析，零成本）；规整文字/表格页；>1000 页/天；要秒级；要同输入同输出；有数据出境限制的客户（skill 会把页面图传给 OCR 与图生模型）。

### 3.7 现成基建（不用自己造）

| 方案 | 说明 |
|---|---|
| **[agent-bridge](https://github.com/R3n3r0/agent-bridge)** | 把 `claude -p` / `codex exec` 包成 OpenAI 兼容 HTTP —— **最现成的壳**（GPL，注意传染） |
| **火山 ARK Managed Agents**（`arkcli agent`） | Agent / Skill(zip+版本) / Env / Session + 挂 TOS + 事件流 —— **国内最接近成品**，斯文 |
| Anthropic Managed Agents | $0.08/session-hour + token，托管 agent loop，沙箱自建 |
| 自研 | 就是 §3.5 那套，15–25 人日 |

### 3.8 结论：Agent+Skill 的产品定位

**别把它当"图片转 PPT"的主卖点**——会被 ¥1/页 的商业 API 打死。两个能赚钱的定位：

1. **疑难页救援**：¥9.9–19.9/页，明写"5–30 分钟"，只接 Tier 0/1 失败的页。用户愿意为"能救回来"付溢价。
2. **人机协同编辑器**：逐页 diff 展示 + 用户点"重做这页"。把不可控和重试成本变成**用户的主动选择**，顺带解决复现性问题。

---

## 4. 自研到底要多少工作量（源码级结论）

### 4.1 三个必须先纠正的认知

| 常见误解 | 实际 |
|---|---|
| "px-image2pptx 是个完整方案" | **只有 ~1100 行**，只做「OCR → 文字掩膜 → LaMa 补底图 → 纯 textbox」。**没有元素分类、没有形状/图标重建、没有渲染回环、不支持多页/PPTX 输入** |
| "开源有位图转矢量的方案" | **六个项目里没有一个做自动 tracer**。figedit 是让 VLM 写 SVG；cell-ppt 是付费云 API。自研 tracer 15–25 人日且不稳 |
| "MinerU2PPT 架构好可以抄" | **无 LICENSE，代码不能抄**，只能读思路；且它把 table/figure/formula/chart **全部降级成 300dpi 栅格裁剪** |

### 4.2 模块 → 最佳参考 → 人日

| 模块 | 最佳参考 | License | 自研人日 | 抄改人日 |
|---|---|---|---|---|
| 图片/PDF/PPTX 输入 | image2editable `inputs.py` / `pdf_input.py` / `pptx_input.py` | MIT | 6–8 | 2–3 |
| OCR 中英混排 | px-image2pptx `ocr.py`（120 行） | MIT | 1–2 | 0.3 |
| 文字墨迹掩膜 | px-image2pptx `textmask.py`（180 行） | MIT | 2–3 | 0.5 |
| 掩膜 ∩ OCR 裁剪 | `clip_mask_to_ocr()` | MIT | 1 | 0 |
| 去字补底图（LaMa） | px-image2pptx `inpaint.py` | MIT | 1–2 | 0.5 |
| 组件语义分割（SAM2） | image2editable `sam_worker.py` | MIT | 15–20 | 5–7 |
| 文本提示检测（GroundingDINO） | image2editable `object_detect.py` | MIT | 5 | 2 |
| 文本行/段落重建 | MinerU2PPT `ir_merge.py` + `ocr_merge.py` | **无** | 8–10 | 只能重写 4–5 |
| 字号归一化（K-means） | MinerU2PPT `generator.py:401` | 无 | 2–3 | 1.5 |
| 字号拟合（PIL 度量） | image2editable `ppt_assemble.py:833` | MIT | 2 | 0.5 |
| 元素分类/路由 | slide-alchemy `SKILL.md` 第 5 步 | MIT | 6–8 | 3 |
| 位图→矢量 tracer | **无开源** | — | 15–25 | 接 API 2 |
| **SVG → 原生 DrawingML** | **figedit `scripts/svg_to_pptx/`**（190KB） | MIT | 20–25 | **3–5** |
| **pptx 组装器** | **image2editable `ppt_assemble.py`**（38KB） | MIT | 10–12 | **2–3** |
| 中文 ea 字体 | 两者 `ppt_assemble.py:1075` | MIT | 2–3 | 0.3 |
| **渲染回环 + 门禁** | **image2editable `render_qa.py` + `route_execution.py:482`** | MIT | 8–10 | **2–3** |
| 混合 PPTX 保留原生 | image2editable `pptx_input.py`（73KB） | MIT | 10–15 | 5–6 |

### 4.3 三条"直接抄"（6–8 人日出骨架）

1. **`pip install "px-image2pptx[ocr,inpaint]"` + 改 3 处**（CJK 宽度改真实度量、补 `a:ea`、中文行内不插空格）→ **半天**拿到"文字可编辑 + 干净底图"基线。
2. **`cp -r figedit/scripts/svg_to_pptx`** 后调 `create_pptx_with_native_svg(..., use_native_shapes=True)` → 一次拿到 custGeom 圆角/弧环、`a:ea`、`spcPts` 行高、`srcRect` 像素裁剪、`asvg:svgBlip`、OMML 公式。**自研要 20–25 人日，移植 3–5 人日**。
3. **复制 image2editable 三个无耦合文件**（`ppt_assemble.py` / `render_qa.py` / `libreoffice_renderer.py`）当"IR → pptx"后端 + 评分器。**自研 18–22 人日，抄改 2–3 人日**。

### 4.4 python-pptx 做不了的 11 件事（必须手写 XML）

| 能力 | python-pptx 1.0.2 | 要写什么 |
|---|---|---|
| 透明度 | ❌ | `a:alpha` |
| 文字渐变 | ❌ | `rPr/a:gradFill` |
| 任意曲线 | ❌ | `a:custGeom` + `a:cubicBezTo`（`build_freeform` 只有 `add_line_segments`，**无贝塞尔**） |
| z-order 调整 | ❌ | `spTree` / `insert_element_before` |
| 内嵌 SVG | ❌ | `add_picture` 不收 SVG → 2 个 media + 2 个 rel + Content_Types + `asvg:svgBlip` |
| 表格边框/去默认样式 | ❌ | 表格 XML |
| OMML 公式 | ❌ | MathML/OMML 手写 |
| 阴影 / 发光 | ❌ | `effectLst` |
| 字符间距 | ❌ | `rPr@spc` |
| 文本描边 | ❌ | `rPr/a:ln` |
| 母版/版式新建 | ❌ | 整个 part |

**半残**：中文 `a:ea` 字体（`font.name` 只写 `a:latin`）。
**原生可用**：`word_wrap`、`auto_size`、`line_spacing`、`space_before/after`、`add_connector` + `begin_connect`、`add_group_shape`、`add_table`、`fill.gradient()`（1.0+）、`crop_*`。

### 4.5 自研工作量三档

| 档位 | 范围 | 人日 |
|---|---|---|
| **快速验证** | 文字 + 底图 + 简单几何 + 图标裁图 | **10–13** |
| **可用产品** | + 中文排版 + 渲染门禁 + 四类图 | **25–35** |
| **对标最佳** | + SAM2 + Agent 路由 + 混合 PPTX + CI 回归 | **60–80** |

**最容易被低估的四件事**：段落重建（60KB 代码级）、字号字重调参（20 张语料 ≈3 人日）、LibreOffice 在 CI 的稳定性（psutil 监控 + 300s 判死不是过度设计）、"不差于栅格"的三级降级链。

---

## 5. 三条落地架构：怎么选

### 架构 A：纯商业 API（**MVP 首选**）

```
浏览器 → 你的后端 → ComPDF img/pptx（异步 + webhook）
                  → 结果落你的 OSS → 回调通知前端
                  → 用户下载前跑 audit_pptx.py 打分 → 低于阈值提示"人工复核"
```
- **上线 3–7 天**，成本 ¥0.02–1.0/页，**没有效果责任**（效果是供应商的）
- 适合：验证需求、B 端项目制、没有算法团队
- 风险：供应商涨价/断供、质量不可控、效果无法差异化

### 架构 B：LLM 自研管线（**上量后**）

```
上传 → 预检分类器（glm-flashx，判断值不值得转，¥0.005）
     → 三档路由：
        · 数字原生 PDF/PPTX → 直接解析（零成本）
        · 规整页 → Tier0：PaddleOCR-VL + python-pptx 组装（¥0.01）
        · 复杂页 → Tier1：+ VLM 语义分组/阅读顺序（¥0.05–0.07）
     → 渲染回环（LibreOffice + baseline+noise 判据）
     → 不合格 → 对象级降级 → 整页降级
     → audit_pptx.py 出可编辑度报告，随结果交付
```
- **10–35 人日**，COGS ¥0.05–0.07/页，**效果可控、可差异化、可定价 ¥0.6–1.0/页（毛利 90%）**
- 适合：确认有量（>2 万页/月）、要毛利、要差异化

### 架构 C：混合路由（**长期最优**）

架构 B 为主 + Tier2 Agent 救援 + Tier3 商业 API 兜底。**核心不是"用哪个"，是"路由判据"**（§3.6）。这套的复杂度在运维，不在代码——**没有量之前不要做**。

### 5.1 分阶段建议

| 阶段 | 时间 | 做什么 | 花多少 |
|---|---|---|---|
| **P0 验证** | 第 1 周 | ComPDF 免费 200 文档跑通 + `audit_pptx.py` 盲测 5 家 | ¥0 |
| **P1 上线** | 第 2–3 周 | 架构 A（ComPDF 异步 + 预检 + 分档定价） | <¥1k/月 |
| **P2 降本** | 第 2 月 | 自研 Tier0（先啃 60–70% 的规整页）→ 把商业 API 用量压到 30% | 15 人日 |
| **P3 差异化** | 第 3–4 月 | 加 Tier1 + 渲染回环 + 可编辑度报告 | +15 人日 |
| **P4 长尾** | 有需求再说 | Tier2 Agent 救援（¥9.9–19.9/页单独定价） | 15–25 人日 |

### 5.2 单位经济模型（按均衡档自研）

| 项 | 数值 |
|---|---|
| 零售价 | ¥0.8/页 |
| COGS（模型 + 渲染 + 存储） | ¥0.06/页 |
| 人工复核抽检（10% 页 × 2 min） | ¥0.10/页 |
| **毛利** | **≈ ¥0.64/页（80%）** |
| 若走 ComPDF Basic（¥0.02/文档，假设可用） | 毛利 ¥0.78/页，但**质量不可控** |
| 若走 image2ppt（¥0.70/页） | 毛利 ¥0.10/页 → **这个价位做 C 端没戏** |

---

## 6. 本周就能做的三件事

**① 用 `audit_pptx.py` 做供应商盲测（半天）**

```bash
# 1. 准备 10 张真实业务图（矢量PDF / 规整截图 / 扫描件 / AI生图 / 手机拍屏 各 2 张）
# 2. 分别用各家转换，产物丢到一个目录
# 3. 批量审计，出横向 CSV
python3 audit_pptx.py results/comppdf/*.pptx --quiet --csv compdf.csv
python3 audit_pptx.py results/image2ppt/*.pptx --quiet --csv image2ppt.csv
# 4. 看三个数：L2 页占比、非图片对象数、中文缺 ea 数
```
这一步能把"效果好不好"从感觉变成数字，**只需半天**。

**② ComPDF 免费档跑通（1 小时）**

```bash
export COMPDF_KEY=你的key
python3 comppdf_client.py --sync test.png -o comppdf.pptx
python3 audit_pptx.py comppdf.pptx
# 再对比 e_Flow vs e_Box 的差异
python3 comppdf_client.py --sync test.png -o flow.pptx   --flow e_Flow
python3 comppdf_client.py --sync test.png -o box.pptx    --flow e_Box
```

**③ 三天 spike 决定要不要自研**

- Day 1：`pip install "px-image2pptx[ocr,inpaint]"` 跑通，看"文字可编辑 + 干净底图"基线
- Day 2：移植 `figedit/scripts/svg_to_pptx`，把简单图形变成原生形状
- Day 3：接 `image2editable` 的 `render_qa.py`，跑渲染回环

三天后你会知道：**你们团队能不能在 2 个月内做到商业 API 的水平**。这个答案比任何调研都值钱。

---

## 7. 矛盾与不确定性

| 项 | 状态 |
|---|---|
| ComPDF 效果 | **零公开验证**。所有参数、定价、错误码都可核实，唯独"转出来的 pptx 有多可编辑"没有任何第三方数据 → 必须自测 |
| ComPDF 低档位含不含 AI 版面分析 | **未确认**。Basic ¥0.02/文档 比 Pro ¥0.112 便宜 5.6 倍，大概率不含高级能力 → 签约前书面确认 |
| ComPDF Webhook 签名算法 | 官方文档过简，`comppdf_client.py` 里是骨架，**接入前必须与控制台示例对齐** |
| ComPDF 参数名 | 文档中文/英文只给含义，**表单元数据的确切 key 需用控制台/Postman 对齐一次**（脚本里按语义命名，已标注） |
| qwen3-vl-max / flash 单价 | 百炼当前价目表**未列**，不要引用 |
| "可编辑率"口径 | 各家都爱说"90% 可编辑"，但**分母是什么没人说清**。用 `audit_pptx.py` 的"非图片对象数"统一口径 |
| 学术基准与现实 | ReFigBench 最好 77.4/100、PPTBench 最好 67.80/100 —— **没有一个系统真正接近"完美"**，产品文案别承诺 95% |
| Agent 路线成本 | 基于公开 issue + 官方自述 + 我们的 token 单价推算，**非逐页实测**；不同 skill/模型组合波动 2–3 倍 |

---

## 8. 来源

**官方文档（一手）**
- ComPDF 请求模式：https://www.compdf.com/guides/api-reference/v2/request-workflow
- ComPDF 图片转 PPT：https://www.compdf.com/guides/api-reference/v2/image-to-ppt （中文版参数说明更全：`/zh-cn/...`）
- ComPDF 工具清单：https://www.compdf.com/guides/api-reference/v2/tool-list
- ComPDF 版面分析：https://www.compdf.com/guides/api-reference/v2/layout-analysis
- ComPDF 转换错误码：https://www.compdf.com/guides/api-reference/v2/errors_conversion
- ComPDF 安全/留存：https://www.compdf.com/guides/api-reference/v2/security
- ComPDF AI 计费：https://www.compdf.com/guides/api-reference/v2/ai/faq/billing
- ComPDF 定价：https://www.compdf.com/zh-cn/pricing （价格卡片从页面 HTML 抽取）

**技术数据**
- Images2Slides（WWW'26）元素回收率 0.989 / 文本区 IoU 0.364 / CER 0.033
- ReFigBench（arXiv 2609.18844）77.4/100、原生连接线被抹除
- PPTBench 67.80/100、中位 19.47
- GroundingME：Qwen3-VL-235B grounding 45.1%
- image2editable `route_execution.py:482`（baseline+noise 渲染回环）

**分线原始笔记**（本轮新增）
- `notes/E-llm-pipeline.md` — 572 行，字段级 schema、逐档成本计算
- `notes/F-agent-skill-service.md` — 534 行，命令片段、架构图、实测记录
- `notes/H-source-code-teardown.md` — 源码级拆解、21 项硬技术点、人日估算
- `notes/G-api-contracts.md` — 同类 API 契约横向（如有）
