# Lead 亲自核实的一手数据（2026-10-20）

## 1. 可集成 API（最重要）

### image2ppt.com（最对口：图片/PDF → 可编辑 PPTX）
- 官网：https://image2ppt.com/zh/
- 定位：PPT 截图、PDF 页面、AI 生成图 → 文字/表格/线条重建成原生 PowerPoint 对象
- 卖点（官方）：36 页测试中「15 页出现真实可编辑表格」「168 条线重建为可编辑线条」，对标同类工具为 0
- 价格（人民币，官网 pricing 页）：
  - 30 页 ¥29.90（¥1.00/页）
  - 80 页 ¥59.90（¥0.75/页）
  - 200 页 ¥139.90（¥0.70/页）
  - Pro 季卡 ¥899 / 年卡 ¥2,999（每 30 天 500 张）
  - 支付宝实付 ¥66.90（¥59.90 + 渠道成本 ¥7.00）；淘宝兑换码 ¥59.90
- 免费额度：注册赠点（7 天有效），转换失败自动退点
- 限制：单文件 ≤35MB，单请求 ≤90MB，单任务 ≤50 页；图片格式 png/jpg/webp/gif；PDF 支持
- API（关键，可集成性极强）：
  - Python SDK `pip install image2ppt`（0.6.0）、Node SDK `npm i image2ppt`
  - 异步任务：submit → wait → download；支持 callback_url + Standard Webhooks 验签
  - Idempotency-Key、按页计费（1 页 = 1 credit）、失败页退款、page_results 逐页账本
  - 限流：≤10 并发任务、≤60 页/分钟；429 带 Retry-After
  - 速度：单页约 2 分钟，90% 任务 3 分钟内完成
  - API Key 需付费账号（i2p_live_xxx），服务端调用（禁止放浏览器）
  - 文档：https://image2ppt.com/docs/api
- 合规注意：服务器在新加坡，Paddle 收款（境外主体）。国内业务需评估数据出境/发票/支付合规。
- 效果边界（官方自述）：清晰 PPT 截图、PDF 页面、表格页效果最好；复杂流程图、海报、照片、知识地图 best-effort，可能保留为图片元素

### ComPDF Cloud API — Image to Slides（图片→可编辑 PPTX）
- 文档：https://www.compdf.com/guides/api-reference/v2/image-to-ppt
- 接口：POST https://api-server.compdf.com/server/v2/process/img/pptx（同步）+ 异步 + 预签名安全模式
- 参数很专业：OCR 开关、OCR 语言、OCR 范围、AI 版面分析开关（默认开）、保留图片、保留批注、页面背景、公式是否转图（默认保留可编辑）、页面布局模式 e_Flow / e_Box
- 公司：PDF Technologies, Inc.（2010 成立，新加坡/台北/长沙），国内团队，出海品牌 ComPDFKit
- 价格（官网 pricing 页，需以实际为准）：免费 ¥0 最多 200 文档/月；¥20/月（年付 ¥240）最多 1,000 文档/月；更高档 ¥558.25/月、¥999/月
- 判断：**参数最全、最像工程化 API 的一家**，但「AI 版面分析」档位是否含在低价套餐内需核实；效果未见公开实测

### WPS 开放平台（WebOffice）— 图片识别转 PPT
- 文档：https://365.kdocs.cn/3rd/open/documents/app-integration-dev/docs-center/convert/format
- 明确支持：`图片识别转换 Word、Excel、PPT、JSON、Table`；`PDF 识别转换 Word、Excel、PPT、JSON、Table`
- 计费：OCR 按页计费（区别于在线文档转换按次计费）；**具体单价不公开，需联系商务**；调试模式每日免费 50 次
- 判断：国内合规最好的一条路（WPS 生态、发票、等保），但报价不透明、且 OCR 输出的 PPT 质量大概率是「文字可编辑」档，不是「版式对象化还原」档

### 阿里云市场 · 上海度慧「图片转 Word/PPT/Excel/TXT/OFD/MD」
- 商品页：https://apis.baidu.com/store/detail/9a579740-d0a2-43fb-921a-10f9364a9a5c
- 接口：POST http://img2doc.api.bdymkt.com/v1/convert ，参数 type=pptx/docx/...、clean（清背景）、language（16 种）、a4、callbackurl
- 价格（按次数，不按页）：50 次 ¥0（首购）；6000 次 ¥100；30000 次 ¥300；60000 次 ¥500；200000 次 ¥1000；500000 次 ¥2000；1000000 次 ¥3000（≈¥0.003/次）
- 速度：10 页 1080p 图平均 15 秒
- 判断：**极便宜**，但属于 OCR 路线（自动矫正倾斜、复原图片原有样式、清背景）——大概率输出「图片铺底 + 文字框」的 PPT，不是结构还原。适合低成本/低要求场景做兜底。

## 2. 国内可用产品（消费者/团队向）

