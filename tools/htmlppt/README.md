# HTMLPPT · 深度调研与可运行原型

> 目标：**HTML 做幻灯片，并能精确导出为「可编辑」的 .pptx**（文字是原生文本框、形状是原生形状、不是整页截图）。
> 日期：2026-10-19 ｜ 全部结论均有来源链接；原型数字均为本机实跑。

---

## 快速开始（一个命令）

```bash
cd "/Users/an/Desktop/Atlas/PPT/HTML -ppt"
python3 cli/htmlppt.py doctor                    # 环境体检
python3 cli/htmlppt.py extract deck.pptx -o out/  # PPTX → 可编辑 HTML
python3 cli/htmlppt.py build out/deck.html -o rt/ # HTML → 可编辑 PPTX（13 项 gates）
python3 cli/htmlppt.py verify --pptx deck.pptx --html out/deck.html -o qa/
python3 cli/htmlppt.py stack deck.pptx -o loop/   # 闭环自检：extract→build→verify
```

> 实测（18 页真实国赛稿）：闭环 **13/13 gates、字符覆盖率 100%、回渲 MAE 19.96**、138 秒。
> 详见 [`工具说明.md`](工具说明.md)（人读版）与 [`cli/README.md`](cli/README.md)（命令参考）。

## 先看哪个

| 你想知道 | 打开 |
|---|---|
| **能不能把原生 PPT 转成 HTML（换背景/换图/换文案）** | [`pptx2html/README.md`](pptx2html/README.md)（反向技能，18 页真实稿实测） |
| **我要开始用，怎么用** | [`工具说明.md`](工具说明.md) · [`cli/README.md`](cli/README.md) |
| **本轮改了什么、硬数字、遗留** | [`deliverables/README.md`](deliverables/README.md) |
| **国赛级 PPT 做不做得到、还差什么** | [`gold/REPORT.md`](gold/REPORT.md)（参照稿拆解 + 页型覆盖 + 实测样张 + 5 个缺口） |
| **8 个开源引擎谁强谁弱、功能怎么分类、该集成什么** | [`bench/REPORT.md`](bench/REPORT.md)（横向实测 + 功能矩阵 + 选型集成建议） |
| **结论是什么、行业怎么做的、我们该怎么选** | [`调研报告-HTML转可编辑PPT-2026-10-19.md`](调研报告-HTML转可编辑PPT-2026-10-19.md) |
| **这种 HTML 到底该怎么写**（写内容的人看这个） | [`规范-HTMLPPT-HTML契约-v1.0.md`](规范-HTMLPPT-HTML契约-v1.0.md) |
| **怎么实现、架构、验收、里程碑**（工程师看这个） | [`技术方案-HTMLPPT-转换管线-v1.0.md`](技术方案-HTMLPPT-转换管线-v1.0.md) |
| **能跑的东西 + 实测数字** | [`prototype/README.md`](prototype/README.md) |
| **一手调研底稿**（90 / 651 / 697 行，带来源清单） | [`research/01`](research/01-oss-landscape.md) · [`research/02`](research/02-pptx-mapping-constraints.md) · [`research/03`](research/03-authoring-products.md) |

**一条命令验证原型：**

```bash
cd prototype && npm install && npm run build     # 约 9 秒，12 项 gates 全 PASS
open out/deck.pptx                              # 交付物
open out/diff/contact-sheet.png                 # HTML | PPTX | diff 三栏对照
```

---

## 能力矩阵（现在能做什么）

| 能力 | 状态 | 证据 |
|---|---|---|
| HTML → 可编辑 PPTX（文本/形状/图片/表格/渐变/SVG） | ✅ | `prototype/`，13 项 gates |
| SVG 曲线（C/S/Q/T/A）→ 原生 DrawingML 曲线 | ✅ 本轮新增 | `src/svgpaths.mjs`，样例 45 个 `a:cubicBezTo`、0 张 PNG |
| 字体嵌入（EOT/fntdata） | ✅ 本轮新增 | `EMBED_FONTS=1`，18 页实测 +210 KiB / 2 字重，四项验证通过 |
| PPTX → 可编辑 HTML（含背景层/组合/表格） | ✅ 本轮修复 5 类 bug | `pptx2html/`，18 页 MAE 19.84、911 对象、lossy 0 |
| 图片分类 + 槽位替换 + 背景组件 | ✅ 本轮新增 | 18 页实测：background 13 / content 50（可换）/ decoration 317 / covered 7；`htmlppt slots\|replace` |
| 闭环 PPTX→HTML→PPTX | ✅ | `htmlppt stack`，18 页 13/13 gates、覆盖 100% |
| 入口校验（Anthropic 式契约 lint） | ✅ 本轮新增 | `prototype/src/lint.mjs`，13 条规则，一次报全 |
| 逐页保真验收（MAE） | ✅ | `verify.py` / `htmlppt verify` |
| 跨引擎基准 | ✅ | `bench/`，8 引擎矩阵 |
| 图表 / SmartArt / 动画 / 母版继承 | ❌ v1 不做 | 见 `gold/REPORT.md` 缺口清单 |

