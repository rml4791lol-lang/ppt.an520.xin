# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-31

首个公开发布版本（v2 架构）。

### Added

- **生成链路**：文档解析 → 大纲 → 内容梳理 → 风格选择 → 逐页配图 → 图片版 PPTX；单页工作台与整套工作台共用同一套视觉计划。
- **可编辑导出**：WPS / Image2PPT / Codia 多通道按能力声明与页数上限自动选择、失败回退；轻量文字可编辑档（VLM 文字覆盖层，beta）。
- **账户与计费**：邮箱 OTP 与密码登录、星币台账、逐页扣费与失败自动退币、套餐与兑换码、微信 Native 与支付宝（epay）回调履约。
- **任务可靠性**：deck 状态机、幂等重放、崩溃窗口恢复、恢复源注册表、读路径懒恢复（续跑不重复扣费）。
- **插件运行时**：`src/lib/plugin` 契约 + `ctx` 服务注册表 + `profile` 启动期装配；价格表与模型清单收敛为插件（ADR-0001）。
- **功能模块**：`src/modules` 自包含目录（server/ + client/ + README + 契约测试）。
- **生图池**：按单价排序、同价轮换、逐站回退、站内多 key 轮换、死 key 冷却、站点记账。
- **运营与排障**：功能开关板（off/beta/public）、问题日志落盘与健康自查、60 个 Route Handler。
- **工程护栏**：`npm run gate`（分支守卫、标记扫描、lint、typegen、tsc、护栏夹具、B 层 184 项、C 层 1019 项断言）、`gate:fast`、提交前钩子、worktree 脚本、发布校验。
- **文档**：`docs/DEBUG-HANDBOOK.md`（系统全貌）、`docs/DEVELOPMENT.md`（架构与流程）、`docs/LOGGING.md`、`docs/adr/`、`docs/migration/`、本仓库时间线 `docs/TIMELINE.md`。

### Security

- 以 Apache-2.0 开源；公开前完成密钥审计：`.env` 不入库，微信商户号与 AppID 在文档中脱敏。

[0.1.0]: https://github.com/rml4791lol-lang/ppt.an520.xin/releases/tag/v0.1.0
