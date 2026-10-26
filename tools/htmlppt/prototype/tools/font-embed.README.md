# font-embed — 给 .pptx 真正嵌入字体（PowerPoint `fntdata` / EOT）

换机器打开时字体回退 → 重排，是正向管线现在最大的短板。这个工具把**字体文件本身**塞进
`.pptx`，让 PowerPoint 在没有该字体的机器上也能按原字面渲染。

```bash
# 指定字体文件（可重复；按字重的 usWeightClass / Subfamily 自动分到 regular / bold 槽）
node prototype/tools/font-embed.mjs in.pptx out.pptx \
  --font "Noto Sans SC=/Users/an/Library/Fonts/NotoSansSC-Regular.ttf" \
  --font "Noto Sans SC=/Users/an/Library/Fonts/NotoSansSC-Bold.ttf"

# 只给字族名 → 用 fc-match 找系统字体
node prototype/tools/font-embed.mjs in.pptx out.pptx --font "Noto Sans SC"

# 源文件用的字体不可嵌入（PingFang / 微软雅黑）时，先把 typeface 改写成一个可嵌入字族
node prototype/tools/font-embed.mjs in.pptx out.pptx \
  --font "Noto Sans SC" --map "PingFang SC=Noto Sans SC"

# 审计 / 复验，不改文件
node prototype/tools/font-embed.mjs --list   deck.pptx
node prototype/tools/font-embed.mjs --verify deck.pptx
```

其它开关：`--no-subset`（整字重嵌入）、`--no-verify`（跳过四项验证）、`--json r.json`、
`--python <venv-python>`（fontTools 所在解释器，默认 `PPT 复刻/.venv/bin/python`）。
退出码：`0` 成功，`1` 硬失败，`2` 全部字体被许可检查拒绝（文件不会被写出）。

## 它到底改了哪四处

PowerPoint 的嵌入字体不是裸 TTF，而是 **EOT 容器**，放在 `ppt/fonts/N.fntdata`，并且要在
四个地方同时登记（缺一处 PowerPoint 就会忽略或报修）：

| # | 部件 | 内容 |
|---|------|------|
| 1 | `ppt/fonts/N.fntdata` | EOT 字节流（82B 头 + 四个 UTF-16LE 名字 + 裸 TrueType） |
| 2 | `ppt/presentation.xml` | `<p:embeddedFontLst><p:embeddedFont><p:font typeface="X"/><p:regular r:id="rIdN"/>…` |
| 3 | `ppt/_rels/presentation.xml.rels` | `Type=…/relationships/font Target="fonts/N.fntdata"` |
| 4 | `[Content_Types].xml` | `<Default Extension="fntdata" ContentType="application/x-fontdata"/>` |

另外给 `<p:presentation>` 补 `embedTrueTypeFonts="1"`，并把 `<p:embeddedFontLst>` 插到
schema 规定的位置（`sldSz`/`notesSz` 之后、`defaultTextStyle` 之前）。

## 流水线

1. **收集字符**：扫描 `ppt/{slides,slideLayouts,slideMasters,notesSlides,charts}/**/*.xml`，
   按 `<a:r>` / `<a:fld>` 把 `<a:t>` 的文本归到该 run 自己的 `typeface` 上（归类失败的字符
   进"unknown"桶，保证任何字体都不会缺字）。同时固定补 ASCII 0x20–0x7E、CJK 标点
   （U+3000–303F）和常用引号/破折号，方便后续小幅改字。
2. **许可闸门**：读 `OS/2.fsType`（不是 `head` 表——`head` 里没有 fsType，这是本工具与最初
   briefing 的一处事实修正）。只有 `0`（Installable）和 `8`（Editable）放行；
   `2`（Restricted）、`4`（Preview & Print）跳过 + 警告；`0x100` no-subsetting 时强制整字重
   嵌入；`0x200` bitmap-only 直接拒绝。
3. **subset**：`fontTools.subset`（pyftsubset）按上一步的字符集裁剪。TTC 先定位到名字匹配的
   face（不是盲目取 face 0——Songti 的 face 0 是 `fsType=2`，face 1 才是可嵌入的）；
   OTF/WOFF/WOFF2 先用 `fonteditor-core` 解到 TTF（EOT 只装 `glyf` 轮廓）。
4. **写 EOT**：自己按规范拼头（82 字节）、四个名字、裸 TTF。**没有直接用
   `fonteditor-core` 的 `write({type:'eot'})`**，因为它把 FamilyName/StyleName 写成
   UTF-16**BE** 且不带 NUL 终止符，`Italic` 字段还错误地填了 `OS/2.fsSelection`（Regular 会
   变成 64）。本工具修正为 LE + NUL、`Italic = fsSelection & 1`，并原样带出 PANOSE、
   UnicodeRange、CodePageRange、checkSumAdjustment。写完立刻回读自检（`parseEot` 必须与
   输入的 subset TTF 逐字节一致）。
