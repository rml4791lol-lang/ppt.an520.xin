# htmlppt · 统一命令行

把仓库里已有的四套能力（PPTX→HTML、HTML→PPTX、回渲质检、引擎基准）收进**一个命令**。
纯 Python 3.12 标准库 + `subprocess`，从任意目录都能调用；每条命令都支持 `--json`。

```bash
python3 cli/htmlppt.py --help
```

> 下文所有输出都是本机真实运行结果（macOS 27.0 / Python 3.12.14 / Node 26.10 / LibreOffice 26.8），
> 没有手写或美化。

---

## 1. 命令总览

| 命令 | 作用 | 背后调用 |
|---|---|---|
| `doctor` | 检查 node / python / soffice / chrome / pdftoppm / fc-match 与 6 个关键字体 | 无（只探测） |
| `extract <pptx> -o <dir>` | 原生 PPTX → 可编辑 HTML（默认图片内嵌；`--no-embed` 输出 `assets/`） | `pptx2html/pptx2html.py` |
| `build <html> -o <dir>` | HTML → 可编辑 PPTX + 12 项 gates（默认输出 `<html目录>/htmlppt-out`） | `prototype/src/run.mjs` |
| `verify --pptx <p> --html <h> -o <dir>` | HTML 截图 vs PPTX 回渲，逐页 MAE + 平均 + 对比图 | `pptx2html/verify.py` |
| `bench [--quick]` | 打印 8 个引擎的基准矩阵（只读 `bench/runs/*/score.json`） | 不重跑评测，不写 `bench/` |
| `stack <pptx> [-o <dir>]` | 一条龙 extract → build → verify（闭环自检） | 上面三者 |

退出码统一为：

| 码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 工具执行失败（缺文件、转换失败、回渲失败等） |
| `2` | 用法错误（参数缺失 / 未知命令，由 argparse 返回） |

加 `--json`（放在子命令前后都行）时，stdout **只有一段合法 JSON**，进度和错误都走 stderr，便于脚本消费。

---

## 2. 真实跑通记录

### 2.1 `doctor` —— 环境体检

```console
$ python3 cli/htmlppt.py doctor
htmlppt doctor · Darwin 27.0.0 · CLI Python 3.12.14

检查项    必需  状态  版本 / 说明
--------  ----  ----  -------------------------------------------------------------
python    是    ✓     Python 3.12.14
node      是    ✓     v26.10.0
soffice   是    ✓     LibreOffice 26.8.0.3 bce0998afefdbc355585ca324285661a2170ba77
chrome    是    ✓     Google Chrome 155.0.8059.85
pdftoppm  是    ✓     pdftoppm version 26.08.0
fc-match  否    ✓     fontconfig version 2.18.3

关键字体        状态  实际匹配
--------------  ----  ---------------------------
PingFang SC     ✓     PingFang SC,蘋方-簡,苹方-简
Noto Sans SC    ✓     Noto Sans SC
Songti SC       ✓     Songti SC,宋體-簡,宋体-简
Arial           ✓     Arial
Helvetica Neue  ✓     Helvetica Neue
Inter           ✓     Inter

✓ 必需工具齐全
  耗时 0.8s
```

`fc-match` 是可选项；缺字体只给 ⚠ 警告，不影响退出码。缺任一**必需**工具则退出 `1`。

### 2.2 `extract` —— PPTX 转 HTML

```console
$ python3 cli/htmlppt.py extract bench/runs/ours/deck.pptx \
    -o cli/.runs/extract
▶ extract  PPTX → HTML
  输入  bench/runs/ours/deck.pptx
  输出  cli/.runs/extract/deck.html
  规模  5 页 · 111 个对象 · lossy 0
  图片  内嵌 data URI（单文件）
  ✔ 完成 0.5s
```

产物：`deck.html`（单文件、图片全内嵌）、`assets/`（抽取的原图）、`map.json`（逐对象映射 + lossy 清单）。
`--no-embed` 时 HTML 只引用 `assets/`，目录必须一起拷走。

### 2.3 `build` —— HTML 转可编辑 PPTX

```console
$ python3 cli/htmlppt.py build cli/.runs/extract/deck.html
▶ build  HTML → 可编辑 PPTX
  输入  cli/.runs/extract/deck.html
  输出  cli/.runs/extract/htmlppt-out/deck.pptx
  规模  5 页 · 163.7 KiB · MAE 5.41 · 字符覆盖 100%
  gates 12/12 · PASS
  ✔ 完成 11.0s
```

这次故意不写 `-o`，用来演示默认输出落在 `<html 所在目录>/htmlppt-out/`。完整产物：

