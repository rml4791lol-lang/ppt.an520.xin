# ppt-to-base（PPT 转模版底座）

上传一页 PPT 截图（PNG），AI 输出：①主标题原文提取 ②去风格化通用模版底图——版式结构保留、具体文字替换为中性角色词（"标题/正文/要点/图片/数据"…）、风格归一浅色系。底图可直接当模板底座：填内容、换风格即用。开关 `ppt_to_base`（beta 起步），机制与划界见 `docs/DEBUG-HANDBOOK.md` §23。

## 边界

- **主路线·截图 AI 通用化**（5🌟/张，失败全退）：
  - `server/base-image.ts`：开关硬门 → 限流（30 次/时）→ 估价取价（env 价键 `ppt_to_base`，插件动作 `tool.ppt-to-base`）→ 先落 `ppt_to_base_jobs` running 行再 requestId 幂等扣费（重放 409）→ VLM 抽主标题（失败降级空串，不阻塞）→ 精准编辑模型去风格化 → 落盘 `generated/`（kind `ppt-to-base`，行置 succeeded）；失败经定长派生退款键全退后抛公开错误码。
  - 崩溃恢复：`ppt_to_base_jobs` 只由本模块读写，结算入口 `server/recovery.ts`（`interruptedPptToBaseRuns`：列 running 行 + 置 failed + 扣费键/退款描述）；平台 `recovery.reconcileUser(userId)` 在鉴权门（`requireUser`）注入判活口径（本进程注册表或心跳未超 `jobStaleMs`）并调度它，超时置 failed 并按实扣金额补退（幂等），见 `docs/DEBUG-HANDBOOK.md` §4。
  - 编辑指令 `BASE_IMAGE_INSTRUCTION` 的纪律：点名参考图角色 → 改变项/保留项分离 → 不变量重复声明 → 中性词逐字加引号 → 约束词频与原文块数一致。
  - 薄壳路由（不在本目录）：`src/app/api/tools/ppt-to-base/route.ts`（multipart file+requestId；解析 body 之前先做开关硬门 + content-length 预检，之后 ≤10MB、PNG magic 校验）。
  - `client/image-prepare.ts`：任意截图 letterbox 成 1536×864 白底 PNG 再上传。
  - `client/ppt-to-base-client.tsx`：工具页编排（开关门 → 传截图 → 价格预估 → 标题+复制+底图预览/下载；401 去登录、402 去充值）。
- **次路线·pptx 本地擦除**（免费，页面底部折叠入口）：`client/pptx-model.ts` 纯函数层（EMU→px letterbox、OOXML 色彩变换、schemeClr/prstClr/sysClr、几何回退、槽位角色推断、base.json 契约）不依赖 DOM；`pptx-parse.ts`（jszip + DOMParser 走 OOXML）与 `pptx-render.ts`（canvas 重绘）为薄层靠手测。无 server/ 参与、不接计价。
- 页面薄壳（不在本目录）：`src/app/(main)/tools/ppt-to-base/page.tsx`。

## 依赖的平台件（只准用，不准在本模块改）

`lib/server/{auth,feature-flags,credits,engine,rate-limit}.ts`、`lib/server/generation/{images,storage,config,db,recovery,types,route}.ts`、`lib/client/{api,deck-api}.ts`、`components/icons`。jszip 是 dependencies 直引（浏览器端 dynamic import）。编辑模型走 `ANPPT_V2_IMAGE_EDIT_MODEL` / 管理端运行时覆盖。

## 测试

`scripts/tests/ppt-to-base.test.mjs`（由 `scripts/test-generation.mjs` 注入 ctx 调用）：[7e] 钉 pptx-model 纯函数层契约（含 Office 基准色值）；[7f] 截图 AI 路线服务端全 mock（成功链路/提示词契约/VLM vision 分段/重放 409/失败退星/开关外 404/余额 402/缺 requestId/估价 5🌟/崩溃残留行懒恢复补退）。真实上游校准靠手测脚本（`output/ppt-to-base-e2e/`），不进套件。
