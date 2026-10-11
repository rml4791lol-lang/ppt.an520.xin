/** 复刻/美化页只允许站内文件与本页 data URL，避免预览图被改成外链。 */

export function safeReplicateFileUrl(url: string): string {
  const value = String(url || "");
  return value.startsWith("/api/files/") && !value.includes("..") ? value : "";
}

export function safeReplicateShellSrc(url: string): string {
  const value = String(url || "");
  if (value.startsWith("data:image/")) return value;
  return safeReplicateFileUrl(value);
}

export function beautifyHref(projectId?: string | null): string {
  const id = String(projectId || "").trim();
  if (!id || id.includes("..") || /[/?#&]/.test(id)) return "/beautify";
  return `/beautify?projectId=${encodeURIComponent(id)}`;
}
