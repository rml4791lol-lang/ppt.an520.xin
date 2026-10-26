# 迁移执行记录 2026-10-26

## 决策（用户确认）

1. **主干 = 现在版本**：仓库主干采用线上运行版 `anppt-v2/production @ 5c15d9c` 的源码树，而不是把 56 条历史重写成主干。
2. **大文件剔除**：历史里 107.7MB 的 `work/111-pptx/克莱普斯-GEO创业组-逐页.pptx` 超 GitHub 100MB 上限，按 `>50MB` 剔除后作为 `legacy/*` 归档；完整历史另有 bundle。
3. **仓库转私有**：`rml4791lol-lang/ppt.an520.xin` 由 Public 改为 Private。
4. **清理走暂存**：原始目录移到 `~/Desktop/Atlas/_cleanup-20261026/`，保留 7 天。

## 目标仓库

`rml4791lol-lang/ppt.an520.xin`（private）｜本地：`/Users/an/Desktop/Atlas/ppt.an520.xin网站`

分支沿用线上部署约定：`production` 既是主干也是服务器拉取的分支（`deploy/README.md`：production 是唯一代码事实源）。

## 备份层次

| 层 | 内容 | 位置 | 状态 |
|---|---|---|---|
| L1 完整历史 | `anppt-v2` 全部 refs、85 个可达提交（含剔除前的大文件） | `_backups/anppt-v2-full-20261026.bundle`(1.3G) + iCloud `Backups/ppt-migration-20261026/` | 已校验 |
| L1 | `anppt-v2-assets`(64M)、`an520-portal`(51M) | 同上 | 已校验 |
| L2 可读历史 | 剔除 >50MB 后的 22 个分支 | GitHub `legacy/*` | 未推（网络） |
| L3 主干 | production 源码树（832 文件 / 136MB） | GitHub `production` | 部分（`import-batches` 续传中） |
| L4 原始目录 | 迁移前的一切 | `~/Desktop/Atlas/_cleanup-20261026/`（24G，7 天） | 已移入 |

## 迁入内容

