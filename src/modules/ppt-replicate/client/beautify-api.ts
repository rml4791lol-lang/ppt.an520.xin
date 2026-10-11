import { apiFetch } from "@/lib/client/api";
import {
  generateSinglePage,
  getSinglePageProject,
  refineSinglePage,
  uploadAsset,
  type SingleEditableExportStart,
} from "@/lib/client/single-page-api";

export { generateSinglePage, getSinglePageProject, refineSinglePage, uploadAsset };

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
