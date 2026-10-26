import { apiFetch } from "@/lib/client/api";
import {
  generateSinglePage,
  exportSinglePagesImagePptx,
  getSinglePageProject,
  refineSinglePage,
  uploadAsset,
  type SingleEditableExportStart,
  type SingleExportResult,
} from "@/lib/client/single-page-api";

export {
  exportSinglePagesImagePptx,
  generateSinglePage,
  getSinglePageProject,
  refineSinglePage,
  uploadAsset,
  type SingleExportResult,
};

export interface BeautifyDraftResult {
  projectId: string;
  pageCount: number;
}

export function saveBeautifyDraft(input: {
  projectId?: string;
  title?: string;
  pages: Array<{ pageId?: string; title?: string; content?: string; imagePath?: string }>;
}): Promise<BeautifyDraftResult> {
  return apiFetch<BeautifyDraftResult>("/api/single-page/draft", { body: input });
}

export interface BeautifyPlanSlide {
  title: string;
  content: string;
  source: string;
}

export interface BeautifyPlanResult {
  slides: BeautifyPlanSlide[];
  pageCount: number;
  structures: unknown[];
  structureExtracted: number;
}

export type BeautifyBatchStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

export interface BeautifyBatch {
  batchId: string;
  projectId: string;
  status: BeautifyBatchStatus;
  total: number;
  succeeded: number;
  failed: number;
  error: string;
  targetIds: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt: number;
  reused?: boolean;
}

export interface BeautifyBatchPage {
  pageId: string;
  pageIndex: number;
  status: "idle" | "queued" | "running" | "succeeded" | "failed";
  imageUrl: string;
  error: string;
  updatedAt: number;
}

export interface BeautifyBatchDetail {
  batch: BeautifyBatch | null;
  pages: BeautifyBatchPage[];
}

export function planBeautifyCopy(formData: FormData): Promise<BeautifyPlanResult> {
  return apiFetch<BeautifyPlanResult>("/api/tools/replicate/plan", { formData });
}

export function startBeautifyBatch(input: {
  projectId: string;
  pageIds: string[];
  colorMode: "follow-shell" | "new-theme";
  structures?: Record<string, unknown>;
}): Promise<BeautifyBatch> {
  return apiFetch<BeautifyBatch>("/api/single-page/batch", { body: input });
}

export function getLatestBeautifyBatch(projectId: string): Promise<BeautifyBatchDetail> {
  return apiFetch<BeautifyBatchDetail>(`/api/single-page/batch?projectId=${encodeURIComponent(projectId)}`);
}

export function startUploadedEditableExport(files: File[]): Promise<SingleEditableExportStart> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return apiFetch<SingleEditableExportStart>("/api/editable-conversions", { formData: form });
}
