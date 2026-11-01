# 无障碍检查（ui-check）

一条命令把「视觉对比度 / 键盘可达 / 读屏播报 / 标题层级 / 触控尺寸」变成可复跑的断言，而不是评审时说一句"这里有点问题"。

## 跑法

```bash
npm install                        # 首次：装 playwright 与 @axe-core/playwright
npx playwright install chromium    # 首次：拉浏览器；装不上会自动回落系统 Chrome
npm run ui-check                   # 起 dev(3155) → 7 路由 × 2 视口 → 报告
npm run ui-check -- --only /login  # 只查一条路由（调试用）
npm run ui-check -- --no-server --port 3100   # 复用已起的 dev
```

产物：`output/ui-check/report.json`（全量结构化）、`output/ui-check/shots/*.png`（有问题的路由各一张）。退出码 `0` 全绿 / `1` 有失败 / `2` 运行错误（起不来、浏览器缺失）。

**为什么不进 `npm run gate`**：门要秒级且不要求本机装浏览器；`ui-check` 是提交前自选、由人或 CI 显式触发的重型检查。改了 `src/app/globals.css` 的 token、任何表单/弹层/图片布局，跑它。

## 断言了什么

| 类别 | 内容 |
| --- | --- |
| axe | 标签集 `wcag2a wcag2aa wcag21a wcag21aa`，7 条路由 × 1280×800 / 390×844 |
| `dropdown-keyboard` | 首页页数选择器：触发键要有 `aria-expanded`，方向键能改值，Esc 能关 |
| `drawer-focus-trap` | 移动端抽屉：Tab 12 次不得离开 `#mobile-nav`，Esc 后仍关闭且焦点回到触发键 |
| `form-error-announced` | 登录页提交失败后有 `role="alert"` 或 `aria-live` 承载错误文本 |
| 标题 | 每页恰好一个 `h1` |
| 触控 | 移动端可点元素不得小于 24×24（统计数，做棘轮） |
| LCP/CLS | 每页记录 LCP 元素（文本还是图、多 src）与累计布局偏移；CLS > 0.1 判失败 |

axe 看不见键盘与焦点（它是静态 DOM 审），所以那三件事必须真按键盘，写成行为断言。

### 触控目标怎么改

- 文字链接（页脚导航、卡片里的"查看 X"、行内条款链接）：`inline-flex min-h-6 items-center` —— 24px 高，字号和基线不变。
- 纯图标按钮（公告栏关闭）：图标 14px 时用 `p-1.5` → 26×26。
- 不要用 `after:absolute inset-[-4px]` 之类扩热区：ui-check 量的是元素盒子，热区不在盒子里就量不到，等于没守。

## 基线棘轮

`scripts/ui-check-baseline.json`：

```json
{ "allowedRules": { "rule-id": { "reason": "为什么接受", "ref": "#票或文档" } }, "touchTargetUndersizedMax": 0 }
```

- `allowedRules` 只用于**明确接受、且写下来源**的规则；不接受就不写，红了就修。
- `touchTargetUndersizedMax` 只能降不能升。新页面引入小目标 → 数字变大 → 立刻红。
- 报告区分「失败」与「已基线豁免」，两者不会混在一起。

## 首次基线（2026-11-01，修之前）

快照留在 `docs/a11y-baseline-2026-11-01.json`。32 项失败：

- axe 643 节点 / 3 规则：`color-contrast` 635（80% 集中在 5 个 token）、`link-in-text-block` 6（登录页条款链接）、`label-content-name-mismatch` 2（首页）。
- 行为 3 条全红：页数选择器无 `aria-expanded` 且方向键无效、抽屉 Tab 12 次焦点全部外逃、登录错误无播报节点。
- `/login`、`/single-page` 无 `h1`（各两个视口）。
- 移动端小目标：`/` 24、`/help` 26、`/projects` 19、`/style-packs` 18、`/exports` 18、`/login` 5、`/single-page` 1。

这些数字就是本仓库 a11y 整改的起点，收尾时应当全部归零或写进基线并说明理由。

改完 token 后 `color-contrast` 已从 635 节点归零（2026-11-01，同日），基线快照保留的是**修复前**的红线，别拿它当当前状态。

## 色彩 token 与对比度

改了这些值就是在改合规线，跑一次 `npm run ui-check` 复验（它读的是浏览器渲染值，不是本表）。

| token | 值 | 白底 | 主要用途 |
| --- | --- | --- | --- |
| `--color-brand` | `#c23c05` | 5.33:1 | 品牌文字与主按钮填充（白字压它 5.33:1） |
| `--color-brand-strong` | `#a13203` | 7.06:1 | hover/按下态 |
| `--color-brand-soft` / `-softer` | `#fef1e9` / `#fff8f3` | — | 浅色底；`brand` 压它 4.81/5.07:1 |
| `--color-ink` / `ink-2` | `#1f2329` / `#4e5562` | 15.78 / 7.50 | 标题与正文 |
| `--color-ink-3` | `#646c7a` | 5.29:1 | 次要信息、占位符、脚注（最低处 `#f6f7f9` 上 4.94） |
| `--color-line-control` | `#8a919e` | 3.17:1 | 表单控件边界（WCAG 1.4.11 要求 3:1） |
| `--color-line` / `-strong` | `#eceef2` / `#dfe2e8` | 1.16 / 1.30 | **仅装饰分隔线**，不得用作控件边界 |
| `--color-danger` | `#b42318` | 6.57:1 | 错误文字与危险按钮；压 `#fdeeee` 5.84:1 |

原来的亮橙 `#f2571a`（白字压它只有 3.41:1）已从 token 移除；装饰性的橙色只出现在硬编码的渐变/阴影里，不承载文字。

## 已知环境问题

- `playwright` 1.64 要 `chromium_headless_shell-1248`，若本机缓存是旧版本，bundled 启动会失败。脚本按 `bundled → channel:'chrome'` 顺序回落，有系统 Chrome 就能跑。
- dev 模式下 React 的错误遮罩会渲染进 axe 统计；出现可疑的 `color-contrast` 暴涨时先看截图里有没有红色遮罩。
