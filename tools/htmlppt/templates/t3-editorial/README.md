# t3-editorial · 北岸

编辑杂志 / 成果册模板。5 页，1280×720，纯 HTML + 绝对定位；所有正文文字带 `data-slot`，图片带 `data-img-slot`，改字换图后即可走现有管线导出可编辑 PPTX。

虚构刊名「北岸」，第 03 期，2026 年秋。五页构成一个完整的刊物节奏：封面 → 卷首/目录 → 专题 → 数据 → 结语。

## 审美说明

**一句话**：纸白、宋体、焦糖橙、不对称和大量留白；用细线分栏，不用卡片。

- **纸感**：背景统一 `#FAF8F3`，不铺纹理、不加阴影。每页只有 1px 的 `#D9D2C5` 细线在切分信息，页面边缘留 88px 白边，栏与栏之间靠 1px 竖线呼吸。
- **字**：标题用 `Songti SC` 700，封面 74px / 行高 84px，专题 64px / 74px，结语整页 64px / 88px。正文用 `PingFang SC`（专题 17px / 32px，卷首为衬线 18px / 32px），数据用 `Arial` 700 120px。栏名、页码、刊头一律 11px，字距 2–3px。
- **色**：橙色 `#C2410C` 只出现在四个地方——栏目小标签、封面第三行标题、数据大数字与刻度、结语最后一行；面积始终很小，深墨 `#14110D` 和纸白承担 95% 的画面。
- **栅格**：不对称。P1 是 5:3（文字 680 / 图片 400），P2 是 458 / 552，P3 是三栏 318 / 318 / 372，P4 是 760 / 300，P5 是 1100 宽的整页引语。没有一页把内容放在正中。
- **层级**：大标题与 11px 小字并置，形成强字重/字号对比；目录用 `01/02/03` 三个焦糖橙数字做“唱片式”编号；数据页用 120px 数字压住整个左半版。
- **图片**：P1 竖幅 400×500，外加 12px 纸色卡纸边框；P3 横幅 372×240，用 `object-position: 50% 78%` 裁掉校园照片上半部的亮天空；P4 正方形 260×260。三张图都配 11px 图注，不加圆角。
- **页码**：P2–P4 右下角 11px 页码；封面与结语不编号（遵循共用规范），分别以刊期和 `END / 05` 收尾。

## 五页结构

| 页 | 版面 | 内容 |
|---|---|---|
| P1 | 5:3 左文右图 | 刊头 + 三段大标题（第三行橙色斜体）+ 竖幅主楼照片 + 底部细线 |
| P2 | 5:6 左信右目录 | 卷首语（衬线正文）+ 三条目录 + 右下签名栏 |
| P3 | 三栏 318/318/372 | 栏名、64px 衬线标题、两栏正文、一张横幅图 + 图注、跨栏引语 |
| P4 | 左 760 / 右 300 | 120px `87.4%`、说明、三条横向刻度线、右下方形小图 |
| P5 | 单栏 1100 | 整页三行衬线引语 + 出处 + 版权栏 + 联系方式 |

## 槽位表

所有文字槽位均为 `data-slot="…"`。图片另用 `data-img-slot`，替换 `src` 即可。

| 页 | 区块 | 槽位 | 备注 |
|---|---|---|---|
| P1 | 刊头 | `cover.masthead` `cover.wordmark` `cover.issue` | 刊名 / 英文刊名 / 期号+日期 |
| P1 | 标题与导语 | `cover.kicker` `cover.title` `cover.deck` `cover.keywords` | `cover.title` 内含 3 个 `<span>` + 2 个 `<br>`，第三行橙色斜体 |
| P1 | 图片 | `cover.photo`（`data-img-slot`）`cover.caption` | 竖幅 400×500，外边 1px 卡纸框 |
| P1 | 页脚 | `cover.footer-left` `cover.footer-right` | 底部细线上下 |
| P2 | 刊头与标题 | `editor.running-head` `editor.running-right` `editor.kicker` `editor.title` | 内页 running head |
| P2 | 卷首正文 | `editor.body-1` `editor.body-2` | 衬线 18/32；第一段 4 行，第二段 2 行 |
| P2 | 目录 | `contents.label` `contents.item1.num` `contents.item1.title` `contents.item1.summary` `contents.item2.num` `contents.item2.title` `contents.item2.summary` `contents.item3.num` `contents.item3.title` `contents.item3.summary` | 三则，编号 01/02/03 |
| P2 | 签名与页脚 | `editor.signature` `editor.date` `editor.footer-left` `editor.page` | 签名在右下 |
| P3 | 刊头与标题 | `feature.running-head` `feature.running-right` `feature.kicker` `feature.title` `feature.standfirst` | 标题 2 行；摘要 3 行 |
| P3 | 栏名与正文 | `feature.col1.label` `feature.col1.body` `feature.col2.label` `feature.col2.body` `feature.col3.label` | 正文两栏，各 4 行；第三栏放图 |
| P3 | 图片 | `feature.photo`（`data-img-slot`）`feature.image-caption` | 横幅 372×240；裁切靠 `object-position` |
| P3 | 引语 | `feature.pullquote` `feature.pullquote-source` | 跨前两栏的 30px 衬线引语 |
| P3 | 页脚 | `feature.footer-left` `feature.page` | |
| P4 | 刊头 | `data.running-head` `data.running-right` `data.kicker` `data.note` | 右侧注样本量 |
| P4 | 数字与说明 | `data.number` `data.statement` | 120px Arial 700；说明 2 行 |
| P4 | 三条刻度 | `data.scale-label` `data.scale1.label` `data.scale1.value` `data.scale2.label` `data.scale2.value` `data.scale3.label` `data.scale3.value` | 轨道 560px，橙色段宽按百分比 |
| P4 | 侧栏与图 | `data.aside-label` `data.aside` `data.photo`（`data-img-slot`）`data.caption` | 方形 260×260 |
| P4 | 页脚 | `data.footnote` `data.footer-left` `data.page` | |
| P5 | 刊头 | `closing.running-head` `closing.running-right` `closing.kicker` | |
| P5 | 引语 | `closing.mark` `closing.quote` `closing.source` | `closing.quote` 3 个 `<span>` + 2 个 `<br>`，末行橙色斜体 |
| P5 | 版权 | `closing.colophon` | 三行右对齐：主编 / 摄影 / 设计 |
| P5 | 页脚 | `closing.contact` `closing.end` | 底部细线与邮箱电话 |

