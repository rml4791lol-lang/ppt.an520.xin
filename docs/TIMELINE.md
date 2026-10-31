# 项目时间线（真实记录）

> 本文件只记录有据可查的事实：每条都能在仓库文件、提交哈希或 issue 编号里找到出处。
> 早期阶段（2026-07 ~ 2026-10-20）的实物在 `docs/migration/INVENTORY.md` 的资产盘点表里，日期取自文件系统最后修改时间。

## 一、v1 研发期（2026-07 ~ 2026-10）

| 时间 | 事件 | 出处 |
| --- | --- | --- |
| 2026-07-25 | 立项，标题链/视频管线等周边资产开始沉淀 | `docs/migration/INVENTORY.md:36` |
| 2026-07-28 | v1 进入国赛生产：`AnPPT-国赛生产` 素材、路演与可编辑素材归档 | `docs/migration/INVENTORY.md:55-58` |
| 2026-08-04 | 素材库整理归档（84M） | `docs/migration/INVENTORY.md:56` |
| 2026-08-15 | 本地归档快照（1.3G，后判定过期） | `docs/migration/INVENTORY.md:51` |
| 2026-08-28 | 中转站门户（非 PPT 域） | `docs/migration/INVENTORY.md:35` |
| 2026-09-03 | ai-agent 方向的 PPT 实验 | `docs/migration/INVENTORY.md:34` |
| 2026-09-06 | `anppt-dsh` 分支实验（3 提交，无远端） | `docs/migration/INVENTORY.md:33` |
| 2026-10-11 | 旧版应用 `anppt-app`（1.8G） | `docs/migration/INVENTORY.md:50` |
| 2026-10-20 | 交接材料 `anppt-v2-handoff`（1.0G）+ 图片转可编辑 PPT 调研报告 | `docs/migration/INVENTORY.md:32,44` |

## 二、v2 重构与迁移（2026-10-26 ~ 10-29）

| 时间 | 事件 | 出处 |
| --- | --- | --- |
| 2026-10-26 | v2 立项：以线上运行版 `anppt-v2/production @ 5c15d9c` 源码树为干；旧历史 85 个提交归档为 bundle（1.3G）；仓库私有化 | `docs/migration/MIGRATION-2026-10-26.md:1-22`；提交 `573bb6c` |
| 2026-10-27 | 架构深化：插件运行时 ADR-0001 落地（价格表归 pricing 插件、UI 贡献点、启动期装配 fail-fast）；typed intent 收敛；懒恢复收成单一 reconcile | `docs/adr/0001-plugin-runtime-advance.md`；提交 `46204b1` `58ae6ad` `2cf8d2b` |
| 2026-10-28 | 护栏体系：`npm run gate` / `gate:fast` 一条命令、提交前钩子、worktree 脚本、并发测试互斥、发布脚本校验 | issue #17–#24 |
| 2026-10-29 | 计费运行模块、恢复源注册表、多通道可编辑导出、生图池按单价调度、架构深化收口 | issue #40–#45；提交 `2b24412` |
| 2026-10-30 | 收敛与文档补齐（系统手册、日志规范） | `docs/DEBUG-HANDBOOK.md` `docs/LOGGING.md` |

## 三、开源（2026-10-31）

| 时间 | 事件 | 出处 |
| --- | --- | --- |
| 2026-10-31 | 以 Apache-2.0 开源：新增 `LICENSE`、`package.json` 许可字段、README 徽章；商户号/AppID 脱敏（`docs/DEBUG-HANDBOOK.md:79`） | 提交 `bbce8cb` |
| 2026-10-31 | 仓库转为 public，补 description / homepage / topics；完整 147 个提交与 47 个 issue 一并公开 | GitHub API `visibility=public` |
| 2026-10-31 | 建立对外门面：README（对外版）、CHANGELOG、ROADMAP、CONTRIBUTING、本时间线；打 `v0.1.0` | 提交（本文件同批） |

## 四、演示视频分镜（2–3 分钟）

| 段落 | 时长 | 画面 | 旁白要点 |
| --- | --- | --- | --- |
| 开场 | 0:00–0:15 | 站点首页 + 一句定位 | 把文档变成可直接用、还能改的 PPT |
| 输入 | 0:15–0:35 | 上传 Word/PDF，解析成页 | 解析链路：文档 → 页面 → 大纲 |
| 生成 | 0:35–1:15 | 选风格、逐页生图（快进） | 逐页配图、失败自动退币、断点续跑 |
| 导出 | 1:15–1:45 | 导出图片版 PPTX，再走可编辑导出 | 多通道自动降级，产物可在 Office/WPS 改 |
| 工程 | 1:45–2:15 | 终端 `npm run gate` 全绿 + docs/ 目录 | 1200+ 断言、ADR、插件运行时 |
| 收尾 | 2:15–2:30 | 仓库页 + License | Apache-2.0 开源，欢迎 issue / PR |
