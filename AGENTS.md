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
