# Spec · 模板化 PPT 生产管线（HTML 投影 + plan/apply 协议）

> 来源：本会话（2026-10-20 ~ 10-22）逐轮设计决策 + 仓库盘点 + 两份调研（agent 交互协议 / 无 PowerPoint 验收）。
> 状态：待发布到 issue tracker（`ready-for-agent`）。本仓库尚未配置 issue tracker，见文末「发布」。
> 词汇沿用仓库现有命名：国金模板体系、内容树、op 序列、槽位契约、版式、组件（dev）、主题（palette）、门禁。

---

## Problem Statement

我们要做的不是"把 PPT 转成 HTML 再转回去"，而是：**基于已有的优秀 PPT（国金模板 potx + 5 本获奖复刻稿），把内容与素材换成新的，稳定产出同样水准的新 PPT**。

现在这条路是断的：

- 模板（potx 24 版式 / 728 槽位）与内容（`内容树.json`）都在，但**没有 HTML 层**：非专家和 agent 都只能改 JSON 或 python 脚本，看不到版面，改不了"这一页长什么样"。
- 出稿只能靠 `build_page.py` 全量重建，**没有"提案—校验—确认—落盘"的中间态**：agent 一次性改一堆槽位，错了只能整册重来。
- 换组件、换版式、换主题**没有机器可执行的命令**，只有人肉改 Python。
- 验收靠 LibreOffice 与像素对照，**结构与真机兼容性没有门禁**（已实测发现 `presentation.xml` 子元素顺序违反 ECMA-376 XSD，三个产物全中）。
- 资产（74 个图片槽位、组件、10 套主题、logo 墙网格）**没有清单与库**，每次都要重新找。

结果：每次做新稿，仍要人从头理解模板、手改脚本；agent 无法安全参与；产出质量不可复现。

## Solution

建一条**以 potx 为唯一事实来源、以 `plan.json` 为唯一写原语的本地管线**：

```
内容/素材（文档、数据、图片）
   │  (人工或 agent)
   ▼
plan.json（语义寻址的命令集：改文字/换图/换组件/换版式/换主题）
   │  validate（门禁：容量、对比度、结构、复用作用域、权限档位）
   ▼
preview（HTML 投影 + 与 PPTX 的对照图）
   │  confirm（人确认，发 token）
   ▼
apply（staging 构建 → 门禁 → 原子提交 → 审计）
   ▼
PPTX（potx 母版/版式原样）+ HTML（同一份 op 序列的投影）
```

三个关键性质：

1. **同源**：HTML 与 PPTX 都从同一份 op 序列/槽位契约渲染，不出现两套真相；HTML 是编辑层，PPTX 是交付层。
2. **可回滚**：plan 是工件，apply 只认同一份 plan；失败时线上零改动；审计 JSONL 可重放、可撤销。
3. **可对话**：agent 产出的就是 plan；"帮我把这页换成三卡、主题换农业绿"= 一条 plan，而不是一段脚本。

## User Stories

