# SVG 曲线路径 → DrawingML 曲线

`prototype/src/svgpaths.mjs` 把 SVG `path/@d`（以及 `rect` 圆角）解析成**绝对坐标的
`M / L / C / Z` 序列**，`Q/T/A` 全部折成三次贝塞尔；`postprocess.mjs` 再把它写成
`<a:custGeom>` 里的 `<a:cubicBezTo>`。曲线图标、曲线箭头、拓扑连线因此保持**矢量可编辑**，
不再整块降级成 PNG。

改动的文件：

| 文件 | 作用 |
|---|---|
| `src/svgpaths.mjs`（新增） | tokenizer、全命令解析器、`Q/T→C`、`A→C`（SVG F.6.5 + 自适应分段） |
| `src/measure.mjs` | 页面内改用 `svgpaths.mjs`（源码注入，单一实现）；`rect rx/ry` 走弧；不支持的特性显式回退 PNG |
| `src/postprocess.mjs` | 输出 `a:cubicBezTo`；`path/@w = ext/@cx`、`path/@h = ext/@cy`（EMU 坐标，缩放系数恒为 1） |
| `samples/curves.html`（新增） | 曲线图标 + 曲线箭头 + 拓扑连线样本 |

`convert.mjs` **不需要改**：曲线在 measure 阶段就已折成 `C`，占位矩形 + directive 的协议不变
（`convert_stats.svg` 的口径因此完全没动）。

---

## 1. 数据流

```
samples/*.html
  └─ measure.mjs（在 Chrome 页面里跑）
       ├─ window.__svgpaths = <svgpaths.mjs 源码注入>   ← 剥掉 export 关键字，单一实现
       └─ extractSvgGeometry(): 每个 <path>/<rect rx>/<polyline>/<line>
            → { t:'M'|'L'|'C'|'Z', ... }  绝对坐标（viewBox 用户单位）
  └─ measure.json
  └─ convert.mjs：每个样式分组放一个占位矩形（marker 颜色），记录 directive
  └─ postprocess.mjs：把占位矩形换成 a:custGeom，坐标换成 EMU
  └─ deck.pptx
```

为什么用「源码注入」而不是 `import`：`measureSlideInPage` 由 Playwright 序列化后在**页面**里执行，
拿不到 Node 的模块作用域。`svgpaths.mjs` 无依赖、无副作用，所以 `measure.mjs` 读取它的源码、
去掉 `export ` 关键字、注入成 `window.__svgpaths`——数学只有一份实现，Node 侧单测和页面侧跑的是同一段代码。

---

## 2. 支持的语法

| 命令 | 处理 |
|---|---|
| `M m` | moveto；后续隐式坐标对按 `L/l` 处理（规范要求） |
| `L l` | 直线 |
| `H h` / `V v` | 折成 `L`（绝对坐标） |
| `C c` | 原样保留为 `C` |
| `S s` | 第一控制点 = 上一段三次贝塞尔第二控制点的反射（2·当前点 − 上一控制点）；无前一段则取当前点 |
| `Q q` | 二次→三次精确升阶：`C1 = P0 + 2/3(Q−P0)`，`C2 = P1 + 2/3(Q−P1)` |
| `T t` | 先按上一段二次控制点反射得到 `Q`，再按 `Q` 升阶 |
| `A a` | SVG 规范 F.6.5 端点参数→中心参数，再自适应分段成 `C`（见 §3） |
| `Z z` | `close`（`a:close` 会补上闭合直线，与 SVG 一致） |
| 隐式重复 | `M0 0 10 0 20 0`、`c ... ...` 都支持 |
| 相对坐标 | 全部就地换算成绝对坐标 |
| `rect rx/ry` | 圆角用同一套弧→贝塞尔（SVG 1.1 §9.2 的 rx/ry 自动规则） |

