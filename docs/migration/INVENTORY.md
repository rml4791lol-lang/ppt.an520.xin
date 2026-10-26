# PPT 资产盘点与迁移方案（2026-10-26）

> 只读盘点结果。所有体积为 `du -sh` 实测，状态为实跑命令所得。

## 0. 结论先行

1. **线上站点 = anppt-v2**（Next.js，`production` 分支，远端 Caddy 反代 127.0.0.1:3100）。
   DNS 走代理 fake-ip（198.18.0.34），**本机未运行该服务**，本地清理不影响线上。
2. **`anppt-v2` 目前没有任何远端备份**：`github.com/An-an-525/anppt-v2` 实测
   `Repository not found`，且 `An-an-525` 已不是有效 GitHub 账号。3.0G 工作区 + 1.3G 历史 = 单点。
3. 1.3G 历史里有一个 **107.7MB blob**（`work/111-pptx/克莱普斯-GEO创业组-逐页.pptx`），
   超过 GitHub 单文件 100MB 硬上限，**直接推会被拒**。
4. 15 个分支无 upstream（`git for-each-ref` 实测），4 个 worktree 各拖 544M `node_modules`。

## 1. 站点代码（唯一需要长期开发的）

| 路径 | 体积 | 版本控制 | 分支 / HEAD | 状态 |
|---|---|---|---|---|
| `~/ZCodeProject/anppt-v2` | 3.0G（.git 1.3G、node_modules 544M、.next 320M） | git，56 commits | `codex/bim-competition-vertical` @ db1608b，19 个未提交 | **主仓，远端已死** |
| `~/ZCodeProject/anppt-v2.production` | 825M | worktree | `production` @ 5c15d9c | 生产分支 |
| `~/ZCodeProject/anppt-v2-logging` | 788M | worktree | `codex/logging-operations` @ 812cdb9 | 功能分支 |
| `~/ZCodeProject/anppt-v2.wps-aippt` | 792M | worktree | `codex/wps-aippt` @ 44c0778 | 功能分支 |
| `~/ZCodeProject/anppt-v2.worktrees/{beautify-batch-recovery,logout}` | — | worktree | 各自分支 | 功能分支 |
| `~/.cursor/worktrees/anppt-v2/*`（8 个） | `~/.cursor/worktrees` 共 8.8G | worktree | `cursor/*` | 多为一次性 agent 会话 |
| `~/.codex/worktrees/editable-30-pages/anppt-v2` | `~/.codex/worktrees` 共 784M | worktree | `codex/editable-30-pages` | 一次性 agent 会话 |

## 2. 站点周边

| 路径 | 体积 | 版本控制 | 状态 |
|---|---|---|---|
| `~/ZCodeProject/anppt-v2-assets` | 132M | git，1 commit | **远端同样已死**（`An-an-525`） |
| `~/ZCodeProject/anppt-v2-handoff` | 1.0G | 无 git | 交接材料，最后修改 2026-10-20 |
| `~/ZCodeProject/anppt-dsh` | 278M | git，3 commits，无 remote | 2026-09-06 后未动 |
| `~/ZCodeProject/ai-agent-ppt` | 2.0M | 无 git | 2026-09-03 后未动 |
| `~/ZCodeProject/an520-portal` | 104M | git，2 commits，远端已死 | 中转站门户，2026-08-28 后未动（非 PPT 域） |
| `~/ZCodeProject/an520-channels` | 1.4M | 无 git | 2026-07-25 后未动（非 PPT 域） |

## 3. PPT 工具链与研究（`~/Desktop/Atlas/PPT`，3.0G，全部无 git）

| 子目录 | 体积 | 内容 | 状态 |
|---|---|---|---|
| `HTML -ppt` | 1.7G（media 1.2G、code+docs 210M） | HTMLPPT 转换管线：`cli/htmlppt.py` extract/build/verify/stack，13 gates、闭源实测 100% 字符覆盖；自带 `.scratch` 本地 ticket 工作流与 AGENTS.md | **活跃**，最后修改 2026-10-24，**无版本控制** |
| `PPT 复刻` | 1.4G（node_modules 530M） | 复刻/渲染流水线（ppt-master、ppt-lab-render-v1、preview-v1） | 2026-10-13 后未动 |
| `转可编辑` | 4.0M | 图片转可编辑 PPT 的调研报告与对比矩阵（xlsx） | 2026-10-20，纯文档 |

## 4. 素材与历史归档（`~/Documents/AI PPT`，5.3G，全部无 git）

| 子目录 | 体积 | 状态 |
|---|---|---|
| `anppt-app` | 1.8G | 2026-10-11，旧版应用 |
| `anppt-local-archive-20260815` | 1.3G | 2026-08-15 归档，明确过期 |
| `HTML ppt 转化` | 1.3G（含 1.9G pptx 素材库） | 素材库，非代码 |
| `slideflow-studio-current` | 393M | 无最近修改 |
| `an520-ppt-video` | 241M | 视频素材工程 |
| `AnPPT-国赛生产-2026-07-28` | 158M | 2026-07-28 素材 |
| `AnPPT-asset-archive` | 84M | 2026-08-04 归档 |
| `qa-artifacts` | 29M | QA 产物 |
| `AnPPT-路演素材/可编辑素材-2026-07-28` | 32M | 2026-07-28 素材 |

`~/Documents/_archive/an520-ppt-archive`（1.2M）：`.git` 存在但无分支无提交（空壳），内容 `editable-chain`、`k3-frontend`。

## 5. 磁盘

`df -h`：可用 232Gi。上述 PPT 域合计约 **19G**（其中重复的 `node_modules`/`.next` 约 3.2G、历史素材约 8G）。

## 6. 不在本次范围（未盘点、不动）

`~/Desktop/Atlas/微信小程序`(3.3G)、`视频`(6.2G)、`three.js 建模 3d`(2.6G)、`个人生活`(1.4G)、
`长理创客`(207M)、`DeepSeek harness`(63M，git 无 remote，48 个未提交)、`模型路由`(380K)。

## 7. 待决策

1. 仓库结构：`site/` 子目录单仓 / 站点独占根 / 只备份不动结构。
2. 1.3G 历史里的超限 blob：剔除（先做完整 bundle）/ 装 LFS 保留。
3. 本仓库可见性：现为 PUBLIC，站点代码入库后是否切私有。
4. 清理力度：暂存 7 天 / 直接删 / 先只备份。
