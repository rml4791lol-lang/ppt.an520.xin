# HTMLPPT 模板库

> 每个模板族 = 一个自包含 HTML 文件（1280×720 × N 页），**文字即内容**，改字就是改内容。
> 约定：所有可替换文字都带 `data-slot="<页.位置>"`，方便脚本/人按槽位填充。

## 目录

| 模板族 | 审美方向 | 适用 | 页数 | 槽位 | lint | gates | MAE |
|---|---|---|---|---|---|---|---|
| `t1-academic-blue/` | **学院蓝**：白底 + 大图 + 深海军蓝 + 蓝色渐变胶囊 + 细线 | 国赛/校庆/汇报 | 6 | 95 | 0 error | 13/13 | 9.35 |
| `t2-dark-tech/` | **深色科技**：近黑底 + 青色细线 + 大图压暗 + 微标签 | 路演/技术发布 | 5 | 106 | 0 error | 13/13 | 6.26 |
| `t3-editorial/` | **编辑杂志**：纸白 + 宋体大标题 + 焦糖橙 + 5:3 不对称栅格 | 成果册/品牌故事 | 5 | 73 | 0 error | 13/13 | 7.84 |

> 每组都通过 `lint`（0 error）和 `run.mjs`（13/13 gates、字符覆盖 100%），MAE = HTML 与导出 PPTX 回渲的像素差。
> 预览：各自目录下 `preview.png`；设计语言对照见 `对比-参照稿vsT1-设计语言.png`；保真对照见 `对比-HTMLvsPPTX-三族.png`。

## 可视化编辑器

每个模板目录都生成了 `editor.html`（用 `tools/make-editor.py` 生成）：

```bash
# 已在运行：
#   T1 http://127.0.0.1:8900/t1-academic-blue/editor.html
#   T2 http://127.0.0.1:8900/t2-dark-tech/editor.html
#   T3 http://127.0.0.1:8900/t3-editorial/editor.html

# 重新生成编辑器（任意 deck.html / index.html 都行）
"/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python" tools/make-editor.py <模板>/index.html <模板>/editor.html
```

点字改字、点图换图（保持比例）、超框自动缩字、改完「导出 HTML」。

## 怎么改内容

1. 直接用编辑器打开 `index.html`，改 `data-slot` 对应的文字即可（图片换 `src`）。
2. 或按槽位批量填充：`slots.json` 列出所有槽位 id 与当前值，配套脚本后续提供。
3. 改完跑一遍检查与导出：

```bash
# 契约检查（必须 0 error）
node prototype/src/lint.mjs templates/t1-academic-blue/index.html

# 导出可编辑 PPTX（13 项 gates）
HTMLPPT_DECK=.../index.html HTMLPPT_OUT=/tmp/t1 node prototype/src/run.mjs
```

## 设计规范（所有模板族共用）

- 画布 1280×720，`overflow:hidden`；所有坐标绝对定位，禁止 `vw/vh/em/rem`。
- 字体：标题用 `PingFang SC` / 衬线族按模板；正文 ≥16px；行高写死数值。
- 颜色：每族一个主色 + 一个强调色 + 中性色阶；不做彩虹。
- 图片：`../assets/` 下共享（校门/大楼/会议/二维码/校徽），按比例裁切。
- 装饰：细线（1–2px）、小色块、编号、图标；**不用**大面积圆角卡片堆叠。
- 每页右下角页码；封面/结语不编号。

## 素材

`assets/` 来自参照稿自身的照片与标识（用户素材，仅本仓库使用）：

- `cover-building.jpg` 主楼航拍
- `campus.png` 校园全景
- `meeting.jpg` 会议现场
- `wordmark.png` 学校+科创港标准字
- `emblem.png` 校徽
- `qr.jpg` 二维码
- `flourish.png` 标题下方蓝色飘带
