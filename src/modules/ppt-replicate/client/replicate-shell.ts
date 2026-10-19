"use client";

const SHELL_W = 1536;
const SHELL_H = 864;
export const BEAUTIFY_MAX_PAGES = 40;

export function letterbox(source: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SHELL_W;
  canvas.height = SHELL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, SHELL_W, SHELL_H);
  const scale = Math.min(SHELL_W / sw, SHELL_H / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, (SHELL_W - dw) / 2, (SHELL_H - dh) / 2, dw, dh);
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("无法编码图片"));
    }, type, quality);
  });
}

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  // public/pdf.worker.min.mjs 由 scripts/sync-pdf-worker.mjs 在 dev/build 前同步。
  pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${encodeURIComponent(pdfjs.version)}`;
  return pdfjs;
}

async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  if (!file.type.startsWith("image/")) throw new Error("不支持的文件类型");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片无法读取"));
      el.src = url;
    });
    return letterbox(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pdfToCanvases(file: File): Promise<HTMLCanvasElement[]> {
  const pdfjs = await loadPdfjs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  if (pdf.numPages > BEAUTIFY_MAX_PAGES) {
    throw new Error(`一次最多 ${BEAUTIFY_MAX_PAGES} 页（与整套 PPT 相同），请拆开再传`);
  }
  const out: HTMLCanvasElement[] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(SHELL_W / base.width, SHELL_H / base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法渲染 PDF 页");
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    out.push(letterbox(canvas, canvas.width, canvas.height));
  }
  return out;
}

export async function filesToShellCanvases(files: File[]): Promise<HTMLCanvasElement[]> {
  const pptx = files.find((file) => /\.pptx?$/i.test(file.name) || file.type.includes("presentation"));
  if (pptx) throw new Error("PPTX 请先另存为 PDF 再上传（浏览器拆不出位图）");
  try {
    const canvases: HTMLCanvasElement[] = [];
    for (const file of files) {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        canvases.push(...(await pdfToCanvases(file)));
      } else {
        canvases.push(await fileToCanvas(file));
      }
      if (canvases.length > BEAUTIFY_MAX_PAGES) {
        throw new Error(`一次最多 ${BEAUTIFY_MAX_PAGES} 页（与整套 PPT 相同），请拆开再传`);
      }
    }
    return canvases;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror|loading chunk|dynamically imported/i.test(text)) {
      throw new Error("参考稿读取失败，请检查网络后重试");
    }
    throw error;
  }
}

export async function blobFromUrl(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("读取生成图失败");
  return res.blob();
}

export async function toJpegFile(blob: Blob, name: string): Promise<File> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("生成图无法编码"));
      el.src = url;
    });
    const canvas = letterbox(img, img.naturalWidth, img.naturalHeight);
    const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.86);
    return new File([jpeg], name, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker()));
  return out;
}
