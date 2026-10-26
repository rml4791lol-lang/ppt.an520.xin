---
name: anppt-gate
description: AnPPT v2 全量门——任何改动算"完成"前必须五连全绿。当用户说"跑一下门"、"验收"、"全绿"、"提交流程"时使用；改动收尾时也应主动按此执行。
---

# AnPPT v2 全量门

改动算完成 = 以下五步全绿，缺一不可（顺序执行，任何一步红了先修再往下）：

```bash
npm run lint -- --max-warnings=0   # 含架构边界 import/no-restricted-paths
npx tsc --noEmit                   # .next/types 缺失先跑 npx next typegen
node scripts/test-backend.mjs      # 账户/支付/后台/开关板域
node scripts/test-generation.mjs   # 生成/导出/计费域，全 mock，禁止真实付费调用
npm run build && git diff --check
```

纪律：

- 测试断言数变化 → 同步 README 与 docs/DEBUG-HANDBOOK.md §8 的数字
- 测试里 Codia/生图/VLM 一律 mock；真机验证走 dev 小额度（`npm run dev -- -p 3120`）
- 不在 build 进行时起 dev（抢 .next 目录）
- 不执行 git commit/push/reset/rebase，除非用户明确要求
