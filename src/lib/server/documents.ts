// 文档上传解析：TXT/MD 直读，DOCX 走 mammoth，PDF 走 pdfjs-dist legacy build。
// 内容截断由调用方按 getGenerationConfig().sourceTextMaxChars 处理（默认 10 万字）。
import { createRequire } from 'node:module';
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

async function parsePdf(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  // createRequire 走 node_modules 真实路径加载，避免打包器解析 pdfjs 内部
  // import.meta.url/worker 引用；Node 26 支持 require(ESM)。
  const require = createRequire(import.meta.url);
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs') as {
    getDocument(opts: Record<string, unknown>): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
      }>;
      destroy(): Promise<void>;
    };
  };
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
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
      return { text: await parseDocx(buffer), format: 'docx', pageCount: 0 };
    }
    const pdf = await parsePdf(buffer);
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