解析失败（未知命令、缺参数、非有限数、非法弧标志、不以 moveto 开头）→ `parsePathD` 返回 `null`，
调用方把**整个 SVG** 回退成 4x PNG，绝不画半截路径。

坐标模型（写进 `measure.json`）：

```jsonc
{ "t": "M", "x": 20.49, "y": 15 }
{ "t": "L", "x": 23, "y": 4 }
{ "t": "C", "x1": 33.4, "y1": 8.2, "x2": 28.1, "y2": 12.7, "x": 30.5, "y": 20.1 }
{ "t": "Z" }
```

---

## 3. `A` → 三次贝塞尔（SVG 规范 F.6.5 + 自适应分段）

1. **F.6.5**：端点参数 `(x1,y1,rx,ry,φ,fA,fS,x2,y2)` → 中心参数 `(cx,cy,rx,ry,φ,θ1,Δθ)`。
   - 终点=起点 → 不画（F.6.2）；`rx`/`ry` 为 0 → 退化成直线；
   - F.6.6 半径过小（`Λ>1`）→ 按规范把 `rx/ry` 同比例放大（不是直接放弃）；
   - `fA==fS` 时圆心取负号，`fS` 决定 `Δθ` 的符号，保证大弧/小弧、顺时针/逆时针都对。
2. **分段**：初始 `n = ceil(|Δθ| / 90°)`，每段用标准 alpha 近似
   `α = sin θ · (√(4 + 3·tan²(θ/2)) − 1) / 3` 生成单位圆上的三次贝塞尔。
3. **误差检查在单位圆空间**：对每段在 `t = 0.25/0.5/0.75` 采样，取
   `max |‖B(t)‖ − 1|`，再乘 `rmax = max(rx,ry)` 换成 px。这是仿射不变的检查方式
   （在椭圆空间直接量会随半径/旋转失真）。`err·rmax > tol` 就 `n *= 2` 重来，最多 10 轮 / 8192 段。
4. 单位圆上的点再经 `E(p) = C + R(φ)·S(rx,ry)·p` 映射到椭圆空间。

默认容差 `PATH_TOLERANCE = 0.1`（**viewBox 用户单位**，与参考实现一致；渲染误差 ≈ 0.1 × 渲染缩放）。

分段数随角度和半径自适应（实测，`tol = 0.1`）：

| 弧 | 0.1 容差 | 0.01 容差 |
|---|---|---|
| 90°，r=10 | 1 | 2 |
| 180°，r=10 | 2 | 4 |
| 270°（large-arc），r=10 | 3 | 6 |
| 180°，r=46 | 2 | 4 |
| 180°，r=1000 | 4 | 8 |

即「每 ≤90° 一段」是起点，只有半径很大或容差很严时才会翻倍——本文 3 页样本里所有弧线、二次曲线
加起来只写了 45 个三次贝塞尔段。

---

## 4. 精度实测

### 4.1 解析正确性：对照 Chrome（独立实现）

同一段 `d` 同时交给 ①Chrome 的 `<path>` + `getPointAtLength()`（按弧长采样 400 点）
和 ②本模块（每段三次贝塞尔离散 80 点），算单向 Hausdorff 距离（Chrome 采样点到我们折线的最近距离取最大值）。
不是拿自己的数学对答案，而是拿浏览器对答案——顺带覆盖了相对坐标、S/T 反射、大弧/小弧、sweep 方向。

| 用例 | 最大偏差 |
|---|---|
| `M0 0 Q50 -80 100 0`（Q 升阶） | 0.0062 px |
| `M0 0 Q…T…`（T 反射） | 0.0062 px |
| `M0 0 C…S…`（S 反射） | 0.0118 px |
| `M0 0 A50 50 0 0 1 100 0`（半圆） | 0.1003 px |
| `M10 10 A80 40 30 1 0 120 90`（旋转椭圆大弧） | 0.0799 px |
| `M0 0 A10 10 0 0 1 60 0`（半径过小，F.6.6 放大） | 0.0602 px |
| `M0 0 a20 10 45 0 1 40 0`（相对弧） | 0.0572 px |
| `rect rx=20 ry=8` | 0.0216 px |
| 心形 `a5.5 5.5 … z` | 0.0003 px |

