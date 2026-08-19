// POST /api/deck/[id] 的 action RPC 调度。
// 内容类 action（outline/增删重排/拆页/structure）在 confirm-structure 后一律拒绝，
// 需 unlock-structure 解锁（作废已生成页）。
import { ApiError, validationError } from '../http';
import type { EngineDeps } from '../engine';
import { generateOutline, splitSlide, structureSlides, structureOneSlide } from '../engine';
import { cleanString, type OutlineSlide } from './types';
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
  touchDeck,
  updateSlideStructure,
  type DeckRow,
} from './decks';
import { startDeckGeneration, type GenerateDeps, type StartedJob } from './generate';
import { resolveStylePack } from './style-packs';

export interface ActionDeps extends EngineDeps, GenerateDeps {}

export interface ActionResult {
  state: ReturnType<typeof getDeckState>;
  extra: Record<string, unknown>;
  status: number;
  /** 生成类 action 的 job 句柄；路由只用 extra 里的摘要，测试可 await job.done */
  job?: StartedJob;
}

const CONTENT_LOCKED_MESSAGE =
  '内容已冻结：请先执行 unlock-structure 解锁（解锁将作废已生成的页面图）';

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

  switch (action) {
    case 'outline': {
      const deck = getOwnedDeck(userId, deckId);
      assertContentEditable(deck);
      const force = body.force === true;
      if (listSlides(deck.id).length > 0 && !force) {
        return { state: getDeckState(userId, deck.id), extra: { reused: true }, status: 200 };
      }
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
      const result = await splitSlide(toOutlineSlide(slide), into, deps);
      replaceSlideWithMany(deck.id, slide.slideId, result.slides);
      touchDeck(deck.id, { status: 'outlined' });
      return {
        state: getDeckState(userId, deck.id),
        extra: { provider: result.provider, into: result.slides.length },
        status: 200,
      };
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

    case 'generate':
    case 'retry-failed':
    case 'generate-slide':
    case 'refine-slide': {
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
        const slideId = cleanString(body.slideId, 80);
        const editInstruction = cleanString(body.editInstruction, 1000);
        if (!slideId || !editInstruction) throw validationError('缺少 slideId 或 editInstruction');
        const slide = getSlide(deck.id, slideId);
        if (slide.genStatus !== 'succeeded' || !slide.activeVersionId) {
          throw new ApiError('REFINE_NEEDS_IMAGE', '该页还没有生成图，无法改图', 409, false);
        }
        options = { slideIds: [slideId], kind: 'deck-refine', refineInstruction: editInstruction };
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