1. 作为非专家的项目负责人，我想把一份项目资料（文字/数据/图片）丢进去就得到一份可编辑 PPT，以便不用理解版式也能出稿。
2. 作为非专家，我想在网页里看到每一页的真实版面，并直接点文字改字，以便不靠想象改内容。
3. 作为非专家，我想点一张图就能换掉，且新图自动保持比例不变形，以便不破坏版式。
4. 作为非专家，我想在字的长度超出槽位时被明确提示、并自动缩字到能放下，以便不会"字被裁掉"却不知道。
5. 作为非专家，我想一键换一套行业配色（10 套），以便同一份内容适配不同场合。
6. 作为非专家，我想把某一页从"四卡"换成"三卡"或"数据大字页"，且原有内容尽量保留，以便按内容多少调整版面。
7. 作为非专家，我想把某个组件（如结论条）换成另一种样式（胶囊条/数据条），以便微调观感而不破坏整册统一。
8. 作为非专家，我想在"应用"前看到前后对比图和校验结果，以便确认改动符合预期。
9. 作为非专家，我想随时撤销上一次应用，回到上一版，以便改错不慌。
10. 作为 agent（Claude Code/Codex/DSH），我想只产出一份 plan.json 就能完成整批修改，以便可复现、可审计、可重放。
11. 作为 agent，我想在写 plan 前 `describe` 出槽位/组件/主题清单与容量上限，以便不猜、不越界。
12. 作为 agent，我想提交 plan 后得到结构化的校验结果（哪些槽位超限、哪些对比度不足、影响哪些页），以便一次改全。
13. 作为 agent，我想用 `expect` 声明前置条件（当前值/哈希），以便命令错位时立刻失败而不是静默写错。
14. 作为 agent，我想通过语义寻址（`S07/LAYER_1_MOD_1_名称`、组名、组件 occurrence）定位目标，以便插入/删除后引用不错位。
15. 作为 agent，我想被权限档位约束（L0 读 / L1 内容 / L2 结构 / L3 主题与全局），以便不能意外重构整册。
16. 作为 agent，我想在预览阶段只拿到 PNG 路径与哈希、不拿 base64，以便不撑爆上下文。
17. 作为 agent，我想在 apply 失败时得到明确的错误码（E_CHARLIMIT / E_CONTRAST / E_CONFLICT / E_TIER / E_APPROVAL），以便按码修复。
18. 作为 agent，我想读每个版式的 `layout.md`（槽位/容量/示例/禁忌），以便一次就写对。
19. 作为设计师/维护者，我想资产库按 slot/component/theme/bitmap 四层组织，每条有 manifest、缩略图和标签，以便复用而不是重造。
20. 作为设计师，我想组件是可参数化的（logo 墙 12/26/48 槽网格、rail-steps 进度尺、四卡列），以便不同内容密度都能套。
21. 作为设计师，我想把"换组件"分三阶段推进（变体 → 版式 → 自由增删），以便先拿可控收益。
22. 作为维护者，我想所有改动只能通过 plan 写，禁止裸改 XML/PPTX，以便一致性不被破坏。
23. 作为维护者，我想 apply 使用 staging + 原子 rename，失败时线上零改动，以便没有"写了一半"的坏包。
24. 作为维护者，我想 content tree 是只读派生模型，内容写入内容表，以便树与模板不漂移。
25. 作为维护者，我想未改页跑逐 part 差异=0 的 verify，以便防范模板漂移。
26. 作为维护者，我想复用字段（赛事全称、项目名大字）必须显式 `scope`，以便"只改本页"与"改全册"不被混淆。
27. 作为维护者，我想有乐观锁（base.rev + sha256）与 deck.lock，以便并发写不会互相覆盖。
28. 作为维护者，我想审计日志是 append-only JSONL，以便复盘与追责。
29. 作为维护者，我想退出码稳定（0/1/2/3/4/5），以便 CI 与 agent 可脚本化。
30. 作为质量负责人，我想门禁包含：容量、对比度（≥4.5:1 且不豁免大字）、结构、复用作用域、权限，以便不是"看起来像"。
31. 作为质量负责人，我想 HTML 投影与 PPTX 回渲逐页 MAE ≤10，以便"编辑层"与"交付层"一致。
32. 作为质量负责人，我想复用结构差/骨架 IoU 口径对比原稿，以便"像不像人做的"有数。
33. 作为质量负责人，我想跑 ECMA-376 XSD 校验与 LibreOffice 打开，以便提前发现结构违规（已知 `presentation.xml` 子元素顺序问题）。
34. 作为质量负责人，我想 .potx 用 zip/XML 或换 Content-Type 的副本验收（python-pptx 直开不了），以便模板本身可验。
35. 作为交付负责人，我想有一份"打开即测"清单（≤8 条）交给真 PowerPoint 机器回归，以便补上代理验收的盲区。
36. 作为交付负责人，我想字体先嵌入（子集 + fntdata），以便换机器不回落。
37. 作为首批验收者，我想先做蓝海核卫士 13 页 + 参照稿 4 页，以便用真实获奖稿验证全链路。
38. 作为新项目使用者，我想同一套模板能复用到不同项目（只换内容与主题），以便越用越省。
39. 作为未来的面板用户，我想右侧可视化编辑器和 CLI/agent 共用同一套协议，以便不用维护两套逻辑。
40. 作为未来的批量使用者，我想同一份内容能生成多份（按主题/版式变体），以便一人产出多版。

## Implementation Decisions

### 架构与事实源

