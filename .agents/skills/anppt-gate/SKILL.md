---
name: anppt-gate
description: AnPPT v2 全量门——任何改动算"完成"前跑一条命令。当用户说"跑一下门"、"验收"、"全绿"、"提交流程"时使用；改动收尾时也应主动按此执行。
---

# AnPPT v2 全量门

改动算完成 = `npm run gate` 退出码 0。

门内部顺序固定、失败即停：分支范围空白与冲突标记 → lint → typegen + tsc → 两套测试 → build。

迭代期用快集：`npm run gate:fast`（跳过 build 与两套测试，其余步骤同一套实现）。

纪律：

- 门就是唯一口径：不要手抄命令，也不要在文档里另写一套五步；文档提到但命令没有的检查视为缺陷。
- 测试断言数变化 → 同步 `README.md` 与 `docs/DEBUG-HANDBOOK.md` §8 的数字。
- 解冲突后照常跑完整门：冲突标记由门内 markers 步骤全量扫描（2026-10-27 一个带冲突标记的 merge 躲过了 lint/tsc/build）。
- 测试里 Codia/生图/VLM 一律 mock；真机验证走 dev 小额度（`npm run dev -- -p 3120`）。
- 不在 build 进行时起 dev（抢 `.next` 目录）。
- 不执行 git commit/push/reset/rebase，除非用户明确要求。
