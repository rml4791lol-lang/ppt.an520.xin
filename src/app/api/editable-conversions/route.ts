import { requireUser } from '@/lib/server/auth';
import { assertEditableCapacity, startEditableExport, uploadedEditableSource, uploadedPageCapacity } from '@/modules/editable-export/server/editable';
import { ApiError, jsonOk } from '@/lib/server/http';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { defineApiRoute } from '@/lib/server/generation/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const config = getGenerationConfig();
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > config.uploadMaxBytes + MULTIPART_OVERHEAD_BYTES) {
    throw new ApiError(
      'FILE_TOO_LARGE',
      `文件合计不能超过 ${Math.floor(config.uploadMaxBytes / 1024 / 1024)}MB`,
      413,
      false,
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError('VALIDATION_ERROR', '请求必须是 multipart/form-data', 400, false);
  }
  const entries = [...form.getAll('files'), ...form.getAll('file')];
  const uniqueFiles = entries.filter((value, index) => value instanceof File && entries.indexOf(value) === index) as File[];
  if (uniqueFiles.length === 0) throw new ApiError('VALIDATION_ERROR', '请选择 PDF 或图片文件', 400, false);
  // 读 Buffer 前用共享上限门早拒（文件数 = 页数）；未配置通道时 capacity=0，由 uploadedEditableSource 报未配置。
  const capacity = uploadedPageCapacity(config);
  if (capacity.capacity > 0) assertEditableCapacity(uniqueFiles.length, capacity);
  const totalSize = uniqueFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > config.uploadMaxBytes) {
    throw new ApiError(
      'FILE_TOO_LARGE',
      `文件合计不能超过 ${Math.floor(config.uploadMaxBytes / 1024 / 1024)}MB`,
      413,
      false,
    );
  }
  const files = await Promise.all(
    uniqueFiles.map(async (file) => ({
      name: file.name,
      mime: file.type || 'application/octet-stream',
      data: Buffer.from(await file.arrayBuffer()),
    })),
  );
  const force = String(form.get('force') || '') === 'true';
  const deps = { config };
  const source = await uploadedEditableSource(user.id, files, deps);
  const started = await startEditableExport(source, 'editable', { force, deps });
  return jsonOk(started, { status: started.status === 'succeeded' ? 200 : 202 });
}, { mutation: true });