- **potx 为唯一事实源**：`国金模板.potx`（1 母版 + 24 版式 + 728 占位符）。HTML 是它的投影，不反向定义模板。
- **内容树为只读派生模型**：`内容树.json`（8 章/24 页/728 槽位/106 重复组/11 规则）由模板反算；内容写入内容表（JSON/CSV/Markdown），不回写树。
- **新增 `deck.json` 清单**：页序、每页来源（`spec:S07` / `fill` / `patch`）、主题、内容表引用。plan 依赖它计算影响面。
- **op 序列是渲染源**：`pipelines/award/spec/pages/S01-24.json` 同时驱动 `build_page.py`（→PPTX）与新的 HTML 投影渲染器（→HTML），保证同源。
- **`.potx` 读取**：python-pptx 不能直开 `.potx`（content-type 限制），统一走 zip/XML 解析或"换 Content-Type 的临时副本"。

### 协议：plan 作为唯一写原语

- 生命周期五拍：`describe → propose → validate/preview → confirm → apply`；apply 之外不碰成品。
- `plan.json` 顶层字段：`schema`（`htmlppt/plan@1`）、`plan_id`、`base`（`deck/rev/tree_sha256/pages[sha256]`）、`intent`、`actor`、`policy`（`max_tier/preview/confirm`）、`commands[]`。
- 命令集（tier）：
  - `content.set_text`（L1）：`target.slot`、`args.text/scope(slot|page|deck)/allow_overflow`
  - `content.set_image`（L1）：`path/fit(cover|contain)/alt`
  - `content.set_group`（L1）：`values[]/scope`
  - `component.replace`（L2）：`page/group/dev/occurrence` + `component/args/text_bind`
  - `layout.set`（L2）：`page/layout/bind{new:old}/drop[]`
  - `page.reorder` / `page.remove`（L2）
  - `theme.set`（L3）：`palette/roles{}/allow_unmanaged`
  - `doc.patch`（L3，逃生口）：RFC 6902 `add/remove/replace/test`
- 寻址：**语义寻址**，禁止下标（`ops[12]` 插一条即错位）。`expect` 支持 `{value}` 或 `{sha256}` 做前置条件。
- 幂等：每条命令带 `id` 与规范化哈希；`apply` 重放返回首次结果；禁止 `append/increment` 这类相对命令；跨命令依赖显式 `depends_on`。
- 复用字段必须显式 `scope`，否则 `E_REUSE_SCOPE`（如"赛事全称"跨 p1/p5）。
- 权限：L0 只读 / L1 内容 / L2 结构 / L3 主题与全局 / L4 导出；tier 由 op+scope 计算，超 `max_tier` 整单拒绝。
- 错误码：`E_SCHEMA/E_TARGET/E_EXPECT/E_CONFLICT/E_TIER/E_APPROVAL/E_REUSE_SCOPE/E_CHARLIMIT/E_CONTRAST/E_STRUCT/E_OVERLAP`；退出码 `0/1/2` + `3` 校验失败 / `4` 冲突 / `5` 权限不足。
- 并发：单写者 + `deck.lock`（PID/plan_id/超时）；乐观锁 `base.rev + tree_sha256 + pages[s]`；冲突返回三方差异，不自动 merge。
- 审计：append-only JSONL（plan_id/actor/op/target/before/after/gates/approval/rev）；`undo` 把 manifest 指回上一 rev。

### apply 的工程约束

- **staging + 原子提交**：写 `.htmlppt/staging/<plan_id>/` → 未改页 `build_page.py --verify`（逐 part 差异=0）→ 改过页 schema+渲染 → `check.py` 六组门禁 → manifest-last `os.replace`；失败线上零改动。
- `apply --dry-run` 等价于 validate+preview。
- `approval_token` 绑定 plan 规范化哈希 + `base.rev`，apply 重算，不一致 `E_APPROVAL`。

### HTML 投影（编辑层）

- 每版式一页 HTML，由同一份 op 序列 + 槽位契约渲染：`data-slot="S07/LAYER_1_MOD_1_名称"`、`data-dev="plain_card:2"`、`data-palette`。
- 编辑器支持：改文字（自动缩字适配）、换图（比例 cover/contain）、换组件变体、换版式、换主题；导出 `changes.json`（槽位寻址）。
- 写回两条路都支持：`changes.json` → 编译成 plan → apply（默认）；或直接改内容表/内容树（内部用户，需过门禁）。
- 只有带 `slot_id` 的 changes 才能回写源码；否则只能改成品（避免源码与成品分叉）。

### 组件库与资产库

