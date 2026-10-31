# AnPPT v2

**把文档变成能直接讲、还能改的 PPT。**

上传 Word / PDF / Markdown，或按页录入要点 —— 经过大纲、内容梳理、风格选择，逐页生成配图，最后导出可直接放映的 PPTX，或继续在 Office / WPS 里二次编辑的可编辑档。

Next.js 16 全栈单体（App Router + Route Handlers + `node:sqlite`），不依赖 Redis / MQ / 对象存储，**一台机器就能跑起来**。

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) · [在线体验](https://ppt.an520.xin) · [文档](docs/) · [路线图](ROADMAP.md) · [变更日志](CHANGELOG.md)

---

## 为什么做这个

从素材到能讲的 PPT，通常要花几个小时：找模板、排大纲、配图、调字号、导 PDF 再导 PPTX。现有 AI 工具多数止步于「生成大纲和文字」，交到你手里的还是需要重排的半成品。

AnPPT 的目标是把 **文档 → 逐页配图 → 可编辑 PPTX** 这条链路做成可自部署、可扩展的基础设施：生成要能中断续跑、失败要退币、导出要能在 Office 里接着改。

## 核心能力

| 能力       | 说明                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 多形态输入 | 上传文档解析成页，或按页手工录入；单页工作台与整套工作台共用同一套视觉计划                                        |
| 生成链路   | 大纲 → 内容梳理 → 风格选择 → 逐页配图 → 图片版 PPTX                                                               |
| 可编辑导出 | WPS / Image2PPT / Codia 多通道按页数与能力自动选择、失败回退；另有轻量文字可编辑档（beta）                        |
| 账户与计费 | 邮箱 OTP + 密码登录、星币台账、逐页扣费、**失败自动退币**、套餐与兑换码、微信 Native / 支付宝回调履约             |
| 任务可靠性 | deck 状态机、幂等重放、崩溃窗口恢复、恢复源注册表、读路径懒恢复 —— 断点续跑不重复扣费                             |
| 插件运行时 | 价格表、模型清单、UI 入口收敛为插件；平台只依赖 `ctx` 契约（[ADR-0001](docs/adr/0001-plugin-runtime-advance.md)） |
| 生图池     | 按单价排序 + 同价轮换 + 逐站回退 + 站内多 key 轮换 + 死 key 冷却 + 站点记账                                       |
| 运营与排障 | 功能开关板（off/beta/public）、问题日志落盘、健康自查、60 个 Route Handler                                        |

## 生成链路

```
文档 / 手工录入
    │  解析成页（documents）
    ▼
大纲 ── 内容梳理 ── 风格选择
    │
    ▼  视觉计划（visual plan）
逐页配图 ── 生图池调度（按单价、逐站回退）
    │
    ├── 图片版 PPTX（合成即用）
    └── 可编辑导出（WPS → Image2PPT → Codia 自动降级）
```

每一页的生成与计费都挂在同一套幂等键上：进程崩溃、用户刷新、任务重跑都不会重复扣星币。

## 技术架构

- **运行时**：Next.js 16.3（App Router + Route Handlers）、React 19.2、TypeScript、`node:sqlite`
- **部署**：Ubuntu 单机 + systemd + Caddy 反代；`deploy/` 下有一键脚本
- **分层**：

```
src/app          页面与 API（(main) 布局组 + 60 个 route.ts）
src/modules      自包含功能模块：server/ + client/ + README + 契约测试
src/plugins      插件：plugin.ts + README（pricing / models / default-profile）
src/lib/plugin   插件运行时：types 契约 / ctx 服务注册表 / profile 启动期装配
src/lib/server   平台件：auth / credits / recharge / payments / documents / exports / generation / problem-log
```

平台与功能之间只通过契约通信：换报价、换模型、加一个导出通道，都只写插件，不动平台代码。

## 快速开始

```bash
node -v                       # 需要 Node 22+
npm ci
cp .env.example .env.local    # 按注释填；不填则生图 / LLM / 支付相关接口不可用
npm run dev
```

打开 <http://localhost:3000>。只想看页面与流程，不接真实生图，可以先用 mock 测试跑通：

```bash
node scripts/test-backend.mjs
node scripts/test-generation.mjs
```

## 工程门禁

```bash
npm run gate:fast   # 迭代用：分支检查 / 标记扫描 / lint / typegen / tsc
npm run gate        # 收尾用：再加护栏夹具 + B 层 184 项 + C 层 1034 项断言
```

提交前钩子与 CI 跑的是同一条命令，门不过就不提交。护栏夹具自带「会红」用例，证明门真的会拦住问题，而不是摆设。

## 文档索引

| 文档                                               | 内容                                                          |
| -------------------------------------------------- | ------------------------------------------------------------- |
| [`docs/DEBUG-HANDBOOK.md`](docs/DEBUG-HANDBOOK.md) | 系统全貌：部署、链路、计费、恢复、禁区                        |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)       | 架构分层、最小改动原则、功能开关三步、注释纪律                |
| [`docs/TIMELINE.md`](docs/TIMELINE.md)             | 真实项目时间线（2026-07 立项 → 2026-10 v2 重构 → 10-31 开源） |
| [`docs/adr/`](docs/adr/)                           | 架构决策记录（插件运行时等）                                  |
| [`docs/migration/`](docs/migration/)               | 迁移记录与资产盘点                                            |

## 项目演进

项目自 **2026-07** 起持续开发：v1 用于国赛路演与课程汇报材料生产，2026-10 完成 v2 架构重构并开源。完整历程见 [docs/TIMELINE.md](docs/TIMELINE.md)，未来计划见 [ROADMAP.md](ROADMAP.md)，版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 参与贡献

欢迎 issue 与 PR，先读 [CONTRIBUTING.md](CONTRIBUTING.md) 与上述三份文档。改动请保持最小 diff，收尾跑 `npm run gate`。

## 许可

[Apache License 2.0](LICENSE) —— 可自由使用、修改、分发（含商业用途），保留版权与许可声明即可。

线上服务 <https://ppt.an520.xin> 由维护者独立运营；`.env`、支付证书、服务器凭据不入库。

## 免责声明

本项目按「现状」提供，不承诺任何明示或默示担保。使用者需自行承担部署、计费、支付合规与生成内容的法律责任；生成内容请遵守所在地区法规与平台规范。
