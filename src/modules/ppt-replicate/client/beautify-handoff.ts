/** 首页美化页把文件交给 /beautify：同页 client 跳转保留内存，不走 URL。 */

let pending: File[] | null = null;

export function stashBeautifyFiles(files: File[]): void {
  pending = files.length > 0 ? files : null;
}

export function takeBeautifyFiles(): File[] {
  const files = pending ?? [];
  pending = null;
  return files;
}
