# 复刻 PPT（结构参考 + 真设计）试验场

日期：2026-09-03  
状态：已对齐，产品面在首页美化页与模板库，不并大纲工作台

## 问题

用户有一份现成 PPT（壳），要换上自己的内容，但不要「旧页涂改」，也不要丢掉原页另起炉灶。需要的是：参考壳的**结构**，按新材料做**真设计**，再转可编辑 PPTX。

## 产品合同

- **复刻的是画面 + 结构**：页序跟壳；媒介/场景/构图/道具跟壳；每页分区、槽位数、谁大谁小跟壳。
- **替换的是内容身份**：标题、正文、数字、旧产品名、旧界面文案换成用户文案；壳上的旧字、Logo、人名不得保留。
- **不是另做一页商务 PPT**：禁止把插画壳抽成「几张卡」后改成白底信息图或按主题另配医院摄影。
- **配色（C）**：每套可切换。默认「跟随原页」；可改为「只换色板」（场景仍跟壳）。

## 范围

做：

- 产品页 `/beautify`（首页「PPT美化」、模板库「自己的 PPT」、侧栏「PPT 美化」）。旧 `/tools/replicate-ppt.html` 跳转过去。不改大纲→风格→整套生成。
- 上传壳：PDF 按页拆图，或 PNG/JPG/WebP，**一次最多 40 页**（与整套解析对齐）。PPTX 提示先另存 PDF。
- 逐页填新文案（可给主题、PPT 大纲、官方材料；大纲铺到壳页数上，默认可完善创新）。
- 每页：VLM 读结构（失败降级）→ `/images/edits` 图生图。
- 转可编辑异步排队；Codia 每任务 20 页，前端按 20 切批投递，页面不等转换完成。

不做：

- 不解析 PPTX 占位符、不服务端光栅化 PPTX、不改工作台状态机、不新造扣费键/价格。
- 不把复刻链进 `kind=template` 整套生成（官方模板仍走灌内容；自己的 PPT 走美化页）。

## 生成两拍

1. **结构卡（平台吸收，不计用户扣费）**  
   VLM 看壳图，输出：family / zones / slots / hierarchy / world / forbidden。失败则空卡，仍继续生图。
2. **图生图**  
   底图 + `buildReplicateCopyPrompt`（只含本页文案，不走风格包/主题配图）+ `buildReplicateInstruction`（保画面、槽位、配色策略）。

## 接口

`POST /api/single-page/generate` 增加：

- `mode: "replicate"`（缺省保持原单页行为）
- `colorMode: "new-theme" | "follow-shell"`（缺省 `follow-shell`）
- 复刻时 `imagePath` 必填

硬门：`assertFeatureVisible('ppt_replicate', user)`，开关默认 `beta`。  
其余复用：`POST /api/assets/upload`、`POST /api/single-page/refine`、`POST /api/editable-conversions`。

## 计费与限制

- 生成：现有单页 10🌟/页，失败退星，可带 `requestId`。
- 可编辑：现有 upload 源 20🌟/页，切批前整单估价，余额不够一次 402、不建半套任务。
- 上传仍走单文件 30MB、每用户每小时 60 次。不另加页数产品上限。
- 生图串行，避免和全站并发抢到 409。

## 失败语义

- 单页失败标红，已扣星按单页失败退回，其余页继续。
- 结构卡失败不阻塞生图。
- 可编辑批次互相独立，进下载中心懒恢复。

## 以后并主路线

同一套「结构卡 + 锁结构 edits」接到 `kind=template` 与「用户上传 PPT 当壳」。试验场 HTML 可留作调试入口。