```
<html目录>/htmlppt-out/
├── deck.pptx            # 最终可编辑 PPTX
├── metrics.json         # 12 项 gates + 像素/文本/结构指标
├── html/slide-N.png     # Chrome 真值截图
├── pptx/slide-N.png     # LibreOffice 回渲
└── diff/contact-sheet.png
```

任一硬 gate 失败时 `run.mjs` 返回非 0，`htmlppt` 退出 `1`，不会把坏稿当成功。

> 对“整页背景就是一张图”的原稿，`extract → build` 可能触发 `noFullPagePicture` 硬 gate
> （这是保真度的预期结果，不是 bug）。此时应换用非整页图的输入，或接受该 gate 失败。

### 2.4 `verify` —— 逐页 MAE 质检

```console
$ python3 cli/htmlppt.py verify \
    --pptx cli/.runs/extract/htmlppt-out/deck.pptx \
    --html cli/.runs/extract/deck.html \
    -o cli/.runs/verify
▶ verify  HTML vs PPTX 回渲
  PPTX  cli/.runs/extract/htmlppt-out/deck.pptx
  HTML  cli/.runs/extract/deck.html

页  MAE    diff>16%  diff>48%
--  -----  --------  --------
1   7.66   5.05      3.76
2   3.99   3.83      2.46
3   3.98   4.05      2.53
4   5.06   4.26      3.14
5   10.86  9.92      7.55

  合计  5 页 · 平均 MAE 6.31 · >16 5.42% · >48 3.89%
  对比图 cli/.runs/verify/compare.png
  ✔ 完成 5.4s
```

产物：`verify.json`（逐页 + 汇总，机器可读）、`compare.png`（HTML / PPTX / diff 三列拼版）。
MAE 越低越像；`diff>16%` 是肉眼可见差异的面积占比。

> LibreOffice 共用用户配置目录：刚跑完 `build` 立刻 `verify`，偶尔第一次回渲会静默产出 0 页。
> CLI 会自动等 2 秒重试（最多 3 次），并在仍失败时给出可操作的报错。

### 2.5 `bench` —— 引擎基准矩阵

```console
$ python3 cli/htmlppt.py bench
bench · 引擎基准矩阵（bench/runs/*/score.json）
引擎         页数  覆盖  a:t  p:sp  p:pic  表  cust  grad  整页图  MAE    >16%   闸门  耗时s
-----------  ----  ----  ---  ----  -----  --  ----  ----  ------  -----  -----  ----  -----
ours         5/5   100%  89   108   2      1   5     1     0       7.03   6.96   6/6   10.5
hasasasa     5/5   100%  72   96    7      0   0     0     1       21.14  14.85  5/6   536.7
gx           5/5   100%  107  196   0      0   15    0     0       19.7   24.71  6/6   1.81
yuna78       5/5   100%  107  196   0      0   15    0     0       17.23  17.06  6/6   2.02
mmoollee     5/5   100%  89   100   5      1   0     0     2       16.59  18.62  4/6   2.0
designarena  5/5   100%  81   111   4      0   0     1     0       22.54  16.65  5/6   4.0
junyuaini    5/5   100%  83   101   4      1   0     1     1       56.08  26.04  5/6   7.14
abdelkrimkr  5/5   100%  99   104   1      0   0     0     0       25.11  30.22  4/6   1.15

  8 个引擎有分数 · 矩阵 bench/matrix.json
```

`--quick` 只保留「引擎 / 页数 / MAE / >16% / 闸门 / 耗时」六列：

```console
$ python3 cli/htmlppt.py bench --quick
bench · 引擎基准矩阵（bench/runs/*/score.json）
引擎         页数  MAE    >16%   闸门  耗时s
-----------  ----  -----  -----  ----  -----
ours         5/5   7.03   6.96   6/6   10.5
hasasasa     5/5   21.14  14.85  5/6   536.7
gx           5/5   19.7   24.71  6/6   1.81
yuna78       5/5   17.23  17.06  6/6   2.02
mmoollee     5/5   16.59  18.62  4/6   2.0
designarena  5/5   22.54  16.65  5/6   4.0
junyuaini    5/5   56.08  26.04  5/6   7.14
abdelkrimkr  5/5   25.11  30.22  4/6   1.15

  8 个引擎有分数 · 矩阵 bench/matrix.json
```

`bench` **只读**已有 `bench/runs/<label>/score.json`，不会重跑评测，也不会改写 `bench/matrix.json`。
没有 `score.json` 的目录不进入表格（仍会出现在 `--json` 的 `runs[]` 里）。
需要重跑某一引擎时，仍用 `bench/evaluate.py`，详见 `bench/REPORT.md`。

### 2.6 `stack` —— 闭环自检

