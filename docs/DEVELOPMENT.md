# AnPPT v2 开发与架构约定

> 本文是开发流程与架构纪律的权威入口；系统全貌（部署/链路/运维）见 `docs/DEBUG-HANDBOOK.md`。
> 改代码前读本文；改完代码同步两份文档。最后更新：2026-08-22

## 1. 金字塔分层

依赖只允许自上而下，禁止下层反向引用上层；同层之间不交叉 import，交叉需求提到更下层。

```
src/app/            页面与 Route Handlers —— 只做鉴权、参数校验、调用业务层、 shaping 响应
src/components/     客户端组件 —— 只通过 src/lib/client-api.ts 访问后端，不直拼 fetch 逻辑
src/lib/server/     业务层（全部领域逻辑）—— auth / credits / recharge / payments /
                    documents / exports / generation/*(状态机/DSL/引擎/生图/调度/恢复)
src/lib/client-api.ts  前端唯一 API 入口
src/data/           静态数据 —— 风格包/套餐/页型等，纯数据无逻辑
src/lib/server/db.ts   持久层 —— node:sqlite（WAL），业务层不手写 SQL 之外的存储细节
```

- 新功能先问"属于哪一层"，代码只放那一层；路由里出现业务判断 = 分层错误。
- 静态数据优先：能写死在 `src/data/` 的不建表；必须运行时可改（管理员要调）才进 DB 或加密运行时配置。

## 2. 改动原则

- **最小改动**：只动任务直接要求的文件；不顺手重构、不改无关格式、不批量清理注释。
- **不大重构**：结构演进靠"新代码进正确分层"，老代码只有在被任务触碰时才归位。
- **模块化**：新能力独立成 `lib/server/` 下的单文件/单目录，对外只暴露少量函数（参照 `feature-flags.ts`、`usage-meter.ts`）。
- **不重复造轮子**：动手前 grep 现有实现；扣费/退星/幂等键/懒恢复/配置快照都有成例，照抄模式不另发明。
- **二阶思维**：每个改动回答两个问题——"失败时用户看到什么、钱是否安全"和"重启/崩溃后这行数据谁收拾"（参照 exports/generation 的懒恢复模式）。

## 3. 注释纪律

- 代码里**克制注释**：只在"为什么这么写"无法从代码看出时留一两行；不写复述代码的注释、不写大段头注。
- 知识沉淀到文档：机制、口径、坑、决策原因写进 `docs/DEBUG-HANDBOOK.md` 对应小节；新功能开新小节（带日期）。
- 用户可读的文案（按钮/报错/弹窗）是产品的一部分，改动视同功能改动，不走"顺手优化"。

## 4. 新功能开发流程（开关板三步）

1. **登记**：`src/lib/server/feature-flags.ts` 的 `FEATURE_FLAG_DEFS` 加一条，`defaultState: 'beta'`（新功能一律 beta 起步，未经拍板不得直接 public）。
2. **服务端硬门**：路由入口 `assertFeatureVisible(key, user)`——不可见返回 404，不暴露功能存在性。
3. **前端隐藏**：入口按钮挂 `/api/features` 可见性地图，不可见不渲染。

验收路径：测试用户在 `/admin` 用户行「设为测试」→ beta 实测（dev 可烧真额度，生产先小额度）→ 管理员后台开关板转 public。public 之前普通用户任何路径都摸不到功能。

## 5. 测试与提交

```bash
node scripts/test-generation.mjs  # 生成/导出/计费域（全部 mock，零真实付费调用）
node scripts/test-backend.mjs     # 账户/支付/后台/开关板域
npm run lint -- --max-warnings=0
npx tsc --noEmit
npm run build
git diff --check
```

- 改业务逻辑必须同步加/改断言；两套测试全绿才允许提交，断言数变化同步更新 README 与手册 §8。
- Codia、生图、VLM **禁止真实调用进测试**（全部 mock）；真机验证走 dev 环境小额度实测。
- commit 用英文祈使句；不执行 git commit/push/reset/rebase，除非用户明确要求。
- 部署前查双队列（生成+导出在途为 0），流程见 `deploy/README.md` 与手册 §2。

## 6. 文档维护

- `docs/DEBUG-HANDBOOK.md` = 系统全貌唯一权威入口：改完代码同步更新对应小节；新功能新增编号小节（格式：机制 → 关键代码路径 → 失败/恢复语义 → 测试约束）。
- `README.md` = 对外门面：业务规则、测试数、目录结构变化时同步。
- 本文 = 流程与纪律：分层/流程变化时同步。
- 文档写"是什么+为什么+在哪"，不写逐步教程；每张截图、每个命令都要能直接执行验证。
