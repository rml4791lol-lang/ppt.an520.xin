// POST /api/deck/[id] 的意图 RPC 调度：唯一入口只收 typed intent，非法动作在编译期就发不出来。
// 内容类意图在 confirmStructure 后一律拒绝，需 unlockStructure 解锁（作废已生成页）——
// 前置条件与拒绝理由在 src/lib/deck-gates.ts，同一份规则同时算出 state.availableIntents。
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
import {
  parseDeckIntent,
  type DeckIntent,
  type DeckIntentExtra,
  type DeckIntentKind,
} from '../../deck-intents';
import {
  deckGateDenial,
  deckGateFacts,
  isDeckContentLocked,
  type DeckGateFacts,
} from '../../deck-gates';

export interface ActionDeps extends EngineDeps, GenerateDeps {}

/** 响应 = 全量 deck 状态 + 该意图的 extra（按 kind 钉住字段，写错字段名编译期失败） */
export interface ActionResult<K extends DeckIntentKind = DeckIntentKind> {
  state: ReturnType<typeof getDeckState>;
  extra: DeckIntentExtra[K];
  status: number;
  /** 生成类意图的 job 句柄；路由只用 extra 里的摘要，测试可 await job.done */
  job?: StartedJob;
}

function reply<K extends DeckIntentKind>(
  state: ReturnType<typeof getDeckState>,
  extra: DeckIntentExtra[K],
  status: number,
  job?: StartedJob,
): ActionResult<K> {
  return { state, extra, status, job };
}

// 免费 LLM 动作（outline 重生成/structure/拆页）不扣星但烧上游 token：按用户限频，防零成本循环调用
function assertFreeLlmRate(userId: string): void {
  const rate = hitRateLimit(`llm-free:${userId}`, { windowMs: 10 * 60 * 1000, max: 30 });
  if (!rate.allowed) throw new ApiError('LLM_RATE_LIMITED', '操作过于频繁，请稍后再试', 429, true);
}

