// 插件契约唯一定义处（docs/PLUGIN-ARCHITECTURE.md §3/§4 冻结清单）。
// 本文件只放跨插件共享的类型，机制说明见手册 §22。

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
  register(ctx: PluginRegistry): void | Promise<void>;
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
