// 生成链共享类型。OutlineSlide / tagged DSL 对齐
// image2-studio-v2/docs/ANPPT-V2-INTEGRATION-CONTRACT.md §3（冻结 v1）。

export type SlideRole = 'cover' | 'toc' | 'section' | 'content' | 'ending';

export interface OutlineSlide {
  pageIndex: number;
  role: SlideRole;
  chapter: string;
  pageType: string;
  title: string;
  goal: string;
  mustKeep: string[];
  rawText: string;
  summary: string[];
  visualNote: string;
}

/** deck 状态机：parse → outline → structure → confirm → generate → deliver */
export type DeckStatus =
  | 'parsed' // 文档已解析，等待大纲
  | 'outlined' // 大纲已生成（增/删/重排/拆页后仍为此态）
  | 'structured' // 内容梳理完成（未冻结）
  | 'confirmed' // 结构已确认冻结，可生成
  | 'generating' // 逐页生图进行中
  | 'generated' // 全部页面生成成功
  | 'partial'; // 部分页面生成失败

export type StructureStatus = 'pending' | 'ok' | 'failed';

/** stale：解锁结构或换风格后被作废的历史生成页 */
export type GenStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'stale';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

export type JobKind =
  | 'deck-generate'
  | 'deck-slide'
  | 'deck-refine'
  | 'single-generate'
  | 'single-refine';

export const SLIDE_ROLES: readonly SlideRole[] = ['cover', 'toc', 'section', 'content', 'ending'];

export function isSlideRole(value: unknown): value is SlideRole {
  return typeof value === 'string' && (SLIDE_ROLES as readonly string[]).includes(value);
}

export function cleanString(value: unknown, max = 4000): string {
  return String(value ?? '').trim().slice(0, max);
}

export function cleanStringArray(value: unknown, maxItems = 20, maxLen = 500): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item, maxLen)).filter(Boolean).slice(0, maxItems);
}

/** 宽松地把引擎/LLM 输出归一成 OutlineSlide（非法角色降级为 content） */
export function normalizeOutlineSlide(raw: unknown, fallbackIndex: number): OutlineSlide {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pageIndex = Number(obj.pageIndex ?? obj.page_index ?? fallbackIndex);
  return {
    pageIndex: Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : fallbackIndex,
    role: isSlideRole(obj.role) ? obj.role : 'content',
    chapter: cleanString(obj.chapter, 120),
    pageType: cleanString(obj.pageType ?? obj.page_type, 80),
    title: cleanString(obj.title, 200),
    goal: cleanString(obj.goal, 500),
    mustKeep: cleanStringArray(obj.mustKeep ?? obj.must_keep),
    rawText: cleanString(obj.rawText ?? obj.raw_text, 8000),
    summary: cleanStringArray(obj.summary, 12, 300),
    visualNote: cleanString(obj.visualNote ?? obj.visual_note, 500),
  };
}
