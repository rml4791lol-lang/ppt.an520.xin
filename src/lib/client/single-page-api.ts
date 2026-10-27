// 单页生成器（创意页面生成器）API 客户端。
// 对齐 src/app/api/single-page/* 与 src/lib/server/generation/single-pages.ts。
import { apiFetch, dispatchIntent, type ProjectListResult } from "./api";
export type { ProjectItem, ProjectListResult } from "./api";
import { toSinglePageActionCall, type SinglePageIntent } from "../single-page-intents";

export type SinglePageStatus = "idle" | "queued" | "running" | "succeeded" | "failed";

/** generate / refine 的同步响应（单张版本） */
export interface SingleRunResponse {
  pageId: string;
  projectId: string;
  jobId: string;
  versionId: string;
  status: "succeeded" | "failed";
  imageUrl: string;
  error: string;
  balance: number;
}

/** 动作经 typed intent 分发：路径与信封由 src/lib/single-page-intents.ts 决定 */
function sendIntent<T>(intent: SinglePageIntent): Promise<T> {
  return dispatchIntent<T>(toSinglePageActionCall(intent), intent);
}

export function generateSinglePage(input: {
  pageId: string;
  projectId?: string;
  title?: string;
  content: string;
  stylePackId?: string;
  requestId?: string;
  /** 原稿图路径（i2i 原稿重设计，正式契约）：来自 /api/assets/upload 的 path；服务端校验归属当前用户，否则报 FILE_FORBIDDEN/原稿不存在 */
  imagePath?: string;
  mode?: string;
  colorMode?: string;
  structure?: unknown;
}): Promise<SingleRunResponse> {
  return sendIntent({ kind: "generatePage", params: input });
}

export function refineSinglePage(input: {
  pageId: string;
  editInstruction: string;
  requestId?: string;
}): Promise<SingleRunResponse> {
  return sendIntent({ kind: "refinePage", params: input });
}

export interface SingleExportResult {
  exportId: string;
  url: string;
  pageCount: number;
  kind: "image";
}

/** 单页项目 → 图片版 PPTX（免费）：{projectId} 或 {pageIds} */
export function exportSinglePagesImagePptx(input: {
  projectId?: string;
  pageIds?: string[];
  title?: string;
}): Promise<SingleExportResult> {
  return sendIntent({ kind: "exportImagePptx", params: input });
}

export interface SingleEditableExportStart {
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

/** 单页项目 → 可编辑 PPTX（20🌟/页，WPS 免费优先 / Image2PPT / Codia 备用）：202 返回任务句柄，轮询 /api/pptx-exports/{id} */
export function startSingleEditableExport(projectId: string, force = false): Promise<SingleEditableExportStart> {
  return sendIntent({ kind: "exportEditablePptx", params: { projectId, force } });
}

export function listProjects(query: {
  projectType?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ProjectListResult> {
  const params = new URLSearchParams();
  if (query.projectType) params.set("projectType", query.projectType);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const qs = params.toString();
  return apiFetch<ProjectListResult>(`/api/projects${qs ? `?${qs}` : ""}`);
}

export function deleteProject(id: string): Promise<unknown> {
  return apiFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ---------- 项目详情恢复 ---------- */

export interface SinglePageVersionView {
  versionId: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  imageUrl: string;
  error: string;
  createdAt: number;
}

export interface SinglePageDetailPage {
  pageId: string;
  projectId: string;
  userId: string;
  pageIndex: number;
  title: string;
  content: string;
  stylePackId: string;
  shellPath?: string;
  status: "idle" | "queued" | "running" | "succeeded" | "failed";
  error: string;
  activeVersionId: string;
  createdAt: number;
  updatedAt: number;
  /** 新的在前 */
  versions: SinglePageVersionView[];
}

export interface SinglePageProjectDetail {
  project: { id: string; title: string; source?: "single" | "replicate"; createdAt: number; updatedAt: number };
  pages: SinglePageDetailPage[];
}

/** 打开既有单页项目：GET /api/single-page/project?projectId=（404 → 项目不存在或已删除） */
export function getSinglePageProject(projectId: string): Promise<SinglePageProjectDetail> {
  return apiFetch<SinglePageProjectDetail>(
    `/api/single-page/project?projectId=${encodeURIComponent(projectId)}`,
  );
}

/* ---------- 版本选择（真实切换导出/预览版本） ---------- */

export interface SelectVersionResponse {
  pageId: string;
  projectId: string;
  status: string;
  activeVersionId: string;
}

/** 切换页面生效版本：POST /api/single-page/select-version（错误码 VERSION_NOT_FOUND/VERSION_NOT_READY/GENERATION_RUNNING） */
export function selectSinglePageVersion(input: {
  pageId: string;
  versionId: string;
}): Promise<SelectVersionResponse> {
  return sendIntent({ kind: "selectVersion", params: input });
}

/** 素材上传（单页「传图」原稿）：POST /api/assets/upload（FormData，≤30MB） */
export function uploadAsset(file: File, kind = "uploads"): Promise<{
  path: string;
  url: string;
  size: number;
  mime: string;
}> {
  const form = new FormData();
  form.set("file", file);
  form.set("kind", kind);
  return apiFetch("/api/assets/upload", { formData: form });
}
