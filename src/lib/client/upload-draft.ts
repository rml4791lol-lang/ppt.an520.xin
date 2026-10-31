"use client";

import type { StylePack } from "@/data/style-packs";

/**
 * 生成器草稿（模块级内存）。
 * 登录跳转是 SPA 导航：组件卸载重挂，但模块作用域还在，
 * 所以未登录时已经选好的文档能跨登录保留，回来不用再放一次。
 * 刷新或关闭页面会丢（File 无法写进 sessionStorage），这是有意的取舍。
 */
export interface UploadDraft {
  tab: string;
  style: StylePack | null;
  duration: string;
  customPages: string;
  quality: string;
  pages: string[];
  file: File | null;
  savedAt: number;
}

let draft: UploadDraft | null = null;

export function saveUploadDraft(next: Omit<UploadDraft, "savedAt">): void {
  draft = { ...next, savedAt: Date.now() };
}

export function readUploadDraft(): UploadDraft | null {
  return draft && Date.now() - draft.savedAt < 30 * 60 * 1000 ? draft : null;
}

export function clearUploadDraft(): void {
  draft = null;
}