| 来源 | 去向 | 提交 |
|---|---|---|
| `anppt-v2/production` 源码树（547 文件） | 仓库根 | `b16d5de` |
| 引用修正（仓库/路径/账号失效） | AGENTS.md、DEBUG-HANDBOOK、deploy/* | `367b570` |
| `~/Desktop/Atlas/PPT/HTML -ppt` 代码+文档 | `tools/htmlppt/`（303 文件 / 35M） | `196f7f2` |
| `~/Desktop/Atlas/PPT/转可编辑` 调研 | `docs/research/image-to-editable/` | `196f7f2` |

## 清理（24G 已进暂存区）

`~/Documents/AI PPT`(5.3G)、`~/Desktop/Atlas/PPT/{HTML -ppt,PPT 复刻,转可编辑}`(3.1G)、
`~/ZCodeProject/{anppt-v2,anppt-v2.production,anppt-v2-logging,anppt-v2.wps-aippt,anppt-v2.worktrees,anppt-v2-assets,anppt-dsh,anppt-v2-handoff,ai-agent-ppt}`、
`~/Documents/_archive/an520-ppt-archive`、`~/.cursor/worktrees/anppt-v2`(6.2G)、`~/.codex/worktrees/editable-30-pages`(784M)。

launchd `xin.anppt.v2-sync` 已 bootout，plist 改名 `*.disabled-20261026`（原任务每 5 分钟拉死远端）。

## 未完成（阻塞于网络）

GitHub 上传只完成前 2–3 批。实测：本地 136MB / 832 文件；单次 push 到 119MB 时报
`curl 56 Recv failure: Connection reset by peer`；改 8–14MB 分块后能推，但 21:58 起链路进一步劣化，
14MB 批也超时，远端停在 `import-batches @ e44fad9`。

续传（网络恢复后）：

```bash
bash scripts/finish-github-push.sh      # 8MB 分块续传，完成后自动提升 import-batches 为 production
bash scripts/push-legacy-history.sh     # 再推 22 个 legacy/* 历史分支
```

镜像丢失时重建：

```bash
git clone --mirror "_backups/anppt-v2-full-20261026.bundle" /tmp/anppt-v2-mirror.git
cd /tmp/anppt-v2-mirror.git && git filter-repo --strip-blobs-bigger-than 50M --force
```

## 环境事实（迁移时）

- 线上 `ppt.an520.xin` 由 hk-hermes 的 Caddy 反代 `127.0.0.1:3100`（Next.js），本机不跑该服务；本机 DNS 走代理 fake-ip（198.18.0.34）。
- 原远端 `github.com/An-an-525/anppt-v2` 实测 `Repository not found`，账号已不存在，anppt-v2 / anppt-v2-assets / an520-portal 三个仓库全部失联。
- 本机无 git-lfs；`git-filter-repo` 在 `~/.local/bin`；git 走代理时大对象易被重置。

## 待办

1. 网络恢复后跑上面两个脚本。
2. 服务器 `/opt/anppt-v2/source` 的 origin 仍指向死仓库，需在 hk-hermes 改指新仓库，否则 `publish-production` / `deploy-production` 拉取失败。
3. 本地首跑需 `npm ci`（node_modules 未随仓迁移）。
4. 7 天后删除 `~/Desktop/Atlas/_cleanup-20261026/`（24G）。
5. 未动的其它项目：`~/ZCodeProject/{an520-portal,an520-channels,image2-studio-v2,pi-desktop,an-hub,an-img}`、`~/Desktop/Atlas/{微信小程序,视频,three.js 建模 3d,个人生活,长理创客,DeepSeek harness,模型路由}`。

## 第二批清理（23:06 用户批准：其余项目同套路）

**规则**：先做不可再生的备份，再移入暂存区；有进程在跑的项目不动。

已入暂存（`~/Desktop/Atlas/_cleanup-20261026/`，清单见其 `MANIFEST.md`）：

- 冷数据：`视频`(6.2G)、`three.js 建模 3d`(2.6G)、`个人生活`(1.4G)、`模型路由`(380K)
- ZCodeProject 全量归档：`image2-studio-v2`(1.2G)、`an520-portal`(104M)、`an-img`(69M)、`an-hub`(17M)、`pi-desktop`(2.9M)、`an520-channels`、`docs`、散落脚本/json/docx

新增 bundle（`_backups/` + iCloud）：`image2-studio-v2`(73M)、`an-img`(26M)、`an-hub`(5.9M)、`pi-desktop`(780K)、`deepseek-harness`(2.2M) 及其 51 个未提交改动的 WIP 快照(27M tar.gz)。全部 `git bundle verify` 通过。

**这 5 个仓库的远端同样是已失效的 `An-an-525`**，与 anppt-v2 一样此前无任何远端备份。

刻意保留（未动）：`微信小程序`（洛小童上门体育，有进程）、`长理创客`（技术分享网站，有进程）、`DeepSeek harness`（当天仍在提交，仅备份）。

暂存区总量：**35G**。磁盘可用 218Gi。

## 服务器切换（23:2x–23:45 完成）

hk-hermes（43.161.198.195）已切到新仓库：

| 项目 | 变更 |
|---|---|
| `/opt/anppt-v2/source` origin | `An-an-525/anppt-v2`（死）→ `rml4791lol-lang/ppt.an520.xin` |
| fetch refspec | 由只拉 production 改为 `+refs/heads/*:refs/remotes/origin/*` |
| `/opt/anppt-v2/git/github_token` | 换成 `rml4791lol-lang` 的 token；旧 token 备份为 `github_token.bak-20261026` |
| 验证 | 服务器 `git ls-remote origin` 正常读到私有仓 |

**GitHub `production` 分支已上线**：`573bb6c`，547 文件 / 100MB，由服务器直接推送（服务器到 GitHub 直连 0.1s，本机代理链路只有 ~100KB/s 且频繁 reset，大对象传不动）。默认分支已切到 `production`，临时分支 `main`、`import-batches` 已删除。

## 本地与远端的现状（重要）

- **远端 `production` = 线上运行版源码（547 文件）**，与本仓库 4 个后续提交（迁移文档、push 脚本、tools/htmlppt）**尚未合并**。
- 本机当前无法 `git fetch`：拉取需要约 100MB，链路持续超时（23:40 三次重试全失败）。

网络恢复后按下面顺序对齐（把本地独有的改动叠到远端主干上，而不是反过来）：

```bash
git fetch origin production
git checkout -B production origin/production
git checkout 488da66 -- docs/migration docs/research scripts AGENTS.md deploy .gitignore
git commit -m "docs: migration records and push helpers"
git checkout 488da66 -- tools/htmlppt
git commit -m "feat(tools): import HTMLPPT toolchain"
git push origin production          # 约 40MB
```

## 历史分支（L2）

原计划把剔除大文件后的 22 个分支推 `legacy/*`。**改由本机 bundle 承担**：服务器上没有那份 85 提交历史（其 .git 仅 96M / 63 提交），且未装 `git-filter-repo`，本机又传不动 1.3G。
完整历史已安全落盘：`_backups/anppt-v2-full-20261026.bundle` + iCloud。需要时用 `scripts/push-legacy-history.sh` 在网络好的机器上补推。
