// POST /api/deck/[id] 的 action RPC 调度。
// 内容类 action（outline/增删重排/拆页/structure）在 confirm-structure 后一律拒绝，
// 需 unlock-structure 解锁（作废已生成页）。
import { ApiError, validationError } from '../http';
import type { EngineDeps } from '../engine';
import { generateOutline, splitSlide, structureSlides, structureOneSlide } from '../engine';
import { cleanString, type OutlineSlide } from './types';
import { validateTaggedDsl } from './dsl';
import {
  deleteSlide,
  getDeckState,
  getOwnedDeck,
  getSlide,
  insertSlide,
  listSlides,
  markSlidesGenStale,
  reorderSlides,
  replaceSlides,
  replaceSlideWithMany,
  setActiveVersion,
  setDeckAnchor,
  touchDeck,
  updateSlideContent,
  updateSlideStructure,
  type DeckRow,
} from './decks';
import { getGenDb } from './db';
import { startDeckGeneration, type GenerateDeps, type StartedJob } from './generate';
import { loadStyleReferenceDataUrl, resolveStylePack } from './style-packs';
import { buildOutlinePageMapping, resolveTemplateReferenceImage } from './mapping';
import { assertStylePackUsable, getTemplate, getTemplatePages, resolveTemplateKind } from '../templates';
import { assertFeatureVisible } from '../feature-flags';
import { findUserById } from '../auth';
import { hitRateLimit } from '../rate-limit';
import { parseDeckIntent, toDeckActionCall, type DeckIntent } from '../../deck-intents';

export interface ActionDeps extends EngineDeps, GenerateDeps {}

export interface ActionResult {
  state: ReturnType<typeof getDeckState>;
  extra: Record<string, unknown>;
  status: number;
  /** 生成类 action 的 job 句柄；路由只用 extra 里的摘要，测试可 await job.done */
  job?: StartedJob;
}

// 免费 LLM 动作（outline 重生成/structure/拆页）不扣星但烧上游 token：按用户限频，防零成本循环调用
function assertFreeLlmRate(userId: string): void {
  const rate = hitRateLimit(`llm-free:${userId}`, { windowMs: 10 * 60 * 1000, max: 30 });
  if (!rate.allowed) throw new ApiError('LLM_RATE_LIMITED', '操作过于频繁，请稍后再试', 429, true);
}

const CONTENT_LOCKED_MESSAGE =
  '内容已冻结：请先执行 unlock-structure 解锁（解锁将作废已生成的页面图）';

// 图片级编辑工具（开关板硬门；off 时按 404 处理，不暴露功能存在性）
const EDIT_ACTION_FLAGS: Record<string, string> = {
  'erase-slide': 'magic_erase',
  'text-edit-slide': 'image_text_edit',
  'fuse-slide': 'template_fusion',
  'set-reference': 'set_as_reference',
};

// 高精清除：标记图 + 固定提示词（自写）。灾备渠道多图支持未验证，丢图时把意图降级为文字。
const ERASE_INSTRUCTION =
  '第二张图是第一张的标记版，红色涂抹区是要擦除的内容；移除该区内容并用与周围一致的底色/留白自然填充，其余元素、文字、版式、配色全部保持不变，图上不得出现红色标记。';
const ERASE_DEGRADE_NOTE =
  '（附加的红色涂抹标记图未能传递到生图服务：请依据常识判断图上最可能被用户要求移除的多余元素并移除，用与周围一致的底色/留白自然填充，其余元素、文字、版式、配色全部保持不变。）';

/** base64 dataURL → Buffer；标记图 ≤2MB（前端导出 1536x864 涂抹层），融合样张 ≤8MB（对齐样张读取上限）。 */
function dataUrlToBuffer(value: unknown, label: string, maxBytes: number): Buffer {
  const clean = cleanString(value, maxBytes * 2);
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(clean);
  if (!match) throw validationError(`${label} 必须是图片 base64 dataURL`);
  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0) throw validationError(`${label} 内容为空`);
  if (buffer.length > maxBytes) throw validationError(`${label} 超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`);
  return buffer;
}

function assertContentEditable(deck: DeckRow): void {
  if (['confirmed', 'generating', 'generated', 'partial'].includes(deck.status)) {
    throw new ApiError('CONTENT_LOCKED', CONTENT_LOCKED_MESSAGE, 409, false);
  }
}

