// 单页生成器（创意页面生成器）API 客户端。
// 对齐 src/app/api/single-page/* 与 src/lib/server/generation/single-pages.ts。
import { apiFetch } from "./api";

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

export function generateSinglePage(input: {
  pageId: string;
  projectId?: string;
  title?: string;
  content: string;
  stylePackId?: string;
  requestId?: string;
  /** 原稿图路径（前向兼容字段：当前后端路由忽略，待服务端支持 i2i 后生效） */
  imagePath?: string;
}): Promise<SingleRunResponse> {
  return apiFetch<SingleRunResponse>("/api/single-page/generate", { body: input });
}

export function refineSinglePage(input: {
  pageId: string;
  editInstruction: string;
  requestId?: string;
}): Promise<SingleRunResponse> {
  return apiFetch<SingleRunResponse>("/api/single-page/refine", { body: input });
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
  return apiFetch<SingleExportResult>("/api/single-page/export-image-pptx", { body: input });
}

export interface ProjectItem {
  id: string;
  projectType: "deck" | "single-page";
  title: string;
  status: string;
  pageCount: number;
  coverUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectListResult {
  items: ProjectItem[];
  total: number;
  page: number;
  pageSize: number;
  retentionDays: number;
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
