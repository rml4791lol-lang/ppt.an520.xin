// ppt_replicate 的 UI 贡献点（ADR-0001 G2）：入口是静态数据，组件只存懒加载指令。
// 实现仍在 src/modules/ppt-replicate——迁移按 PLUGIN-ARCHITECTURE §5 分批进行，这里先迁入口。
import type { PluginUi } from "@/lib/plugin/types";

export const pptReplicateUi: PluginUi = {
  key: "ppt-replicate",
  entries: [
    {
      id: "beautify",
      slot: "sidebar",
      label: "PPT 美化",
      href: "/beautify",
      icon: "monitor",
      badge: "试验",
      after: "styles",
      order: 20,
      flag: "ppt_replicate",
    },
    {
      id: "beautify",
      slot: "upload-card",
      label: "PPT美化",
      icon: "monitor",
      order: 20,
      flag: "ppt_replicate",
      component: () =>
        import("@/plugins/ppt-replicate/client/beautify-tab").then((mod) => ({
          default: mod.BeautifyTab,
        })),
    },
    {
      id: "own",
      slot: "template-library",
      label: "自己的 PPT",
      hint: "保画面：用你的演示文稿当模板",
      order: 20,
      flag: "ppt_replicate",
      component: () =>
        import("@/modules/ppt-replicate/client/own-template-panel").then((mod) => ({
          default: mod.OwnTemplatePanel,
        })),
    },
  ],
};
