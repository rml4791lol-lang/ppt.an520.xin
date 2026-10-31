# 参与贡献

## 先看三份文档

| 文档 | 读它解决什么 |
| --- | --- |
| `docs/DEBUG-HANDBOOK.md` | 系统全貌：部署、链路、计费、恢复、禁区 |
| `docs/DEVELOPMENT.md` | 架构分层、最小改动原则、开关板三步、注释纪律 |
| `docs/adr/` | 已有架构决策，改之前先看有没有被决策过 |

## 开发环境

```bash
node -v          # 需要 Node 22+
npm ci
cp .env.example .env.local   # 按注释填；不填则生图/LLM 相关接口不可用
npm run dev
```

## 提交前必须过门

```bash
npm run gate:fast   # 迭代时：分支检查 / 标记扫描 / lint / typegen / tsc
npm run gate        # 收尾时：再加护栏夹具 + B 层 184 项 + C 层 1019 项断言
```

门没过就不要提 PR——CI 与本地钩子跑的是同一条命令。

## 改动约定

- 最小 diff：先读懂现有实现，再动；同类逻辑照抄既有模式（扣费、退币、幂等键、懒恢复、功能开关都有成例）。
- 新功能走功能开关板：`off / beta / public` 三态，测试用户先验收。
- 代码里少写注释，机制与决策原因写进 `docs/`；架构级决策补一条 ADR。
- 提交信息用英文祈使句：`feat(plugins): ...`、`refactor(intent): ...`、`fix(exports): ...`。

## 新功能模块 / 插件怎么加

- 模块：`src/modules/<name>/`，自包含 `server/` + `client/` + `README.md`，对外只暴露 facade，平台不 import 内部实现。
- 插件：`src/plugins/<name>/plugin.ts` + `README.md`，通过 `ctx` 拿服务，不直读平台内部（见 ADR-0001）。

## 提 PR

1. 一个 PR 只做一件事，附「怎么验证」的步骤；
2. 涉及计费 / 恢复 / 导出通道的改动，必须说明失败路径与补偿；
3. 评审按 `docs/REVIEW.md` 两轴：规格是否实现、标准是否守住。

## Issue

用仓库自带的分诊标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
报告缺陷请附：复现步骤、期望 / 实际、`npm run gate` 结果、相关日志片段。
