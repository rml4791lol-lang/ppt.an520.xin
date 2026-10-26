---
name: anppt-module
description: AnPPT v2 功能模块规范与存量归拢——新建模块、审查模块边界、执行存量归拢时使用。触发词：模块、归拢、四件套、自包含目录。
---

# AnPPT v2 功能模块

形态：整块自包含目录 `src/modules/<key>/`（样板：`ppt-replicate`）：

```
src/modules/<key>/
  README.md     边界：模块有什么、依赖哪些平台件、测试在哪
  server/       服务端逻辑，唯一出口
  client/       React 组件与前端规则
```

四件套缺一不可：开关（feature-flags.ts 登记，beta 起步）、计价（复用 credits 幂等成例）、测试（`scripts/tests/<key>.test.mjs`，由主套件注入 ctx 调用）、文档（README + DEBUG-HANDBOOK 小节）。

边界（lint 强制，`import/no-restricted-paths`）：

- 模块可依赖平台件（lib/server、lib/client、data、共享组件）；平台件不得 import 模块
- 模块之间不交叉 import；交叉需求下沉平台层
- 合法例外在 `eslint.config.mjs` 以 overrides 逐个登记并注释原因
- 页面/路由是薄壳（Next 硬约束留 src/app）：只做鉴权/参数/调模块
- 页面级编排组件（upload-card/template-library 等）允许 import 模块 client 做接线；纯共享件（icons/layout）不得

存量归拢顺序（每次一块，搬完全量门必绿）：editable-export → image-edit-tools → single-page → deck → payments → admin → auth。

搬移手法：mv 文件 → 修导入（模块内部相对路径，平台件用 @/ 别名）→ 抽测试 → 写 README → 更新手册/DEVELOPMENT → 全量门。
