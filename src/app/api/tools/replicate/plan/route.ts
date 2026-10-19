import { jsonOk, readJsonBody, ApiError } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { assertFeatureVisible } from '@/lib/server/feature-flags';
import { parseDocument } from '@/lib/server/documents';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { runReplicatePlan } from '@/modules/ppt-replicate/server/replicate';
import { defineApiRoute } from '@/lib/server/generation/route';
import { hitRateLimit } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

async function fileText(file: FormDataEntryValue | null, maxBytes: number): Promise<string> {
  if (!(file instanceof File) || file.size <= 0) return '';
  if (file.size > maxBytes) throw new ApiError('FILE_TOO_LARGE', '单文件最大 30MB', 413, false);
  const parsed = await parseDocument(Buffer.from(await file.arrayBuffer()), file.name);
  return parsed.text.trim();
}

async function readPlanInput(request: Request): Promise<{
  topic: string;
  sourceText: string;
  outlineText: string;
  pageCount: number;
  gapPolicy: string;
  copyMode: string;
  imagePaths: unknown;
}> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const maxBytes = getGenerationConfig().uploadMaxBytes;
    // 先验 content-length 再解析：formData() 会把整个 multipart 先读进内存，
    // 两个文件字段各限 maxBytes，留 1MB 边界余量
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes * 2 + MULTIPART_OVERHEAD_BYTES) {
      throw new ApiError(
        'FILE_TOO_LARGE',
        `文件合计不能超过 ${Math.floor((maxBytes * 2) / 1024 / 1024)}MB`,
        413,
        false,
      );
    }
    const form = await request.formData();
    const sourceText = [String(form.get('sourceText') || '').trim(), await fileText(form.get('file'), maxBytes)]
      .filter(Boolean)
      .join('\n\n');
    const outlineText = [String(form.get('outlineText') || '').trim(), await fileText(form.get('outlineFile'), maxBytes)]
      .filter(Boolean)
      .join('\n\n');
    return {
      topic: String(form.get('topic') || ''),
      sourceText,
      outlineText,
      pageCount: Number(form.get('pageCount')),
      gapPolicy: String(form.get('gapPolicy') || ''),
      copyMode: String(form.get('copyMode') || ''),
      imagePaths: form.get('imagePaths'),
    };
  }
  const body = await readJsonBody(request);
  return {
    topic: String(body.topic ?? ''),
    sourceText: String(body.sourceText ?? ''),
    outlineText: String(body.outlineText ?? ''),
    pageCount: Number(body.pageCount),
    gapPolicy: String(body.gapPolicy ?? ''),
    copyMode: String(body.copyMode ?? ''),
    imagePaths: body.imagePaths,
  };
}

/** 按主题 / 大纲 / 材料拆成与壳页数一致的文案。免费 LLM，不计星星。有壳图时先读结构再拆页。 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  assertFeatureVisible('ppt_replicate', user);
  const rate = hitRateLimit(`replicate-plan:${user.id}`, { windowMs: 60 * 60_000, max: 40 });
  if (!rate.allowed) {
    throw new ApiError('PLAN_RATE_LIMITED', '参考稿处理过于频繁，请稍后再试', 429, true);
  }
  const input = await readPlanInput(request);
  const result = await runReplicatePlan(user.id, input);
  return jsonOk(result);
}, { mutation: true });
