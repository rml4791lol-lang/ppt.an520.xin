// 插件契约唯一定义处（docs/PLUGIN-ARCHITECTURE.md §3/§4 冻结清单）。
// 本文件只放跨插件共享的类型，机制说明见手册 §22。
import type { ComponentType } from 'react';

export interface PluginRegistry {
  register(key: string, impl: unknown): void;
  use<T = unknown>(key: string): T;
  has(key: string): boolean;
}

export interface AnPlugin {
  key: string;
  version: string;
  /** 注册到 ctx 的服务键清单 */
  provides: string[];
  /** 涉及的计费动作 key（只声明动作，价格数字归 pricing 插件） */
  pricing?: string[];
  /** 运行参数声明，进 profile */
  config?: Record<string, unknown>;
  /** UI 贡献点：静态数据 + 懒加载指令，壳按注册表渲染（§2.5） */
  ui?: PluginUi;
  register(ctx: PluginRegistry): void | Promise<void>;
}

// ---- UI 贡献点（壳只认槽位，不认具体插件） ----

export type UiSlot = 'sidebar' | 'upload-card' | 'template-library';

export interface UiEntryBase {
  /** 槽内稳定标识（侧栏 key / 页签 key） */
  id: string;
  slot: UiSlot;
  /** 显式定序，不依赖注册顺序 */
  order: number;
  /** 开关板 key：不成立时整条 entry 不渲染 */
  flag?: string;
}

export interface SidebarEntry extends UiEntryBase {
  slot: 'sidebar';
  label: string;
  href: string;
  /** 壳的设计系统图标名——插件不自带图标与风格 */
  icon?: 'monitor';
  badge?: string;
  /** 插到壳里哪个既有入口之后（锚点决定分组） */
  after?: string;
}

/** 懒加载指令：插件 JS 不进首屏；组件模块默认导出 */
export type UiComponentLoader = () => Promise<{ default: ComponentType }>;

interface PanelEntryBase extends UiEntryBase {
  label: string;
  icon?: 'monitor';
  /** 页签旁的说明文案 */
  hint?: string;
  component: UiComponentLoader;
}

export interface UploadCardEntry extends PanelEntryBase {
  slot: 'upload-card';
}

export interface TemplateLibraryEntry extends PanelEntryBase {
  slot: 'template-library';
}

export type PanelEntry = UploadCardEntry | TemplateLibraryEntry;
export type PluginUiEntry = SidebarEntry | PanelEntry;

export type SlotEntry<S extends UiSlot> = {
  sidebar: SidebarEntry;
  'upload-card': UploadCardEntry;
  'template-library': TemplateLibraryEntry;
}[S];

export interface PluginUi {
  key: string;
  entries: PluginUiEntry[];
}

// ---- 冻结数据契约（复刻流水线：改动需开 Issue 拍板） ----

/** 模板图（参考稿一页） */
export interface Ref {
  id: string;
  name: string;
  dataUrl: string;
}

export interface Page {
  id: string;
  refId: string;
  title: string;
  points: string[];
  role: string;
}

export interface Result {
  status: 'pending' | 'ok' | 'failed';
  candidates: string[];
  picked: string | null;
}
