# D. 效果与口碑：「图片/截图/扫描版 PPT → 可编辑 PPT」真实表现调研

- 调研时间：2026-10-20
- 调研范围：中文社区（WPS 社区、V2EX、简书、CSDN/博客园、什么值得买、黑猫/消费保）、B 站测评、英文社区（Reddit、Hacker News）、官方方案（Microsoft PDF Reflow / Adobe Acrobat / Google Slides）、学术与技术分析（arXiv 2026）
- 结论一句话：**这项技术已经不是"能不能做"，而是"做到几分、在哪一层失败"**。文字层基本可用（75–90 分），**结构层（图形、箭头、图表、母版）普遍不及格（30–50 分）**，而且产品宣传与用户预期之间有一道稳定的落差：用户以为买的是"还原"，实际拿到的是"重排"或"塞图"。

---

## 0. 方法与可达性说明（重要，影响证据权重）

| 渠道 | 状态 | 处理方式 |
|---|---|---|
| 小红书 | **登录墙**：`opencli xiaohongshu search` 返回 `AUTH_REQUIRED`；网页版搜索亦要求扫码登录（实测 2026-10-20） | 未登录、未绕过。改用二手引用：什么值得买横评中对小红书高赞帖的转述（含赞数/楼层数），以及黑猫投诉中"从小红书看到广告"的投诉记录 |
| B 站 | `bili` CLI 因缺少 `DEFAULT_AUTH_USER_ID`/`DEFAULT_ALBUM_ID` 环境变量启动崩溃；改用公开搜索 API 取标题/播放量/日期（成功），评论 API 返回空（反爬） | 用视频标题与播放量做"话题热度/叙事口径"证据，**不把 UP 主口播当独立评价**（多数为工具推广） |
| 知乎 | 可搜到，但高相关回答多为 2018–2022 年"图片不可逆"时代的旧结论 | 作为"旧共识"引用，与 2025–2026 新工具有明显代际差 |
| V2EX | sov2ex 公开 API 可用 | 取到 2 条 2026 年真实求助/开发者帖（见 §3） |
| Reddit | Exa 可检索到原帖与高赞评论 | 引语为主，标注版块与日期 |
| Hacker News | Algolia 检索：相关帖子**点数极低（1–17 pts）**，无实质讨论 | 结论：HN 对该品类几乎无公共讨论，不能作为口碑来源（这本身是个信号：英文技术圈不认为这是"值得讨论的技术问题"） |
| Exa | 中途触发免费额度限流 | 已获结果足够，未再重试 |

> 证据分级：**A** = 一手用户实测（WPS 社区测评、V2EX、Reddit 原帖）；**B** = 媒体/横评转述（什么值得买、秋叶PPT、简书）；**C** = 厂商/SEO 内容（CSDN/博客园"横评"、工具官网博客），仅用于提取**能力分层与技术自述**，不采信其排名。

---

## 1. 先建立判断框架：四种"转换"，效果差一个数量级

业内已经形成一个比较清晰的分层（博客园 8 款实测提出 L1/L2/L3，SlideForge 提出 stuffer/reconstructor 二分，二者可合并）：

| 层级 | 做法 | 用户到手的东西 | 30 秒识别法 |
|---|---|---|---|
| **L0 塞图（image-stuffer）** | 图片铺满整页，改后缀为 .pptx，最多叠一层隐形 OCR | 一张照片 | 点文字：出现"整页选框"而不是光标 → 是图 |
| **L1 只认字（OCR→重排）** | OCR 取文字，套模板重新生成 | 一份"内容对了、版式没了"的新 PPT | 原图配色/位置全丢，但字能改 |
| **L2 元素还原（reconstruction）** | 视觉模型拆文字/形状/表格/图片，写成原生对象 | 可分层、可改样式的 PPTX | 能单独选中某个箭头/卡片 |
| **L3 拍照还原** | 透视校正 + 去反光/阴影 + 再走 L2 | 白板/手机拍图的可用稿 | 歪的图变正了 |