共 73 个文字槽位 + 3 个图片槽位。

## 怎么改字

1. 用编辑器打开 `index.html`，搜索 `data-slot`，只替换标签内部的文字，保留外层 `p/h1/h2/h3`。
2. 三处带装饰性 `<span>` 的槽位要保留内部结构：
   - `cover.title`：三段 `<span>`，第三段 `style="color:#C2410C;font-style:italic;"`；
   - `closing.quote`：三段 `<span>`，第三段是橙色斜体；
   - 其余槽位如 `feature.pullquote` 也含橙色引号 `<span>`，可随文案一起替换。
3. 文案长度尽量保持原来的行数。标题/正文框的 `height` 是按行高算好的（例如 `cover.title` 3×84=252，`editor.body-1` 4×32=128）。如果多出一行，请同步加 `height` 并下移后续元素，或把文案改短。
4. 不要给文字元素加 `overflow:hidden`；lint 会把被裁的文字报成 `overflow-text` error。
5. 新增文字时，用 `p`/`h*` 承载，并补 `data-slot`；不要直接往 `div` 里塞裸文本。
6. 字体、颜色 token 集中在 `<style>` 的 `.serif` / `.sans` / `.latin`，以及各元素的内联色值；不要引入 `vw/vh/em/rem`、`filter`、`clip-path`。

## 怎么换图

1. 改 `src`，建议仍用 `../assets/` 下的相对路径；`alt` 一并改掉。
2. 保留图片框的 `width/height`，用 `object-fit:cover` 负责裁切。若换比例差异很大的图，调 `object-position` 重新选主体。
3. 三处图片槽位：`cover.photo`（400×500 竖幅）、`feature.photo`（372×240 横幅）、`data.photo`（260×260 方形）。
4. `object-position` 只影响浏览器预览。当前转换器把图片按测得的矩形写入 PPTX，并按中心裁切；如果 PPTX 里的主体偏移，优先换一张主体居中的图，或在导出前把裁切位置做进图片本身。
5. 图片本身不加圆角、阴影；需要边框时，用独立的 1px 细线形状（P1 的卡纸框就是这样做的）。

## 检查与导出

```bash
# 契约检查（必须 0 error）
node prototype/src/lint.mjs templates/t3-editorial/index.html

# 导出可编辑 PPTX（13 项 gates）
HTMLPPT_DECK="$(pwd)/templates/t3-editorial/index.html" HTMLPPT_OUT=/tmp/t3 node prototype/src/run.mjs
```

当前结果：

- lint：**0 error / 6 warning**。6 条都是 `mixed-content`（标题/引语里的内联 `<span>` + `<br>`），是本方言支持的写法，不影响转换；不要为了消 warning 把橙色字拆成图片。
- 管线：**gates 13/13 PASS**，字符覆盖 **100%**（103 个 `a:t` run），无整页图片、无截图页。
- 预览：`preview.png` 为 2 列网格，5 格各 720×405，标题 P1–P5；由 Playwright 截取 2× HTML 后合成。

## 已知边界

- **PPTX 里的字体是全局的**：当前 `convert.mjs` 用 `FONT_FACE`（默认 `PingFang SC`）统一写入所有 run，HTML 里的宋体/黑体混排不会逐 run 带过去。要在 PowerPoint 里全部用宋体，导出时设 `FONT_FACE="Songti SC"`；代价是正文也变成宋体。模板的衬线效果以 HTML / `preview.png` 为准。
- 图片按矩形中心裁切，`object-position` 不进入 PPTX（见“怎么换图”）。
- 文案是虚构的（“北岸”刊名、人名、数据、邮箱均为示例），替换成真实内容时请同步改 `cover.issue`、`editor.date`、`data.note` 和页脚。
