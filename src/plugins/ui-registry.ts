// UI 贡献组合根：壳只 import 这里，不 import 具体插件（与 default-profile.ts 同构，
// 一个是服务端配置单、一个是前端贡献单）。新增插件 = 这里多一行。
import type { PluginUi, SlotEntry, UiSlot } from "@/lib/plugin/types";
import { pptReplicateUi } from "./ppt-replicate/ui";

export type { SlotEntry } from "@/lib/plugin/types";

const MANIFESTS: PluginUi[] = [pptReplicateUi];

const SORTED = MANIFESTS.flatMap((manifest) => manifest.entries).sort(
  (a, b) => a.order - b.order || a.id.localeCompare(b.id),
);

/** 某挂载点的全部入口；开关过滤在壳侧按 entry.flag 统一做。 */
export function entriesForSlot<S extends UiSlot>(slot: S): SlotEntry<S>[] {
  return SORTED.filter((entry) => entry.slot === slot) as SlotEntry<S>[];
}