来源：[SlideForge 技术说明](https://slideforge.dev/blog/image-to-editable-powerpoint)（2026-07-14）提出 "image-stuffers vs reconstructors" 与 30 秒测试；[博客园 8 款实测](https://www.cnblogs.com/zzppt/p/23294146)（2026-10-14）提出 L1/L2/L3 分层。

**关键事实：市面上大多数"免费在线转换"停在 L0/L1，而用户投诉的绝大多数问题，恰恰是"我以为我买的是 L2，结果拿到 L0/L1"。**

---

## 2. 口碑矩阵（产品 × 好评点 / 差评点）

### 2.1 中文产品

| 产品 | 好评点（有出处） | 差评点（有出处） | 综合判断 |
|---|---|---|---|
| **WPS AIPPT（Nano Banana Pro 图片转 PPT）** | 转换+下载目前免费；文字基本能拆出来改；图片、图标质感保留尚可（[秋叶PPT/网易](https://m.163.com/dy/article/KUATCIKM05169CIL.html)，2026-06-01）；表格能生成原生表格、单元格可改（[CSDN 横评](https://blog.csdn.net/daxiongbaodian24/article/details/166866320)，2026-09-30，C 级） | 官方宣称"文本可编辑、字体还原准、图层可分离"，实测：**图形元素无法选中**、"可编辑元素仍然只有文字……该图转换效果是失败的"（[WPS 社区 77441](https://bbs.wps.cn/topic/77441)，2025-12-14）；**文字错乱无法选中**、柱形图直接变图片、3 个底框选不中、整页背景模糊（[77508](https://bbs.wps.cn/topic/77508)，2025-12-15）；**分辨率下降**、箭头/图标/装饰框被并进背景、文字错位遗漏（[77796](https://bbs.wps.cn/topic/77796)，2025-12-17）；➗、√ 等符号识别差、背景只识别一部分（[77458](https://bbs.wps.cn/topic/77458)）；设计感强的页面"右边正文没有拆分出来"（秋叶，2026-06） | **当前中文市场最可用的"零成本 L2 尝试"**，但只在"文字+简单卡片"页面成立；一旦涉及流程图/图表/装饰形状就退回 L1 |
| **千问办公（通义）** | 三工具横评中"图片转可编辑 PPT 还原度最高"，"转出来只需要 5 分钟微调"（[什么值得买](https://post.smzdm.com/p/aqrxkev7/)，2026-08-28，B 级转述） | 同一横评："三者都存在发挥不稳定的问题" | 目前中文侧**还原度口碑最好**，但"不稳定"是共识 |
| **Kimi PPT** | 能提文字、按标题段落逻辑重建，叙事结构还原好，"还原率 7–8 成"（CSDN 横评，C 级）；设计稿复刻能力（博客园，C 级） | 走"理解后重排"，**不复刻原图配色细节**；复杂图文混排元素分离偏差，需手动调层级 | 适合"我要一份新的、像样的 deck"，不适合"我要这一页原样" |
| **豆包 PPT** | 重排美观、会智能配图（简书实测，2026-01-31） | **会自作主张改内容**，"与原稿差异大"；文字识别错误多；图片基本无法识别（同上，A 级小样本） | 定位是"生成"，不是"还原"，用于还原场景会翻车 |
| **Gemini（作为转换器）** | 文字识别精准、布局还原出色、忠于原内容（简书，2026-01-31） | **图片部分基本为空**，需手动补图 | 目前"文字+版式"最稳的通用模型路径，但图形资产会丢 |
| **百度文库 AI PPT** | 模板多、Office 生态好 | 只有 **OCR→新大纲→套模板**，不还原原图布局（CSDN、博客园一致） | 不属于"还原"品类，用户最容易买错 |
| **讯飞智文** | 中文内容理解、文档转 PPT 强 | **当前版本没有图片转 PPT 功能**（CSDN 5 款实测，2026-10-09） | 明确不在赛道内 |
| **智在PPT（浩鲸）** | 号称 L2/L3：对象化还原、表格原生、白板手写可识别、输出无编辑锁（博客园/CSDN，均为同一 SEO 分发网络，**C 级，疑似推广**） | 自述边界："超长图片解析会受限"；复杂图文混排仍需微调 | 能力方向对，但现有"测评"几乎全是软文，**缺独立验证** |
| **AiPPT / 熊猫办公 / Gaippt 等** | — | 收费套路集中爆发区（见 §6）：299 元"终身会员"后专业版再收费、AI 功能需二次充值、虚拟产品不退（[黑猫投诉](https://tousu.sina.com.cn/complaint/view/17401872997/)、[消费保](https://www.xfb315.com/brands/38648.html)） | 与"效果"无关，但**是用户实际损失最大的一类坑** |

### 2.2 英文产品 / 官方方案

| 方案 | 好评点 | 差评点 | 判断 |
|---|---|---|---|
| **Adobe Acrobat（PDF→PPT）** | 矢量图形、嵌入字体、复杂表格处理最好；"Adobe 自己造的 PDF 格式"，多栏、超链接、表单、图层都能过（[Deckary](https://deckary.com/blog/pdf-to-powerpoint)，2026-02-07，B 级） | 缺字体时**直接把文字渲染成图片**以保外观（[PyMuPDF #4999](https://github.com/pymupdf/PyMuPDF/discussions/4999)，2026-05-21）；渐变叠加、多层组合形状、专用工具画的图表**会被拍平成图片**；订阅 $22.99/月 | **矢量 PDF 的最优解（80–90 分）**，但"保真"与"可编辑"在缺字体时是对立的 |
| **Microsoft PDF Reflow（Word 打开 PDF）** | 简单文档格式保留不错（TheWindowsClub 等） | 微软自己警告"可能看起来不完全一样"，表格（单元格间距）、边框、分页会断（[EasyPDF 转述微软文档](https://www.easypdf.fr/edit-pdf-in-word)，2026-10-08）；"设计感越强，转换越差"（[Flipsnack](https://blog.flipsnack.com/how-to-edit-a-pdf-in-word/)，2026-06-10）；同一 PDF 每次转换结果略有差异，**不可复现**（日文技术博客，2026-04-22） | 定位是"文档"，不是"幻灯片"；对 deck 基本不可用 |
| **Google Slides** | 原生、协作好 | 插入的图片**不能"转换为形状"**（该能力在 PowerPoint 侧）；Drive 的 OCR 只把图片转成 **Docs 纯文本**，不带版式 | 官方没有"图片→可编辑幻灯片"路径；学术侧才有 Images2Slides 这类实验管线（见 §5） |
| **Free online converters（Smallpdf/iLovePDF/Canva）** | 免费、快 | 图表质量 "Poor"、自定义字体 "Poor"、多栏 "Moderate"，需大量手工清理；且文件要上传第三方（Deckary，2026-02-07） | 只适合纯文字页 |
| **SlideForge / Codia NoteSlide / ButDoc** | 明确区分 reconstruct / preserve / explain / split，**转换前先免费预检并告知"这图不适合还原"**（SlideForge，2026-07） | 按页收费（约 $0.10/页）；ButDoc 直言"重建是另一件更难的事，结果需要逐行检查"（[ButDoc](https://butdoc.com/image-to-pptx/)，2026-01-05） | **产品设计最诚实的一类**：不承诺 100%，先分类再收费 |

---

## 3. 中文社区真实声音（一手）

### 3.1 WPS 社区（官方论坛，最集中的一手差评，均为 2025-12 的 Nano Banana Pro 图片转 PPT 测评活动帖）

- **"可编辑元素仍然只有文字，图形元素无法被选中"**——用户上传流程图，转换后只有文字可改，图形仍是整块；"很多流程图无法被修改时只能通过截图或者修图的方式使用……**对于我来说，该图转换效果是失败的！**"（[77441](https://bbs.wps.cn/topic/77441)）
- **"文字结果错乱，无法选中"；柱形图"直接识别成了一个图片，无法形成动态图表"；"整个 PPT 背景很模糊，给人一种失真的感觉"；"大结构中的 3 个底框是无法选中的，这说明你已经无法改变整个 PPT 的结构了"**——并给出致命结论："像这样的 PPT 我就无法拿到会上去做解说的。"（[77508](https://bbs.wps.cn/topic/77508)）
- **"部分图片分辨率下降……放大展示时影响观感"；"箭头、图标、装饰框等形状被直接归入背景图片中，无法单独编辑"；"文字会有少许错位甚至遗漏，需大量手动修正，反而增加了工作负担"**（[77796](https://bbs.wps.cn/topic/77796)）
- 符号层面：**"➗、更号等符号识别效果不好"；"背景有时候会识别不出来或者仅识别部分"；"方框内文字识别效果和底图优化效果不佳"**（[77458](https://bbs.wps.cn/topic/77458)）
- 值得注意的"好评"也很克制：多位用户给"积极评价"的理由是"**尚处起步阶段**""降低门槛""作为底稿可用"，**没有一条说"可以直接交付"**。这是本品类口碑的典型形状：**宽容的好评 + 具体的差评**。

### 3.2 V2EX（技术用户，语气更直接）

- 2026-07-26《有没有牛逼的图片转 PPT 的工具》："经常有一些图片，比如 processon 或者 draw io 画的……**试过一些图片转 PPT 的 claude 技能，也让 AI 编过，效果都不行。这个技术有没有突破**"（905 次浏览，0 回复——**问的人多、答的人少**，说明没有公认解）——[t/1229851](https://www.v2ex.com/t/1229851)
- 2026-10-17《撸了个图片转 PPT 的站点》："之前一直在找图片转 PPT 的工具，**发现转出来一塌糊涂**，工作中又用的比较多，于是自己花了些时间撸了个 image2ppt.asia"（[t/1249637](https://www.v2ex.com/t/1249637)）——**"自己造工具"本身就是需求未被满足的最强信号**。
- 2021 年旧帖《有无快速图片转一份 PPT 的工具？》：五年过去问题仍在（sov2ex 检索）。

### 3.3 简书小样本横评（A 级，样本小但诚实，2026-01-31）

同一张图喂三个模型：
- Gemini：文字精准、布局出色、**图片部分基本为空**；
- 豆包：**会自作主张编写内容**、布局"自动重新梳理、不忠于原文"、图片"很差"；
- 千问：整体一般。
- 作者结论（也是社区最常见的"组合拳"）：**Gemini 取文字与结构 → 豆包/其他做美化**——即"一次转换拿不到成品，要两段式"。

### 3.4 什么值得买（B 级，但是目前对"翻车帖"最系统的二手整理，2026-08-28）

- 小红书"AI 一键生成 PPT 太辣眼睛"**1.5 万赞、1.5 万收藏**；"我的 GPT 做的 PPT 怎么这么丑"1 万赞；"用 AI 做 PPT 浪费了我一天时间，啥也没得到"盖了 **635 层楼**。
- 高赞评论点破预期错位："**不要指望 agent 直接给你生成完美的 PPT、自己一个字不用改**"；"**有一个成品在那儿，改起来会方便一点**"。
- 三工具横评结论："图片转可编辑 PPT **千问还原度最高**……但三者都存在**发挥不稳定**的问题"。
- 成本侧：生成一页约 **30–200 积分**，模型越贵消耗越快，**生成速度普遍偏慢**；会员是"月度总额度 + 滚动限速"结构。

### 3.5 B 站（只作热度与叙事口径，不作独立评价）

公开搜索 API 显示该话题在 2025-12 至 2026-10 形成稳定内容带，播放量集中在 2k–15k：
- 2025-12-22《1 分钟搞定❗把任意图片变为可编辑 PPT🔥》14,950 播放
- 2026-06-06《2 种方法，图片秒变可编辑 PPT！文字、图表、图标全活捉》10,611 播放
- 2025-08-21《硬核神器｜截图秒变 PPT｜排版、格式、图表都能一比一复刻》8,996 播放
- 2026-06-13《K03：codex 神级 skill，图片一键转化可编辑 ppt！》9,679 播放
- 2026-08-10《图片版 PPT 如何还原成可编辑 PPTX？办公提效必备！》2,019 播放
- 2026-09-27《一张 PPT 图片，看我 2 分钟把它还原可编辑版本》279 播放；2026-10-12《图片转可编辑 PPTX 升级 V5.4.1》173 播放

观察：**标题普遍用"秒变/一比一复刻/全活捉"，且 2026 年下半年起叙事从"某产品"转向"Codex/Claude Skill + 工作流"**（与 V2EX、GitHub 侧的 skill 爆发同向）。标题承诺与 §3.1 的用户实测形成明显反差。

### 3.6 小红书（未能直接取证，仅记录可达性）

登录墙，未绕过。可间接确认其为本品类主要流量入口：黑猫投诉中多起"在小红书看到 AI 做 PPT 广告→加微信/付费→不满意→退款难"（如 [Gaippt 投诉](https://tousu.sina.com.cn/complaint/view/17389268568)、[大城语墨投诉](https://tousu.sina.cn/complaint/view/17390669841)）。**小红书的角色更像"获客渠道"而非"评价池"，这会影响后续调研设计。**

---

## 4. 现成横评清单（可直接引用/复核）

| # | 标题 | 来源/日期 | 核心结论摘录 | 偏见提示 |
|---|---|---|---|---|
| 1 | [图片素材堆成山却不会做 PPT？深度体验 5 款能"图转 PPT"的 AI 工具](https://blog.csdn.net/daxiongbaodian24/article/details/167301810) | CSDN，2026-10-09 | 智在PPT（对象化还原最好）、讯飞智文（**无此功能**）、百度文库（仅 OCR 生大纲）、Kimi（重排）、WPS（文字强、复杂版式需二次加工） | 同一作者两篇"横评"均突出智在PPT，属 GEO 分发内容，**排名不可信，能力描述可参考** |
| 2 | [告别手敲 PPT：图转 PPT 工具横评](https://blog.csdn.net/daxiongbaodian24/article/details/166866320) | CSDN，2026-09-30 | Kimi 还原 7–8 成；WPS 表格/文字强、装饰形状会被合并；百度文库不还原布局 | 同上 |
| 3 | [图转 PPT 怎么把图片还原成可编辑幻灯片？实测 8 款工具](https://www.cnblogs.com/zzppt/p/23294146) | 博客园，2026-10-14 | 提出 **L1/L2/L3 能力分层**；实测三类素材（拍照旧 PPT、海报扫描件、白板流程图）；承认超长图/潦草手写会失准 | 推广智在PPT，但分层框架有独立价值 |
| 4 | [翻完十几条万赞翻车帖，我整理出 AI 做 PPT 什么时候能信](https://post.smzdm.com/p/aqrxkev7/) | 什么值得买，2026-08-28 | 引小红书 1.5 万赞翻车帖；千问还原度最高但"三款都不稳定"；积分 30–200/页；建议留 30% 时间做微调 | 二手转述，但**是目前最好的"用户预期管理"材料** |
| 5 | [Banana/GPT 生成的 PPT 如何编辑？2 款免费 AI 神器](https://m.163.com/dy/article/KUATCIKM05169CIL.html) | 秋叶PPT/网易，2026-06-01 | WPS AIPPT 免费、文字可拆但**字体变宋体**；设计感强的页面**右栏正文拆不出来**；文多多拆分效果更好 | 带课程引流，实测截图可信 |
| 6 | [AI 工具在图片转 PPT 的比较](https://www.jianshu.com/p/a4cc8834366c) | 简书，2026-01-31 | Gemini 文字/布局好但图片为空；豆包会改内容；建议 Gemini+豆包组合 | 个人小样本，平台已标"疑似 AI 辅助生成" |
| 7 | [PDF to PowerPoint: 5 Best Conversion Methods Compared](https://deckary.com/blog/pdf-to-powerpoint) | Deckary，2026-02-07 | 200+ 份 PDF 实操；字体替换、文本框碎片化、图表拍平；Acrobat 最强但仍有边界 | 服务商博客，技术描述与 Reddit 互证 |
| 8 | [Image to editable PowerPoint: what "converted" actually means](https://slideforge.dev/blog/image-to-editable-powerpoint) | SlideForge，2026-07-14 | stuffer/reconstructor 二分 + **30 秒测试**；"不肯承认边界的工具会把密集看板重画成看起来很自信的垃圾" | 厂商博客，但**主动劝退不适用场景**，可信度较高 |
| 9 | ReFigBench（arXiv 2609.18844） | 2026-09-16 | 1000 张真实论文概览图、4 个模型家族、10 种配置：**感知仍是瓶颈**；专用 PPTX 工作流在**所有配置下都会抹掉原生连接线**；同一模型换 harness 分数就变；最强 agent 仍达不到评分上限 | 学术基准，**本调研最硬的技术证据** |
| 10 | Images2Slides（arXiv 2602.07645，WWW'26 Companion） | 2026-04 | 元素回收率 0.989、文字 CER 0.033，但**文本区域布局 IoU 仅 0.364**（图片区域 0.644） | 学术管线，说明"字对了、位置错了"是结构性现象 |

---

## 5. 英文社区对照

### 5.1 Reddit（r/powerpoint 为主，2025–2026）

- **r/powerpoint, 2026-07-28**《Reliable way to convert a pdf to powerpoint when the source is image-heavy?》
  - 原帖："**Every time I convert a pdf to powerpoint the images flatten and text becomes uneditable.** On Windows with 365 — is there a method that keeps things editable, or is manual rebuild the only real option?"
  - 高赞回复（u/jkorchok）："When converting from PDF, **you'll never get the structure that is in a native PowerPoint deck**… you'll always get a better file with more long-term use if you **re-create** the deck."
  - 另一回复："It really depends on the PDF. **If the PDF is flattened, the structure will be lost.** … Acrobat Distiller does a pretty good job (including OCR), **but even Acrobat cannot do wonders.**"
  - → 英文侧的技术共识：**结果的上限由源文件是否矢量化决定，而不由工具决定。**

- **r/powerpoint, 2025-10**《How can I convert PDF to Powerpoint without butchering…》
  - "Directly converting PDF to Powerpoint turned out to be an option that must be avoided at all costs as it **butchers the equations beyond recognition**."
  - 回复："**Equations converted to PDF become brain-dead and must be redone**… If you don't need working equations, you can do screen shots of the equations."
  - → **公式是公认的不可逆项**，连"保真优先"的方案也建议退回截图。

- **r/powerpoint, 2026-02-26**《ChatGPT generated diagrams to editable PPT》
  - 原帖："ChatGPT generates great diagram images… I was looking for a way to convert this into an editable PPT form. **Couldn't find anything useful.**"
  - 实际解决方式（评论）："In the end, **I took a screenshot of the image and pasted it into a PPT slide**…"（即放弃转换）
  - → 与中文侧"AI 生图 → 可编辑"的需求完全同构，答案同样是"没有好办法"。

- **r/powerpoint, 2026-05-20**《Getting AI to make a Powerpoint》
  - "when I try to **recreate** the entire slide as a PowerPoint file, it **looks really rough and unprofessional**… I can easily copy the image into a slide, but then I can't edit the text."
  - 高赞回复："I'd avoid trying to recreate the AI image directly… That usually turns into either **a flat image you can't edit, or a rough layout that needs a ton of cleanup**."
  - → **"二选一困境"的英文原话**：要么不可编辑，要么可编辑但很粗糙。

- **r/ChatGPT, 2026-04-25**《Open source tool to convert GPT image 2 to editable slide》
  - 两条现实路径：① "use codex / cc to **convert to SVG**, then edit in Figma"——"works incredibly well **if the image only contains simple shapes and diagrams**"；② 自建 `px-image2pptx`（OCR + 定位）。
  - → 与中文 Codex Skill 热潮同源，**能力边界也一致：简单图形可以，复杂图形不行**。

- **r/notebooklm, 2026-01-06**：NotebookLM 输出静态 PDF，"You can't edit the text, change translations, or fix layouts without recreate everything from scratch"；开发者用 OCR+OpenCV 去字补背景再重建文本框——**只解决"字"，不解决"图"**。

### 5.2 Hacker News（负面信号）

Algolia 检索 `editable powerpoint` / `pdf to pptx`：相关 story 点数 1–17，评论 0–4，且几乎全是 Show HN 自荐（Paper2Any 13 pts 为最高）。**结论：HN 上没有关于"图片转可编辑 PPT"质量的技术讨论**——该问题在英文技术圈被视为"文档转换的脏活"，而非值得攻克的通用问题。引用时不宜虚构热度。

### 5.3 官方方案的实际评价（汇总）

| 方案 | 真实定位 | 对"图片型 PPT"的有效性 |
|---|---|---|
| Microsoft PDF Reflow | Word 的 PDF 导入，面向**文档** | 对幻灯片版式基本无效；微软自认"可能不完全一样"，表格/边框/分页会坏 |
| Adobe Acrobat PDF→PPT | 矢量 PDF 的最佳商用路径 | **仅当 PDF 含矢量文字/图形**；缺字体时把文字栅格化；渐变/组合形状/图表会拍平 |
| Google Slides | 无图片转对象能力；Drive OCR 只出 Docs 纯文本 | 不适用（学术管线 Images2Slides 是外挂，不是官方功能） |

---

## 6. 技术难点共识：为什么"图片 → 可编辑 PPT"难

### 6.1 本质：这是一个"逆向工程 + 重建"问题，不是"格式转换"

PDF/PPTX 是**结构化文档**（对象树、母版、占位符、继承样式）；图片是**像素**。转换等于让模型从像素反推出对象树，并且要同时满足两个互相拉扯的目标：**保真（看起来一样）** 与 **可编辑（结构对）**。ReFigBench 直接把这句话写进摘要："**the tension between fidelity and editability as the central challenge**"。

### 6.2 六个硬难点（按"目前是否可解"排序）

1. **版面/坐标还原（当前最大瓶颈，且被低估）**
   - Images2Slides 在受控基准上：元素回收率 0.989、文字 CER 0.033（字几乎全对），但**文本区域布局 IoU 仅 0.364**——意思是"字对了，但位置平均只对三分之一强"。
   - ReFigBench："**Perception remains a bottleneck that iterative rendering only partly repays**"（感知是瓶颈，反复渲染只能部分弥补）。
   - 后果：用户看到"字都能改"先惊喜，然后发现**每一块都要重新拖位置**——这正是 WPS 社区"需大量手动修正，反而增加了工作负担"的技术解释。

2. **图形/箭头/连接线（结构性失败，且是"看起来能改"的假象）**
   - ReFigBench 最刺眼的一条：**"The specialized workflow erases native connectors in every configuration"**——专用 PPTX 工作流在**所有**模型/harness 组合下都会把原生连接线抹掉（变成图片或散落形状）。
   - 用户侧对应："箭头、图标、装饰框被直接归入背景图片"（WPS 77796）、"图形元素无法被选中"（77441）。
   - 这是"**只能改字不能改图**"的根因：模型能可靠输出文本框，但把矢量图形重建成**可编辑、连接关系正确**的原生形状，成本高、收益低，产品侧普遍选择"并进背景图"。

3. **字体（中文场景的头号体验杀手）**
   - 字体不在本机 → 替换 → 换行/间距/整页版式变化（Deckary）；中文默认落回**宋体**（秋叶实测）。
   - 更极端：缺字体时 Acrobat 类工具**直接把文字渲染成图片**以保外观（PyMuPDF #4999）——用户于是得到"导出后还是图片"。
   - 中文特有：艺术字、书法字体、圆体/手写体几乎无法匹配；字体授权也阻止嵌入。

4. **图表 / SmartArt / 表格**
   - 图表：视觉上可重建，但**数据不在图里**——只能读刻度估值；产品普遍退化为图片（WPS 77508）。
   - SmartArt：其本质是"布局算法 + 关系模型"，逆向时既没有布局参数也没有层级语义；ReFigBench 的连接线结论同样适用于 SmartArt 的连线与从属关系。
   - 表格：简单表可成原生表（WPS 被好评的点），但合并单元格、单元格间距、边框样式易坏（微软自述）。

5. **渐变 / 阴影 / 透明 / 3D / 纹理**
   - 这些是"渲染结果"，没有可反推的参数；重建只能近似（多层半透明叠加尤其）。
   - 产品策略分两派：**拍平成图**（保真、不可编辑）或**近似重画**（可编辑、失真）。SlideForge 的 "preserve vs reconstruct" 就是把这条分界线产品化。

6. **公式 / 特殊符号 / 上下标**
   - Reddit 共识："equations converted to PDF become brain-dead"；中文侧 "➗、√ 识别效果不好"。
   - 公式要变成 OMML 原生对象，需要专门识别与排版引擎；当前多数方案输出图片或纯文本，**公式基本不可编辑**。

### 6.3 一个被忽略的工程事实：结果不稳定、不可复现

- ReFigBench："**the same model gains from the specialized workflow inside one harness and loses inside the other**，and the harness shifts scores even under an identical direct prompt"——**同一模型、同一提示，换个执行框架分数就变**。
- 日文技术博客对 PDF Reflow："同じPDFでもWord変換のたびに微妙に異なる結果になる"（同一 PDF 每次结果略有不同），**无法构建可复现流水线**。
- 产品侧对应："三者都存在发挥不稳定的问题"（什么值得买横评）。
- → 对用户意味着：**同一份图，今天转得好，明天可能转得差；不能作为生产流程的一环，只能作为"抽奖式预处理"。**

### 6.4 业内给出的"诚实答案"

- 能做就做、不能做就明说：SlideForge 的 **reconstruct / preserve / explain / split** 四分类，转换前免费预检并给置信度。
- 复杂图不要硬转：figedit 的规则是"**只有用三五笔基础图元能画得像的图形才允许 redraw**"，复杂轮廓一律保留为素材；Image2PPT 也承认"复杂插图、照片、无法可靠测量的局部效果会保留为独立图片资产"。
- 矢量优先：**能从源头拿 PDF/SVG 就不要走截图**（Deckary、SlideForge、Reddit 三方一致）。

---

## 7. 关键失败模式清单（按用户踩坑频率排序）

| # | 失败模式 | 用户原话/证据 | 频率判断 |
|---|---|---|---|
| 1 | **导出后还是图片 / 伪可编辑**（整页被当背景图，只能整体缩放） | "可编辑元素仍然只有文字"（WPS 77441）；"most converters don't convert anything — they paste your picture and rename the file .pptx"（SlideForge） | ★★★★★ 最常见，且最难在购买前发现 |
| 2 | **图形/箭头/图标并入背景，无法单独选中**（只能改字不能改图） | WPS 77796、77508；ReFigBench "connectors erased in every configuration" | ★★★★★ |
| 3 | **错字/漏字/乱码**（中文标点、全角半角、特殊符号、上下标） | WPS 77458（➗、√）；简书（豆包识别错误多）；WPS 77796（"错位甚至遗漏"） | ★★★★★ |
| 4 | **版式漂移/元素错位**（字对了但位置全偏，需逐块拖） | Images2Slides IoU 0.364；WPS 77796；CSDN"需手动调整位置和层次" | ★★★★☆ |
| 5 | **字体被替换**（中文普遍变宋体；换行/间距连带变化） | 秋叶实测；Deckary "font substitution… changes line breaks, spacing, and sometimes overall slide layout" | ★★★★☆ |
| 6 | **图表变静态图片，数据不可改** | WPS 77508"柱形图直接识别成图片，无法形成动态图表"；Deckary 图表 "Poor" | ★★★★☆ |
| 7 | **图片分辨率下降 / 背景模糊 / 二次压缩** | WPS 77796"分辨率下降…放大展示影响观感"；77508"整个 PPT 背景很模糊" | ★★★☆☆ |
| 8 | **收费与额度套路**：免费试用→导出收费；"终身会员"后专业版再收费；积分/限速；虚拟商品不退 | 黑猫：299 元终身会员仍需再付费（[链接](https://tousu.sina.com.cn/complaint/view/17401872997/)）；消费保：熊猫办公 AI 功能二次充值、59 元拒退；SMZDM：30–200 积分/页 + 滚动限速 | ★★★★☆（损失最直接） |
| 9 | **长图/多页/批量失败**（十几页拼一张长图解析受限） | 博客园自述边界；WPS 多页需逐页 | ★★★☆☆ |
| 10 | **结构不可维护**（母版/版式/占位符全丢，后续改版等于重做） | Reddit u/jkorchok："you'll never get the structure that is in a native PowerPoint deck" | ★★★☆☆（专业用户最痛） |
| 11 | **公式变图或乱码** | Reddit "butchers the equations beyond recognition"；中文符号识别差 | ★★★☆☆（学术/理工场景致命） |
| 12 | **拍照/白板场景额外失败**：透视、反光、阴影、手写潦草 | 博客园实测"个别潦草字词有误差"；SlideForge 将 whiteboard photo 列为需预检类别 | ★★★☆☆ |

> 另有两条"元级"坑：
> - **把"AI 生成 PPT"当成"图片转 PPT"**：前者是重排/生成（豆包会改内容、百度文库只取大纲），买错品类必然翻车。
> - **只看宣传语"图层可分离/字体还原准"**：WPS 官方就是这么写的，而实测结论是"可编辑元素仍然只有文字"。**宣传语描述的是能力上限，不是默认结果。**

---

## 8. 分场景效果预期（综合证据的主观评分，满分 100）

评分口径：**"不改任何东西直接能拿去讲/交付"= 90+；"改 10 分钟能用"= 75；"改半小时以上或只能当参考"= 50 以下。** 分数为综合推断，非任一来源直接给出。

| 场景 | 典型输入 | 现在能做到 | 分数 | 主要瓶颈 | 建议 |
|---|---|---|---|---|---|
| **A. 矢量 PDF（PPT 导出，非扫描）** | Acrobat/Keynote 导出的 PDF | 文字、矢量形状、表格基本可编辑；复杂渐变/组合形状可能拍平 | **80–90** | 字体是否嵌入；图表数据 | **唯一"接近可用"的场景**。优先 Acrobat / 矢量抽取，$0.01–0.02/页级别 |
| **B. 整页截图型 PPT（规整、纯文字+卡片+简单色块）** | 设计稿截图、课程截图 | 文字 90% 可拆，位置 70–80% 对；卡片底框/装饰条常并进背景 | **70–80** | 图形层、字体 | 可作"底稿"，预留 20–30% 时间微调；WPS AIPPT 免费可先试 |
| **C. 扫描件（印刷体、平整、清晰）** | 扫描仪 300dpi | 文字可读，表格结构部分保留；图片与装饰丢失 | **60–70** | 去噪、倾斜、表格线 | 先做图像校正再转；别期待图表 |
| **D. AI 生图整页 PPT（Nano Banana / GPT-Image 生成）** | 艺术字、渐变背景、插画式排版 | 文字可拆但常漏行/错字；**背景被重绘后模糊**；插画/图标不可编辑 | **45–60** | 生成图本身无结构；艺术字与背景强耦合 | 目前最热的"伪需求"：**生成时就让模型输出结构化稿（HTML/pptx），不要先生成图再反解** |
| **E. 会议白板照片（手写+箭头）** | 手机拍白板 | 手写字可识别（潦草字有误差）；箭头/框可重建为形状（部分工具）；透视需先校正 | **40–55** | 透视/反光、手写体、箭头拓扑 | 只有明确做 L3 的工具能碰；否则手抄更快 |
| **F. 手机拍的幻灯片（会场/屏幕）** | 透视、摩尔纹、反光、暗角 | 文字识别率明显下降；版式基本不可信 | **30–45** | 成像质量 | **不推荐**。若必须，先做透视校正+去摩尔纹，再按 B 处理 |
| **G. 密集信息图 / 科研图 / 数据看板** | 几十个标签、细线、图例 | 文字能读，结构几乎不可重建；强行重建会"看起来很自信地错" | **30–45** | 元素密度、连线、图层 | 走 "preserve"（保留原图 + 重做关键页），不要 reconstruct |
| **H. 图片型 PPTX（每页是一张图）** | 别人发来的"假 PPT" | 等价于 B/C，取决于图片质量；母版信息已彻底丢失 | **50–70** | 源图质量 | 同上；注意这类文件常是"导出即图"，无解 |

**一句话版本：**
- **能做到 80 分的**：矢量 PDF（A）、规整截图纯文字页（B）。
- **只能到 40 分的**：手机拍屏幕（F）、密集信息图/科研图（G）、白板照片（E）。
- **最尴尬的是 D（AI 生图）**：需求最旺、满意度最低——因为它的"设计感"恰恰来自不可结构化的像素效果（渐变、光效、插画），而这正是重建最做不好的部分。

---

## 9. 给后续方案设计的 6 条硬约束（从证据反推）

1. **不要承诺"还原"，承诺"分层交付"**：文字层 / 形状层 / 图表层 / 背景层分别标注可信度，让用户知道哪层要自己动手。
2. **先分类再转换**（SlideForge 模式）：输入是矢量 PDF、截图、照片、AI 生图，走的管线完全不同；对 F/G 类直接劝退或转 "preserve"。
3. **转换前必须能预检**：给出"预计可编辑元素比例"，比任何营销话术都更能降低退款率（黑猫投诉的核心是预期落差，不是效果本身）。
4. **字体策略要前置**：列出缺失字体、给出替代建议、允许"文字转图保版式"作为显式选项（而不是偷偷栅格化）。
5. **图表要么给数据表，要么明说"这是图片"**：半可编辑（图形能选、数据没有）是最差体验。
6. **稳定性要写进 SLA**：同一输入结果不稳定是当前行业通病；产品侧应支持"重跑/换模型"并保留中间产物（区域 JSON），否则无法进入生产流程。

---

## 10. 未解问题 / 下一步建议

- **小红书一手语料缺失**：需要登录态或第三方数据（新红/千瓜）才能做"笔记级"情感分析。当前只能用二手转述，建议后续单独补。
- **B 站评论区抓取失败**：若要量化 UP 主测评的"翻车率"，需用带 cookie 的接口或人工看 3–5 条高播放视频。
- **缺少独立第三方横评**：现有中文"横评"高度集中于同一 SEO 分发网络（CSDN/博客园/知乎同一作者），**排名不可信**；英文侧只有厂商博客与学术基准。建议自建一个小规模盲测（10 张图 × 5 工具 × 3 指标：文字 CER、位置 IoU、可编辑元素数），这比引用任何现有测评都更有说服力。
- **价格信息时效性强**：WPS AIPPT 目前免费、豆包工作 30 天会员等均可能变化，落地前需复核。

---

## 11. 来源清单（按引用顺序，含日期）

**中文一手**
1. WPS 社区《图片转换 PPT 流程中，一直以来存在的问题 Nano 能否解决？》2025-12-14 — https://bbs.wps.cn/topic/77441
2. WPS 社区《关于 WPS AIPPT 支持 Nano Banana Pro 图片转 PPT 编辑功能小白的一点体会》2025-12-15 — https://bbs.wps.cn/topic/77508
3. WPS 社区《WPS AI "Nano 图片转 PPT"功能使用测评》2025-12-17 — https://bbs.wps.cn/topic/77796
4. WPS 社区《Nano Banana Pro 图片转 PPT 体验与优化建议》2025-12-15 — https://bbs.wps.cn/topic/77458
5. V2EX《有没有牛逼的图片转 PPT 的工具》2026-07-26 — https://www.v2ex.com/t/1229851
6. V2EX《撸了个图片转 PPT 的站点，不知道有没有市场》2026-10-17 — https://www.v2ex.com/t/1249637
7. 简书《AI 工具在图片转 PPT 的比较》2026-01-31 — https://www.jianshu.com/p/a4cc8834366c
8. 什么值得买《翻完十几条万赞翻车帖，我整理出 AI 做 PPT 什么时候能信》2026-08-28 — https://post.smzdm.com/p/aqrxkev7/
9. 秋叶PPT/网易《Banana/GPT 生成的 PPT 如何编辑？推荐这 2 款免费 AI 神器》2026-06-01 — https://m.163.com/dy/article/KUATCIKM05169CIL.html
10. 博客园《图转 PPT 怎么把图片还原成可编辑幻灯片？实测 8 款工具》2026-10-14 — https://www.cnblogs.com/zzppt/p/23294146
11. CSDN《图片素材堆成山却不会做 PPT？深度体验 5 款…》2026-10-09 — https://blog.csdn.net/daxiongbaodian24/article/details/167301810
12. CSDN《告别手敲 PPT：图转 PPT 工具横评》2026-09-30 — https://blog.csdn.net/daxiongbaodian24/article/details/166866320
13. 黑猫投诉：aippt 终身会员后仍要付费 2025-09-25 — https://tousu.sina.com.cn/complaint/view/17401872997/
14. 黑猫投诉：Gaippt 免费试用无法使用 2025-10-27 — https://tousu.sina.com.cn/complaint/view/17389268568
15. 消费保：熊猫办公 AI 生成 PPT 拒退 59 元 — https://www.xfb315.com/brands/38648.html
16. WPS 官方《PPT 嵌入字体怎么设置：防止演示文稿字体乱码》2026-07-13 — https://www.wps.cn/article/ppt-embed-fonts-prevent-garbled.html

**英文社区 / 官方**
17. r/powerpoint《Reliable way to convert a pdf to powerpoint when the source is image-heavy?》2026-07-28 — https://www.reddit.com/r/powerpoint/comments/1v8nvlh/
18. r/powerpoint《How can I convert PDF to Powerpoint without butchering…》2025-10 — https://www.reddit.com/r/powerpoint/comments/1n6rdxq/
19. r/powerpoint《ChatGPT generated diagrams to editable PPT》2026-02-26 — https://www.reddit.com/r/powerpoint/comments/1rfd7vr/
20. r/powerpoint《Getting AI to make a Powerpoint》2026-05-20 — https://www.reddit.com/r/powerpoint/comments/1tj38gq/
21. r/ChatGPT《Open source tool to convert GPT image 2 to editable slide》2026-04-25 — https://www.reddit.com/r/ChatGPT/comments/1suwjp8/
22. r/notebooklm《Fixed the biggest pain point of NotebookLM…》2026-01-06 — https://www.reddit.com/r/notebooklm/comments/1q5k50v/
23. Deckary《PDF to PowerPoint: 5 Best Conversion Methods Compared》2026-02-07 — https://deckary.com/blog/pdf-to-powerpoint
24. SlideForge《Image to editable PowerPoint: what "converted" actually means》2026-07-14 — https://slideforge.dev/blog/image-to-editable-powerpoint
25. ButDoc《Image to PPTX》2026-01-05 — https://butdoc.com/image-to-pptx/
26. EasyPDF《How to Edit a PDF in Word (PDF Reflow) and What It Breaks》2026-10-08 — https://www.easypdf.fr/edit-pdf-in-word
27. Flipsnack《How to Edit a PDF in Word (And When It's Not Worth It)》2026-06-10 — https://blog.flipsnack.com/how-to-edit-a-pdf-in-word/
28. PyMuPDF Discussion #4999《Converting pdf to pptx, some text became images》2026-05-21 — https://github.com/pymupdf/PyMuPDF/discussions/4999
29. Mapsoft《Converting PDF to PowerPoint》2026-03-16 — https://mapsoft.com/posts/convert-pdf-to-powerpoint.html
30. Tutkit《Convert PDF to PowerPoint and optimize》2024-12-15 — https://www.tutkit.com/en/text-tutorials/4615-convert-and-optimize-pdf-to-powerpoint

**学术 / 技术**
31. ReFigBench: Benchmarking Scientific Figure Reconstruction as Editable PowerPoint Artifacts, arXiv:2609.18844, 2026-09-16 — https://arxiv.org/abs/2609.18844
32. From Dead Pixels to Editable Slides (Images2Slides), WWW'26 Companion, arXiv:2602.07645, 2026-04 — https://ar5iv.labs.arxiv.org/html/2602.07645
33. DrawAI: Agentic Benchmark and Workflow for Making Raster Images Editable, arXiv:2608.00548, 2026-07-31 — https://arxiv.org/html/2608.00548
34. Image2PPT README（能力边界自述）2026-08-24 — https://github.com/Paul-Jeo/Image2PPT
35. figedit SKILL.md（矢量重建的限制）2026-06-19 — https://github.com/giszzt/figedit/blob/main/SKILL.md
36. slide-alchemy README（"不是把整页截图塞回 PowerPoint 就称为可编辑"）2026-06-12 — https://github.com/CodingFeng101/slide-alchemy/blob/main/README.zh-CN.md
37. image-to-editable-pptx（PageIR/PptxGenJS 工作流）2026-10-10 — https://github.com/algerchen2024/image-to-editable-pptx

**B 站（话题热度，非评价）**
38. BV19xBpB7EN5 2025-12-22 / 14,950 播放 — https://www.bilibili.com/video/BV19xBpB7EN5
39. BV1fx7S6JELD 2026-06-06 / 10,611 播放 — https://www.bilibili.com/video/BV1fx7S6JELD
40. BV1o5JJ6AEMg 2026-06-13 / 9,679 播放 — https://www.bilibili.com/video/BV1o5JJ6AEMg
41. BV1WCYQzDEG6 2025-08-21 / 8,996 播放 — https://www.bilibili.com/video/BV1WCYQzDEG6
42. BV1msat6rEcT 2026-09-27 / 279 播放 — https://www.bilibili.com/video/BV1msat6rEcT

---

*说明：本笔记中的"分数"与"频率星级"为跨来源综合推断，非任一来源直接结论；引用原话均保留原始表述（含错别字），以便复核。*