// 图片级编辑工具（开关板硬门；off 时按 404 处理，不暴露功能存在性）
const EDIT_INTENT_FLAGS: Partial<Record<DeckIntentKind, string>> = {
  eraseSlide: 'magic_erase',
  editSlideText: 'image_text_edit',
  fuseSlide: 'template_fusion',
  setReferenceImage: 'set_as_reference',
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

function factsOf(deck: DeckRow, slides?: () => ReturnType<typeof listSlides>): DeckGateFacts {
  return deckGateFacts({
    status: deck.status,
    stylePackId: deck.stylePackId,
    slides: slides ?? (() => listSlides(deck.id)),
  });
}

function assertDeckIntent(kind: DeckIntentKind, facts: DeckGateFacts): void {
  const denial = deckGateDenial(kind, facts);
  if (!denial) return;
  throw new ApiError(denial.code, denial.message, denial.status, denial.retryable);
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
 * 意图调度。返回 { state, extra, status }：
 * state 恒为最新全量状态（与 GET /api/deck/[id] 同形），前端可直接 setState。
 */
export async function dispatchDeckIntent<K extends DeckIntentKind>(
  userId: string,
  deckId: string,
  intent: Extract<DeckIntent, { kind: K }>,
  deps: ActionDeps = {},
): Promise<ActionResult<K>> {
  // 运行时分派按 kind 展开，具体 kind 在入口泛型里收窄；这里是唯一一处抹平 kind 的断言
  return dispatchByKind(userId, deckId, intent, deps) as Promise<ActionResult<K>>;
}

async function dispatchByKind(
  userId: string,
  deckId: string,
  intent: DeckIntent,
  deps: ActionDeps,
): Promise<ActionResult> {
  // 图片级编辑工具的开关硬门放调度入口：off 时与未知意图一样摸不到
  const editToolFlag = EDIT_INTENT_FLAGS[intent.kind];
  if (editToolFlag) assertFeatureVisible(editToolFlag, findUserById(userId));

  switch (intent.kind) {
    case 'generateOutline': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('generateOutline', factsOf(deck));
      const force = intent.params.force === true;
      if (listSlides(deck.id).length > 0 && !force) {
        return reply<'generateOutline'>(getDeckState(userId, deck.id), { reused: true }, 200);
      }
      assertFreeLlmRate(userId);
      const outline = await generateOutline(
        {
          sourceText: deck.sourceText,
          durationMinutes: deck.durationMinutes,
          targetPageCount: deck.targetPageCount,
          stylePackId: deck.stylePackId || undefined,
          force,
        },
        deps,
      );
      replaceSlides(deck.id, outline.slides);
      touchDeck(deck.id, { status: 'outlined', error: '' });
      return reply<'generateOutline'>(
        getDeckState(userId, deck.id),
        { reused: false, provider: outline.provider, pageCount: outline.slides.length },
        200,
      );
    }

    case 'addSlide': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('addSlide', factsOf(deck));
      const atIndex = Number.isInteger(Number(intent.params.atIndex))
        ? Number(intent.params.atIndex)
        : listSlides(deck.id).length;
      insertSlide(deck.id, atIndex, (intent.params.slide || {}) as Partial<OutlineSlide>);
      touchDeck(deck.id, { status: 'outlined' });
      return reply<'addSlide'>(getDeckState(userId, deck.id), {}, 200);
    }

    case 'removeSlide': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('removeSlide', factsOf(deck));
      const slideId = cleanString(intent.params.slideId, 80);
      if (!slideId) throw validationError('缺少 slideId');
      if (listSlides(deck.id).length <= 1) throw validationError('至少保留一页');
      deleteSlide(deck.id, slideId);
      touchDeck(deck.id, { status: 'outlined' });
      return reply<'removeSlide'>(getDeckState(userId, deck.id), {}, 200);
    }

    case 'reorderSlides': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('reorderSlides', factsOf(deck));
      reorderSlides(deck.id, cleanIdList(intent.params.order, 'order'));
      return reply<'reorderSlides'>(getDeckState(userId, deck.id), {}, 200);
    }

    case 'splitSlide': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('splitSlide', factsOf(deck));
      const slide = getSlide(deck.id, cleanString(intent.params.slideId, 80));
      const into = Math.min(5, Math.max(2, Math.floor(Number(intent.params.into)) || 2));
      assertFreeLlmRate(userId);
      const split = await splitSlide(toOutlineSlide(slide), into, deps);
      replaceSlideWithMany(deck.id, slide.slideId, split.slides);
      touchDeck(deck.id, { status: 'outlined' });
      return reply<'splitSlide'>(
        getDeckState(userId, deck.id),
        { provider: split.provider, into: split.slides.length },
        200,
      );
    }

    case 'updateSlide': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('updateSlide', factsOf(deck));
      const params = intent.params;
      const slideId = cleanString(params.slideId, 80);
      if (!slideId) throw validationError('缺少 slideId');
      const structuredContent = params.structuredContent === undefined
        ? undefined
        : cleanString(params.structuredContent, 12000);
      if (structuredContent !== undefined) {
        if (!structuredContent) throw validationError('梳理内容不能为空');
        const validation = validateTaggedDsl(structuredContent);
        if (!validation.ok) throw validationError(validation.errors[0] || '梳理内容格式不正确');
      }
      const { contentChanged } = updateSlideContent(deck.id, slideId, {
        role: params.role,
        chapter: params.chapter,
        pageType: params.pageType,
        title: params.title,
        goal: params.goal,
        rawText: params.rawText,
        summary: params.summary,
        visualNote: params.visualNote,
        structuredContent,
      });
      // 标题/原文变更后该页需重新梳理；deck 状态回退到 outlined（章节等弱变更不动状态）
      if (structuredContent !== undefined) {
        if (deck.status !== 'structured') touchDeck(deck.id, { status: 'structured', error: '' });
      } else if (contentChanged && deck.status !== 'outlined') {
        touchDeck(deck.id, { status: 'outlined' });
      }
      return reply<'updateSlide'>(getDeckState(userId, deck.id), { contentChanged }, 200);
    }

    case 'commitVersion': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('commitVersion', factsOf(deck));
      const slideId = cleanString(intent.params.slideId, 80);
      const versionId = cleanString(intent.params.versionId, 80);
      if (!slideId || !versionId) throw validationError('缺少 slideId 或 versionId');
      setActiveVersion(deck.id, slideId, versionId);
      // 若此前有失败页，版本回退把它救活了：全部成功则整单转 generated
      const slides = listSlides(deck.id);
      if (deck.status === 'partial' && slides.every((slide) => slide.genStatus === 'succeeded')) {
        touchDeck(deck.id, { status: 'generated', error: '' });
      }
      return reply<'commitVersion'>(getDeckState(userId, deck.id), {}, 200);
    }

    case 'structureSlides':
    case 'structureSlide': {
      const deck = getOwnedDeck(userId, deckId);
      const slides = listSlides(deck.id);
      assertDeckIntent(intent.kind, factsOf(deck, () => slides));
      let targets: ReturnType<typeof listSlides>;
      if (intent.kind === 'structureSlide') {
        targets = [getSlide(deck.id, cleanString(intent.params.slideId, 80))];
      } else {
        const force = intent.params.force === true;
        targets = slides.filter((slide) => force || slide.structureStatus !== 'ok');
      }
      if (targets.length === 0) {
        return reply<'structureSlides'>(getDeckState(userId, deck.id), { reused: true }, 200);
      }
      assertFreeLlmRate(userId);
      if (intent.kind === 'structureSlide') {
        const structured = await structureOneSlide(toOutlineSlide(targets[0]), deps);
        updateSlideStructure(deck.id, targets[0].slideId, structured);
      } else {
        const structured = await structureSlides(targets.map(toOutlineSlide), deps);
        const byIndex = new Map(structured.pages.map((page) => [page.pageIndex, page]));
        for (const slide of targets) {
          const page = byIndex.get(slide.pageIndex);
          if (page) updateSlideStructure(deck.id, slide.slideId, page);
        }
      }
      touchDeck(deck.id, { status: 'structured', error: '' });
      const failedSlides = listSlides(deck.id)
        .filter((slide) => slide.structureStatus === 'failed')
        .map((slide) => slide.slideId);
      return reply<'structureSlides'>(getDeckState(userId, deck.id), { failedSlides }, 200);
    }

    case 'confirmStructure': {
      const deck = getOwnedDeck(userId, deckId);
      const slides = listSlides(deck.id);
      assertDeckIntent('confirmStructure', factsOf(deck, () => slides));
      touchDeck(deck.id, { status: 'confirmed', confirmedAt: Date.now(), error: '' });
      return reply<'confirmStructure'>(getDeckState(userId, deck.id), {}, 200);
    }

    case 'unlockStructure': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('unlockStructure', factsOf(deck));
      if (!isDeckContentLocked(deck.status)) {
        return reply<'unlockStructure'>(getDeckState(userId, deck.id), { alreadyUnlocked: true }, 200);
      }
      const invalidated = markSlidesGenStale(deck.id);
      touchDeck(deck.id, { status: 'structured', confirmedAt: null, error: '' });
      return reply<'unlockStructure'>(
        getDeckState(userId, deck.id),
        {
          invalidated,
          warning: '已解锁，可修改内容；已生成的页面图已作废，重新确认后需重新生成并重新计费',
        },
        200,
      );
    }

    case 'setStyle': {
      const deck = getOwnedDeck(userId, deckId);
      assertDeckIntent('setStyle', factsOf(deck));
      const stylePackId = cleanString(intent.params.stylePackId, 80);
      const pack = resolveStylePack(stylePackId);
      if (!pack) throw validationError('风格包不存在');
      // 门控测试包硬门：不可见用户按 404 处理
      assertStylePackUsable(stylePackId, findUserById(userId));
      const hadGenerated = ['generated', 'partial'].includes(deck.status);
      touchDeck(deck.id, { stylePackId });
      return reply<'setStyle'>(
        getDeckState(userId, deck.id),
        hadGenerated
          ? { note: '风格已切换；已有页面图仍是旧风格，如需全套新风格请在风格页重新生成' }
          : {},
        200,
      );
    }

    case 'setReferenceImage': {
      // 设为参考图：不生图不扣费，把某页已生成图记为全套风格锚点；slideId 为空即取消
      const deck = getOwnedDeck(userId, deckId);
      const slideId = cleanString(intent.params.slideId, 80);
      if (!slideId) {
        setDeckAnchor(deck.id, '', '');
        return reply<'setReferenceImage'>(getDeckState(userId, deck.id), { anchorCleared: true }, 200);
      }
      const slide = getSlide(deck.id, slideId);
      const version = slide.activeVersionId
        ? getGenDb()
            .prepare('SELECT image_path, status FROM slide_versions WHERE id = ?')
            .get(slide.activeVersionId) as { image_path?: string; status?: string } | undefined
        : undefined;
      const imagePath = String(version?.image_path || '');
      if (slide.genStatus !== 'succeeded' || version?.status !== 'succeeded' || !imagePath) {
        throw new ApiError('REFINE_NEEDS_IMAGE', '该页还没有生成图，无法设为参考图', 409, false);
      }
      setDeckAnchor(deck.id, slide.slideId, imagePath);
      return reply<'setReferenceImage'>(
        getDeckState(userId, deck.id),
        { anchorSlideId: slide.slideId },
        200,
      );
    }

    case 'generateSlides':
    case 'retryFailedSlides':
    case 'generateSlide':
    case 'refineSlide':
    case 'eraseSlide':
    case 'editSlideText':
    case 'fuseSlide': {
      const deck = getOwnedDeck(userId, deckId);
      let options: Parameters<typeof startDeckGeneration>[2] = {};
      if (intent.kind === 'generateSlides') {
        assertDeckIntent('generateSlides', factsOf(deck));
        options = { forceRegenerate: intent.params.forceRegenerate === true, kind: 'deck-generate' };
      } else if (intent.kind === 'retryFailedSlides') {
        const slides = listSlides(deck.id);
        assertDeckIntent('retryFailedSlides', factsOf(deck, () => slides));
        const failedIds = slides
          .filter((slide) => slide.genStatus === 'failed')
          .map((slide) => slide.slideId);
        options = { slideIds: failedIds, kind: 'deck-generate' };
      } else if (intent.kind === 'generateSlide') {
        const slideId = cleanString(intent.params.slideId, 80);
        if (!slideId) throw validationError('缺少 slideId');
        options = { slideIds: [slideId], kind: 'deck-slide' };
      } else {
        // 改图类动作共用前置：必须有已生成图；均按 deck-refine 计 deck_page_refine
        const slideId = cleanString(intent.params.slideId, 80);
        if (!slideId) throw validationError('缺少 slideId');
        const slide = getSlide(deck.id, slideId);
        if (slide.genStatus !== 'succeeded' || !slide.activeVersionId) {
          throw new ApiError('REFINE_NEEDS_IMAGE', '该页还没有生成图，无法改图', 409, false);
        }
        if (intent.kind === 'refineSlide') {
          const editInstruction = cleanString(intent.params.editInstruction, 1000);
          if (!editInstruction) throw validationError('缺少 editInstruction');
          options = { slideIds: [slideId], kind: 'deck-refine', refineInstruction: editInstruction };
        } else if (intent.kind === 'eraseSlide') {
          const markImage = dataUrlToBuffer(intent.params.markImageDataUrl, '涂抹标记图', 2 * 1024 * 1024);
          options = {
            slideIds: [slideId],
            kind: 'deck-refine',
            refineInstruction: ERASE_INSTRUCTION,
            refineExtraImages: [markImage],
            refineExtraNote: ERASE_DEGRADE_NOTE,
          };
        } else if (intent.kind === 'editSlideText') {
          const editInstruction = cleanString(intent.params.editInstruction, 1000);
          if (!editInstruction) throw validationError('缺少 editInstruction');
          options = {
            slideIds: [slideId],
            kind: 'deck-refine',
            refineInstruction: `图上改字：${editInstruction}。只改指定文字，其余元素、版式、配色全部保持不变。`,
          };
        } else {
          // fuseSlide：取融合包同页型样张作第二参考图，无同页型时按 mapping 兜底链（末位首页）
          const fusionPackId = cleanString(intent.params.fusionPackId, 120);
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
          const extra = cleanString(intent.params.editInstruction, 1000);
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
      return reply<'generateSlides'>(
        getDeckState(userId, deck.id),
        { job: { jobId: job.jobId, status: job.status, total: job.total } },
        202,
        job,
      );
    }
  }
}

/**
 * 路由边界：只接受 {intent:{kind,params}}。
 * 旧 {action,...params} 信封已删除——action 名不再是线上词汇（见 docs/DEBUG-HANDBOOK.md §29）。
 */
export function readDeckIntent(body: unknown): DeckIntent {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('intent' in body)) {
    throw validationError('缺少意图');
  }
  const intent = parseDeckIntent((body as { intent: unknown }).intent);
  if (!intent) throw validationError('未知意图');
  return intent;
}
