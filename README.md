# AnPPT v2（ppt.an520.xin）

AI PPT 生成工作台：上传文档 / 按页录入 → 大纲 → 内容梳理 → 选风格 → 逐页生图 → 导出图片版 PPTX。
Next.js 16 全栈单体（App Router + Route Handlers + node:sqlite），无外部服务依赖，单机房部署。

## 业务规则（已冻结）

- 注册送 100🌟；登录支持邮箱 OTP + 账号密码
- 计费：逐页生成 10🌟/页，**失败自动退还**；大纲 / 内容梳理 / 解析 / 图片版导出免费
- 套餐：¥9.9/100🌟、¥39.9/500🌟（推荐）、¥79.9/1000🌟、¥149.9/2000🌟；支持兑换码
- 支付：微信 Native 扫码 + 支付宝（epay 收银台），回调验签 + 金额校验 + 幂等履约
- 可编辑导出双档：WPS 免费通道优先、Image2PPT / Codia 自动回退，20🌟/页（全量开放）；轻量文字可编辑档 5🌟/页（VLM 文字覆盖层，beta 开关，仅测试用户）
- 新功能走功能开关板：off/beta/public 三态，测试用户先行验收，见 `docs/DEVELOPMENT.md` §4

## 目录

```
src/
  app/                    页面（(main) 布局组：首页/风格库/充值/积分/项目/工作台/单页/美化）
  app/api/                Route Handlers（auth/credits/recharge/deck/single-page/projects/exports/tools）
  modules/                功能模块（自包含目录：server/+client/+README）：ppt-replicate / editable-export
  plugins/                插件（plugin.ts+README，ctx 服务协作）：pricing / models + default-profile.ts
  components/             平台级共享客户端组件
  data/                   风格包/套餐/规则等静态数据
  lib/plugin/             插件运行时三件：types(契约) / ctx(服务注册表) / profile(配置单 boot)
  lib/server/             服务端平台件：auth(OTP+会话) credits(台账幂等) recharge(订单履约)
                          payments/(wechat native + epay) documents(解析) exports(pptx)
                          generation/(deck 状态机/DSL/生图/单页运行时/项目) problem-log(问题日志落盘/读取)
scripts/
  tests/                  模块测试（由两套主套件注入 ctx 调用）
<<<<<<< HEAD
  test-backend.mjs        B 层：163 项（注册/OTP/积分/订单/回调/兑换码/开关板/客户端IP口径/mock生产硬拒/页数上限/问题日志追踪与健康）
  test-generation.mjs     C 层：520 项（解析/DSL/引擎+兜底/状态机/扣费退还/导出/WPS+Image2PPT+Codia 多通道/轻量文字档/生图回退/图片级编辑工具/复刻PPT 批量任务/幂等重放/LLM频控/插件运行时/typed intent 工作台）
||||||| ad02eff
  test-backend.mjs        B 层：163 项（注册/OTP/积分/订单/回调/兑换码/开关板/客户端IP口径/mock生产硬拒/页数上限/问题日志追踪与健康）
  test-generation.mjs     C 层：519 项（解析/DSL/引擎+兜底/状态机/扣费退还/导出/WPS+Image2PPT+Codia 多通道/轻量文字档/生图回退/图片级编辑工具/复刻PPT 批量任务/幂等重放/LLM频控/插件运行时/typed intent 工作台）
=======
  test-backend.mjs        B 层：170 项（注册/OTP/积分/订单/回调/兑换码/开关板/客户端IP口径/mock生产硬拒/页数上限/问题日志追踪与健康）
  test-generation.mjs     C 层：535 项（解析/DSL/引擎+兜底/状态机/扣费退还/导出/WPS+Image2PPT+Codia 多通道/轻量文字档/生图回退/图片级编辑工具/复刻PPT 批量任务/幂等重放/LLM频控/插件运行时/typed intent）
>>>>>>> spec/deepening
  ts-hooks.mjs            node 直跑 TS 的 resolve 钩子（含 @/ 别名）
docs/                     DEBUG-HANDBOOK（系统全貌）/ DEVELOPMENT（架构与流程）/ LOGGING（日志变更、上线与监控）
deploy/                   systemd 单元 / 部署脚本 / Caddy 切换块 / Runbook
```

## 生成链状态机

`parse → outlined → structured → confirmed(内容冻结) → generating → generated|partial`

- 冻结后内容类 action 一律 409（CONTENT_LOCKED），需 unlock-structure 解锁（作废旧图）
- 按页录入（paged-copy-v2）跳过 LLM 大纲，直接 outlined → structure
- 大纲/梳理优先走 PPT 引擎内部 API，不可达时降级本地 LLM 兜底
  （契约：`image2-studio-v2/docs/ANPPT-V2-INTEGRATION-CONTRACT.md`，schema/DSL v1 已冻结）

## 开发

```bash
npm install
npm run dev                 # http://localhost:3000
./node_modules/.bin/tsc --noEmit
node scripts/test-backend.mjs && node scripts/test-generation.mjs
```

本地联调常用 env（见 `.env.example` 全量注释）：
`OTP_DEV_ECHO=true`（验证码回显）、`WECHAT_PAY_MOCK=true`（假码+mock 回调）、
`ANPPT_V2_LLM_*`（DeepSeek 官方）、`ANPPT_V2_IMAGE_*`（sqface 生图，与 LLM 密钥分开）。

## 部署

见 `deploy/README.md`（Git production 分支 + 不可变 release 发布 + Caddy 切换/回滚）。
