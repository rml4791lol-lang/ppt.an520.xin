# AnPPT 日志系统变更与上线手册

> 适用对象：并行修改本站的开发者、发布负责人、值班运维。机制事实仍以 `docs/DEBUG-HANDBOOK.md` §24 为准；本文负责“怎么安全地改、怎么提交、怎么上线、怎么监控、出事怎么退”。

## 1. 边界与分层

| 层 | 位置 | 用途 | 生命周期 |
| --- | --- | --- | --- |
| 运行日志 | systemd journal | 进程启动、异常栈、兜底告警行 | 由 journald 轮转 |
| 问题日志 | `<ANPPT_V2_DATA_DIR>/logs/problems-YYYY-MM-DD[.N].jsonl` | 结构化记录关键失败，后台可查 | 14 天；单文件 20 MiB 滚动；总量 100 MiB 上限，当天触顶拒绝新落盘并告警 |
| 管理审计 | SQLite `admin_audit_logs` | 管理员写操作审计 | 随数据库备份 |
| 监控告警 | `/usr/local/sbin/anppt-health-monitor.py` | 服务、健康契约、磁盘、备份、日志落盘告警 | root cron 每 5 分钟 |
| 发布验证 | `scripts/verify-health.mjs` + deploy 脚本 | 确认发布版本和日志健康契约 | 每次发布 |

三条原则：

1. **业务不被日志阻断**：问题日志写入失败只降级到 journal，不改变原业务流程。
2. **日志不能无界增长**：保留期、单文件滚动、总量清理三层同时生效。
3. **日志不能成为泄密面**：Bearer、Cookie、密码、API key、token、私钥等字段在落盘前脱敏。

## 2. 当前契约

### 2.1 问题日志行

新记录固定包含：

```text
ts level category message detail userId refType refId eventId requestId method route release
```

- `requestId`：每个 Route Handler 自动生成，格式 `req_<24 hex>`，同时写入响应头 `x-request-id`；500 响应的 `error.requestId` 也会回填。
- `route` / `method`：来自请求上下文，必填；后台直接显示。
- `release`：生产取 `.deploy-commit`，本地 production build 回退 `.next/BUILD_ID`，非生产为 `dev`。
- `eventId`：单条记录去重/定位用。
- 旧日志缺少新字段时读取端回退为空串，不要求一次性迁移历史文件。

### 2.2 文件与读取

- 正常日文件：`problems-YYYY-MM-DD.jsonl`。
- 单文件达到 20 MiB：继续写同日分段 `problems-YYYY-MM-DD.1.jsonl`、`.2.jsonl`。
- 读取端按“日期新到旧、同日分段大到小”扫描，最多解析 3000 行；后台每次 200 条，可继续加载。
- 坏行跳过；未知字段忽略；新增字段只能追加，不能重命名或删除已有字段。

### 2.3 健康契约

`GET /api/health` 现在同时提供：

```json
{
  "ok": true,
  "service": "anppt-v2",
  "release": "<commit>",
  "db": true,
  "plugins": {
    "profile": "default",
    "assembledAt": "2026-10-27T13:00:00.000Z",
    "plugins": [
      { "key": "pricing", "version": "0.2.0", "provides": ["pricing"] }
    ],
    "services": ["config", "pricing", "models"]
  },
  "logging": {
    "ok": true,
    "writable": true,
    "fileCount": 2,
    "totalBytes": 805,
    "writeFailures": 0,
    "lastFailureAt": 0,
    "recentFailure": false,
    "retentionDays": 14
  }
}
```

`ok` 仍表示核心服务/数据库可用；`logging.ok` 是独立的可观测性契约。发布脚本要求两者同时为真，监控脚本也会单独告警日志异常。

`plugins` 是启动期装配清单：`profile` 名、`assembledAt`、每个插件的 `key`/`version`/`provides`，以及注册的服务键 `services`。它是只读诊断信息，不参与 `ok` 判定；装配异常时整条探针不 500，只把这个字段降级为 `{ "error": "<原因>" }`，其余字段照常返回。

