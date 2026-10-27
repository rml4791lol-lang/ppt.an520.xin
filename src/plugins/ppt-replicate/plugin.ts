// ppt-replicate 插件：UI 贡献点先行（ADR-0001 G2），服务端实现暂留模块。
// 本插件不注册服务键——入口经 src/plugins/ui-registry.ts 静态装配进壳。
import type { AnPlugin } from "@/lib/plugin/types";
import { pptReplicateUi } from "./ui";

export const pptReplicatePlugin: AnPlugin = {
  key: "ppt-replicate",
  version: "0.1.0",
  provides: [],
  pricing: ["generate.single-page", "edit.single-page", "export.editable"],
  ui: pptReplicateUi,
  register() {},
};
