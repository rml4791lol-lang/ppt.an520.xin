import { jsonOk, ApiError } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { parseDocument, truncateSourceText } from '@/lib/server/documents';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { createDeck } from '@/lib/server/generation/decks';
import { extForFile, saveFile } from '@/lib/server/generation/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function intField(value: FormDataEntryValue | null, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

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
  if (file.size > config.uploadMaxBytes) throw new ApiError('FILE_TOO_LARGE', '单文件最大 30MB', 413, false);

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parseDocument(buffer, file.name || 'document.txt');
  const { text, truncated } = truncateSourceText(parsed.text, config.sourceTextMaxChars);
  if (!text) throw new ApiError('EMPTY_DOCUMENT', '文档没有可解析的文字内容', 422, false);

  const duration = intField(form.get('duration'), 15, 1, 240);
  const targetPageCount = intField(form.get('targetPageCount') ?? form.get('target_page_count'), 10, 1, 100);
  const qualityTier = String(form.get('qualityTier') || 'standard').trim().slice(0, 20) || 'standard';
  const stylePackId = String(form.get('stylePackId') || '').trim().slice(0, 80);
  const title = (file.name || '未命名项目').replace(/\.[a-z0-9]{1,8}$/i, '').slice(0, 120) || '未命名项目';

  const deck = createDeck(user.id, {
    title,
    sourceFileName: (file.name || '').slice(0, 200),
    sourceText: text,
    durationMinutes: duration,
    targetPageCount,
    qualityTier,
    stylePackId,
  });
  // 原始文档留档（不影响解析结果）
  await saveFile('uploads', user.id, buffer, {
    kind: 'source',
    ext: extForFile(file.name, file.type),
    id: deck.id,
  });

  return jsonOk(
    { deckId: deck.id, title: deck.title, status: deck.status, truncated, chars: text.length },
    { status: 201 },
  );
}, { mutation: true });
