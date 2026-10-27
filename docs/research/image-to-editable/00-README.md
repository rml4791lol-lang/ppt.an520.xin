# 目录：图片型 PPT → 可编辑 PPT 调研

> 调研日期：2026-10-20　｜　全部价格均已读官方页面原文核实
> 两轮调研：第一轮「市场与选型」，第二轮「契约细节 + LLM 管线 + Agent 路线 + 源码级工作量」

## 一、主交付物

| 文件 | 说明 |
|---|---|
| [`调研报告-图片PPT转可编辑PPT-20261020.md`](调研报告-图片PPT转可编辑PPT-20261020.md) | **第一轮·主报告**。L0–L3 分层框架、24 个国内产品、可集成 API、开源项目、真实口碑、成本模型 |
| [`深度报告-ComPDF与LLM与Agent路线-20261020.md`](深度报告-ComPDF与LLM与Agent路线-20261020.md) | **第二轮·深度报告**。ComPDF 契约全拆解（参数/错误码/三档请求模式/真实定价）、LLM 管线（schema/坐标/成本/渲染回环）、Agent+Skill 实测、源码级自研工作量 |
| [`对比矩阵-图片转可编辑PPT-20261020.xlsx`](对比矩阵-图片转可编辑PPT-20261020.xlsx) | **可筛选总表**。①32 个产品/API　②16 个开源项目（License 已核原文）　③分场景效果 + 价格锚点 + 建议定价 |

## 二、本轮实测结论（硬数字）

image2ppt 是市面上**唯一提供可下载成品样本**的一家（4 个官方 pptx 已下载到 `notes/samples-image2ppt/`）。用 `audit_pptx.py` 拆开测：

| 样本 | 判定 | 原生文本框 | 几何对象 | 全幅底图 | 原生表格 | 风险字体 |
|---|---|---|---|---|---|---|
| zh-saas-revenue-expansion | L2 | 47 | 13 | 无 | **0** | Microsoft YaHei ×96 |
| en-saas-revenue-expansion | L2 | 36 | 13 | 有 | **0** | — |
| zh-ai-growth-command | L2 | 23 | 14 | 有 | **0** | Microsoft YaHei |
| zh-product-launch-day | L2 | 11 | 4 | 有 | **0** | SimHei + YaHei |

**四条结论**：① 确实是 L2 真元素还原；② 3/4 页 z0 是全幅底图（行业主流形态，**不算不合格**）；③ **4 个样本原生表格全为 0**，官网宣称的"15/36 页可编辑表格"无法复现 → **表格页必须自己 POC**；④ 中文字体全用微软雅黑/黑体（**法律上不可嵌入**，用户没装就 fallback 宋体）。

👉 市场上的"最好" = L2 + 底图 + 无表格 + 雅黑。**你的差异化空间：表格原生 + 字体合规 + 可选"无底图"模式。**

## 三、可直接跑的工具

| 文件 | 用途 |
|---|---|
| [`audit_pptx.py`](audit_pptx.py) | **PPTX 可编辑度审计**。输入任意供应商输出的 pptx，输出 L0/L1/L2 分层、非图片对象数、图片覆盖率、中文字体缺失（`a:ea`）、字体版权风险。支持批量出 CSV，用于「10 图 × 5 工具」盲测。**这是把"效果好不好"变成数字的唯一办法。** |
| [`comppdf_client.py`](comppdf_client.py) | **ComPDF 参考客户端**。同步/异步/预签名骨架、错误码分类重试、国内域名切换（`api-server.compdf.cn`）、Webhook 验签骨架、原子落盘。改 `COMPDF_KEY` 即跑。 |

```bash
# 审计一份结果
python3 audit_pptx.py out.pptx

# 批量盲测出 CSV
python3 audit_pptx.py results/*.pptx --quiet --csv bench.csv

# 调 ComPDF
export COMPDF_KEY=xxx
python3 comppdf_client.py --sync slide.png -o out.pptx
python3 audit_pptx.py out.pptx
```

## 四、原始分线笔记（`notes/`）