告警口径：`plugins.error` 表示计价/模型服务不可用——`scripts/verify-health.mjs` 见到即判发布失败并触发回滚，`deploy/anppt-health-monitor.py` 见到即计入异常。回滚到没有 `plugins` 字段的旧 release 是人工止血动作，监控不对“缺字段”告警；发布验证只针对本次刚上线的新 release，缺字段照样判失败并回滚。

健康契约的消费方（改 `/api/health` 字段必须同时核对这三处，缺一处就是发布门与线上告警的认知分叉）：

- `scripts/verify-health.mjs`：发布门。显式 `error` 必失败、缺字段按回滚场景区分（新 release 缺字段照样失败）、`release` 必须与本次部署 commit 一致。
- `deploy/anppt-health-monitor.py`：root cron 每 5 分钟告警（服务存活、`logging.ok`、`plugins.error`、磁盘、备份新鲜度）。
- `.agents/skills/anppt-deploy`：部署技能的执行流程（部署 → 健康校验 → 失败回滚），与上面两处共用同一契约。

## 3. 多人并行修改规则

### 3.1 开工前

- 从 `origin/production` 拉独立分支：`codex/logging-<change>`；不要在当前别人的 Open API / BIM / WIP 工作区直接改日志。
- 先做 `git status --short`，确认没有需要保留的未提交改动。
- 同一时间只允许一个“日志 schema/writer”变更；读取页、监控、部署脚本可以并行，但必须先约定字段命名。
- 新 category 可直接在调用点使用，后台会动态发现；仍建议在 PR 描述中列出 category 名称和来源。

### 3.2 提交拆分

推荐两个可独立回滚的提交：

1. `Add request tracing and problem log health checks`：writer、schema、健康契约、后台读取、测试。
2. `Harden logging rollout and monitoring`：monitor、deploy verifier、发布脚本、文档。

禁止在一个提交里混入计费、支付、生成状态机重构或无关 UI 改动。提交信息用英文祈使句。

### 3.3 合并前

- `git fetch origin production && git rebase origin/production`；不要 force push。
- 冲突文件优先重新应用最小改动，不删除别人的新 category 或监控检查。
- 发布负责人确认：没有正在进行的日志 schema 迁移、没有未合并的同类 writer 分支。
- 日志变更必须同时更新 `docs/DEBUG-HANDBOOK.md` §24 和本文；如果改变健康契约，再更新 §3 与 `deploy/README.md`。

## 4. 测试与门禁

在干净工作区执行：

```bash
npm run gate   # 完整门（分支范围空白/冲突标记 → lint → typegen+tsc → 两套测试 → build）
```

日志相关额外检查：

```bash
python3 -m py_compile deploy/anppt-health-monitor.py
printf '%s' '{"ok":true,"service":"anppt-v2","release":"test","db":true,"plugins":{"profile":"default","plugins":[],"services":[]},"logging":{"ok":true,"writable":true,"fileCount":1}}' | node scripts/verify-health.mjs
```

测试要求：

- 写一条带请求上下文的日志，断言 `requestId/method/route/release` 落盘。
- 构造密码、API key、Bearer、Cookie，断言落盘文本不含原值。
- 把日志目录指向普通文件，断言 `logProblem()` 不抛出且健康检查为 `ok:false`。
- 构造同日 `.1.jsonl` 分段，断言读取顺序和动态 category。
- 禁止在测试里真实调用生图/Codia/支付接口。

## 5. 上线顺序

1. **确认队列为空**：整套生成 `queued/running`、PPT 美化批量 `queued/running`、导出 `pending/processing` 都必须为 0；部署脚本也会再次检查。
2. **全量门全绿**，文档、断言数、README 已同步。
3. **提交并推送分支**，由发布负责人合并到 `production`；不要直接编辑服务器源码。
4. 如果本次改到了 `/opt/anppt-v2/bin/deploy-production` 使用的 `deploy/deploy-production.sh`，先做一次 bootstrap（新脚本之后会自更新安装副本）：

```bash
ssh hk-hermes 'cd /opt/anppt-v2/source && git fetch origin production && git merge --ff-only origin/production'
ssh hk-hermes 'sudo -n install -m 0755 /opt/anppt-v2/source/deploy/deploy-production.sh /opt/anppt-v2/bin/deploy-production'
```