拒绝用例也验过：`M0`、`M0 0 L`、`X5 5`、`M0 0 Z 5 5` 等 7 种畸形输入全部返回 `null`。

### 4.2 容差上界：解析径向误差

Chrome 的 `getPointAtLength` 本身有大路径误差：180°、r=1000 的弧它给出的总长是
3142.036，而真值是 `π·1000 = 3141.593`，采样点最大偏离真圆 **0.27px**。所以上表在超大半径下
不可分辨。真正代表精度的是解析径向误差（把每个贝塞尔采样点反变换回单位圆空间，
取 `|‖u‖−1|·rmax` 的最大值）：

| 弧 | 段数 | 解析径向误差 |
|---|---|---|
| `A50 50` 半圆 | 2 | 0.0981 px |
| `A80 40 30 1 0` 旋转椭圆 | 3 | 0.0774 px |
| `A10 10 → 60 0`（半径放大后 r=30） | 2 | 0.0589 px |
| `a20 10 45 0 1` | 2 | 0.0621 px |
| `A600 200 25 1 1` | 6 | 0.0104 px |
| `A1000 1000` 半圆 | 4 | 0.0292 px |

全部 ≤ 0.0981px，即 0.1px 的承诺是**真的上界**，不是「大致」。
半圆之所以贴着 0.1：参考实现的 α 公式在 90° 时略小于精确的 `4/3·tan(θ/4)`
（0.54858 vs 0.55228），单段径向误差 0.196%·r，r=50 正好用掉 0.098px 预算；
r>51 的 90° 弧会自动翻倍（r=1000 时 4 段，误差 0.029px）。换句话说，
自适应分段把误差**压在容差内**，同时允许单段误差逼近容差——这是参考算法的取舍，不是实现偏差。

### 4.3 复跑

临时脚本（不落库）：页面里 `p.setAttribute('d', d)` 后用 `getPointAtLength` 采样 400 点，
本模块每个 `C` 段离散 80 点算单向 Hausdorff 距离；解析误差用 §4.2 的反变换公式。

---

## 5. DrawingML 输出与坐标约定

`postprocess.mjs` 从占位 `<p:sp>` 的 `<a:ext>` 里读出真实尺寸，令
**`path/@w = ext/@cx`、`path/@h = ext/@cy`**，坐标按 `kx = ext.cx / viewBox.width` 换算成 **EMU**。
这样 DrawingML 的映射系数恒为 1（1 个 path 单位 = 1 EMU），不会因为二次缩放损失精度。

真实产物（`samples/curves.html` 第 2 页刷新图标的圆弧段，`ext = 419100×419100` EMU = 44px）：

```xml
<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/>
  <a:pathLst>
    <a:path w="419100" h="419100">
      <a:moveTo><a:pt x="357807" y="261938"/></a:moveTo>
      <a:cubicBezTo><a:pt x="334556" y="327748"/><a:pt x="270120" y="370555"/><a:pt x="200442" y="366478"/></a:cubicBezTo>
      <a:cubicBezTo><a:pt x="130764" y="362402"/><a:pt x="71759"  y="312374"/><a:pt x="56340"  y="244301"/></a:cubicBezTo>
      <a:cubicBezTo><a:pt x="40922"  y="176228"/><a:pt x="72612"  y="105658"/><a:pt x="133734" y="71957"/></a:cubicBezTo>
      <a:cubicBezTo><a:pt x="194855" y="38255"/> <a:pt x="271448" y="49119"/> <a:pt x="320786" y="98489"/></a:cubicBezTo>
      <a:lnTo><a:pt x="401638" y="174625"/></a:lnTo>
    </a:path>
  </a:pathLst>
</a:custGeom>
```