| 文件 | 内容 |
|---|---|
| `notes/A-domestic-sites.md` | 24 个国内网站/桌面工具，逐家价格与功能核实 |
| `notes/B-cloud-apis.md` | 15 类开放平台 API（阿里/腾讯/百度/火山/WPS/TextIn/有道/Adobe/Azure…） |
| `notes/C-open-source.md` | 25 个开源项目，License 原文核对、三条自研路线 |
| `notes/D-effects-reviews.md` | 42 条口碑来源，失败模式、分场景分数、学术侧硬数据 |
| `notes/E-llm-pipeline.md` | **LLM 管线**：字段级 JSON schema、坐标精度实测、逐档成本计算、渲染回环伪码 |
| `notes/F-agent-skill-service.md` | **Agent+Skill 服务化**：headless 实跑记录、成本时延、最小生产架构、分流策略 |
| `notes/G-api-contracts.md` | **同类 API 契约**横向（ComPDF/Nutrient/Adobe/Aspose/TextIn/度慧/WPS/image2ppt） |
| `notes/H-source-code-teardown.md` | **源码级拆解**：模块→人日映射、pptx 硬技术点、三条抄法 |
| `notes/samples-image2ppt/` | **image2ppt 官方成品样本 4 个 pptx**（市面上唯一可下载的真成品），已用 `audit_pptx.py` 拆解 |
| `notes/LEAD-verified.md` | 主调研员亲自核实的一手数据 |

---

## 30 秒版

1. **这不是一个功能，是四个层级**：L0 塞图 → L1 只认字 → L2 元素还原 → L3 拍照还原。市面 90% 产品停在 L0/L1。**验收法：点一行字，出光标=文字，出整页选框=图片。**
2. **国内一线云厂商没有「图片→可编辑 PPTX」的 API**，只有 Word/Excel/JSON/Markdown 原料层。这是产品空位。
3. **商业 API 里 ComPDF 工程最正规**（三档请求模式、完整错误码、国内域名、版面分析可单独买），但**效果零公开验证** → 必须用 `audit_pptx.py` 自测。
4. **LLM 只该干三件事**：语义分组、阅读顺序、渲染差异判因。让它直接吐整页 PPTX 是浪费（PPTBench 最好 67.8/100，中位 19.47，不可复现）。
5. **Agent + Skill 是商业 API 的 15–40 倍成本、6–30 倍时延**（¥12–40/页 vs ¥0.7–1.0/页；12–60min vs 2–3min）。**能跑，但只能做"疑难页救援"，不能做主力。**慢的主因是 SAM2-large + DINO 的 CPU 推理（9–16 min/页），不是 token。
6. **自研真实工作量**：快速验证 10–13 人日 / 可用产品 25–35 / 对标最佳 60–80。三条"抄法"能 6–8 人日出骨架。
7. **效果天花板**：矢量 PDF 80–90 分、规整截图 70–80、扫描件 60–70、AI 生图 45–60、手机拍屏 30–45。

**推荐路径**：第 1 周用 ComPDF 免费档（200 文档/月）+ `audit_pptx.py` 盲测（含拆 image2ppt 现成样本）→ 第 2–3 周接商业 API 上线 → 第 2 月自研 Tier0 降本 → 第 3–4 月加渲染回环 + 表格原生 + 字体合规做差异化。

**ComPDF 的两套参数预设**（已内置进 `comppdf_client.py`）：
- 要"尽量原生可编辑" → `enableAiLayout=1, pageBackground=0, formulaToImage=0`
- 要"视觉 1:1 保真" → `pageBackground=1`（代价：整页底图，背景改不动）
- ⚠️ `language` 是**报错信息语言**，OCR 语言是 `ocrRecognitionLang` —— 这个坑很多人踩。

---

## 重要提醒

- 这个品类的中文"横评"**软文污染严重**（CSDN `daxiongbaodian24`、博客园 `zzppt` 等同一分发网络批量产出），排名不可采信。本报告只取其 L0–L3 分层框架。
- 价格会变。所有价格均标注抓取日期 **2026-10-20**，签约前请复核。
- 三个 License 陷阱：Edit Banana 徽章写 Apache 实为 **AGPL**；PPTist 是 **AGPL**（商用 ¥2,999/年、¥5,999 永久）；MinerU2PPT / OCRPDF-TO-PPT / svg2pptx **完全无 LICENSE**（不可商用）。
- 中文字体：PingFang / 宋体 **法律上不可嵌入**（fsType=4/2）；产物只出 Noto / 思源（fsType=0）。