### WPS AIPPT「图片转 PPT」（Nano Banana Pro）— 目前最强的免费选择
- 入口：https://aippt.wps.cn/aippt/convert-ppt/
- 官网自述：`Nano Banana Pro 图片转 PPT｜文本可编辑 字体还原准 图层可分离｜限时免费`
- 限制：≤30 张、≤20MB 的 PNG/JPG/JPEG/WEBP；或单个 ≤100MB 的 PDF
- 流程：上传图片 → WPS AI 转换 → 下载或编辑
- 生态：WPS 会员体系（AI 功能按大会员权益分配，WPS 会员各档 0–599 元/人/年，WPS 365）
- 判断：**个人/小团队首选，当前限时免费，可分离图层**；但无公开 API（要接只能走 WPS 开放平台 OCR 通道，两套东西）

### PPTBot（深圳市比特意图科技有限公司，eeebit.com）— 国内明确主打「PDF/图片 → 可编辑 PPTX」
- 上线：2026-04-13；ICP：粤ICP备2026040605号-1
- 两大能力：①主题/文档 AI 生成 PPT；②「整页图片风格」PDF 或按序 JPG/PNG/WebP 截图 → 可编辑 PPTX
- 点数价：¥10/100 点、¥30/300、¥60/600、¥120/1200、¥500/5000（¥0.1/点）
- 转可编辑计价：**普通版 3 点/页 = ¥0.30/页；高精版 15 点/页 = ¥1.50/页；或 22 点/页 = ¥2.20/页**
- 附加：PPT 换皮（上传已有 PPTX 按模板重出视觉）、品牌视觉、演讲视频、在线预览、站内编辑
- **官方 FAQ 明确承认：转可编辑后「主要文字可编辑修改，装饰元素可能仍是图片」** ← 这是效果天花板的诚实披露
- 无公开 API（未见开发者文档）

### 智在PPT（浩鲸科技，https://ppt.zzjilu.com）
- 宣称「图转PPT：把静态图片还原成分层可编辑 PPTX」，文字/基础形状/表格分离为独立对象，十几秒/页
- 但**官网首页只有「输入主题生成」**，未展示图转PPT入口；/img-to-ppt 返回的是 SPA 空壳
- 相关横评文章集中在 cnblogs「zzppt」与 CSDN「daxiongbaodian24」等账号，**高度疑似 SEO 软文**（同一账号矩阵批量发布「图转PPT 横评」）
- 置信度：功能存在性「中」，效果「低」。需要实机验证。

### iSlide —— **没有**图片转PPT功能（已核实：其 AI 是生成/美化/填充，不是位图还原）
### 迅捷PDF转换器 —— App 会员 ¥30/月、¥58/年、¥78/终身；主打 PDF↔Office，不是图片结构还原
### 福昕 PDF Editor —— ¥880.30/用户/年，含 Convert PDF to PowerPoint（转换器路线）

## 3. 开源项目（已核实）

| 项目 | Stars | License | 最近提交 | 路线 |
|---|---|---|---|---|
| https://github.com/DSY-Xueai/image2editable | 56 | MIT | 2026-10-09 | Agent Skill：OCR + 视觉拆分(SAM) + 重建 + 质量门禁（每组件最多 5 轮修复） |
| https://github.com/giszzt/figedit | 189 | MIT | 2026-09-24 | 位图图形 → 可编辑 SVG + 原生 PPT（图形/图标场景） |
| https://github.com/CodingFeng101/slide-alchemy | 45 | MIT | 2026-07-13 | 干净底图(AI inpaint) + 组件分类 + 简单几何走 OOXML + 复杂图标走生成式 PNG + 真文本框 |
| https://github.com/yrui-cmd/cell-ppt | 61 | MIT | 2026-09-26 | PPT 插件，科研图 → 原生可编辑路径 + 文本 |
| https://github.com/pipipi-pikachu/PPTist | 9,409 | **AGPL-3.0** | 2026-10-10 | Vue3 在线 PPT 编辑器/演示，支持导出 PPTX；AGPL 对 SaaS 闭源集成有传染风险 |

关键洞察（来自 image2editable / slide-alchemy README）：
- 现有开源方案本质是**Agent 驱动**，不是确定性流水线：消耗 LLM token、每分钟级延迟、效果依赖视觉模型与图像编辑模型
- 因此很难直接包装成「固定单价 + 秒级」的 API；要么做成异步任务（用户等 1–3 分钟），要么走商业 API
- 三条技术路线的高下：
  1. 纯 OCR：只出文字框（便宜、最快、版式丢）
  2. 结构重建（主流）：文本框 + 简单几何原生形状 + 复杂图标透明 PNG + AI 清洗底图
  3. 矢量重绘：整体矢量化（形状可编辑但变成曲线，文字仍是死的）

## 4. 负面结论（避免踩坑）
- **阿里云文档智能 DocMind 不支持输出 PPTX**：格式转换只有 PDF→Word、PDF→Excel、图片→Word、图片→Excel、PDF/图片→PDF。API 文档：https://help.aliyun.com/zh/document-mind/developer-reference/api-reference/
- 腾讯云文档转码（DocProcess）只输出 HTML5/图片，不出可编辑 PPTX
- 百度智能云 DocParser 输出的是版面/坐标 JSON（需自己组装 pptx）
- 合合信息 TextIn xParse 主打 markdown/JSON（2 分钱/页起），不出 pptx
- 结论：**国内云大厂几乎都不提供「图片→可编辑 PPTX」的成品 API**，这条能力目前由垂直玩家（image2ppt / ComPDF / WPS 开放平台 OCR / 度慧）把持
