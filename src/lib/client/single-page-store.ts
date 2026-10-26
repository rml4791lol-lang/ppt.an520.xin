// 单页生成器客户端状态模型 + 未登录草稿（localStorage）。
// 草稿只存可序列化字段；图片页的本地 File 不可持久化，刷新后需重新上传原图。

export type SpPageStatus = "idle" | "uploading" | "ready" | "generating" | "done" | "error";

export interface SpVersion {
  versionId: string;
  imageUrl: string;
  createdAt: number;
  /** 是否优化（refine）产生的版本 */
  optimized: boolean;
}

export interface SpPage {
  /** 客户端生成的稳定 id（后端 cleanPageId 要求 ^[a-zA-Z0-9_-]{1,80}$） */
  pageId: string;
  kind: "text" | "image";
  /** 粘贴的文本内容（图片页为补充说明） */
  text: string;
  /** 原稿图（已上传的 URL 或本地 objectURL） */
  sourceImageUrl?: string;
  /** 已上传到服务端的文件路径（generate 时随请求上送，后端暂忽略） */
  sourceImagePath?: string;
  stylePackId?: string;
  status: SpPageStatus;
  versions: SpVersion[];
  /** 本地预览选中的版本（导出固定用服务端最新成功版本，见交接风险） */
  activeVersionId?: string;
  error?: string;
}

export interface SpDraft {
  projectTitle: string;
  projectId: string | null;
  pages: SpPage[];
  savedAt: number;
}

const DRAFT_KEY = "anppt:sp-draft-v1";

export const SP_MAX_PAGES = 50;

export function newPageId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `p_${rand}`;
}

export function createPage(partial: Partial<SpPage> = {}): SpPage {
  return {
    pageId: newPageId(),
    kind: "text",
    text: "",
    status: "idle",
    versions: [],
    ...partial,
  };
}

export function loadDraft(): SpDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SpDraft;
    if (!parsed || !Array.isArray(parsed.pages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(draft: SpDraft): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* 存储满/隐私模式下静默失败 */
  }
}

export function clearDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/** 页面状态点文案（SPEC §3） */
export const SP_STATUS_LABEL: Record<SpPageStatus, string> = {
  idle: "待上传",
  uploading: "上传中",
  ready: "已就绪",
  generating: "生成中",
  done: "已生成",
  error: "失败",
};

/** 页面当前步骤推导（SPEC §2 UZ 简化版）：0 添加内容 / 1 选择风格 / 2 生成结果 */
export function pageStep(page: SpPage): 0 | 1 | 2 {
  if (page.status === "done" || (page.status === "generating" && page.versions.length > 0)) {
    return 2;
  }
  if (page.status === "generating") return 1;
  if (page.kind === "image" && page.sourceImageUrl) return 1;
  if (page.kind === "text" && page.text.trim()) return 1;
  return 0;
}

/** 粘贴文本字数对应的本地分析提示（SPEC §5 paste） */
export function pasteHint(text: string, kind: "text" | "image"): string {
  const len = text.replace(/\s/g, "").length;
  if (kind === "image") {
    return "已上传图片：生成时将结合原稿图与文字说明重新设计本页。";
  }
  if (len === 0) return "请粘贴文本内容，系统会自动判断页面类型与处理方式。";
  if (len <= 40) return "内容较短：可能是封面 / 金句 / 过渡类页面，将做字段化结构化处理。";
  if (len <= 160) return "内容中等：可能是半结构化内容，将做轻度整理后上屏。";
  return "内容较长：可能是未结构化文本，将进入深度梳理与信息分组。";
}
