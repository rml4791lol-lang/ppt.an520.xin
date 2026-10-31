# 分支合并盘点（2026-10-31）

目的：按「按时间线合并；太久远、会覆盖现有功能的就不合并」的口径，把仓库里 11 个本地分支、
24 个远程分支逐个核一遍，判断还有没有内容值得回捞。

结论：**没有可合并的分支。** 除 `production` 与 `integration/image-pool` 同源外，其余分支都是独立根
（`git merge-base` 全部返回 "no merge base"），本质是 8–10 月的旧快照；它们相对 HEAD 的差异是
「HEAD 更新、分支更旧」的方向，merge 会把旧实现盖回来。唯一确认丢失且值得修的是顶栏登出入口，
已在本次补回。

## 分支清单与处置

| 分支 | tip | 处置 | 依据 |
| --- | --- | --- | --- |
| `integration/image-pool` | 2026-10-31 | 当前 HEAD | 生图站池 + 余额熔断，即 #48 的实现 |
| `production` | 2026-10-31 | fast-forward 到 HEAD | 同源 |
| `spec/architecture-deepening` | 2026-10-29 | 跳过 | `paid-run.ts` / `charge-keys.ts` 内容与 HEAD 一致；`images.ts`（588 行）已被 HEAD 975 行的站池覆盖；`recovery.ts`（289 行）已被 `paid-run.ts` 的 `failPaidRun` 取代 |
| `fix/upstream-balance-alert` | 2026-10-28 | 跳过 | tip 的余额告警已被 `deploy/anppt-health-monitor.py` 的 `is_balance_error` + 4 元组覆盖；其余是重命名/迁移 |
| `integration/guardrails-17` | 2026-10-28 | 跳过 | 是上一条的父提交（子集）；`scripts/gate.mjs`、`test-guardrails.mjs`、`release.mjs` 等对 HEAD 零差异 |
| `import-batches` | 2026-10-26 | 跳过 | HEAD 文件集的真子集（667 个 HEAD-only 文件）；`eslint.config.mjs` 的豁免指向不存在的文件 |
| `legacy/*`（23 个远程 ref） | 2026-08 ~ 10-20 | 跳过，保留作档案 | 见下节 |
| `backup/pre-push-*` | — | 跳过 | 推送前快照 |

`refs/remotes/legacy/` 是 23 个 ref、21 个唯一 commit（4 个 WIP 分支同一 commit `308b949`；
`production` 与 `beautify-batch-recovery` 同为 `5c15d9c`）。

## 有意不回捞

- **BIM 竞赛垂类**（`legacy/codex/bim-competition-vertical`，10-20）：`src/app/(main)/bim/page.tsx`
  285 行 + 7 个 `bim-*` 页型。HEAD 的垂类叙事已换到设计风格/模板体系，回捞要重接导航、首页与
  sitemap，属于「覆盖现有功能」。
- **site-agent / html-slide / html-pptx**（`legacy/cursor/26ddd8d5`，09-13）：整套功能已从产品删除，
  其 ADR 描述的 `TEMPLATE_EDITABLE_CLAUSE` 等在 HEAD 全无，文档不可直接使用。
- **MinerU 扫描件解析**（`legacy/cursor/b4e562e6`，09-02）：`src/lib/server/mineru.ts` 567 行是独立
  客户端，但其产品路径（`mineru:` 任务前缀、5🌟/25🌟 扫描件重建）在 HEAD 已整体消失；将来要恢复
  再单独捞这一个文件与测试块。
- **admin 用户 watch**（`legacy/main`）：HEAD 只保留 `users/[id]/role`。
- **`/api/pptx-exports/quote`**：HEAD 有意删除（`docs/DEBUG-HANDBOOK.md` §30，
  `scripts/tests/surface-intents.test.mjs:166` 断言无 `quoteExport`）。
- **`scripts/test-{mapping,page-types,prompt}.mjs`**：断言已并入 `scripts/test-generation.mjs`
  与 `scripts/tests/visual-plan.test.mjs`。

## 本次补回：顶栏登出入口

`src/components/layout/user-area.tsx` 在重构后只剩用户名文本，`/api/auth/logout` 没有任何调用方。
现按 `legacy/codex/logout-entry`（`93d9d8d`）的做法补回用户菜单：用户名按钮（`aria-haspopup` /
`aria-expanded` / `aria-controls`）→ `role="menu"` → 「退出登录」，`POST /api/auth/logout`
带 `x-anppt-action: 1`，成功后 `window.location.replace("/")`。Escape 与点击外部关闭菜单。

验证：本地 3111 端口用探针账号登录后，菜单展开出现「退出登录」，`aria-controls` 与菜单 id 一致，
Escape 可关闭；点击退出后跳回 `/`，`/api/auth/session` 返回 `authenticated: false`。

## 复核命令

```bash
git merge-base HEAD <branch> || echo "独立根"
git cat-file -e HEAD:<path> && echo "HEAD 已有"
git diff --shortstat HEAD...<branch>
git ls-remote origin refs/heads/production
```