- 四层：`slot`（74：logo 32 / photo 18 / document 12 / portrait 11 / map 1）、`component`（≈20 类 / 45 变体）、`theme`（10 套 palette）、`bitmap`（4 个艺术字位）。
- 组件参数化：logo 墙 `12/26/48` 槽 + 通栏；`rail-steps`（p04–p07 复用）；四卡列、结论条、数据条、胶囊、引号、时间轴、画的表格、证书宫格、团队卡、组织架构、柱状图、饼图、箭头流、地图位。
- 合规：logo（商标权）、人像（肖像权）、证书（编号脱敏）一律**中性占位**；蓝海核卫士 p09 含真名/编号，入库前脱敏。
- 入库主键 = 槽位/组件规格，不是图片文件（全库 0 位图，407 图位是描边框）。

### 契约文档与校验

- 每版式一份 `layout.md`（槽位表/容量/示例/禁忌）+ JSON Schema（plan 与 deck/layout/component manifest）+ 校验器（复用 `check.py` 六组 + `capacity.py` + 对比度 + 结构）。
- agent 操作手册遵循 Skills 模式（SKILL.md + references），规则正文不写进 Markdown 的 schema，而以 JSON Schema 为准。

### 验收（无 PowerPoint 代理链）

已实测可行的六层，按"从便宜到贵"排序，全绿才发：

| 层 | 工具 | 覆盖 | 关键判据 |
|---|---|---|---|
| OPC 包 | `verify_pkg.py`（zipfile + lxml） | CRC、Content-Types 覆盖、rels 悬空、重复 part、压缩方法、slide→layout→master、sldSz | 零错误 |
| 结构 | `xmllint --schema pml.xsd/dml-main.xsd`（ECMA-376 Transitional） | 元素顺序、必填属性、类型/枚举 | 全部 validates |
| 语义 | `ooxml-validate`（Open XML SDK 3.5.1 预编译二进制；`npx -y ooxml-validate@0.0.4`） | Microsoft365 conformance 的 Schema/Semantic/Package 校验 | exit 0 |
| 打开/渲染 | `soffice --headless --convert-to pdf` | 真引擎能否打开 | 只看 stderr 无 `Error:` + 产出存在 + 页数正确（**exit code 不可信**：截断 40% 的文件也返回 0） |
| potx | `verify_potx.py` | main CT=template.main+xml、master/layout 关系闭合、layout type 唯一 | 零错误（python-pptx 打不开 .potx，需换 CT 的临时副本或走 zip/XML） |
| 字体 | `verify_fonts.py`（fontTools） | fntdata→sfnt/EOT、fsType 允许、embeddedFontLst↔rels↔part 一致、码点覆盖 | 三方一致 |

- **已实测的真实缺陷（先修）**：
  1. `presentation.xml` 子元素顺序违规——`notesMasterIdLst` 必须在 `sldIdLst` **之前**；三个产物（prototype/gold/新作）全中；xmllint 与 Open XML SDK 两个独立来源同判。来源 `.cache/gen-xml.ts:1799`；修复参考 `bench/engines/hasasasa/scripts/embed_fonts.py::_reorder_pres_children`；改完必须真机回归。
  2. `新作-科创港6页.pptx` 另有 2 条 `Sch_AttributeValueDataTypeDetailed`：slide3/slide5 的 `<a:lin ang="21600000"` 越界（约束 ang<21600000），改成 0 即可。
- **字体实测**：Songti SC fsType=2（禁止嵌入）、Helvetica=0、Arial=8、Hiragino Sans GB=8、Heiti TC=0。字体策略必须按 fsType 白名单选，别用宋体做嵌入。
- 视觉口径：HTML↔PPTX 逐页 MAE ≤10；与原稿对比复用结构差/骨架 IoU（结构差÷原稿 edge 密度，绝对值不跨本比）。
- 真机：用户提供 PowerPoint 机器；我方出"打开即测"清单（≤8 条：打开无修复提示/翻页/字体不回落/占位符可选/potx 新建继承/补丁页正确/另存后仍嵌入/生僻字无豆腐块）与 3 份样本。

### 首批范围

- **蓝海核卫士 13 页**（纯形状稿：三件套、rail-steps、38 图位、结论条）+ **参照稿 4 页**（P3 拓扑 / P10 卡片 / P17 渐变 / P5 地图）。
- 字体先嵌入（子集 + fntdata）；模板重出（对比度不达标）后置。

