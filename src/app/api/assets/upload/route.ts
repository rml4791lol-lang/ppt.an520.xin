import { jsonOk, ApiError } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { extForFile, saveFile } from '@/lib/server/generation/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const config = getGenerationConfig();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError('VALIDATION_ERROR', '请求必须是 multipart/form-data', 400, false);
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new ApiError('VALIDATION_ERROR', '缺少 file 字段', 400, false);
  if (file.size === 0) throw new ApiError('EMPTY_FILE', '文件内容为空', 400, false);
  if (file.size > config.uploadMaxBytes) {
    throw new ApiError('FILE_TOO_LARGE', '单文件最大 30MB', 413, false);
  }
  const kind = String(form.get('kind') || 'uploads').trim() || 'uploads';
  const mime = file.type || 'application/octet-stream';
  const buffer = Buffer.from(await file.arrayBuffer());
  const saved = await saveFile('uploads', user.id, buffer, {
    kind,
    ext: extForFile(file.name, mime),
  });
  return jsonOk({ path: saved.relPath, url: saved.url, size: file.size, mime }, { status: 201 });
}, { mutation: true });