```console
$ python3 cli/htmlppt.py stack bench/runs/ours/deck.pptx \
    -o cli/.runs/stack
▶ 1/3 extract  5 页 · 111 对象 → cli/.runs/stack/extract
▶ 2/3 build    5 页 · gates 12/12 · 字符覆盖 100% → cli/.runs/stack/build/deck.pptx
▶ 3/3 verify   平均 MAE 6.38 · 5 页 → cli/.runs/stack/verify/verify.json

闭环  5 页 · 111 对象 · gates 12/12 · 回渲 MAE 6.38 · 字符覆盖 100%
所有产物 cli/.runs/stack · 总耗时 16.3s
```

默认产物根为 `<pptx 所在目录>/<stem>-stack/`，下设 `extract/`、`build/`、`verify/`。
任一步失败会打印失败阶段并退出 `1`，已完成步骤保留现场。

---

## 3. `--json` 与退出码

```console
$ python3 cli/htmlppt.py verify --pptx ... --html ... -o ... --json
{
 "command": "verify",
 "ok": true,
 "pptx": "/abs/deck.pptx",
 "html": "/abs/deck.html",
 "out": "/abs/verify",
 "perSlide": [
  {"slide": 1, "mae": 7.66, "pct_gt16": 5.05, "pct_gt48": 3.76},
  {"slide": 2, "mae": 3.99, "pct_gt16": 3.83, "pct_gt48": 2.46},
  {"slide": 3, "mae": 3.98, "pct_gt16": 4.05, "pct_gt48": 2.53},
  {"slide": 4, "mae": 5.06, "pct_gt16": 4.26, "pct_gt48": 3.14},
  {"slide": 5, "mae": 10.86, "pct_gt16": 9.92, "pct_gt48": 7.55}
 ],
 "aggregate": {"slides": 5, "mae": 6.31, "pct_gt16": 5.42, "pct_gt48": 3.89},
 "report": "/abs/verify/verify.json",
 "compare": "/abs/verify/compare.png",
 "elapsedSec": 5.4
}
```

失败时：

```json
{"command": "build", "ok": false, "error": "prototype 构建失败（退出码 1）\n..."}
```

各命令 JSON 顶层字段：

| 命令 | 字段 |
|---|---|
| `doctor` | `checks[]`、`fonts[]`、`missingRequired[]`、`missingFonts[]` |
| `extract` | `html`、`slides`、`objects`、`lossy`、`embed`、`map`、`bytes` |
| `build` | `deck`、`slides`、`verdict`、`gates{}`、`gatesPassed`、`gatesTotal`、`headline{}` |
| `lint <html>` | 入口校验（13 条规则） | `lint --json` / `lint --strict` |
| `verify` | `perSlide[]`、`aggregate{}`、`report`、`compare` |
| `bench` | `runs[]`、`scored`、`quick`、`matrix` |
| `stack` | `steps.extract/build/verify`、`summary{}`；失败时多 `stage` |

---

## 4. 仓库定位与依赖发现

- 仓库根**不依赖 cwd**：`Path(__file__).resolve().parents[1]`。在任何目录运行 `python3 /path/to/cli/htmlppt.py ...` 都可以。
- 子工具 Python：依次尝试 `HTMLPPT_PYTHON` → 仓库约定的 `/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python` → 当前解释器 → `python3`，并要求能 `import pptx, PIL, numpy`。
- Node：`HTMLPPT_NODE` → `PATH` 里的 `node`。
- Chrome：`CHROME` → `Google Chrome.app` → `google-chrome/chromium/chrome`。
- 所有子进程都在仓库根执行，stdout/stderr 被捕获；只有失败时才把尾部日志抛给用户，避免污染 `--json`。

调用关系：

```
htmlppt.py
├── doctor    → shutil.which + fc-match + --version
├── extract   → python pptx2html/pptx2html.py
├── build     → HTMLPPT_DECK/HTMLPPT_OUT/PYTHON → node prototype/src/run.mjs
│                └── metrics.json → gates 摘要
├── verify    → python pptx2html/verify.py → verify.json
├── bench     → 只读 bench/runs/*/score.json
└── stack     → extract → build → verify
```

---

## 5. 本次真跑产物

| 路径 | 内容 |
|---|---|
| `cli/.runs/extract/` | 5 页提取结果（`deck.html`、`assets/`、`map.json`） |
| `cli/.runs/extract/htmlppt-out/` | 默认路径下的构建结果（`deck.pptx`、`metrics.json`、`html/pptx/diff/`） |
| `cli/.runs/verify/` | `verify.json` + `compare.png` |
| `cli/.runs/stack/` | 闭环三阶段完整产物 |

这些目录是验收证据，可随时删除；命令本身不依赖它们。