## Testing Decisions

- **好测试的定义**：只测外部行为——`plan → artifacts + gate report` 的契约；不测内部函数、不测 Python 对象结构、不断言具体 XML 片段（除结构门禁本身）。
- **单一主缝（seam）**：`htmlppt plan validate|preview|apply` 的 CLI 契约（stdout 单个 JSON，stderr 日志，稳定退出码）。所有新能力都从这个缝驱动；理想情况下只新增这一个缝。
- **次级缝（复用现有）**：`build_page.py --verify`（逐 part 差异=0）、`check.py`（六组门禁）、`geodiff.py`/`pixdiff.py`（几何/像素）、`render.sh`（渲染）。不新增平行实现。
- **测试用例集**：
  - 夹具：蓝海核卫士 13 页、参照稿 18 页、gold-template 24 版式空页。
  - 正常路径：`content.set_text` 单槽 / 批量 / `scope=deck`；`layout.set` 换版式保内容；`theme.set` 十套 palette；`component.replace` 变体。
  - 边界与失败：超容量（E_CHARLIMIT）、对比度不足（E_CONTRAST）、下标寻址（E_SCHEMA）、`expect` 不匹配（E_EXPECT）、并发冲突（E_CONFLICT）、越权（E_TIER）、approval 不符（E_APPROVAL）。
  - 幂等：同一 plan 连跑两次，第二次为 no-op 且产物 sha256 不变。
  - 原子性：staging 中途 kill，产物目录零改动。
  - 同源性：HTML 截图 vs PPTX 回渲逐页 MAE ≤10。
  - 结构：XSD 校验全过（含 `presentation.xml` 顺序修复后）。
- **测试数据与黄金基线**：现有 `award-replica/*/复刻-pNN.png` 与 `gold-template/_验收对照/` 可直接作为像素/几何基线；新测试沿用 `accept.sh` 报告的格式。
- **CI 姿态**：先本地 `accept.sh --fast` + 新增 `plan` 契约测试；不引入新框架，沿用 python（pytest 可选，若加则单文件）。

## Out of Scope

- DSH 右侧可视化插件（协议先定，插件后做）。
- 自由拖拽排版 / 任意位置微调（会破坏模板几何）。
- 批量生成几十份、按客户分发（留接口，不做 UI）。
- 原生图表 / SmartArt / OLE / 动画 / 3D（本批稿为 0；检测到则告警并降级）。
- 多人实时协作 / CRDT / 云端 SaaS。
- 模板重出（主题对比度修复）与 24 版式之外的扩展页型（S25–S28 暂不入模板）。
- 从零生成顶级 HTMLPPT 的"自由创作"路线（作为备选，不纳入本 spec）。

## Further Notes

- **调研依据**：agent 协议调研（Terraform plan/apply、RFC 6902、Stripe 幂等、MCP、Skills、AGENTS.md、ffprobe/gh 的 JSON 契约）；验收调研（ECMA-376 XSD、Open XML SDK 需 dotnet、xmllint 可用、.potx 不能直开、LibreOffice 代理的盲区）。
- **已知坑**：① `presentation.xml` 顺序违规（三个产物全中）；② `a:lin ang="21600000"` 越界（新作 6 页稿 slide3/5）；②b 同一 `a:p` 多个 `a:pPr`（round-trip 18 页稿 16 处，XSD/SDK 均报错）；③ 主题 accent1 对比度 2.587:1 不达标；④ 模板未嵌字体；⑤ `extract_spec.py` 可能覆盖手改 spec（双源风险）；⑥ 编码/渲染需 `FONTCONFIG_FILE`；⑦ LibreOffice exit code 不可信；⑧ python-pptx 打不开 .potx；⑨ `retint.py` 只改 srgbClr，国金模板 108 处是 schemeClr 主题引用，换色需 `tools/theme-recolor.py`；⑩ 浅色主题（medical/bp）存在覆盖层文字对比度问题，见 ticket 14。
- **合规**：logo/人像/证书一律中性占位；证书编号脱敏；不存真实商业标识。
- **发布**：issue tracker 已配置为 Local markdown（`docs/agents/issue-tracker.md`），本 spec 对应 `.scratch/template-ppt-pipeline/spec.md`，13 张工单已发布在 `.scratch/template-ppt-pipeline/issues/`。