5. **注入**并整包重压（`JSZip`，DEFLATE level 9，去掉 Store 的目录条目）。
6. **验证**四项，见下。

## 许可边界（本机实测）

| 字体 | 文件 | fsType | 结论 |
|---|---|---|---|
| Noto Sans SC | `~/Library/Fonts/NotoSansSC-Regular.ttf` | `0x0000` | ✅ 可嵌入（可 subset） |
| PingFang SC | 系统 `PingFang.ttc` face 3 | `0x0004` | ❌ Preview & Print，不能编辑 |
| Songti SC | 系统 `Songti.ttc` face 0 / face 1 | `0x0002` / `0x0008` | ❌ face 0 拒绝，✅ face 1 放行 |
| Heiti SC | `STHeiti Medium.ttc` face 1 | `0x0000` | ✅ 可嵌入 |
| Arial | `Arial.ttf` | `0x0008` | ✅ Editable |
| Microsoft YaHei | — | — | ⚠️ 本机没有该字体文件，**未能实测**；briefing 称其不可嵌入，工具按 fsType 现场判定，不写死名单 |

**PingFang SC 是本管线当前所有 deck 的默认字体，而它不可嵌入。** 所以真正的修法不是"事后补嵌"，
而是正向管线选字体时就别选 PingFang：用 Noto Sans SC / Heiti SC（本机 `fsType=0`）做
`font-family`，再让本工具嵌入。`--map` 只是给已有的、别人的 deck 做补救（会改变字宽，
已渲染的布局会跟着变，慎用）。

## 体积代价（实测）

| deck | 原大小 | 嵌入后 | 变化 | 嵌入内容 |
|---|---|---|---|---|
| `bench/runs/ours/deck.pptx` (5 页) | 246 KiB | 457 KiB | **+210 KiB (+85%)** | Noto Sans SC Regular+Bold，各 173 KiB |
| `bench/runs/junyuaini/deck.pptx` (12 页) | 40 KiB | 143 KiB | **+103 KiB (+258%)** | Noto Sans SC Regular，173 KiB |

单字重的代价基本恒定，跟 deck 页数无关，只跟"用到多少个字"有关：

| 阶段 | Regular | 说明 |
|---|---|---|
| 原始 TTF | 10,595,876 B (10.1 MiB) | 31,036 字形全量 |
| subset 后 | 177,064 B (173 KiB) | 528 字符 → 924 字形（含复合字形依赖），**缩到 1.67%** |
| EOT 容器 | 177,356 B | 头 + 名字 + 4 字节对齐，+292 B |

经验值：**每嵌入一个字重 ≈ 170–200 KiB**（700 字符量级的中文 deck）；拉丁字体小得多
（Arial 全量 755 KiB，几百字符 subset 后约 20–40 KiB）。两个中文字重 ≈ 350 KiB，12 页以上的
deck 完全可接受；页数多、字数多时按字符数线性增长，可用 `--no-subset` 之外的默认行为观察
report 里的 `subsetBytes / originalBytes`。

## 四项验证（每次 `--verify` 自动跑）

对上面两个产物都是 4/4 通过：

1. **解包结构**：`ppt/fonts/*.fntdata` 存在且每个都以 EOT magic `0x504C` 开头；
   `<p:embeddedFontLst>` 中每个 `r:id` 都能在 rels 里解析、且目标部件真实存在；
   `[Content_Types].xml` 有 `fntdata → application/x-fontdata`。
2. **zip 100% DEFLATE**：解析中央目录，39/39 条目 method=8，0 个 Store（Store 会让
   PowerPoint 报"需要修复"）。
3. **python-pptx 重开**：`Presentation(out)` → `slides=5 size=12192000x6858000`，无异常。
4. **LibreOffice 回渲**：`FONTCONFIG_FILE=/opt/homebrew/etc/fonts/fonts.conf soffice --headless
   --convert-to pdf` 成功，PDF 409 KiB，`pdffonts` 里出现 `NotoSansSC-Regular/Bold`。

额外做了一次**更硬的 A/B**（`prototype/out/font-embed/libreoffice-embedded-font-evidence.txt`）：
用 fontconfig `rejectfont` 把系统里所有 `Noto*` 屏蔽掉（`fc-match "Noto Sans SC"` 会掉到
Hiragino），再渲染：

