<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 项目约定（先于一切编码动作阅读）

- 系统全貌唯一权威入口：`docs/DEBUG-HANDBOOK.md`（部署/链路/计费/恢复/禁区）；改完代码必须同步更新对应小节。
- 架构与开发流程：`docs/DEVELOPMENT.md`（金字塔分层、最小改动、开关板三步、注释纪律、测试与提交）。
- 动手前先 grep 现有实现：扣费/退星/幂等键/懒恢复/配置快照/功能开关均已成例，照抄模式，不另发明。
- 代码里克制注释（只留"为什么"），机制与决策原因写进 docs/，不写进代码。
- 两套测试全绿（`node scripts/test-backend.mjs`、`node scripts/test-generation.mjs`）+ lint + tsc + build 通过，才算一个改动完成。

## Agent skills

### Issue tracker

任务与 spec 跟踪在本仓库的 GitHub Issues（`gh` CLI 操作）。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认分诊标签：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根 `CONTEXT.md` + `docs/adr/`（均惰性创建，由 domain-modeling 技能在有真实术语/决策时落地）。见 `docs/agents/domain.md`。

### 项目级技能

`.agents/skills/`：`anppt-gate`（全量门）、`anppt-deploy`（部署）、`anppt-module`（功能模块四件套与归拢顺序）。新会话优先于全局技能加载。

## Cursor Cloud specific instructions

云端 Agent 跑在独立 Ubuntu VM，**读不到本机 `.env.local` 和 `127.0.0.1:6800` 隧道**。密钥只从 Cursor Dashboard → Cloud Agents → Secrets 注入。

- 生图：配 `ANPPT_V2_IMAGE_BASE_URL` / `ANPPT_V2_IMAGE_API_KEY` / `ANPPT_V2_IMAGE_MODEL`（以及灾备 `ANPPT_V2_IMAGE_BACKUP_*`）。类型用 **Runtime Secret**。
- LLM：不要把本机隧道地址带上云。若 `ANPPT_V2_LLM_BASE_URL` 含 `127.0.0.1`/`localhost`，`scripts/cloud-dev.sh` 会改走 `ANPPT_V2_LLM_BACKUP_*`（DeepSeek 官方）。
- 转可编辑：另配 `ANPPT_V2_CODIA_API_KEY`（本机 `.env.local` 目前也没有这项）。
- 禁止把 `.env.local` 提交进 Git；本仓库自 2026-10-31 起 **public**（Apache-2.0，`rml4791lol-lang/ppt.an520.xin`，本地唯一开发目录 `/Users/an/Desktop/Atlas/ppt.an520.xin网站`）——任何提交都会立刻公开，商户号/密钥/服务器凭据一律不入库。
- 日常验证用 mock 测试：`node scripts/test-backend.mjs` 与 `node scripts/test-generation.mjs`。真实生图/Codia 会扣上游额度，用户没点名就不要打付费接口。
- 密钥注入发生在 Agent **启动时**；改完 Secrets 要新开一轮 Cloud Agent。
- 未 git push 的本地改动不会出现在云端会话里。
