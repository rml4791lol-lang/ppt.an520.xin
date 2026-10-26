// 文档上传解析：TXT/MD 直读，DOCX 走 mammoth，PDF 走 pdfjs-dist legacy build。
// 内容截断由调用方按 getGenerationConfig().sourceTextMaxChars 处理（默认 10 万字）。
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiError } from './http';

export interface ParsedDocument {
  text: string;
  format: 'txt' | 'md' | 'docx' | 'pdf';
  /** pdf 页数；其它格式为 0 */
  pageCount: number;
}

const SUPPORTED_EXTS = ['.txt', '.md', '.docx', '.pdf'] as const;

function extOf(filename: string): string {
  const match = String(filename || '').toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return match ? match[0] : '';
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const require = createRequire(import.meta.url);
  const mammoth = require('mammoth') as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || '');
}

interface PdfTextItem {
  str?: string;
}

/**
 * pdfjs 在 Node 下默认用相对路径 "./pdf.worker.mjs" 动态 import worker。
 * 放进 Next 服务端 chunk 后，这个相对路径会落到 .next/server/chunks 下而找不到文件。
 * 因此显式指向 node_modules 里的真实文件，dev/prod 都不受打包方式影响。
 */
function pdfjsDistDir(): string {
  const local = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  if (!existsSync(local)) {
    throw new Error(`pdfjs-dist 未安装或工作目录不正确：${local}`);
  }
  return local;
}

export function resolvePdfWorkerSrc(): string {
  return pathToFileURL(path.join(pdfjsDistDir(), 'legacy', 'build', 'pdf.worker.mjs')).href;
}

interface ParseGate {
  active: number;
  queue: Array<() => void>;
}

const parseGateGlobal = globalThis as typeof globalThis & {
  __anpptParseGate?: ParseGate;
};
const parseGate: ParseGate = parseGateGlobal.__anpptParseGate ?? { active: 0, queue: [] };
parseGateGlobal.__anpptParseGate = parseGate;

function parseConcurrency(): number {
  const value = Number(process.env.ANPPT_V2_DOCUMENT_PARSE_CONCURRENCY);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(8, value) : 2;
}

function parseQueueTimeoutMs(): number {
  const value = Number(process.env.ANPPT_V2_DOCUMENT_PARSE_QUEUE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : 20_000;
}

/**
 * PDF/DOCX 解析是 CPU 重活，且 pdfjs 在 Node 下走 fake worker（同线程）。
 * 用进程内小队列限制并发，避免多用户同时上传大文档时把事件循环打满。
 */
async function withParseSlot<T>(run: () => Promise<T>): Promise<T> {
  const max = parseConcurrency();
  if (parseGate.active >= max) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = parseGate.queue.indexOf(wake);
        if (index >= 0) parseGate.queue.splice(index, 1);
        reject(new ApiError('DOCUMENT_PARSE_BUSY', '当前文档解析请求较多，请稍后重试', 503, true));
      }, parseQueueTimeoutMs());
      const wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      parseGate.queue.push(wake);
    });
  } else {
    parseGate.active += 1;
  }
  try {
    return await run();
  } finally {
    parseGate.active = Math.max(0, parseGate.active - 1);
    const next = parseGate.queue.shift();
    if (next) {
      // 先占位再唤醒，保证并发上限不会被微任务间隙突破
      parseGate.active += 1;
      next();
    }
  }
}

async function parsePdf(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  // Node 22.12+ 支持 require(ESM)；worker/CMap 路径在下方显式指向 node_modules，
  // 不依赖打包器对 pdfjs 内部 import.meta.url 的改写。
  const require = createRequire(import.meta.url);
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs') as {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(opts: Record<string, unknown>): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
      }>;
      destroy(): Promise<void>;
    };
  };
  const pdfRoot = pdfjsDistDir();
  pdfjs.GlobalWorkerOptions.workerSrc = resolvePdfWorkerSrc();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    // 中文等非嵌入 CID 字体需要 CMap；标准字体/JPX WASM 也从本地 pdfjs-dist 读取。
    cMapUrl: `${pdfRoot}${path.sep}cmaps${path.sep}`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfRoot}${path.sep}standard_fonts${path.sep}`,
    wasmUrl: `${pdfRoot}${path.sep}wasm${path.sep}`,
  });
  try {
    const doc = await loadingTask.promise;
    const parts: string[] = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => item.str || '').join(' ').trim());
    }
    return { text: parts.filter(Boolean).join('\n\n'), pageCount: doc.numPages };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export async function parseDocument(buffer: Buffer, filename: string): Promise<ParsedDocument> {
  const ext = extOf(filename);
  if (!(SUPPORTED_EXTS as readonly string[]).includes(ext)) {
    throw new ApiError(
      'UNSUPPORTED_FILE_TYPE',
      `仅支持 ${SUPPORTED_EXTS.join(' / ')} 格式的文档`,
      400,
      false,
    );
  }
  if (buffer.length === 0) throw new ApiError('EMPTY_FILE', '文件内容为空', 400, false);
  try {
    if (ext === '.txt' || ext === '.md') {
      return { text: buffer.toString('utf8'), format: ext.slice(1) as 'txt' | 'md', pageCount: 0 };
    }
    if (ext === '.docx') {
      return { text: await withParseSlot(() => parseDocx(buffer)), format: 'docx', pageCount: 0 };
    }
    const pdf = await withParseSlot(() => parsePdf(buffer));
    return { text: pdf.text, format: 'pdf', pageCount: pdf.pageCount };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'DOCUMENT_PARSE_FAILED',
      `文档解析失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`,
      422,
      false,
    );
  }
}

export function truncateSourceText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  if (clean.length <= maxChars) return { text: clean, truncated: false };
  return { text: clean.slice(0, maxChars), truncated: true };
}
