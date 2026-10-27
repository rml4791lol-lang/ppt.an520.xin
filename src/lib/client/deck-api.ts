// 整套 PPT（deck）工作台 API 客户端。
// 类型对齐 src/lib/server/generation/decks.ts 的 getDeckState 返回（后端已实现）。
import { apiFetch } from "./api";
import type { DeckIntent, DeckIntentExtra, DeckIntentKind, SlideRole } from "../deck-intents";

export type { DeckIntent, DeckSlideDraft, DeckSlidePatch, SlideRole } from "../deck-intents";

export type DeckStatus =
  | "parsed"
  | "outlined"
  | "structured"
  | "confirmed"
  | "generating"
  | "generated"
  | "partial";

export type StructureStatus = "pending" | "ok" | "failed";

export type GenStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "stale";

export interface DeckSlideVersion {
  versionId: string;
  versionNo: number;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  imageUrl: string;
  error: string;
  jobId: string;
  createdAt: number;
}

export interface DeckSlide {
  slideId: string;
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
  structuredContent: string;
  structureStatus: StructureStatus;
  structureWarnings: string[];
  genStatus: GenStatus;
  genError: string;
  activeVersionId: string;
  versions: DeckSlideVersion[];
}

export interface DeckInfo {
  id: string;
  title: string;
  status: DeckStatus;
  stylePackId: string;
  qualityTier: string;
  durationMinutes: number;
  targetPageCount: number;
  sourceFileName: string;
  error: string;
  /** 全套风格锚点页（设为参考图工具）；空串 = 未设置 */
  anchorSlideId: string;
  confirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeckActiveJob {
  jobId: string;
  kind: string;
  status: "queued" | "running";
  total: number;
  succeeded: number;
  failed: number;
  createdAt: number;
  updatedAt: number;
}

export interface DeckPageSummary {
  total: number;
  idle: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  stale: number;
}

export interface DeckState {
  deck: DeckInfo;
  slides: DeckSlide[];
  activeJob: DeckActiveJob | null;
  pageSummary: DeckPageSummary;
  contentLocked: boolean;
}

/** 意图的响应 data = 全量 state + 该意图的 extra 平铺（见 actions.ts 路由） */
export type DeckIntentResult<K extends DeckIntentKind> = DeckState & DeckIntentExtra[K];

export function getDeckState(deckId: string): Promise<DeckState> {
  return apiFetch<DeckState>(`/api/deck/${encodeURIComponent(deckId)}`);
}

/** 意图 RPC：POST /api/deck/{id} {intent}，响应按意图收窄（附带字段由 kind 决定） */
export function deckIntentAction<K extends DeckIntentKind>(
  deckId: string,
  intent: Extract<DeckIntent, { kind: K }>,
): Promise<DeckIntentResult<K>> {
  return apiFetch<DeckIntentResult<K>>(`/api/deck/${encodeURIComponent(deckId)}`, {
    body: { intent },
  });
}

export interface DeckExportResult {
  exportId: string;
  url: string;
  pageCount: number;
  kind: "image";
}

/** 图片集 PPTX 导出（免费）。响应用 url 字段（后端 exports.ts 的 ExportResult） */
export function exportDeckImage(deckId: string): Promise<DeckExportResult> {
  return apiFetch<DeckExportResult>(`/api/deck/${encodeURIComponent(deckId)}/export-image`, {
    body: {},
  });
}

export interface EditableExportStart {
  exportId: string;
  status: "processing" | "succeeded";
  credits: number;
  pageCount: number;
  progress: number;
  completedPages: number;
  totalPages: number;
  stage: string;
  url: string;
  reused: boolean;
}

/** 可编辑 PPTX 导出（20🌟/页，WPS 免费优先 / Image2PPT / Codia 备用）：202 返回任务句柄，结果轮询 getExportRecord */
export function startEditableExport(deckId: string, force = false): Promise<EditableExportStart> {
  return apiFetch<EditableExportStart>(`/api/deck/${encodeURIComponent(deckId)}/export-editable`, {
    body: { force },
  });
}

/** 轻量文字可编辑 PPTX 导出（5🌟/页，VLM 覆盖层链，beta 开关功能） */
export function startTextEditableExport(deckId: string, force = false): Promise<EditableExportStart> {
  return apiFetch<EditableExportStart>(`/api/deck/${encodeURIComponent(deckId)}/export-editable-text`, {
    body: { force },
  });
}

/** 当前用户功能可见性地图（开关板驱动，未开放功能前端据此隐藏入口） */
export function getFeatureFlags(): Promise<{ flags: Record<string, boolean> }> {
  return apiFetch<{ flags: Record<string, boolean> }>("/api/features");
}

export function getAuthSession(): Promise<{ authenticated: boolean }> {
  return apiFetch<{ authenticated: boolean }>("/api/auth/session");
}

export function getMe(): Promise<{ user: { id: string; username: string }; balance: number }> {
  return apiFetch<{ user: { id: string; username: string }; balance: number }>("/api/me");
}

export interface ExportRecord {
  exportId: string;
  refType: string;
  refId: string;
  sourceName?: string;
  kind: string;
  status: "pending" | "processing" | "succeeded" | "failed";
  pageCount: number;
  progress: number;
  completedPages: number;
  totalPages: number;
  stage: string;
  url: string;
  error: string;
  chargedCredits: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt: number;
  isCurrentSource: boolean;
}

/** 导出详情（轮询用） */
export function getExportRecord(exportId: string): Promise<ExportRecord> {
  return apiFetch<ExportRecord>(`/api/pptx-exports/${encodeURIComponent(exportId)}`);
}

/** 下载中心列表 */
export function listExportRecords(
  page = 1,
  pageSize = 50,
  filters: { refType?: "deck" | "single-page" | "upload"; refId?: string; kind?: "image" | "editable" | "editable_text"; latest?: boolean } = {},
): Promise<{ items: ExportRecord[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (filters.refType) params.set("refType", filters.refType);
  if (filters.refId) params.set("refId", filters.refId);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.latest) params.set("latest", "1");
  return apiFetch(`/api/pptx-exports?${params.toString()}`);
}

/** 当前项目最近一次可编辑导出（kind 区分可编辑重管线 / 轻量文字档）；用于刷新后恢复任务状态。 */
export async function getLatestEditableExport(
  refType: "deck" | "single-page",
  refId: string,
  kind: "editable" | "editable_text" = "editable",
): Promise<ExportRecord | null> {
  const result = await listExportRecords(1, 1, { refType, refId, kind, latest: true });
  return result.items[0] ?? null;
}

export interface ParseDeckResult {
  deckId: string;
  title: string;
  status: string;
  truncated: boolean;
  chars: number;
}

/** 首页「导入文档」：POST /api/deck/parse（FormData） */
export function parseDeckDocument(input: {
  file: File;
  duration: number;
  targetPageCount: number;
  pageCountMode: string;
  qualityTier: string;
  stylePackId?: string | null;
}): Promise<ParseDeckResult> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("duration", String(input.duration));
  form.set("targetPageCount", String(input.targetPageCount));
  form.set("pageCountMode", input.pageCountMode);
  form.set("qualityTier", input.qualityTier);
  if (input.stylePackId) form.set("stylePackId", input.stylePackId);
  return apiFetch<ParseDeckResult>("/api/deck/parse", { formData: form });
}

/** 首页「按页录入」：POST /api/deck/paged-copy-v2（JSON） */
export function createPagedCopyDeck(input: {
  pages: { title?: string; rawText: string }[];
  qualityTier: string;
  stylePackId?: string | null;
}): Promise<{ deckId: string }> {
  return apiFetch<{ deckId: string }>("/api/deck/paged-copy-v2", { body: input });
}

/** 项目改名（deck 与单页项目共用）：PATCH /api/projects/{id} {title} */
export function renameProject(id: string, title: string): Promise<unknown> {
  return apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { title },
  });
}

export interface CreditEstimate {
  action: string;
  unitPrice: number;
  pages: number;
  credits: number;
}

/** 费用预估：POST /api/credits/estimate（deck 逐页生成动作为 deck_page_generate） */
export function estimateCredits(action: string, pages?: number): Promise<CreditEstimate> {
  return apiFetch<CreditEstimate>("/api/credits/estimate", { body: { action, pages } });
}

/** 星星余额 */
export function getCreditBalance(): Promise<number | null> {
  return apiFetch<{ balance?: number; available?: number }>("/api/credits/balance").then(
    (data) => data.balance ?? data.available ?? null,
    () => null,
  );
}
