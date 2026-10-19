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

export function planBeautifyCopy(formData: FormData): Promise<BeautifyPlanResult> {
  return apiFetch<BeautifyPlanResult>("/api/tools/replicate/plan", { formData });
}

export function startUploadedEditableExport(files: File[]): Promise<SingleEditableExportStart> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return apiFetch<SingleEditableExportStart>("/api/editable-conversions", { formData: form });
}