- 一个 SVG `<path>` 元素 → 一个 `<a:path>`（内部可以有多个 `moveTo` 子路径，DrawingML 允许）；
- `<a:cubicBezTo>` 固定 3 个 `<a:pt>`（控制点1、控制点2、终点）；
- 每个 `<a:cubicBezTo>` 在 PowerPoint / LibreOffice / WPS 里都是可拖控制柄的真曲线；
- 线宽仍是 `stroke-width × (ext.cx / viewBox.width) × 0.75pt`，端帽/连接沿用原逻辑。

---

## 6. 回归数字（本轮实测）

### 6.1 `cd prototype && npm run build`（samples/deck.html，5 页）

| 指标 | 改前 | 改后 |
|---|---|---|
| gates（12 项） | 12/12 PASS | **12/12 PASS** |
| MAE | 4.25 | **4.25** |
| diff>16 | 4.06% | **4.06%** |
| diff>48 | 2.97% | **2.97%** |
| 文本覆盖率 / `a:t` | 100% / 68 | **100% / 68** |
| 整页大图 / `p:pic` | 0 / 3 | **0 / 3** |
| `a:custGeom` / `a:cubicBezTo` | 8 / — | **8 / 0** |
| zip DEFLATE | 39/39 | **39/39** |
| 构建耗时 | ~10s | **~10s**（10.3–15.6s，随 LibreOffice 波动） |

该 deck 的 8 个图标全是直线路径，所以 `cubicBezTo = 0` 是**预期**结果：像素指标一位不差，
说明换成 EMU 坐标空间 + 曲线上游改造没有动到既有直线输出。

### 6.2 基准语料 `HTMLPPT_DECK="../bench/corpus/deck.html" ... node src/run.mjs`

| 指标 | 改前（`bench/runs/ours`） | 改后（`bench/runs/ours-svg`） |
|---|---|---|
| gates（12 项） | PASS | **PASS** |
| MAE | 5.86 | **5.86** |
| diff>16 / diff>48 | 6.64% / 4.45% | **6.64% / 4.45%** |
| `a:t` / 覆盖率 | 89 / 100% | **89 / 100%** |
| `p:pic` / 整页大图 | 2 / 0 | **2 / 0** |
| `a:custGeom` / `a:cubicBezTo` | 5 / — | **5 / 0** |

篇幅内的两个图表 SVG 含 `<text>`，仍按设计走 PNG 兜底（`p:pic=2`），其余 5 个 custGeom 形状的像素结果逐项相同
（坐标编码从「viewBox×1000」换成 EMU，几何等价，所以 MAE/diff 完全没动）。

### 6.3 曲线样本 `samples/curves.html`（3 页）

```bash
cd prototype
HTMLPPT_DECK="samples/curves.html" HTMLPPT_OUT="/tmp/htmlppt-curves" node src/run.mjs
cd /tmp/htmlppt-curves && unzip -q deck.pptx -d x && \
  grep -o '<a:cubicBezTo>' x/ppt/slides/slide*.xml | wc -l     # → 45
```

| 指标 | 实测 |
|---|---|
| **`<a:cubicBezTo>` 总数** | **45**（第 1 页 4 / 第 2 页 27 / 第 3 页 14） |
| `a:custGeom` 形状 | 15 |
| `p:pic`（PNG 兜底） | **0** |
| 页面数 / `a:t` / 覆盖率 | 3 / 43 / 100% |
| MAE / diff>16 / diff>48 | 3.95 / 3.74% / 2.71% |
| gates（12 项） | **12/12 PASS** |

样本里 10 个内联 SVG 有 9 个含曲线命令（`C/S/Q/T/A/a`）——旧实现（`d` 里出现 `C/S/Q/T/A` 就
`return null`）会把这 9 个整块降级成 4x PNG；现在它们全部是矢量，第 10 个（圆角矩形 `rect rx=4`）
的圆角也从直角变成了真正的弧。