function toOutlineSlide(slide: ReturnType<typeof getSlide>): OutlineSlide {
  return {
    pageIndex: slide.pageIndex,
    role: slide.role,
    chapter: slide.chapter,
    pageType: slide.pageType,
    title: slide.title,
    goal: slide.goal,
    mustKeep: slide.mustKeep,
    rawText: slide.rawText,
    summary: slide.summary,
    visualNote: slide.visualNote,
  };
}

function cleanIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw validationError(`${label} 必须是数组`);
  return value.map((item) => cleanString(item, 80)).filter(Boolean);
}

/**
 * action 调度。返回 { state, extra, status }：
 * state 恒为最新全量状态（与 GET /api/deck/[id] 同形），前端可直接 setState。
 */
export async function dispatchDeckAction(
  userId: string,
  deckId: string,
  body: Record<string, unknown>,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  const action = cleanString(body.action, 40);
  if (!action) throw validationError('缺少 action');
  // 图片级编辑工具的开关硬门放调度入口：off 时与未知 action 一样摸不到
  const editToolFlag = EDIT_ACTION_FLAGS[action];
  if (editToolFlag) assertFeatureVisible(editToolFlag, findUserById(userId));

  switch (action) {
    case 'outline': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const force = body.force === true;
      if (listSlides(deck.id).length > 0 && !force) {
        return { state: getDeckState(userId, deck.id), extra: { reused: true }, status: 200 };
      }
      assertFreeLlmRate(userId);
      const result = await generateOutline(
        {
          sourceText: deck.sourceText,
          durationMinutes: deck.durationMinutes,
          targetPageCount: deck.targetPageCount,
          stylePackId: deck.stylePackId || undefined,
          force,
        },
        deps,
      );
      replaceSlides(deck.id, result.slides);
      touchDeck(deck.id, { status: 'outlined', error: '' });
      return {
        state: getDeckState(userId, deck.id),
        extra: { reused: false, provider: result.provider, pageCount: result.slides.length },
        status: 200,
      };
    }

    case 'add-slide': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const atIndex = Number.isInteger(Number(body.atIndex))
        ? Number(body.atIndex)
        : listSlides(deck.id).length;
      insertSlide(deck.id, atIndex, (body.slide || {}) as Partial<OutlineSlide>);
      touchDeck(deck.id, { status: 'outlined' });
      return { state: getDeckState(userId, deck.id), extra: {}, status: 200 };
    }

    case 'delete-slide': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const slideId = cleanString(body.slideId, 80);
      if (!slideId) throw validationError('缺少 slideId');
      if (listSlides(deck.id).length <= 1) throw validationError('至少保留一页');
      deleteSlide(deck.id, slideId);
      touchDeck(deck.id, { status: 'outlined' });
      return { state: getDeckState(userId, deck.id), extra: {}, status: 200 };
    }

    case 'reorder-slides': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      reorderSlides(deck.id, cleanIdList(body.order, 'order'));
      return { state: getDeckState(userId, deck.id), extra: {}, status: 200 };
    }

    case 'split-slide': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const slide = getSlide(deck.id, cleanString(body.slideId, 80));
      const into = Math.min(5, Math.max(2, Math.floor(Number(body.into)) || 2));
      assertFreeLlmRate(userId);
      const result = await splitSlide(toOutlineSlide(slide), into, deps);
      replaceSlideWithMany(deck.id, slide.slideId, result.slides);
      touchDeck(deck.id, { status: 'outlined' });
      return {
        state: getDeckState(userId, deck.id),
        extra: { provider: result.provider, into: result.slides.length },
        status: 200,
      };
    }

    case 'update-slide': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const slideId = cleanString(body.slideId, 80);
      if (!slideId) throw validationError('缺少 slideId');
      const structuredContent = body.structuredContent === undefined
        ? undefined
        : cleanString(body.structuredContent, 12000);
      if (structuredContent !== undefined) {
        if (!structuredContent) throw validationError('梳理内容不能为空');
        const validation = validateTaggedDsl(structuredContent);
        if (!validation.ok) throw validationError(validation.errors[0] || '梳理内容格式不正确');
      }
      const { contentChanged } = updateSlideContent(deck.id, slideId, {
        role: body.role as OutlineSlide['role'] | undefined,
        chapter: body.chapter as string | undefined,
        pageType: body.pageType as string | undefined,
        title: body.title as string | undefined,
        goal: body.goal as string | undefined,
        rawText: body.rawText as string | undefined,
        summary: body.summary as string[] | undefined,
        visualNote: body.visualNote as string | undefined,
        structuredContent,
      });
      // 标题/原文变更后该页需重新梳理；deck 状态回退到 outlined（章节等弱变更不动状态）
      if (structuredContent !== undefined) {
        if (deck.status !== 'structured') touchDeck(deck.id, { status: 'structured', error: '' });
      } else if (contentChanged && deck.status !== 'outlined') {
        touchDeck(deck.id, { status: 'outlined' });
      }
      return { state: getDeckState(userId, deck.id), extra: { contentChanged }, status: 200 };
    }

    case 'select-slide-version': {
      const deck = getOwnedDeck(userId, deckId);
      if (deck.status === 'generating') {
        throw new ApiError('GENERATION_RUNNING', '生成进行中，请稍后再切换版本', 409, true);
      }
      if (!['confirmed', 'generated', 'partial'].includes(deck.status)) {
        throw new ApiError('VERSION_SELECT_TOO_EARLY', '请先确认内容并生成页面', 409, false);
      }
      const slideId = cleanString(body.slideId, 80);
      const versionId = cleanString(body.versionId, 80);
      if (!slideId || !versionId) throw validationError('缺少 slideId 或 versionId');
      setActiveVersion(deck.id, slideId, versionId);
      // 若此前有失败页，版本回退把它救活了：全部成功则整单转 generated
      const slides = listSlides(deck.id);
      if (deck.status === 'partial' && slides.every((s) => s.genStatus === 'succeeded')) {
        touchDeck(deck.id, { status: 'generated', error: '' });
      }
      return { state: getDeckState(userId, deck.id), extra: {}, status: 200 };
    }

    case 'structure':
    case 'structure-slide': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const slides = listSlides(deck.id);
      if (slides.length === 0) throw new ApiError('NO_SLIDES', '请先生成大纲', 400, false);
      const targets =
        action === 'structure-slide'
          ? [getSlide(deck.id, cleanString(body.slideId, 80))]
          : slides.filter((slide) => body.force === true || slide.structureStatus !== 'ok');
      if (targets.length === 0) {
        return { state: getDeckState(userId, deck.id), extra: { reused: true }, status: 200 };
      }
      assertFreeLlmRate(userId);
      if (action === 'structure-slide') {
        const result = await structureOneSlide(toOutlineSlide(targets[0]), deps);
        updateSlideStructure(deck.id, targets[0].slideId, result);
      } else {
        const result = await structureSlides(targets.map(toOutlineSlide), deps);
        const byIndex = new Map(result.pages.map((page) => [page.pageIndex, page]));
        for (const slide of targets) {
          const page = byIndex.get(slide.pageIndex);
          if (page) updateSlideStructure(deck.id, slide.slideId, page);
        }
      }
      touchDeck(deck.id, { status: 'structured', error: '' });
      const failedSlides = listSlides(deck.id)
        .filter((slide) => slide.structureStatus === 'failed')
        .map((slide) => slide.slideId);
      return {
        state: getDeckState(userId, deck.id),
        extra: { failedSlides },
        status: 200,
      };
    }

    case 'confirm-structure': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const slides = listSlides(deck.id);
      if (slides.length === 0) throw new ApiError('NO_SLIDES', '请先生成大纲', 400, false);
      const notReady = slides.filter((slide) => slide.structureStatus !== 'ok');
      if (notReady.length > 0) {
        throw new ApiError(
          'STRUCTURE_INCOMPLETE',
          `还有 ${notReady.length} 页未完成内容梳理（第 ${notReady.map((s) => s.pageIndex + 1).join('、')} 页），请先重梳或删除`,
          409,
          false,
        );
      }
      touchDeck(deck.id, { status: 'confirmed', confirmedAt: Date.now(), error: '' });
      return { state: getDeckState(userId, deck.id), extra: {}, status: 200 };
    }

    case 'unlock-structure': {
      const deck = getOwnedDeck(userId, deckId);
      if (deck.status === 'generating') {
        throw new ApiError('GENERATION_RUNNING', '生成进行中，请等待完成后再解锁', 409, true);
      }
      if (!['confirmed', 'generated', 'partial'].includes(deck.status)) {
        return { state: getDeckState(userId, deck.id), extra: { alreadyUnlocked: true }, status: 200 };
      }
      const invalidated = markSlidesGenStale(deck.id);
      touchDeck(deck.id, { status: 'structured', confirmedAt: null, error: '' });
      return {
        state: getDeckState(userId, deck.id),
        extra: {
          invalidated,
          warning: '已解锁，可修改内容；已生成的页面图已作废，重新确认后需重新生成并重新计费',
        },
        status: 200,
      };
    }

    case 'style': {
      const deck = getOwnedDeck(userId, deckId);
      if (deck.status === 'generating') {
        throw new ApiError('GENERATION_RUNNING', '生成进行中，暂不能切换风格', 409, true);
      }
      const stylePackId = cleanString(body.stylePackId, 80);
      const pack = resolveStylePack(stylePackId);
      if (!pack) throw validationError('风格包不存在');
      // 门控测试包硬门：不可见用户按 404 处理
      assertStylePackUsable(stylePackId, findUserById(userId));
      const hadGenerated = ['generated', 'partial'].includes(deck.status);
      touchDeck(deck.id, { stylePackId });
      return {
        state: getDeckState(userId, deck.id),
        extra: hadGenerated
          ? { note: '风格已切换；已有页面图仍是旧风格，如需全套新风格请用 generate {forceRegenerate:true}' }
          : {},
        status: 200,
      };
    }

    case 'set-reference': {
      // 设为参考图：不生图不扣费，把某页已生成图记为全套风格锚点；slideId 为空即取消
      const deck = getOwnedDeck(userId, deckId);
      const slideId = cleanString(body.slideId, 80);
      if (!slideId) {
        setDeckAnchor(deck.id, '', '');
        return { state: getDeckState(userId, deck.id), extra: { anchorCleared: true }, status: 200 };
      }
      const slide = getSlide(deck.id, slideId);
      const version = slide.activeVersionId
        ? getGenDb()
            .prepare("SELECT image_path, status FROM slide_versions WHERE id = ?")
            .get(slide.activeVersionId) as { image_path?: string; status?: string } | undefined
        : undefined;
      const imagePath = String(version?.image_path || '');
      if (slide.genStatus !== 'succeeded' || version?.status !== 'succeeded' || !imagePath) {
        throw new ApiError('REFINE_NEEDS_IMAGE', '该页还没有生成图，无法设为参考图', 409, false);
      }
      setDeckAnchor(deck.id, slide.slideId, imagePath);
      return { state: getDeckState(userId, deck.id), extra: { anchorSlideId: slide.slideId }, status: 200 };
    }

    case 'generate':
    case 'retry-failed':
    case 'generate-slide':
    case 'refine-slide':
    case 'erase-slide':
    case 'text-edit-slide':
    case 'fuse-slide': {
      const deck = getOwnedDeck(userId, deckId);
      let options: Parameters<typeof startDeckGeneration>[2] = {};
      if (action === 'generate') {
        options = { forceRegenerate: body.forceRegenerate === true, kind: 'deck-generate' };
      } else if (action === 'retry-failed') {
        const failedIds = listSlides(deck.id)
          .filter((slide) => slide.genStatus === 'failed')
          .map((slide) => slide.slideId);
        if (failedIds.length === 0) throw validationError('没有失败的页面');
        options = { slideIds: failedIds, kind: 'deck-generate' };
      } else if (action === 'generate-slide') {
        const slideId = cleanString(body.slideId, 80);
        if (!slideId) throw validationError('缺少 slideId');
        options = { slideIds: [slideId], kind: 'deck-slide' };
      } else {
        // 改图类动作共用前置：必须有已生成图；均按 deck-refine 计 deck_page_refine
        const slideId = cleanString(body.slideId, 80);
        if (!slideId) throw validationError('缺少 slideId');
        const slide = getSlide(deck.id, slideId);
        if (slide.genStatus !== 'succeeded' || !slide.activeVersionId) {
          throw new ApiError('REFINE_NEEDS_IMAGE', '该页还没有生成图，无法改图', 409, false);
        }
        if (action === 'refine-slide') {
          const editInstruction = cleanString(body.editInstruction, 1000);
          if (!editInstruction) throw validationError('缺少 editInstruction');
          options = { slideIds: [slideId], kind: 'deck-refine', refineInstruction: editInstruction };
        } else if (action === 'erase-slide') {
          const markImage = dataUrlToBuffer(body.markImageDataUrl, '涂抹标记图', 2 * 1024 * 1024);
          options = {
            slideIds: [slideId],
            kind: 'deck-refine',
            refineInstruction: ERASE_INSTRUCTION,
            refineExtraImages: [markImage],
            refineExtraNote: ERASE_DEGRADE_NOTE,
          };
        } else if (action === 'text-edit-slide') {
          const editInstruction = cleanString(body.editInstruction, 1000);
          if (!editInstruction) throw validationError('缺少 editInstruction');
          options = {
            slideIds: [slideId],
            kind: 'deck-refine',
            refineInstruction: `图上改字：${editInstruction}。只改指定文字，其余元素、版式、配色全部保持不变。`,
          };
        } else {
          // fuse-slide：取融合包同页型样张作第二参考图，无同页型时按 mapping 兜底链（末位首页）
          const fusionPackId = cleanString(body.fusionPackId, 120);
          if (!fusionPackId) throw validationError('缺少 fusionPackId');
          const fusionPack = getTemplate(fusionPackId);
          if (!fusionPack || resolveTemplateKind(fusionPack) !== 'template') {
            throw validationError('融合模板不存在');
          }
          assertStylePackUsable(fusionPack.id, findUserById(userId));
          const fusionPages = getTemplatePages(fusionPack);
          const samplePath =
            resolveTemplateReferenceImage(fusionPages, buildOutlinePageMapping([slide], fusionPages), slide.pageIndex)
            || fusionPages[0]?.imageUrl
            || '';
          const sampleDataUrl = loadStyleReferenceDataUrl(resolveStylePack(fusionPack.id), samplePath);
          if (!sampleDataUrl) throw validationError('融合模板没有可用样张');
          const extra = cleanString(body.editInstruction, 1000);
          options = {
            slideIds: [slideId],
            kind: 'deck-refine',
            refineInstruction: `把第一张图的版式骨架保留，视觉风格向第二张参考图靠拢融合，文字内容保持不变。${extra ? `补充要求：${extra}` : ''}`,
            refineExtraImages: [dataUrlToBuffer(sampleDataUrl, '融合样张', 8 * 1024 * 1024)],
            refineExtraNote: `（本次未附带融合参考图：请把本页视觉风格向「${cleanString(fusionPack.name, 40)}」靠拢——${
              fusionPack.visualKeywords.slice(0, 8).join('、') || '同色系商务模板'
            }——版式骨架与文字内容保持不变。）`,
          };
        }
      }
      const job = await startDeckGeneration(userId, deck.id, options, deps);
      // 路由默认后台执行；测试里 await result.job.done
      void job.done;
      return {
        state: getDeckState(userId, deck.id),
        extra: { job: { jobId: job.jobId, status: job.status, total: job.total } },
        status: 202,
        job,
      };
    }

    default:
      throw validationError(`未知 action：${action}`);
  }
}

/**
 * 意图通道：typed intent 经 toDeckActionCall 还原成动作名与参数后，走同一条 dispatchDeckAction。
 * 开关硬门、冻结校验、扣费与幂等全在原路，这里只翻译信封。
 */
export async function dispatchDeckIntent(
  userId: string,
  deckId: string,
  intent: DeckIntent,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  const call = toDeckActionCall(intent);
  // action 后置：params 无法覆盖目标动作名
  return dispatchDeckAction(userId, deckId, { ...call.params, action: call.action }, deps);
}

/** action RPC 统一入口：body 带 intent 走意图通道，否则沿用旧的无类型入口 */
export async function dispatchDeckRequest(
  userId: string,
  deckId: string,
  body: Record<string, unknown>,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  if (body.intent === undefined) return dispatchDeckAction(userId, deckId, body, deps);
  const intent = parseDeckIntent(body.intent);
  if (!intent) throw validationError('未知意图');
  return dispatchDeckIntent(userId, deckId, intent, deps);
}