## 30 秒版结论

1. **全行业只有一条可行路线**：受限 HTML 子集 → 无头浏览器量测 → 映射成原生 DrawingML。
   Marp / Slidev 的旧 pptx 导出都是整页截图（不可编辑）；Slidev 2026-09 才补上原生可编辑。
2. **Anthropic 官方 html2pptx 已弃用且不可商用**（proprietary，禁衍生）。可参考思想，不可搬代码。
3. **Manus 已推翻「网页生成 + 导出转换」改原生生成 .pptx**——HTML 应作为"作者界面"，OOXML 才是"交付骨架"。
4. **"精确"要拆成三个指标**：几何精确（能保证）、语义精确（能保证）、排版精确（只能接近；
   唯一破局手段是**按视觉行硬断行**）。
5. **8 个开源引擎横向实测后，自研基线综合第一**：唯一 6/6 闸门全过、MAE 7.03；
   但**没有全能选手**——SVG 矢量只有 GX-Alex/yuna78/自研，原生表格只有 mmoollee/junyuaini/自研，
   字体嵌入只有 mmoollee/Hasasasa。→ 结论是**补短板，不是换引擎**。详见 [`bench/REPORT.md`](bench/REPORT.md)。
6. **本机原型已跑通**：5 页 → 66 个原生形状 + 1 个原生表格 + 3 张图 + 68 个文本 run，
   **文本字符覆盖率 100%**，SVG 图标 8/8 转成原生 `a:custGeom`、渐变转原生 `a:gradFill`
   （参考实现在这两处都栅格化），zip 39/39 DEFLATE（PowerPoint「需修复」护栏），
   回渲 MAE 4.25 / `diff>16` 4.06%。

---

## 目录

```
HTML -ppt/
├── README.md                          ← 你在这里
├── 调研报告-HTML转可编辑PPT-2026-10-19.md   ← 主报告（路线/工具/商业产品/技术地基/实测/选型）
├── 规范-HTMLPPT-HTML契约-v1.0.md        ← HTML 输入契约（14 节 + 硬禁止清单 + linter + 骨架）
├── 技术方案-HTMLPPT-转换管线-v1.0.md     ← 五层架构 / IR schema / 映射表 / 验收 / 里程碑 / 风险
├── research/
│   ├── 01-oss-landscape.md              ← 工具全景（四维评分 + 未验证清单）
│   ├── 02-pptx-mapping-constraints.md   ← HTML/CSS→DrawingML（单位/文本/映射/字体/验收）
│   └── 03-authoring-products.md         ← 编写范式（框架对比 + PPT-safe CSS 子集 + 中文实践）
├── cli/                                 ← 统一命令行 htmlppt（doctor/extract/build/verify/bench/stack）
├── pptx2html/                           ← 反向技能：PPTX → HTML
│   ├── README.md                        ← 用法 / 映射规则 / 实测保真 / 可替换语义
│   ├── pptx2html.py                     ← 转换器
│   ├── verify.py / shoot.mjs            ← 保真验收（HTML 截图 vs PPTX 回渲）
│   └── out/ref/                         ← 18 页真实稿的转换结果 + 对比图
├── bench/                               ← 引擎横向基准测试台
│   ├── REPORT.md                        ← 8 引擎实测报告 + 功能矩阵 + 集成建议
│   ├── matrix.json                      ← 机器可读的总成绩
│   ├── corpus/                          ← 5 页基准语料 + 真值截图/文本
│   ├── evaluate.py                      ← 统一评测器（可编辑性/保真/结构/成本）
│   ├── summarize.py                     ← 汇总矩阵
│   ├── prepare.mjs                      ← 拆分单页 + 生成真值
│   └── runs/<engine>/                   ← 每个引擎的 pptx / score.json / NOTES.md / 证据
└── prototype/
    ├── README.md                        ← 实测数字、实现要点、已知限制
    ├── samples/deck.html                ← 5 页样本
    ├── src/*.mjs                        ← measure / convert / postprocess / inspect / render / diff
    └── out/
        ├── deck.pptx                    ← 交付物：可编辑 PPTX
        ├── diff/contact-sheet.png       ← HTML | PPTX | diff 三栏对照
        ├── metrics.json                 ← 12 项 gates + 汇总指标
        ├── editability.json             ← 逐页 a:t / 字符覆盖率 / p:sp / p:pic / 整页图检测
        └── font_matrix.json             ← 字体对照实验（9 组）
```
