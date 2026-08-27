// 「按页录入」入口：用户已逐页写好内容，不需要 LLM 生成大纲。
// 建 deck（sourceText=各页拼接留档）→ 逐页塞入大纲页 → 状态直接置 outlined，
// 前端下一步走内容梳理（structure）。对齐旁门 pagedCopyV2：单页上限 1500 字、最多 50 页。
import { jsonOk, ApiError, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { createDeck, replaceSlides, touchDeck } from '@/lib/server/generation/decks';
import { assertStylePackUsable } from '@/lib/server/templates';
import { cleanString, type OutlineSlide } from '@/lib/server/generation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAGES = 50;
const MAX_PAGE_CHARS = 1500;

export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = await readJsonBody(request);

  const rawPages = body.pages;
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'pages 至少要有 1 页', 400, false);
  }
  if (rawPages.length > MAX_PAGES) {
    throw new ApiError('TOO_MANY_PAGES', `一次最多录入 ${MAX_PAGES} 页`, 400, false);
  }

  const pages = rawPages.map((raw, index) => {
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const rawText = cleanString(obj.rawText ?? obj.raw_text, 8000);
    if (!rawText) throw new ApiError('VALIDATION_ERROR', `第 ${index + 1} 页内容为空`, 400, false);
    if (rawText.length > MAX_PAGE_CHARS) {
      throw new ApiError('PAGE_TOO_LONG', `第 ${index + 1} 页超过单页 ${MAX_PAGE_CHARS} 字上限`, 400, false);
    }
    return { title: cleanString(obj.title, 200), rawText };
  });

  const qualityTier = cleanString(body.qualityTier, 20) || 'standard';
  const stylePackId = cleanString(body.stylePackId, 80);
  assertStylePackUsable(stylePackId, user);
  const sourceText = pages.map((page, i) => `第 ${i + 1} 页\n${page.rawText}`).join('\n\n');

  const deck = createDeck(user.id, {
    title: pages[0].title || '按页录入项目',
    sourceFileName: '',
    sourceText,
    durationMinutes: 15,
    targetPageCount: pages.length,
    qualityTier,
    stylePackId,
  });
  const slides: OutlineSlide[] = pages.map((page, i) => ({
    pageIndex: i,
    role: 'content',
    chapter: '',
    pageType: '',
    title: page.title || `第 ${i + 1} 页`,
    goal: '',
    mustKeep: [],
    rawText: page.rawText,
    summary: [],
    visualNote: '',
  }));
  replaceSlides(deck.id, slides);
  touchDeck(deck.id, { status: 'outlined' });

  return jsonOk(
    { deckId: deck.id, title: deck.title, status: 'outlined', pageCount: pages.length },
    { status: 201 },
  );
}, { mutation: true });
