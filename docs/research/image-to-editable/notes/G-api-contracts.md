# G · 图片 / PDF → 可编辑 PPTX：API 接口契约横向深挖

> 调研日期：2026-10-20 · 方法：逐家抓官方 API 文档原文（web_fetch/curl）+ 官方定价页 + GitHub 仓库活跃度 + **下载官方 sample .pptx 并用 python-pptx 拆包**
> 标注约定：`[已核]` = 官方页面原文；`[实测]` = 本机拆包/请求验证；`[推断]` = 由参数/行为反推，需实测确认；`[未核]` = 本轮未拿到原文，不要当结论用

---

## 0. 一页结论

**能"图片直出 .pptx"的只有 6 家**：ComPDF、Nutrient DWS、image2ppt、度慧、讯飞（体验版，禁商用）、WPS（OCR 通道，报价不公开）。
**只能"PDF→pptx"的 4 家**：Adobe、ConvertAPI（也有 jpg→pptx 但本质是 OCR 贴字）、CloudConvert（无 image→pptx）、TextIn。**Aspose.Slides 实际不接受图片输入**，不在候选内。

三个反直觉结论：

1. **"输出 .pptx" ≠ "原生可编辑"**。10 家里只有 image2ppt 公开了可下载 sample，我拆包后看到的是 **"整页底图 + 原生文本框/形状"的混合结构**（4 个样本中 3 个 z0 是一张全幅图片），并非纯矢量重建。这是目前唯一有实证的质量基线。
2. **最工程化的异步契约不是大厂，是 image2ppt**：Idempotency-Key + Standard Webhooks 签名 + 逐页账本 + 失败页退款，字段级文档最完整。ComPDF 次之（taskId + 6 个 webhook 事件 + 双错误码体系），Adobe 是"提交-轮询-下载"的老三样。
3. **按页单价差距 100 倍**：度慧 ≈¥0.017/次（一次最多 50 张图）、ComPDF ≈¥0.02/**文档**、TextIn ¥0.055–0.1/次、image2ppt ¥0.70–1.00/页、Nutrient ≈$0.08–0.135/页。便宜的都偏 OCR 路线，贵的是结构重建。

---

## 1. ComPDF Cloud（重点）

### 1.1 端点全景 `[已核]`

Base URL：`https://api-server.compdf.com/server/`（全球）｜`https://api-server.compdf.cn/server/`（中国大陆，**路径相同，只换域名**）

| 能力 | 方法与路径 | 说明 |
|---|---|---|
| **图片→PPTX** | `POST /v2/process/img/pptx` | 本次重点，单文件 |
| PDF→PPTX | `POST /v2/process/pdf/pptx` | 多 `pageRanges`、`pagePassword`、`separateFile` |
| 图片→其他 | `POST /v2/process/img/{docx,xlsx,csv,html,json,rtf,txt,pdf}` | 同一套图片参数 |
| PDF→其他 | `POST /v2/process/pdf/{docx,xlsx,csv,html,json,md,ofd,rtf,txt,image,...}` | |
| Office/图片→PDF | `POST /v2/process/{word,excel,ppt,txt,html,image,csv,rtf}/pdf` | |
| PDF 工具 | `/v2/process/pdf/{merge,split,compress,watermark,encrypt,decrypt,rotate,insert,delete,extract}` | |
| PDF 生成 | `/v2/process/pdf/generate` | 模板引擎 |
| **任务列表（轮询用）** | `GET /v2/task/list?page=1&size=10` | 返回 taskId/taskStatus/taskCost 等 |
| 任务关闭 | `/v2/task/close`（页面存在，字段未展开）`[未核]` | |

> 关键限制：图片端点 `04007 Only one file is allowed for this endpoint` —— **一次只能传 1 张图**，多图要循环调用再自行合并 pptx。PDF 端点才有 `pageRanges` / `separateFile`。

### 1.2 鉴权 `[已核]`

```
x-api-key: <项目 Public Key>        # 控制台 → API Key 页面获取
```
- 无 OAuth、无签名、无时间戳。Key 泄露即全失。
- 401 = Key 缺失/无效；403 = 权限不足（常见于跨区用错 key：`.com` 的 key 打 `.cn`）。

### 1.3 三种请求模式（官方对照表，原文翻译）`[已核]`

| 维度 | 同步 Sync | 异步 Async | 预签名 Pre-signed |
|---|---|---|---|
| 上传方式 | multipart 直传 ComPDF | multipart 直传 | 客户端 PUT 到对象存储，**文件不过业务 API** |
| 文件数 | 单文件（merge 除外） | 单/多文件 | 单/多文件 |
| 阻塞 | 是，处理完才返回 | 否，立即回 taskId | 否，回 taskId + 上传地址 |
| 取结果 | 响应里直接有 downloadUrl | 轮询 / Webhook | 轮询 / Webhook |
| 推荐大小 | **≤10 MB** | 10–50 MB | 大文件/批量/浏览器直传 |
| 服务端带宽 | 高（双向过网关） | 高（上传仍过网关） | 低（走对象存储 CDN） |
| 复杂度 | ★ | ★★ | ★★★（多一次签名） |

**预签名调用链**：① 请求上传地址（`data.fileName` 必填，用于生成对象存储 URL）→ ② 客户端 PUT/POST 上传（**有效期 15–30 分钟**）→ ③ 触发转换（拿 taskId）→ ④ 轮询/回调 → ⑤ 下载。
**异步调用链**：上传即得 taskId → **轮询间隔 ≥3 秒** → 或挂 Webhook。
**同步**：一次请求完成"上传+处理+返回"，官方建议单文件 ≤10MB 且处理 <60s。

> `[未核]` 异步/预签名的**具体开关字段**没有在抓到的页面里展开（页面是 tab 渲染，只抓到 sync 表单）。已确认的异步原语是 `taskId` + `GET /v2/task/list` + Webhook 事件。落地时先按 sync 接，异步开关向 console/商务确认。

### 1.4 请求参数（`POST /v2/process/img/pptx`）`[已核]`

Content-Type：`multipart/form-data`

| 参数 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `file` | File | 必填 | 源图片（png/jpg 等；错误码含 `02003 Unsupported image format`） |
| `language` | int | 1 | **报错信息语言**：1=英文，2=中文（不是 OCR 语言！） |
| `enableOcr` | 0/1 | 0 | 是否开 OCR。纯截图可关，扫描件必须开 |
| `ocrRecognitionLang` | string | — | OCR 语言码，见 `parameter-description#ocr-language-codes` |
| `ocrRecognitionScope` | enum | `ALL` | OCR 范围：`INVALID_CHARACTER`（乱码页）/`SCAN_PAGE`（扫描页）/`INVALID_CHARACTER_AND_SCAN_PAGE`/`ALL` |
| `enableAiLayout` | 0/1 | **1** | AI 版面分析。**这是"结构还原"的总开关**，关掉基本退化成贴图 |
| `preserveImages` | 0/1 | 1 | 保留原图里的图片元素 |
| `preserveAnnotations` | 0/1 | 1 | 保留批注 |
| `pageBackground` | 0/1 | 1 | 是否输出页面背景图；**仅 OCR 开启时生效**。想要"无底图纯矢量"要设 0 |
| `formulaToImage` | 0/1 | **0** | 公式转图片？0=保持可编辑（默认），1=转图 |
| `pageLayoutMode` | enum | `e_Flow` | `e_Flow`（流式）/`e_Box`（文本框定位） |

PDF→pptx 额外字段：`pagePassword`、`pageRanges`（如 `1-3,6`）、`separateFile`（每页单独出文件 0/1）。

**选型提示**：想要"尽量原生"→ `enableAiLayout=1, pageBackground=0, formulaToImage=0`；想要"视觉 1:1 保真"→ `pageBackground=1`（代价是整页底图，PPT 里改不动背景）。

### 1.5 响应结构 `[已核]`

```json
{"code":"200","msg":"success","data":{
  "fileKey":"...", "taskId":"...", "fileName":"...", "downFileName":"...",
  "fileUrl":"...", "downloadUrl":"https://download.compdf.com/...",
  "sourceType":"...", "targetType":"...", "fileSize":0, "convertSize":0,
  "convertTime":0, "status":"success", "failureCode":"", "failureReason":"",
  "fileParameter":"{...提交时的参数 JSON...}"
}}
```
- **HTTP 200 ≠ 业务成功**，必须判 `code == "200"`。
- `downloadUrl` 24 小时有效；官方另一处写"次日 24:00 删除"，按 24h 设计最稳。
- 简版示例还给了 `expireTime`（UTC）。

### 1.6 异步 / Webhook `[已核]`

轮询：`GET /v2/task/list`，状态枚举 `TaskStart / TaskWaiting / TaskProcessing / TaskFinish / TaskOverdue`；单条记录含 `taskFileNum / taskSuccessNum / taskFailNum / taskCost / callbackUrl / sourceType / targetType`。
Webhook 事件（在控制台配置，非 API 创建）：

| 事件 | 触发 |
|---|---|
| `task.start` | 任务创建成功 |
| `task.finish` | 任务内所有文件处理完（无论成败） |
| `task.overdue` | 等待超时（创建后 1 小时未执行） |
| `file.start` | 单文件上传成功 |
| `file.success` | 单文件处理成功 |
| `file.failed` | 单文件处理失败 |

> **签名**：抓取到的 webhook 页面只列事件，**没有 HMAC/签名算法**。导航里的 "Signatures" 是 PDF 数字签名功能，不是 webhook。落地建议：回调只当"敲门"，收到后用 `taskId` 回查 `task/list` 再落库（pull-back 校验），不要信任回调 body。

### 1.7 错误码（两套体系，必须都处理）`[已核]`

**框架层**（所有端点）：
| code | HTTP | 含义 |
|---|---|---|
| 01001/01002/01003/01004 | 500 | 内部错误/上传存储失败/上传错误/下载失败 |
| 01005/01006/01007 | 400 | 空文件/参数非法/任务 ID 为空 |
| 02001/02002/02003 | 400 | 格式错误/不支持/图片格式不支持 |
| 02201/02207 | 400 | 文件加密/打不开 |
| 02209 | 413 | 文件过大 |
| 03000 | 400 | 参数校验失败 |
| 04001/04002/04003 | 400 | fileKey 不存在/大小为 0/文件不存在 |
| 04007 | 400 | **该端点只允许 1 个文件** |
| 04008 | 400 | merge 最多 5 个文件 |
| 05001/05002/05003/05004/05005 | 404/409/400/410/400 | 任务不存在/状态异常/文件数达上限/任务过期/至少 1 文件 |
| **06001** | **402** | **配额用尽，需购买** |

**转换层**：
| code | errorCode | HTTP | 备注 |
|---|---|---|---|
| 100001 | INVALID_REQUEST | 400 | |
| 100101 | INVALID_FILE_TYPE | 415 | 不是 PDF（PDF 端点） |
| 100104 | FILE_TOO_LARGE | 413 | 超同步上限，改用异步 |
| 100105 | PAGE_LIMIT_EXCEEDED | 422 | 页数超限 |
| 120001/120002 | AUTH_REQUIRED/INVALID_TOKEN | 401/403 | |
| 130001 | NOT_FOUND | 404/410 | 结果已清理 |
| 130002 | JOB_NOT_READY | 409 | |
| 130003 | INVALID_STATE | 409 | 终态不可取消 |
| **130004** | **IDEMPOTENCY_IN_PROGRESS** | 409 | **说明服务端有幂等键机制**（键名未在页面给出） |
| 190001–190010 | CONVERT_FAILED / PDF_PASSWORD_ERROR / PDF_FORMAT_ERROR / PDF_SECURITY_ERROR / OCR_FAILURE / JOB_TIMEOUT / NO_TABLE / OUT_OF_MEMORY / FILE_ERROR / IMAGE_INVALID | 4xx/5xx | **可退避重试（≤3 次）** |
| 190999 | INTERNAL_ERROR | 500/503 | 可重试 |

**重试矩阵**：`190xxx` 与 `190999` 退避重试；`130001–130004` 视情况；`100xxx/120xxx/01xxx/02xxx/04xxx/06001` **不要重试**。

### 1.8 限制 `[已核]`

| 项 | 值 |
|---|---|
| 同步建议 | ≤10 MB，单文件，<60s |
| 单请求硬上限 | **默认 50 MB**，超限 413（企业版"文件大小不限"） |
| 多文件 | 图片端点 **1 个**；merge ≤5 |
| 下载链接 | 24 小时（另有"次日 24:00"说法） |
| OSS 留存 | **2 天**自动删除（官方 Security 页原文） |
| 任务等待超时 | 1 小时（`task.overdue`） |
| 页数上限 | 有 `100105`，**具体阈值未公开** |
| 下载次数 | 未见限制 |

### 1.9 定价 / 免费额度 `[已核，官网中文定价页]`

| 档 | 价格 | 文档量/月 |
|---|---|---|
| 免费 | ¥0 | **200 文档/月** |
| 入门 | **¥20/月**（年付 ¥240） | 1,000 |
| 热门 | **¥558.25/月**（年付 ¥6,699） | 5,000 |
| 高 | **¥999/月**（年付 ¥11,988） | 10,000 |
| 企业 | 定制 | 更多 + 不限文件大小 + 不限并行 + 分析面板 |

- **按"文档"计费，不按页**；图片算 1 文档 → 折算 ¥0.02/张（1,000 档）。10 页 PDF 摊到每页 ¥0.002。
- 私有化/SDK 报价：定价页写"简单用例低至 **$1,300**"；企业版需联系销售。
- AI 文档解析/抽取是**另一套按页计费**（每月赠 40 页），不要把 conversion 额度混进去。

### 1.10 SDK / 私有化 `[已核 GitHub + PyPI]`

| 类型 | 仓库/包 | 状态 |
|---|---|---|
| 云 API SDK（Python） | `compdfkit-api-python` 1.3.3（PyPI） | 有，但 1.3.x 老版本，未见 2026 更新 |
| 云 API SDK（PHP） | `compdfkit/compdfkit-api-php`（Packagist） | 有 |
| 转换 SDK（本地/自建） | `ComPDFKit/compdfkit-conversion-sdk-{python,nodejs,java,go,php,ruby,cpp,c}` | Apache-2.0，2★ 级别，最后 push 2026-07/08 |
| 自托管平台 | `ComPDFKit/compdf-self-hosted` | **MIT，147★，Docker Compose**，2026-09 仍活跃 |
| PDF SDK（端） | `compdfkit-pdf-sdk-{windows,android,ios,flutter,react-native,java,netcore}` | 80–140★，活跃 |
| 其他 | `compdf-generation` 362★、`compdf-skills`、`compdf-mcp` | 生态在铺 |

> 结论：**云 API 的官方 client 很弱**（Python 1.3.3 / PHP），生产建议直接写 HTTP（契约简单）；**私有化是这家真正的护城河**——MIT 自托管 + 商业 license 升级路径，官方 README 明写 "Upgrade to Enterprise"。

### 1.11 数据区域 / 合规 `[已核]`

- 双区域：`api-server.compdf.com`（全球） / `api-server.compdf.cn`（中国大陆）。**key 不通用**。
- 处理文件：任务结束立即删临时文件；原件/结果放 OSS，**2 天后自动删除**。
- 主体：PDF Technologies, Inc.（KDAN 生态），新加坡/台北/长沙团队。
- 官网页未见 SOC2/ISO 声明（`[未核]`，需向商务索取）。

### 1.12 集成代码

**同步（最小可用）**
```bash
curl -X POST "https://api-server.compdf.com/server/v2/process/img/pptx" \
  -H "x-api-key: $COMPDF_KEY" \
  -F "file=@slide.png" \
  -F "enableOcr=1" -F "ocrRecognitionLang=eng" \
  -F "enableAiLayout=1" -F "pageBackground=0" -F "formulaToImage=0" \
  -F "pageLayoutMode=e_Flow"
```

```python
import requests, time
def img2pptx(path, key):
    r = requests.post("https://api-server.compdf.com/server/v2/process/img/pptx",
        headers={"x-api-key": key},
        files={"file": open(path, "rb")},
        data={"enableOcr": "1", "ocrRecognitionLang": "eng",
              "enableAiLayout": "1", "pageBackground": "0",
              "formulaToImage": "0", "pageLayoutMode": "e_Flow"},
        timeout=180)
    j = r.json()
    if j.get("code") != "200":
        raise RuntimeError((j.get("code"), j.get("msg")))
    url = j["data"]["downloadUrl"]
    return requests.get(url, timeout=180).content
```

**异步轮询骨架**（开关字段待确认，轮询契约已确认）
```python
# 提交后拿 taskId，然后：
while True:
    t = requests.get("https://api-server.compdf.com/server/v2/task/list",
                     headers={"x-api-key": key}, params={"page":1,"size":20}).json()
    rec = next(x for x in t["records"] if x["taskId"] == task_id)
    if rec["taskStatus"] in ("TaskFinish","TaskOverdue"): break
    time.sleep(3)   # 官方建议 ≥3s
# 再按 taskId 查 asset 详情拿 downloadUrl，或直接用提交响应里的 downloadUrl
```

### 1.13 评价

- **优点**：参数最专业（AI 版面、背景图、公式、OCR 范围、流式/框式）；双区域；自托管真开源；价格按文档计费极便宜。
- **坑**：① 图片端点只能 1 文件，批量要自己并发+合并；② 云 SDK 落后；③ webhook 无签名；④ 异步开关字段文档不透明；⑤ 页数上限不公开。

---

## 2. Nutrient DWS Processor（原 PSPDFKit）

### 2.1 端点 `[已核]`

```
POST https://api.nutrient.io/build        # 统一 Processor 端点，动作由 instructions 决定
Authorization: Bearer <live|test key>
Content-Type: multipart/form-data
```
请求由「文件 part + `instructions` JSON」组成，图片→PPTX 的最小 instructions：

```json
{"parts":[{"file":"file"}],"output":{"type":"pptx"}}
```

多图合成一个 deck：`parts` 按顺序放多个 `{"file":"file1"},{"file":"file2"}`（官方 FAQ 明确支持"多图合成一个 PPTX，单次请求"）。

### 2.2 鉴权 `[已核]`

- `Authorization: Bearer <API key>`；控制台分 live / test key，可创建 **scoped key**（按产品限制）。
- Free plan 用 live key 输出**仍带 "For Evaluation Purposes Only" 水印**。

### 2.3 同步 / 异步 `[已核]`

- **同步**：一次 POST 直接返回文件二进制（`-o result.pptx`）。无 taskId、无轮询、无 webhook。
- 适合单张/少量图；大文件靠 HTTP 超时控制。

### 2.4 请求参数 `[已核]`

| 字段 | 必填 | 含义 |
|---|---|---|
| `file`（multipart part） | 是 | 图片（JPG/PNG/TIFF 等） |
| `instructions` | 是 | JSON 字符串，见上 |
| `parts[].file` | 是 | 引用 multipart 里的 part 名 |
| `output.type` | 是 | `pptx` / `docx` / `xlsx` |

> **没有** OCR 开关、语言、版面模式、背景图、公式等任何旋钮——官方把 image→Office 当一个黑盒动作。要调质量只能换输入（清晰度）或换 PDF→Office 路径。

### 2.5 响应 `[已核]`

- 成功：`200` + `Content-Type: application/vnd...presentationml.presentation` 的二进制。
- 失败：JSON 错误体（HTTP 4xx/5xx）。
- 无下载 URL、无过期时间（结果直接流回）。

### 2.6 限制 / 限流 `[已核]`

| 项 | 值 |
|---|---|
| 限流 | **100 请求/分钟/API key**（所有档位相同） |
| 文件大小 | 未在页面写死；免费/测试 key 有额外 size 限制 |
| 页数 | 未公开 |

### 2.7 计费 `[已核]`

- 图片→PPTX：**1.5 credits / 次**（JPG-to-PPTX 页面标注）。
- PDF→Office：1 credit。
- OCR：2 credits；HTML→PDF 0.5；数字签名 10。

| 档 | 月费 | credits/月 | 单价 |
|---|---|---|---|
| Free | $0 | **50** | PAYG $0.09/credit（带水印） |
| Starter | $75（年付 $67） | 1,000 | $0.09 |
| Growth | $275（年付 $247） | 5,000 | $0.066 |
| Pro | $445（年付 $399） | 10,000 | $0.0534 |
| Custom | 面谈 | 10,000+ | 量价 |

- 折算：1 张图 = 1.5 credits ≈ **$0.135（Free/Starter）/ $0.099（Growth）/ $0.080（Pro）**。
- Free plan 开 PAYG 需先充 **$25** 钱包；free 默认月上限 $50（最高 $500）。

### 2.8 SDK / 私有化 / 区域 `[已核]`

- 语言无关 REST + Postman collection；官方示例覆盖 JS/Python/Java/C#/PHP；无重语言 SDK 包袱。
- 私有化：**有**，on-premises / dedicated deployment（官方 FAQ）。
- 区域：**US + EU** 双区域；SOC 2 Type 2、HIPAA-eligible、GDPR；TLS。
- 支付：Paddle。

### 2.9 Sample output

- **无公开 sample .pptx 下载**。文档里的 "sample file" 指输入样例，不是输出。

### 2.10 代码

```bash
curl -X POST https://api.nutrient.io/build \
  -H "Authorization: Bearer $NUTRIENT_KEY" \
  -o result.pptx --fail \
  -F file=@document.jpg \
  -F 'instructions={"parts":[{"file":"file"}],"output":{"type":"pptx"}}'
```

```python
import requests, json
r = requests.post("https://api.nutrient.io/build",
    headers={"Authorization": f"Bearer {key}"},
    files={"file": open("slide.png","rb")},
    data={"instructions": json.dumps({"parts":[{"file":"file"}],"output":{"type":"pptx"}})},
    timeout=300)
r.raise_for_status(); open("out.pptx","wb").write(r.content)
```

### 2.11 "可编辑"官方措辞 `[已核]`

> "converts JPG images into editable PPTX presentations **using OCR to extract text and structure so the output can be edited in PowerPoint rather than embedded as a flat image**"

—— 明确对标"不是整页贴图"，但**没有承诺形状/表格是原生对象**。

---

## 3. Adobe PDF Services `exportpdf`（PDF→PPTX）

### 3.1 端点与流程 `[已核：官方 howto + 官方 Node SDK 4.1.0 源码]`

Base：`https://pdf-services.adobe.io`；认证：`https://ims-na1.adobelogin.com/ims/token/v3`

```
① POST /assets                     → {"uploadUri": "...", "assetID": "..."}
② PUT  <uploadUri>                 （不带 Authorization，直传 S3）
③ POST /operation/exportpdf        body: {"assetID":"...","targetFormat":"pptx","ocrLang":"en-US"}
                                   → 201 + Location: .../operation/exportpdf/<jobId>/status
④ GET  .../status                  → {"status":"in progress"|"done"|"failed", ...}
⑤ GET  .../output                  → 302/200 预签名下载
```
- 官方 SDK 常量：`OperationHeaderInfoEndpointMap.EXPORT_PDF = ("Export PDF Operation", "exportpdf")`，请求 URI 模板 `pdfServicesUri + "/operation/"` → 证实 `/operation/exportpdf`。
- `targetFormat` 枚举（SDK 源码）：`doc | docx | pptx | rtf | xlsx`；另 `exportpdftoimages` 支持 `jpeg/png`。
- **OCR 参数名是 `ocrLocale`（SDK 层）/ `ocrLang`（payload 层）**，不是 `ocrLanguage`。

### 3.2 鉴权 `[已核]`

- OAuth 2.0 **Server-to-Server（client credentials）**：Adobe Developer Console 建项目 → 拿 Client ID / Client Secret。
- 请求头：`x-api-key: <Client ID>` + `Authorization: Bearer <access_token>`。
- JWT（Service Account）方式已废弃；官方 SDK 只支持 `ServicePrincipalCredentials`。
- SDK 明确"仅限服务端"，凭证不得下发客户端。

### 3.3 同步/异步 `[已核]`

- **异步作业模型**：提交返回 job location，轮询 status，再取 output。SDK 内部封装轮询（`PDFServicesHelper.pollForStatus`）。
- 无 webhook（官方 SDK 无回调参数）。

### 3.4 输入限制 `[已核 + 常识]`

- **只接受 PDF**。图片必须先 `POST /operation/createpdf`（支持 jpg/png/bmp/gif/tiff）转成 PDF，再 exportpdf。**没有图片直转 pptx 的端点**。
- 免费额度：**500 Document Transactions/月**（"Free Tier: 500 free Document Transactions per month"，无需信用卡）。
- 区域：**US（默认）/ EU** 可配置（`ClientConfig.region`）。
- 付费：按量报价，联系销售（无公开单价）。

### 3.5 SDK `[已核]`

Java / .NET / Node.js / Python 官方 SDK（`@adobe/pdfservices-node-sdk` 4.1.0 等），加 REST 直调。样例仓库：`adobe/pdfservices-*-sdk`（本轮 raw.githubusercontent 访问 404，`[未核]` 仓库当前可见性）。

### 3.6 质量与 sample

- 官方只承诺"export a source PDF into pptx"，**未描述对象级还原**。Adobe 的 PDF→PPT 历来是"文本框 + 图片"路线，表格常退化为文本框/图片 `[推断]`。
- **无官方 sample .pptx 下载**。

### 3.7 代码（REST 全链路）

```python
import requests, time
TOKEN_URL="https://ims-na1.adobelogin.com/ims/token/v3"
tok = requests.post(TOKEN_URL, data={
    "client_id": CID, "client_secret": SECRET,
    "grant_type":"client_credentials",
    "scope":"openid,AdobeID,read_organizations"}).json()["access_token"]
H={"x-api-key":CID,"Authorization":f"Bearer {tok}"}

a = requests.post("https://pdf-services.adobe.io/assets", headers={**H,"Content-Type":"application/json"},
                  json={"mediaType":"application/pdf"}).json()
requests.put(a["uploadUri"], data=open("in.pdf","rb").read(),
             headers={"Content-Type":"application/pdf"})

job = requests.post("https://pdf-services.adobe.io/operation/exportpdf",
                    headers={**H,"Content-Type":"application/json"},
                    json={"assetID":a["assetID"],"targetFormat":"pptx","ocrLang":"en-US"})
loc = job.headers["Location"]
while True:
    s = requests.get(loc, headers=H).json()
    if s["status"] in ("done","failed"): break
    time.sleep(2)
out = requests.get(loc.replace("/status","/output"), headers=H, allow_redirects=True)
open("out.pptx","wb").write(out.content)
```
> `[未核]` 第 5 步 output 路径是按 SDK 行为写的（`/status` ↔ `/output`），上线前用一次真实 job 验证。

---

## 4. Aspose.Slides Cloud / 自建

### 4.1 结论：**不做 image→slides**

- 官方 Supported File Formats 的 load 列只有 PPT/POT/PPS/PPTX/POTX/PPSX/PPTM/PPSM/POTM/ODP/OTP 等**演示文稿格式**；图片只出现在 **save** 列（JPEG/PNG/GIF/BMP/SVG/TIFF）。
- 转换端点 `PUT /v3.0/slides/convert/{format}` 的输入是 presentation；图片只能通过 `AddPicture` 之类接口**贴到已有 slide** 上，不会 OCR/重建版面。
- Aspose 站内的 "JPG to Powerpoint" 在线工具是"一图一页"的贴图器，不是结构还原。
- **判定：不满足"图片→可编辑 PPTX"需求，直接排除。**

### 4.2 端点/鉴权（供参考）`[已核文档目录]`

- Base：`https://api.aspose.cloud/v3.0/slides/`
- 鉴权：OAuth2 client credentials（`https://api.aspose.cloud/connect/token`），App SID + App Key。
- SDK：.NET/Java/PHP/Android/Python/Ruby/Node.js/C++/Perl/Swift/Go（全家桶）。
- 自建：Aspose.Slides for .NET/Java 本地库，可离线跑。

### 4.3 价格 `[部分已核]`

- 自建买断（官方 pricing 页，.NET）：**Developer Small Business US$999**（1 开发者 + 1 部署点）；**Developer OEM US$2,997**（不限部署点）；另有 Site 档（页面未展开）。Metered 按调用计费。
- Cloud：订阅 + 调用额度，免费额度存在；**具体月费在 `purchase.aspose.cloud` 登录后可见，本轮未取到静态价** `[未核]`。

---

## 5. ConvertAPI

### 5.1 端点 `[已核]`

```
POST https://v2.convertapi.com/convert/{from}/to/{to}?Secret=<API_SECRET>
# 例：/convert/pdf/to/pptx 、/convert/jpg/to/pptx
Content-Type: multipart/form-data   字段 File=@x.pdf
```
- 同步返回文件字节（`StoreFile=false` 默认，**纯内存，不落盘**）。
- `StoreFile=true` 时写临时存储，返回限时 URL（**3 小时**）。

### 5.2 鉴权 `[已核]`

- `Secret` 走 **query 参数**（也支持 `Authorization: Bearer`）。无签名、无过期。

### 5.3 参数 `[已核]`

**PDF→PPTX**：`File`、`PageRange`（默认 1-2000）、`Password`、`OcrMode`（auto/force/never）、`OcrLanguage`（28 种）、`OcrEngine`（native/tesseract）、`EmbedFonts`、`TextRecoveryMode`、`StoreFile`。
**JPG→PPTX**：`File`、`MarginHorizontal`/`MarginVertical`（0–500mm）、`PageSize`（a0–a10/letter/legal/default）、`PageOrientation`、`EnableOcr`、`OcrLanguage`、`StoreFile`。

> **质量信号**：jpg→pptx 的旋钮只有"页边距/纸张/方向 + OCR"，说明实现是**"图片铺满 slide + OCR 文字层"**，没有版面结构参数→ 属 L1（文字层），不要期待形状重建。

### 5.4 异步 `[已核]`

- 支持 Async conversions（付费档特性）；异步时返回 JobId，轮询 `/job/{id}`。无 webhook 签名机制文档。

### 5.5 限流/限制 `[已核]`

| 档 | 并发 | 单文件 |
|---|---|---|
| Developer | 1 | 200 MB |
| Startup | 2 | 300 MB |
| Growth | 3 | 500 MB |
| Business | 4 | 1 GB |
| Enterprise | 不限 | 2 GB |

### 5.6 价格 `[部分已核]`

- 官方定价页动态渲染，静态只拿到"档位 + 包含转换次数"：Developer 12,000 / Startup 60,000 / Growth 180,000 / Business 600,000 / Enterprise 1.2M+。
- 第三方汇总（marketgenius）：**$35 / $95 / $175 / 月**（Developer/Startup/Growth）`[未核官方]`。
- 免费：注册送 **250 conversions**（一次性，非每月）。
- 合规：ISO 27001、HIPAA、GDPR；可签 DPA/NDA/BAA；企业可"数据不出境"。

---

## 6. CloudConvert

### 6.1 端点 `[已核]`

```
POST https://api.cloudconvert.com/v2/jobs
Authorization: Bearer <API_KEY>
```
Job = 任务图，典型三段：

```json
{"tasks":{
  "import-1":{"operation":"import/url","url":"https://.../x.pdf"},
  "convert-1":{"operation":"convert","input":"import-1","input_format":"pdf","output_format":"pptx"},
  "export-1":{"operation":"export/url","input":"convert-1"}
}}
```
- 也支持 `import/upload`（先建 upload task 拿 upload URL，PUT 上传）。
- 结果：`export-1.result.files[0].url`，**文件默认只保留 24 小时**（`expires` 字段）。

### 6.2 同步/异步 `[已核]`

- **异步作业**：创建 job 即返回 `wait` URL / job id；轮询 `GET /v2/jobs/{id}`，或 `?wait=true` 阻塞。
- 支持 **Webhook**（job 级 `webhook_url`），无签名算法文档（CloudConvert 用"签名 URL"式回调，需自查）。

### 6.3 能力边界 `[已核]`

- **PDF → PPTX：支持**，官方承诺 "preserve layouts, formatting, graphs and tables... actual usable, clean PowerPoint"。
- **JPG/PNG → PPTX：不支持**（`cloudconvert.com/jpg-to-pptx` 返回 404；pptx 输出仅来自文档类输入）。图片只能先 image→pdf 再 pdf→pptx（两步，两次计费）。

### 6.4 价格 `[已核]`

| 档 | 价格 | credits |
|---|---|---|
| Free | $0 | **10/天**（1GB、5 分钟、5 并发） |
| Package | **$17 / 1,000**（$0.017/credit，永不过期） | |
| Subscription | **$9/月 / 1,000**（$0.009/credit） | |
| Enterprise | 定制 | |

- **PDF→Office 基础消耗 4 credits** → 约 **$0.068（package）/ $0.036（订阅）每次**；超 1 分钟按分钟加收。
- 只对成功转换计费。

---

## 7. TextIn（合合信息）PDF 转 PPT

### 7.1 端点 `[已核]`

```
POST https://api.textin.com/ai/service/v1/file-convert/pdf-to-ppt
```

### 7.2 鉴权 `[已核]`

```
x-ti-app-id: <工作台-账号设置-开发者信息>
x-ti-secret-code: <...>
```
- 另有 timestamp + signature 模式（apifox 文档），标准调用用双 header 即可。
- 支持 **IP 白名单**（错误码 40103）。

### 7.3 同步 / 异步 `[已核]`

- **同步**：响应体直接给 `result` = **转换后文件的 base64**。无 taskId、无轮询、无回调。
- 50MB 以内同步可接受；大文件需自行分片/拆页。

### 7.4 请求体 `[已核]`

两种二选一：
1. `Content-Type: application/octet-stream`：**裸二进制流**（不是 FormData！）
2. `Content-Type: text/plain`：body 是在线文件 URL（http/https）

限制：文件 ≤**50MB**；图像宽高 20–10000 px。

### 7.5 响应 `[已核]`

```json
{"code":200,"message":"success","result":"<base64 of pptx>","x_request_id":"..."}
```
- `result` 对"转图片"类是 zip 的 base64；pdf→ppt 直接是 pptx base64。
- 错误码：40101/40102/40103（凭证/白名单）、40003（余额不足）、40004（参数）、40007/40008（机器人未开通）、40301/40302/40303/40304/40305（文件类型/大小/尺寸/未上传）、**40306（QPS 超限，禁止重试，持续请求会触发 IP 流控）**、40400（链接无效）、30203/500。

### 7.6 限流 / 价格 `[已核]`

- QPS：免费档 **1 QPS**；超出报 40306，扩容找商务。
- 价格（云市场）：**¥0.1/次** 标价；**1,000 次 ¥55（¥0.055/次）**；新客 **50 次免费（1 年有效）**。
- 计费单位是"次"，不是页——一次可传多页 PDF，**单价极低**。

### 7.7 SDK / 私有化 / 区域

- SDK：官方多语言 demo；私有化：**支持**（TextIn 主打私有化/一体机）。
- 区域：中国大陆（上海合合信息）。

### 7.8 质量与 sample

- 官方只承诺"PDF转PPT"，**没有任何可编辑层次的措辞**，也**无 sample 输出**。`[推断]` 为文本+图片混合，表格能力弱于其 xParse。

---

## 8. 讯飞开放平台 · 图片文档还原

### 8.1 接入方式：**WebSocket**（不是 REST）`[已核]`

```
wss://ws-api.xfyun.cn/v1/private/ma008db16
GET /v1/private/ma008db16 HTTP/1.1
```
- 鉴权：**HMAC-SHA256 签名挂在 query**：`?host=...&date=<RFC1123>&authorization=<base64>`
  - `signature_origin = "host: $host\ndate: $date\nGET /v1/private/ma008db16 HTTP/1.1"`
  - `signature = base64(hmac_sha256(signature_origin, APISecret))`
  - `authorization_origin = api_key="...", algorithm="hmac-sha256", headers="host date request-line", signature="..."`
  - `authorization = base64(authorization_origin)`
  - 时钟偏移容忍 **300 秒**。
- 传输：JSON 帧，`header.status` 0 开始 / 1 继续 / 2 结束；图片 base64 放 `payload.test.image`。

### 8.2 参数 `[已核]`

| 参数 | 含义 |
|---|---|
| `header.app_id` | 应用 appid |
| `header.status` | 0/1/2 分帧 |
| `parameter.s15282f39.category` | `ch_en_public_cloud`（中英） |
| `parameter.s5eac762f.result_type` | **`0`=excel，`1`=doc，`2`=ppt** |
| `payload.test.encoding` | jpg/jpeg/png/bmp |
| `payload.test.image` | base64，≤10MB |
| `payload.test.status` | 3=一次性传完 |

### 8.3 响应 `[已核]`

`payload.result.text` = **结果文件的 base64**（PPTX），需 decode 后写文件。`header.code=0` 为成功。

### 8.4 限制与商用 `[已核 · 关键]`

> 官方原文："该产品目前为**体验版**，对于无线、少线表格的识别效果稍弱，**仅供免费试用，暂不商用**。"

- 图片 ≤10MB（base64 后），jpg/jpeg/png/bmp，仅中英文。
- **不可商用** → 只能做 POC/对比基线，不能进生产。这是硬否决项。

### 8.5 Sample

- 无 sample 输出；官方只有 demo 代码（Java/Python）。

---

## 9. 度慧 img2doc（百度云市场 / 阿里云市场）

### 9.1 端点 `[已核 · 百度 API 商城商品页]`

```
POST http://img2doc.api.bdymkt.com/v1/convert      # 多图转换
GET  .../v1/convert                                # 单图转换（另一 tab）
Content-Type: application/json;charset=UTF-8
```
- 鉴权：**百度 BCE 签名**（access key + secret key + `AppSigner`），不是简单 token。
- 异步：返回 `{"code":10000,"result":{"token":"..."}}` → 用 token 查结果；或传 `callbackurl` 回调。

### 9.2 参数 `[已核]`

| 参数 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `url` | array | 是 | 图片 URL 数组（**多图单次最多 50 张**） |
| `type` | string | 是 | 目标格式：`docx` / **`pptx`** / `xlsx` / `txt` / `ofd` / `md` |
| `clean` | 0/1 | 否 | 清除图像背景只留文字（默认 0） |
| `language` | int | 否 | 1 英/2 简中/3 繁中/4 法/5 德/6 意/7 俄/8 日/9 韩/10 西/11 葡/12 丹/13 荷/14 芬/15 挪/16 瑞典（默认 2） |
| `outfilename` | string | 否 | 输出文件名，默认随机 |
| `callbackurl` | string | 否 | 回调 URL（需 URL encode） |
| `a4` | 0/1 | 否 | 输出 A4 尺寸（默认 0） |

- Base64 输入上限 **8MB**；支持 OSS 内网下载。

### 9.3 响应 `[已核]`

```json
{"code":10000,"msg":"","result":{"token":"3345822c..."}}
```
错误：40000 通用 / 40001 参数 / 40002 参数不规范。**结果文件地址需用 token 再查**（查询接口字段商品页未展开 `[未核]`）。

### 9.4 价格 `[已核]`

| 次数 | 价格 | 单价 |
|---|---|---|
| 50（首购） | **¥0** | 0 |
| 6,000 | ¥100 | ¥0.0167 |
| 30,000 | ¥300 | ¥0.010 |
| 60,000 | ¥500 | ¥0.0083 |
| 200,000 | ¥1,000 | ¥0.005 |
| 500,000 | ¥2,000 | ¥0.004 |
| 1,000,000 | ¥3,000 | **¥0.003** |

- **按次不按页**，一次最多 50 张图 → 理论最低 ¥0.00006/图。全场最便宜。
- 速度：官方"10 页 1080p 平均 15 秒"。
- 质量定位：官方措辞"版式**尽量**还原 / 文字可编辑 / 表格识别 / 切边矫正"→ L1–L2，不是结构级。

### 9.5 SDK / 私有化 / 区域

- SDK：商城给 Java/Python/Go/cURL/PHP/Node 示例（都是 BCE 签名封装）。
- 私有化：`[未核]`，需问服务商（上海度慧科技）。
- 区域：中国大陆（百度云市场）。

---

## 10. WPS 开放平台（WebOffice）

### 10.1 能力 `[已核 · 官方支持格式页]`

官方"在线格式转换 → OCR 文字识别"明确列：

> - PDF 识别转换 **Word、Excel、PPT、JSON、Table**
> - **图片识别转换 Word、Excel、PPT、JSON、Table**
> - 提醒：PDF/图片转其它格式走 OCR，**按页计费**；与"在线文档格式转换（按次计费）"是两套计费。

### 10.2 端点与参数 `[未核 · 公开文档未展开]`

- 文档中心（`365.kdocs.cn/3rd/open/.../convert/format`）只给能力矩阵，**具体 endpoint / header / 参数在登录后的 API 文档里**，公开页抓不到。
- 已知形态（来自生态文章，非官方原文）：RESTful + 异步任务队列返回 taskId；单图 ≤50MB、PDF ≤100MB `[未核]`。
- 鉴权：WPS 开放平台 AppID + SecretKey 签名（服务商入驻后发放）。

### 10.3 价格 / 免费 `[部分已核]`

- OCR **按页计费**，**单价不公开，需联系商务**。
- 调试模式每日 **50 次**免费（LEAD 已核）。
- 无公开 sample。

### 10.4 判定

- 国内合规最好（发票、等保、WPS 生态），但**报价不透明 + 契约不公开**，不适合"先写代码再谈价"的场景。适合已确定走 WPS 365 体系的企业。

---

## 11. image2ppt.com

> 本轮契约最完整的一家，且**唯一提供可下载 sample .pptx**。

### 11.1 端点 `[已核 · /docs/api]`

Base：`https://image2ppt.com`

| # | 端点 | 用途 |
|---|---|---|
| 1 | `POST /api/v1/jobs` | 提交（multipart 上传 或 JSON URL 列表） |
| 2 | `GET /api/v1/jobs/{jobId}` | 轮询状态 / 逐页结果 / 回调状态 |
| 3 | `POST /api/v1/jobs/{jobId}/cancel` | 优雅取消（202 finalizing） |
| 4 | `GET /api/v1/jobs/{jobId}/download` | 下 PPTX（二进制） |
| 5 | `GET /api/v1/account` | 余额 |
| 6 | `GET /api/v1/jobs?createdFrom&createdTo&limit&cursor` | 对账/列表 |

### 11.2 鉴权 `[已核]`

```
Authorization: Bearer i2p_live_xxxxxxxx
```
- key 只在创建时完整显示一次；401 `INVALID_API_KEY`；**禁止放浏览器**。

### 11.3 同步/异步 `[已核]`

- **纯异步**：提交即回 `jobId`（201），不阻塞。
- 轮询建议：**从 5s 起，退避到 ~15s**；单页约 2 分钟，90% 任务 3 分钟内完成。
- Webhook：提交时带 `callbackUrl`。

### 11.4 请求参数（multipart）`[已核]`

| 字段 | 必填 | 含义 |
|---|---|---|
| `files` | 是 | 多个文件，png/jpeg/webp/gif/pdf；单文件 ≤35MB、合计 ≤90MB；重复字段名传多文件 |
| `locale` | 否 | `zh-CN`（默认）/ `en` |
| `aspectRatio` | 否 | `auto`（默认，跟源）/ `16:9` / `4:3` |
| `pages` | 否 | 选页，如 `1-3,7`；1-based，最多 1000 字符；重复/重叠自动合并 |
| `callbackUrl` | 否 | https、≤2048 字符、必须公网地址 |
| Header `Idempotency-Key` | 否 | 1–255 个可打印 ASCII；账号级；24h 生命周期 |

**双限**：总页数 ≤**50**；总字节 ≤**90MB**（两条件独立，40 张高清图可能页数够但体积超）。
**URL 提交**：`{"urls":[...1–50 条...], "locale", "aspectRatio", "pages", "callbackUrl"}`，JSON ≤64KB，必须 https、≤2048 字符、禁私网/回环/云元数据；每 URL 60s、整请求 120s、并发下载 4；**账号同时只能有 1 个 URL 提交**。

### 11.5 响应 `[已核]`

提交 201：
```json
{"jobId":"3f2b8c1e-...","status":"pending","slideCount":12,"creditsReserved":12}
```
状态：
```json
{"jobId":"...","status":"processing","progress":45,"slideCount":12,
 "creditsUsed":0,"creditsRefunded":0,"cancellationRequested":false,
 "createdAt":"2026-07-07 08:00:00","completedAt":null,
 "downloadUrl":"/api/v1/jobs/{id}/download",
 "pageResults":[{"pageNumber":1,"status":"converted"}],
 "callback":{"url":"...","status":"pending","attempts":1,"nextAttemptAt":"..."}}
```
- `status`：pending / processing / completed / failed（**没有 cancelled**）。
- `pageResults[]`：`converted` / `failed`，失败带 `error.code` ∈ `CONVERSION_FAILED|CONVERSION_TIMEOUT|PAGE_NOT_ATTEMPTED` + `retryable`。
- 下载 409 NOT_READY / 410 OUTPUT_EXPIRED / 416。

### 11.6 Webhook 签名（**本轮唯一给出完整算法的**）`[已核]`

- 遵循 **Standard Webhooks**。
- Header：`webhook-id`（`msg_...`，重试不变，用于去重）、`webhook-timestamp`（Unix 秒）、`webhook-signature`（`v1,<base64>`，轮换期两个空格分隔）。
- 验签：
  1. `|now - timestamp| > 300s` → 拒；
  2. secret 去掉 `whsec_` 前缀后 **base64 decode** 得 HMAC key；
  3. 签名内容 = `{webhook-id}.{webhook-timestamp}.{raw body}`，HMAC-SHA256 后 base64；
  4. 常量时间比较任一 `v1,` 值；**必须对原始字节计算，不能 JSON 反序列化再序列化**。
- 重试：6 次（立即、1m、5m、30m、2h、6h）；2xx 且 10s 内算成功；`webhook-id` 去重。
- secret 轮换：24 小时内新旧双签。

### 11.7 幂等 `[已核]`

| 情形 | 结果 |
|---|---|
| 同 key 同请求，原 job 还在 | 201 + 同 body + `Idempotent-Replayed: true`，不重复扣 |
| 同 key 不同请求 | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| 同 key 上一请求处理中 | 409 `IDEMPOTENCY_KEY_IN_PROGRESS` + `Retry-After: 2` |
| 上次请求失败（4xx/5xx） | 不占用 key，可重试 |
| 原 job 被网页删除 | key 释放，当新提交 |

### 11.8 限流 `[已核]`

- 并发 in-flight job ≤ **10**；提交速率 ≤ **60 页/分钟**；URL 提交同时 1 个。
- 超限 429 + `Retry-After`；**轮询不限额**。

### 11.9 计费 / 免费 `[已核]`

- **1 页 = 1 credit**；提交时冻结（`creditsReserved`），完成结算；**失败页自动退**。
- 包：30 页 ¥29.90 / $5.99；80 页 ¥59.90 / $11.49；200 页 ¥139.90 / $24.99；**credits 长期有效**。
- 免费：注册赠点，**7 天有效**（有付费/兑换后不过期）。
- 支付：Paddle（MoR），支付宝/微信/淘宝兑换码。
- 留存：结果 **7 天**，之后 410。

### 11.10 SDK / 区域 `[已核]`

- 官方 Python `pip install image2ppt`、Node `npm i image2ppt`（0.2.0+，GitHub `image2ppt/image2ppt-sdk`）；`submit_all()/convert_all()` 自动按 35MB/50 页拆分。
- 区域：**新加坡**（官方定价页原文 "Stored on our servers in Singapore"），加密传输；不用于训练。
- 私有化：无。

### 11.11 代码

```python
from image2ppt import Image2PPTClient, JobFailedError
c = Image2PPTClient(api_key="i2p_live_xxx")
job = c.convert(["s1.png","s2.png","report.pdf"], dest_path="out.pptx",
                locale="zh-CN", aspect_ratio="16:9")
print(job.credits_used, job.credits_refunded)
```

```bash
curl -X POST https://image2ppt.com/api/v1/jobs \
 -H "Authorization: Bearer $I2P" -H "Idempotency-Key: $(uuidgen)" \
 -F files=@s1.png -F files=@s2.png -F locale=zh-CN -F aspectRatio=16:9 \
 -F callbackUrl=https://example.com/hook
```

---

## 12. 总对比表（10 家）

| # | 产品 | 图片→PPTX 端点 | 鉴权 | 同步/异步 | 公开价 | 真·原生可编辑 | 数据地区 | 免费额度 | SDK | 私有化 | Sample PPTX |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **ComPDF Cloud** | `POST /server/v2/process/img/pptx` | `x-api-key` | 同步 / 异步 / 预签名 | ¥20/1k 文档/月（≈¥0.02/张） | 参数支持，**未验证**（L2 预期） | .com 全球 / .cn 大陆 | 200 文档/月 | 弱（Py 1.3.3 / PHP） | ✅ MIT 自托管 | ❌ |
| 2 | **Nutrient DWS** | `POST api.nutrient.io/build` | Bearer | 同步 | $75/1k credits；1.5 cr/张 ≈$0.08–0.135 | 官方称"extract text and structure"，L2 预期 | US / EU | 50 credits/月（水印） | REST+Postman | ✅ on-prem | ❌ |
| 3 | **Adobe PDF Services** | ❌ 仅 `exportpdf`（PDF 入） | OAuth S2S + x-api-key | 异步 job | 无公开单价（按量） | PDF 转出，L2 预期 | US（默认）/ EU | **500 transactions/月** | Java/.NET/Node/Py | ✅（企业） | ❌ |
| 4 | **Aspose.Slides Cloud** | ❌ 不支持图片入 | OAuth2 | 同步 | 云：订阅（未取到）；自建 **$999 起** | N/A | 云多区 / 自建本地 | 有免费额度 | 12 语言 | ✅ 买断 | ❌ |
| 5 | **ConvertAPI** | `/convert/jpg/to/pptx` | query `Secret` | 同步 + 异步 JobId | ~$35/12k 次（第三方）`[未核]` | **L1**（只有边距/纸张/OCR 旋钮） | 可选"数据不出境" | 250 次 | 多语言 | ✅ 私有服务器档 | ❌ |
| 6 | **CloudConvert** | ❌ 无 jpg→pptx（404） | Bearer | 异步 job | $17/1k cr；PDF→Office 4 cr ≈$0.036–0.068 | PDF 转出，官方称保 layout/table | 多区 | 10 credits/天 | 多语言 | ❌ | ❌ |
| 7 | **TextIn** | ❌ 仅 `pdf-to-ppt` | `x-ti-app-id` + `x-ti-secret-code` | **同步 base64** | ¥0.055–0.1/次 | 未声明 | 中国大陆 | 50 次（1 年） | demo 级 | ✅ | ❌ |
| 8 | **讯飞 图片文档还原** | `wss://ws-api.xfyun.cn/v1/private/ma008db16` | HMAC-SHA256 query 签名 | WebSocket 流式 | **免费（体验版）** | 官方称"保留内容格式"，未验证 | 中国大陆 | 免费试用 | demo | ❌ | ❌ |
| 9 | **度慧 img2doc** | `POST img2doc.api.bdymkt.com/v1/convert` | 百度 BCE 签名 | 异步 token + 回调 | **¥0.003–0.017/次**（≤50 图） | L1–L2（"尽量还原"） | 中国大陆 | 50 次 ¥0 | 示例代码 | `[未核]` | ❌ |
| 10 | **WPS 开放平台** | 未公开（OCR 通道） | AppID+Secret 签名 | 异步任务 | 按页，**不公开** | 预计 L1（OCR） | 中国大陆 | 调试 50 次/天 | 有 | ✅ 私有化 | ❌ |
| 11 | **image2ppt** | `POST /api/v1/jobs` | Bearer `i2p_live_` | **纯异步 + Webhook** | ¥0.70–1.00/页 | **L2 实证**（原生文本/形状 + 底图） | **新加坡** | 注册赠点（7 天） | Py + Node 官方 | ❌ | ✅ **4 个直链** |

> "真·原生可编辑"分级：**L1** 整页图 + 文本框；**L2** 原生文本/形状 + 部分底图；**L3** 全矢量（无整页底图、表格为原生 table）。目前**没有任何一家公开承诺 L3**，image2ppt 的 sample 是唯一可验证的 L2 证据。

---

## 13. 异步模型差异表（最有价值的一张）

| 维度 | ComPDF | Nutrient | Adobe | image2ppt | 度慧 | TextIn | CloudConvert | ConvertAPI | 讯飞 | WPS |
|---|---|---|---|---|---|---|---|---|---|---|
| 上传方式 | multipart 直传 / **预签名 PUT 到 OSS** | multipart 直传 | **POST /assets 换 uploadUri → PUT S3** | multipart 或 **URL 拉取** | URL 数组 / base64 | **裸二进制** 或 URL 文本 | import/upload 或 import/url | multipart | WebSocket 帧内 base64 | 未公开 |
| 任务模型 | taskId + task/list 轮询 + 6 webhook | 无任务（同步流回） | job Location + status 轮询 | jobId + 轮询 + webhook | token 查询 + callbackurl | 无任务（同步） | job + 轮询 + webhook | JobId 轮询 | 长连接分帧 status 0/1/2 | 任务队列 |
| 轮询建议 | ≥3s | — | SDK 内置（~2s） | 5s → 15s 退避 | 未公开 | — | 未公开 | 未公开 | — | 未公开 |
| 回调签名 | **未文档化**（建议回查） | — | 无回调 | **Standard Webhooks：HMAC-SHA256(base64(secret)) over `id.ts.body`，300s 容忍，6 次重试，双签轮换** | 未公开 | — | 无签名文档 | 无 | — | 未公开 |
| 幂等 | 有 `130004 IDEMPOTENCY_IN_PROGRESS`（键名未公开） | — | 无（assetID 天然唯一） | **Idempotency-Key：24h、账号级、同 key 异体 422、处理中 409** | 无 | 无 | 无 | 无 | 无 | 未公开 |
| 结果交付 | downloadUrl（24h）+ OSS 2 天 | 响应二进制 | output 预签名 | download 端点（**7 天**） | 结果地址（token 查） | **base64 in JSON** | export/url（24h） | 二进制或 3h URL | base64 in WS 帧 | 未公开 |
| 部分失败 | file.failed 事件 + taskFailNum | 整体失败 | job failed | **pageResults 逐页 + 自动退点** | 未公开 | 整体 | 整体 | 整体 | 整体 | 未公开 |
| 限流 | 未公开（企业版不限并行） | 100 req/min | 未公开 | 10 并发 job / 60 页/分 | 未公开 | 1 QPS（免费） | 5 并发（免费） | 1–4 并发 | 未公开 | 未公开 |

**工程含义**：
- 只有 **image2ppt** 和 **Adobe** 把"上传"和"执行"拆成两个独立步骤（预签名/assetID），天然适合大文件+断点续传；ComPDF 的预签名是第三种形态（先要 fileName 换 URL）。
- 只有 **image2ppt** 的 webhook 能安全验签；ComPDF/CloudConvert/度慧 的回调都应"只当敲门，回查为准"。
- 只有 **image2ppt** 和 **ComPDF** 有幂等语义；其余重试要自己做去重表（按 file hash + 时间窗）。

---

## 14. "可编辑"到底做到哪一层

### 14.1 官方措辞对照 `[已核]`

| 厂商 | 原文 | 解读 |
|---|---|---|
| ComPDF | "Convert image content to **editable Slides (PPTX)**" + `enableAiLayout`/`pageBackground`/`formulaToImage` | 有版面分析开关，**最可能做到形状级**，但无实证 |
| Nutrient | "using OCR to extract text **and structure** so the output can be edited in PowerPoint **rather than embedded as a flat image**" | 明确否认"整页贴图"，未承诺形状/表格原生 |
| Adobe | "Export a source PDF file into ... pptx" | 无质量承诺 |
| image2ppt | "Text, tables and lines are rebuilt as **native PowerPoint objects**... icons come out as separate pieces"；"36 页测试中 15 页出现真实可编辑表格、168 条线重建为可编辑线条" | **最强承诺**，但样本拆包见下 |
| ConvertAPI | jpg→pptx 参数只有 PageSize/Margin/Orientation/OCR | 反证：**图片是铺满的，文字是 OCR 层** → L1 |
| CloudConvert | "preserve layouts, formatting, graphs and tables... actual usable, clean PowerPoint" | PDF 转出，表格可能原生 |
| TextIn | 仅"PDF转PPT" | 无承诺 |
| 讯飞 | "生成**保留内容格式**的 docx、pptx 或 xlsx" | 措辞偏"版式保留" |
| 度慧 | "版式**尽量**还原"、"文字可编辑"、"表格识别" | 诚实但弱 |
| WPS | OCR 按页计费 | 本质 OCR → L1 |

### 14.2 实测：image2ppt 官方 sample 拆包 `[实测]`

下载 4 个官方 sample，用 python-pptx 统计：

| 文件 | 页数 | 形状总数 | 图片 | 文本框 | AutoShape | Freeform | 表格 | 全幅底图(z0) |
|---|---|---|---|---|---|---|---|---|
| `zh-saas-revenue-expansion.pptx` | 1 | 79 | 19 | 47 | 13 | 0 | **0** | **无** |
| `zh-product-launch-day.pptx` | 1 | 42 | 27 | 11 | 2 | 2 | 0 | **有**（z0，12185294×6857872 EMU，几乎满版） |
| `zh-ai-growth-command.pptx` | 1 | 59 | 22 | 23 | 12 | 2 | 0 | **有** |
| `en-saas-revenue-expansion.pptx` | 1 | 70 | 21 | 36 | 13 | 0 | 0 | **有** |

结论（重要）：
1. **"原生对象"是真的**：每页有 11–47 个**原生文本框**、2–13 个 **AutoShape**、0–2 个 Freeform，可点选编辑。
2. **但不是纯矢量**：3/4 样本 z0 是一张**覆盖全幅的图片**（背景层），文字/形状叠在其上。这解释了"高保真"——底图保证视觉一致，上层保证可改。
3. **表格不是原生 table**：4 个样本 `has_table` 全为 0，尽管官网宣称"15/36 页有真实可编辑表格"。样本是营销页，可能刻意不选表格页；**采购前必须用自己的表格页做 POC**。
4. 样本都是**单页**，不能代表整册一致性。

### 14.3 建议的验收脚本（可直接跑）

```python
from pptx import Presentation
p = Presentation("out.pptx")
for i, s in enumerate(p.slides):
    pic = sum(1 for sh in s.shapes if sh.shape_type == 13)
    txt = sum(1 for sh in s.shapes if sh.has_text_frame and sh.text_frame.text.strip())
    tbl = sum(1 for sh in s.shapes if getattr(sh, "has_table", False) and sh.has_table)
    full = sum(1 for sh in s.shapes if sh.shape_type == 13
               and sh.width >= p.slide_width*0.9 and sh.height >= p.slide_height*0.9)
    print(i, "pics", pic, "texts", txt, "tables", tbl, "fullbleed", full)
```
判据：`fullbleed == 0 && tables > 0 && texts > 0` → L3 候选；`fullbleed > 0` → 至多 L2。

---

## 15. 可下载 Sample PPTX 清单（质量审计用）

| 厂商 | 直链 | 状态 |
|---|---|---|
| **image2ppt** | `https://image2ppt.com/samples/pptx/zh-saas-revenue-expansion.pptx` | ✅ 200，已下载拆包 |
| | `https://image2ppt.com/samples/pptx/zh-product-launch-day.pptx` | ✅ |
| | `https://image2ppt.com/samples/pptx/zh-ai-growth-command.pptx` | ✅ |
| | `https://image2ppt.com/samples/pptx/en-saas-revenue-expansion.pptx` | ✅ |
| ComPDF | — | ❌ 文档/仓库均未提供输出样例（`compdfkit-conversion-sdk-python` 仓库只有 `Images/`） |
| Nutrient | — | ❌ 只有输入 sample file |
| Adobe | — | ❌ 只有 `exportPDFInput.pdf` |
| Aspose | — | ❌ |
| ConvertAPI / CloudConvert | — | ❌ |
| TextIn / 讯飞 / 度慧 / WPS | — | ❌ |

> 这是本轮最硬的发现：**10 家里只有 image2ppt 敢放出可下载的成品**。反过来说，其他家要么没做质量自信，要么客户都得先付钱才能看到输出。
>
> 本地副本（已下载并校验可打开）：`notes/samples-image2ppt/{zh-saas-revenue-expansion,zh-product-launch-day,zh-ai-growth-command,en-saas-revenue-expansion}.pptx` —— 可直接拖进 PowerPoint「选择窗格」看层级，或跑 14.3 的脚本复核。

---

## 16. 合规差异（只写官方明示，未核项标注）

| 厂商 | 数据处理地区 | 认证/声明 | 转售/SaaS 二次分发 | 企业认证 |
|---|---|---|---|---|
| ComPDF | `.com` 全球 / `.cn` 大陆；OSS 2 天删除 | 未见 SOC2/ISO 声明 `[未核]` | 未见明文限制 `[未核]` | 需注册；企业版走销售 |
| Nutrient | **US + EU**；可 on-prem | SOC 2 Type 2、HIPAA-eligible、GDPR | 未核（OEM 需商务）`[未核]` | 可自助 |
| Adobe | **US 默认 / EU 可选** | Adobe 全套合规 | Adobe 通用条款，OEM 需另签 `[未核]` | 可自助（500 免费） |
| Aspose | 云多区 / 自建本地 | 未核 | 买断 license 允许嵌入分发（OEM 档） | 可自助 |
| ConvertAPI | 可选"数据不出境"、私有服务器 | ISO 27001、HIPAA、GDPR；可签 DPA/NDA/BAA | 未核 | 可自助 |
| CloudConvert | 多区 | GDPR、DPA | 未核 | 可自助 |
| TextIn | 中国大陆 | 等保/私有化（商务材料） | 未核 | 需实名 |
| 讯飞 | 中国大陆 | — | **明确"暂不商用"** | 需实名 |
| 度慧 | 中国大陆（百度云市场） | 云市场协议 | 未核 | 需百度云实名 |
| WPS | 中国大陆 | 等保、WPS 365 合规体系 | 服务商协议约束 | **需服务商入驻/企业认证** |
| image2ppt | **新加坡**；Paddle（MoR）收款 | 不用于训练、可随时删除 | ToS 未逐条核 `[未核]` | 可自助 |

**结论**：
- 面向国内政企/需发票 → ComPDF（.cn）、TextIn、WPS、度慧。
- 面向海外/可接受数据出境 → image2ppt（新加坡）、Nutrient（US/EU）、Adobe（US/EU）。
- **讯飞是唯一明文"暂不商用"的，直接排除生产**。
- 转售条款本轮**没有逐条读 ToS/AUP**（预算限制），这是交付缺口，签约前必须法务复核，尤其是：ComPDF 是否允许把 API 包装成自己的 SaaS、image2ppt 的 Paddle MoR 下的转售限制、Adobe 的 OEM 条款。

---

## 17. 推荐 Top3

### 🥇 首选：image2ppt（质量可验证 + 契约最完整）
- **理由**：唯一有公开 sample 可拆包验证（L2 实证）；唯一有 Idempotency-Key + Standard Webhooks 验签 + 逐页账本 + 失败退点；纯异步天然适配批量；¥0.70–1.00/页虽贵但**只为成功页付费**。
- **代价**：新加坡数据出境；单任务 ≤50 页/90MB；表格原生性未被样本证实。
- **适用**：对"改得动"要求高、能接受海外支付/数据出境、量不大但质量敏感的场景。

### 🥈 性价比/合规首选：ComPDF Cloud（.cn）
- **理由**：参数最专业（AI 版面、背景图、公式、OCR 范围、流式/框式）；¥20/1000 文档 ≈ ¥0.02/张，**便宜 30–50 倍**；`.cn` 区域 + MIT 自托管兜底，政企可过合规；同步模式 10 分钟能接完。
- **代价**：图片端点只能单文件（批量要自己并发+合并）；云 SDK 落后；webhook 无签名；质量无公开样本，**必须 POC**。
- **适用**：国内业务、成本敏感、需要私有化选项、能自己做批量编排与质检。

### 🥉 基线/兜底：Nutrient DWS
- **理由**：一个 `/build` 端点搞定（同步流回，代码 10 行）；US/EU 双区 + SOC2/HIPAA；100 req/min 明确；按 1.5 credits 计费透明；企业可 on-prem。
- **代价**：无任何质量旋钮；免费档带水印；$0.08–0.135/页是三者最贵；无 sample。
- **适用**：海外业务、要 SOC2/HIPAA、追求"最少代码"的团队；或作为 image2ppt 的备份路由。

**不推荐进主链路**：
- Adobe（无图片直转，要两步；无公开价）、CloudConvert（无 image→pptx）、Aspose（不支持图片入）、ConvertAPI（L1 质量）、TextIn（无质量声明、同步 base64 不适合大文件）、讯飞（禁商用）、WPS（契约不公开、报价不透明）、度慧（最便宜但质量 L1–L2，适合兜底/低要求批量）。

**组合建议**：`image2ppt 主（质量页） + ComPDF 兜底（成本页/国内） + 自研 pptx 后处理（合并、去底图、表格重排）`。路由判据：页面含表格/流程图 → image2ppt；纯文字/截图 → ComPDF；失败重试 → 另一家。

---

## 18. 未证实清单（下一步必须做）

1. **ComPDF 异步/预签名的开关字段**：页面 tab 渲染未抓到，需登录 console 或问商务；`130004` 暗示有幂等键但键名未知。
2. **ComPDF 实际输出层次**：无 sample，必须用 3 类页面（表格页/流程图页/纯文字页）各跑 1 次并拆包。
3. **Nutrient image→pptx 的原生形状比例**：官方只说"text and structure"，需实测。
4. **image2ppt 表格是否原生**：4 个样本 `has_table=0`，与官网"15/36 页真实表格"矛盾，必须用表格页 POC。
5. **Adobe REST `/output` 路径**：按 SDK 行为推断，需一次真实 job 验证。
6. **各家 ToS 的转售/SaaS 条款**：本轮未读原文，签约前法务复核。
7. **WPS OCR 端点/参数/单价**：公开文档未展开，需服务商账号。
8. **Aspose Cloud 月费**：购买门户 SPA，未取到静态价。
9. **ConvertAPI 官方价**：仅第三方汇总 $35/$95/$175。
10. **度慧结果查询接口**：商品页只给了 token，查询端点未展开。

---

## 19. 附：一句话选型口诀

> 要**改得动** → image2ppt（先拆 sample 再付钱）；
> 要**便宜+国内+能私有化** → ComPDF；
> 要**最少代码+海外合规** → Nutrient；
> 要**PDF 转**而不是图片转 → Adobe / CloudConvert / TextIn；
> 要**最便宜试水** → 度慧（¥0.003/次）；
> 要**PPT 原生表格** → 目前没有一家敢承诺，只能自己后处理。