5. 执行唯一入口 `bash deploy/deploy.sh`。脚本会推 production、构建不可变 release、检查三队列、切 symlink、重启。
6. 脚本内置发布后验证：`/api/me` 必须 401，`/api/health` 必须 `ok=true`、`db=true`、`plugins` 清单存在且无 `error`、`logging.ok=true`、`logging.writable=true`，且 `release` 等于本次 commit。任一失败自动回滚到上一个 release。
7. 应用发布后再安装监控脚本（监控脚本不会随 release 自动安装）：

```bash
python3 -m py_compile deploy/anppt-health-monitor.py
ssh hk-hermes 'sudo -n install -m 0755 /opt/anppt-v2/source/deploy/anppt-health-monitor.py /usr/local/sbin/anppt-health-monitor.py'
ssh hk-hermes 'sudo -n /usr/local/sbin/anppt-health-monitor.py'
```

8. 检查监控状态：

```bash
ssh hk-hermes 'sudo -n journalctl -u anppt-v2.service -n 100 --no-pager'
ssh hk-hermes 'sudo -n tail -n 30 /var/log/anppt-monitor.log'
curl -sS https://ppt.an520.xin/api/health
```

## 6. 回滚

- 应用回滚：恢复上一个不可变 release symlink 并重启 `anppt-v2`；deploy 脚本在重启/健康契约失败时会自动做这一步。
- 日志数据不随 release 回滚：`/opt/anppt-v2/shared/data/logs` 和 SQLite 审计仍在共享数据目录。
- 旧 release 可能不认识新的分段文件名或新字段；回滚只用于短期止血，恢复后尽快修复并重新发布。
- 监控脚本回滚：从 Git 取上一版本重新 `install`，手动跑一次，确认恢复邮件行为。
- 任何回滚后都要重新检查：服务 active、`/api/me=401`、`/api/health`、三队列、监控日志。

## 7. 监控与告警

`anppt-health-monitor.py` 每 5 分钟检查：

- `anppt-v2.service`、`caddy.service` 存活；
- `/api/health` 的 `ok`、`release`、`llm.configured`、`image.configured`、`editable.configured`；
- `plugins.error`（插件启动期装配失败；缺 `plugins` 字段视为回滚到旧版，不告警）；
- `logging.ok`、`logging.writable`、近期 `writeFailures`；
- 问题日志总量超过 80 MiB 时提前告警（应用侧 100 MiB 上限）；
- 根分区使用率超过 90%；
- 每日备份新鲜度（26 小时内）。

连续 2 次异常后发邮件；持续异常每小时最多重复一次；恢复后发恢复邮件。不要在监控里重新加入已 disable 的 `slideflow-studio.service`。

## 8. 故障处理

### `logging.ok=false`

1. 看 `/api/health` 和 `/var/log/anppt-monitor.log`。
2. 检查 `df -h`、`<数据目录>/logs` 权限、`ANPPT_V2_PROBLEM_LOG_DIR` 是否指向普通文件或错误路径。
3. 若服务仍可用，先修复目录/磁盘，不必立即重启；日志写入会自然恢复。
4. 需要重启时仍要等三队列为 0，避免打断在途生成/导出。
5. journal 里的 `[anppt-v2][problem][category]` 行仍可作为临时排查来源。

### 日志量异常增长

1. 看 `/admin/problems` 的 category、message、release 分布，确认是否某次发布引入循环错误。
2. 用 `requestId` 关联同一次请求的多条记录。
3. 若总量接近 100 MiB，应用会自动从最旧文件删到 80 MiB；若当天文件单独达到 100 MiB，应用会拒绝新落盘并在 journal/健康检查中告警。不要手动删当天文件，先定位错误循环。
4. 修复后用一次真实失败或健康探测确认 `logging.ok=true`。

### 发布后版本不符

`/api/health.release`、`/opt/anppt-v2/current/.deploy-commit`、本地 `git rev-parse HEAD` 三者必须一致。不一致时不要继续发布，先查 deploy 脚本是否回退或 symlink 是否被手工改动。

## 9. 事故记录模板

```text
时间：
影响：
首个 requestId / eventId：
release：
category：
触发条件：
根因：
止血：
回滚：
修复：
新增回归测试：
监控/发布改进：
```