目视核对：曲线区域在 `out/diff/slide-N.png`（放大差异图）里只剩 1px 抗锯齿描边，
形状、箭头方向、圆环缺口与 HTML 一致。

---

## 7. 限制（会显式回退 PNG，不会画出错图形）

`measure.mjs` 里对下列情况直接把整个 SVG 标成 `supported = false` → 4x PNG 兜底，
并把原因写进 `measure.json` 的 `warnings[].reasons`：

| 情况 | reason | 说明 |
|---|---|---|
| `transform`（元素或祖先 `<g>`、`<svg>`） | `element-transform` / `svg-transform` | 未应用 CTM；带旋转/缩放的图标宁可位图 |
| `<use>` `<clipPath>` `<mask>` `<pattern>` `<marker>` `<symbol>` `<image>` `<svg>` 嵌套 | `<use>` / `<clipPath>` / … | 引用、裁剪、箭头 marker、嵌套视口都不支持 |
| `fill`/`stroke` 为 `url(#…)`（渐变、图案） | `paint-server` | 一个 custGeom 形状只带纯色描边/填充 |
| SVG 内有 `<text>` / `<tspan>` / `foreignObject` | `svg-text` | custGeom 会丢字（既有策略：不丢内容） |
| `d` 无法解析 / 图元非法 | `unparsable-path` / `bad-geometry` | 不画半截路径 |
| 没有任何可画图元 | `empty-geometry` | — |

其他已知限制（不影响解析正确性）：

- **紧凑弧标志**：`a5 5 0 0110 0` 这种省略分隔符的 flag 写法不支持——两个 flag 被校验为必须恰为 0/1，
  一旦被读成 `110` 就判整条路径失败 → 整个 SVG 回退 PNG（不会画出错形状）；正常带空格的
  `A 5 5 0 0 1 10 0` 没问题。
- **容差单位**是 viewBox 用户单位：24 单位图标放大到 72px 时，屏上误差 ≤ 0.3px。
- **不做曲线简化/拟合**：一段弧至少 1 个三次贝塞尔，顶点数随角度线性增长（180°/r=1000 时 4 段）；
  上限 8192 段。
- **`preserveAspectRatio` 未实现**：viewBox 直接拉伸到元素矩形（与本次改动前一致；正方形 viewBox 无影响）。
- **虚线 / marker**：`stroke-dasharray` 与 `marker-start/end` 仍不映射（既有限制，与曲线无关）。
- **even-odd 填充孔**：一个 `<path>` 的多个子路径会写成同一个 `a:path` 的多段 `moveTo`，
  PowerPoint 的填充孔规则与 SVG `fill-rule="evenodd"` 不完全等价（既有限制）。
- **渐变/图案填充**的图形不会被静默丢弃：整个 SVG 回退 PNG（见上表）。

---

## 8. 模块 API

```js
import {
  tokenizePath,      // d -> [ 'M', 0, 0, 'L', 10, 0, ... ]
  parsePathD,        // d -> { cmds:[{t:'M'|'L'|'C'|'Z',…}], closed, subpaths } | null
  quadToCubic,       // (p0, q, p1) -> { c1, c2, p }
  arcCenterParams,   // SVG F.6.5: 端点参数 -> { cx, cy, rx, ry, phi, th1, dth } | null
  arcToCubics,       // (x1,y1,rx,ry,phi,fA,fS,x2,y2,tol?) -> [{c1,c2,p}] | null | []
  rectPath,          // (x,y,w,h,rx,ry,tol?) -> cmds（圆角走弧）
  PATH_TOLERANCE,    // 0.1
} from './svgpaths.mjs';
```

`arcToCubics` 的三态返回是有意的：`null` = 退化成直线（零半径），`[]` = 零长度不画，
数组 = 真正的贝塞尔段——调用方不会把「退化」误当成「解析失败」。
