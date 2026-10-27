# ppt-replicate（PPT 美化 / 复刻）

UI 贡献点先行（ADR-0001 G2）：侧栏入口、首页「PPT美化」页签、模板库「自己的 PPT」页签都由
`ui.ts` 的 `ui.entries` 声明，壳经 `src/plugins/ui-registry.ts` 静态装配并按 `flag` 过滤。

## 边界

- 负责：UI 贡献声明（入口/页签/开关/懒加载指令）；服务端实现与工作台 UI 暂留
  `src/modules/ppt-replicate`，迁移按 `docs/PLUGIN-ARCHITECTURE.md` §5 分批进行。
- 不注册服务键（`provides: []`）：功能能力仍由模块 facade 统一暴露；本插件只贡献入口。
- 计费动作声明与模块 `REPLICATE_BILLING_ACTIONS` 对齐，价格数字只在 pricing 插件。

## 开关

`ppt_replicate`。off 时三条入口同时消失（壳只按 `ui.flag` 过滤，不改壳代码），API 由平台
`assertFeatureVisible` 返回 404，`/beautify` 页面由功能自身显示「功能尚未开放」。
