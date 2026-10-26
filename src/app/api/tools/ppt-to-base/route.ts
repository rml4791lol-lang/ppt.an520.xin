import { ApiError, jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { assertFeatureVisible } from '@/lib/server/feature-flags';
import { runPptToBase } from '@/modules/ppt-to-base/server/base-image';
import { defineApiRoute } from '@/lib/server/generation/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 截图转通用模版底座：multipart（file=PNG + requestId）。客户端已 letterbox 成 1536×864 PNG。 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  // 功能硬门 + 大小预检都要在解析 body 之前：formData() 会把整个 multipart 先读进内存
  assertFeatureVisible('ppt_to_base', user);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new ApiError('FILE_TOO_LARGE', '截图最大 10MB', 413, false);
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size <= 0) throw new ApiError('VALIDATION_ERROR', '请上传截图', 400, false);
  if (file.size > MAX_IMAGE_BYTES) throw new ApiError('FILE_TOO_LARGE', '截图最大 10MB', 413, false);
  const image = Buffer.from(await file.arrayBuffer());
  if (image.subarray(0, 8).compare(PNG_MAGIC) !== 0) {
    throw new ApiError('VALIDATION_ERROR', '请上传 PNG 截图（JPG 可先另存为 PNG）', 400, false);
  }
  const result = await runPptToBase(user.id, { image, requestId: String(form.get('requestId') || '') });
  return jsonOk(result, { status: 201 });
}, { mutation: true });