- 原 deck（无嵌入字体）：PDF 里是 `HiraginoSans-W7` / `STSongti-SC-Bold` / `HiraMaruPro-W4`（回退）
- 嵌入后的 deck：PDF 里稳定出现 `NotoSansSC-Regular` / `NotoSansSC-Bold`

即"该字族在系统上根本不可用，渲染结果仍然用它"——只有从 `ppt/fonts/*.fntdata` 读出来才可能。
另外把我们的 EOT 用 `fonteditor-core` 的 `eot2ttf` 反解，fontTools 能正常读出
`family=Noto Sans SC, glyphs=924, fsType=0x0`，说明容器结构是可逆的。

## 诚实声明 / 已知边界

- **没有在真正的 PowerPoint 里验证过。** 本机只有 LibreOffice。上面的证据链说明"容器结构正确、
  LibreOffice 会读、python-pptx 不炸"，**不能**等价于"PowerPoint 会用它渲染"。EOT 头是本工具
  按 W3C EOT 提交稿手写的（因为 npm 上的转换器有字节序 bug），字段取值已尽量保守（version
  0x00020001、flags=0 不压缩、charset=DEFAULT_CHARSET、PANOSE/UnicodeRange 原样拷贝），但仍有
  未知：PowerPoint 对名字串长度/终止符、UnicodeRange 的挑剔程度无法在此证伪。**上真机前请拿
  一份 deck 在 Windows PowerPoint 里看一眼"文件 → 选项 → 保存 → 嵌入字体"和换机打开效果。**
- **LibreOffice ≠ PowerPoint 的字体匹配**：LO 用 fntdata 内部的 name 表；PowerPoint 同时看
  `<p:font typeface>` 和内部名字。两者不一致时（例如 `--font "Foo=Bar.ttf"`）可能只有一边生效，
  工具会对不一致告警，但不会自动改名。
- **只做 regular / bold / italic / boldItalic 四个槽**，槽位由字体自身的 Subfamily /
  `usWeightClass≥600` 猜，不支持同一字族的多宽度（Condensed 等）。
- **不做主题字号/`+mn-ea` 的替换**：只改显式 `typeface="…"`；主题里的 fallback 仍按本机字体走。
- **`--map` 会改字宽**，布局会变；它是补救手段，不是推荐路径（推荐：管线一开始就用可嵌入字体）。
- subset 只覆盖当前 deck 文本 + ASCII + CJK 标点；**用户之后输入的新字会回退**。
- 生态并不统一：`bench/runs/hasasasa/deck.pptx` 里的 `fntdata` 是**裸 TTF**（文件头
  `00 01 00 00`），而 `bench/runs/mmoollee/font-probe.pptx` 里是 EOT（`0x504C`）。本工具按
  briefing 走 EOT；不保证 PowerPoint 对所有历史产物一视同仁。
- 没有做 "嵌入子集" 标记（EOT flags 保持 0）、没有写 EUDC / 签名块（version 2.1 不需要）。

## 给 Lead 的集成建议

1. 正向管线在 `postprocess` 之后调一次（当前产物 `bench/runs/ours/deck.pptx` 用 PingFang，
   直接跑会被许可检查拒绝，exit 2）：
   ```bash
   node prototype/tools/font-embed.mjs out/deck.pptx out/deck.embedded.pptx \
     --font "Noto Sans SC=/Users/an/Library/Fonts/NotoSansSC-Regular.ttf" \
     --font "Noto Sans SC=/Users/an/Library/Fonts/NotoSansSC-Bold.ttf"
   ```
2. 更根本的修法：`convert` 阶段把字体选成 Noto Sans SC（本机 fsType=0），别用 PingFang；
   这样 `--map` 根本不需要，嵌入是纯增益。
3. 是否默认开启，取决于体积容忍度：单字重 +170 KiB，双字重 +350 KiB；可以在 `metrics.json`
   旁边加一个 `font_embed` 字段记录 `fontsEmbedded / deltaBytes / verificationOk`。
4. `--verify` 的四项已经是 CI 可用的（退出码非 0 即失败），建议作为出包门禁。

## 产物

- `prototype/out/font-embed/ours-deck.pptx` — `bench/runs/ours/deck.pptx` + PingFang→Noto + Regular/Bold
- `prototype/out/font-embed/junyuaini-deck.pptx` — 12 页中文 deck（微软雅黑）+ Regular
- `*.font-embed.json` — 每个字的原始/子集/EOT 字节数、字符数、许可判定、四项验证明细
- `libreoffice-embedded-font-evidence.txt` — 上面的 A/B 证据

依赖：`fonteditor-core`（只用于解 WOFF/WOFF2/OTF/TTC→TTF；EOT 容器由本工具自己写）。
`jszip` 已有。fontTools 走 `PPT 复刻/.venv/bin/python`。
