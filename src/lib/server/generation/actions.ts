// POST /api/deck/[id] 的意图 RPC 调度：唯一入口只收 typed intent，非法动作在编译期就发不出来。
// 内容类意图在 confirmStructure 后一律拒绝，需 unlockStructure 解锁（作废已生成页）——
// 前置条件与拒绝理由在 src/lib/deck-gates.ts，同一份规则同时算出 state.availableIntents。
// 分派是 kind → 处理器注册表（映射类型强制穷尽）：漏注册一个 kind 即编译失败，见 docs/DEBUG-HANDBOOK.md §29。
import { ApiError, validationError } from '../http';
import type { EngineDeps } from '../engine';
import { generateOutline, splitSlide, structureSlides, structureOneSlide } from '../engine';
import type { OutlineSlide } from './types';
import { validateTaggedDsl } from './dsl';
import {
  buildDeckFacts,
  deleteSlide,
  getDeckState,
  getOwnedDeck,
  getSlide,
  insertSlide,
  latestJob,
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
  type DeckSlideRow,
} from './decks';
import { getGenDb } from './db';
import { startDeckGeneration, type GenerateDeps, type StartedJob } from './generate';
import { loadStyleReferenceDataUrl, resolveStylePack } from './style-packs';
import { buildOutlinePageMapping, resolveTemplateReferenceImage } from './mapping';
import { assertStylePackUsable, getTemplate, getTemplatePages, resolveTemplateKind } from '../templates';
import { assertFeatureVisible } from '../feature-flags';
import { findUserById } from '../auth';
import { hitRateLimit } from '../rate-limit';
import type {
  DeckIntent,
  DeckIntentExtra,
  DeckIntentKind,
} from '../../deck-intents';
import {
  deckGateDenial,
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

/** base64 dataURL → Buffer；标记图 ≤2MB（前端导出 1536x864 涂抹层），融合样张 ≤8MB（对齐样张读取上限）。
 *  请求里的 dataURL 形状已由意图解析器回答，这里只解码字节（并防住直调与服务端自读样张）。 */
function dataUrlToBuffer(value: string, label: string, maxBytes: number): Buffer {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match) throw validationError(`${label} 必须是图片 base64 dataURL`);
  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0) throw validationError(`${label} 内容为空`);
  if (buffer.length > maxBytes) throw validationError(`${label} 超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`);
  return buffer;
}

// facts 与 GET state 同源：都从 buildDeckFacts 构造，activeJob 不能只在展示面生效
function factsOf(deck: DeckRow, slides?: () => ReturnType<typeof listSlides>): DeckGateFacts {
  return buildDeckFacts(deck, latestJob(deck.id), slides);
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

/** 一次 dispatch 的上下文：20 个处理器只关心自己 kind 的参数，user/deck/依赖共用 */
interface DeckIntentContext {
  userId: string;
  deckId: string;
  deps: ActionDeps;
}

type DeckIntentHandler<K extends DeckIntentKind> = (
  ctx: DeckIntentContext,
  intent: Extract<DeckIntent, { kind: K }>,
) => Promise<ActionResult<K>>;

/** kind → 处理器：映射类型要求 20 个 kind 全登记（漏一个即编译失败），每项按 kind 收窄参数与 extra */
export type DeckIntentHandlerTable = { [K in DeckIntentKind]: DeckIntentHandler<K> };

/** 生成类意图的共同返回形状：7 个 kind 的 extra 都是 { job }，按 generateSlides 的钉型取一次 */
type GenerationReply = {
  state: ReturnType<typeof getDeckState>;
  extra: DeckIntentExtra['generateSlides'];
  status: number;
  job?: StartedJob;
};

/** structureSlides/structureSlide 的共同返回形状：两个 kind 的 extra 同形 */
type StructureReply = {
  state: ReturnType<typeof getDeckState>;
  extra: DeckIntentExtra['structureSlides'];
  status: number;
};

/** 生成类意图的共同出口：启动 job → 202 + job 摘要 */
async function startGeneration(
  ctx: DeckIntentContext,
  options: Parameters<typeof startDeckGeneration>[2],
): Promise<GenerationReply> {
  const { userId, deckId, deps } = ctx;
  const job = await startDeckGeneration(userId, deckId, options, deps);
  // 路由默认后台执行；测试里 await result.job.done
  void job.done;
  return {
    state: getDeckState(userId, deckId),
    extra: { job: { jobId: job.jobId, status: job.status, total: job.total } },
    status: 202,
    job,
  };
}

/** 改图类意图的共同前置：本页必须有已生成图（页级判断不进 deck-gates） */
function requireRefineSlide(ctx: DeckIntentContext, slideId: string): DeckSlideRow {
  const slide = getSlide(ctx.deckId, slideId);
  if (slide.genStatus !== 'succeeded' || !slide.activeVersionId) {
    throw new ApiError('REFINE_NEEDS_IMAGE', '该页还没有生成图，无法改图', 409, false);
  }
  return slide;
}

/** structureSlides/structureSlide 的共同收尾：两次请求只有目标页来源不同，落库与响应同形 */
async function applyStructure(
  ctx: DeckIntentContext,
  kind: 'structureSlides' | 'structureSlide',
  targets: ReturnType<typeof listSlides>,
): Promise<StructureReply> {
  const { userId, deckId, deps } = ctx;
  assertFreeLlmRate(userId);
  if (kind === 'structureSlide') {
    const structured = await structureOneSlide(toOutlineSlide(targets[0]), deps);
    updateSlideStructure(deckId, targets[0].slideId, structured);
  } else {
    const structured = await structureSlides(targets.map(toOutlineSlide), deps);
    const byIndex = new Map(structured.pages.map((page) => [page.pageIndex, page]));
    for (const slide of targets) {
      const page = byIndex.get(slide.pageIndex);
      if (page) updateSlideStructure(deckId, slide.slideId, page);
    }
  }
  touchDeck(deckId, { status: 'structured', error: '' });
  const failedSlides = listSlides(deckId)
    .filter((slide) => slide.structureStatus === 'failed')
    .map((slide) => slide.slideId);
  return { state: getDeckState(userId, deckId), extra: { failedSlides }, status: 200 };
}

/**
 * 意图处理器注册表：一个 kind 一个处理器，业务逻辑与 switch 版逐行等价。
 * 参数清洗已在路由解析器完成；计费/幂等/权限/开关等业务硬门仍留在处理器里。
 */
export const DECK_INTENT_HANDLERS: DeckIntentHandlerTable = {
  generateOutline: async ({ userId, deckId, deps }, intent) => {
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
  },

  addSlide: async ({ userId, deckId }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('addSlide', factsOf(deck));
    const atIndex = intent.params.atIndex ?? listSlides(deck.id).length;
    insertSlide(deck.id, atIndex, intent.params.slide);
    touchDeck(deck.id, { status: 'outlined' });
    return reply<'addSlide'>(getDeckState(userId, deck.id), {}, 200);
  },

  removeSlide: async ({ userId, deckId }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('removeSlide', factsOf(deck));
    const { slideId } = intent.params;
    if (listSlides(deck.id).length <= 1) throw validationError('至少保留一页');
    deleteSlide(deck.id, slideId);
    touchDeck(deck.id, { status: 'outlined' });
    return reply<'removeSlide'>(getDeckState(userId, deck.id), {}, 200);
  },

  reorderSlides: async ({ userId, deckId }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('reorderSlides', factsOf(deck));
    reorderSlides(deck.id, intent.params.order);
    return reply<'reorderSlides'>(getDeckState(userId, deck.id), {}, 200);
  },

  splitSlide: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('splitSlide', factsOf(deck));
    const slide = getSlide(deck.id, intent.params.slideId);
    const into = intent.params.into ?? 2;
    assertFreeLlmRate(userId);
    const split = await splitSlide(toOutlineSlide(slide), into, deps);
    replaceSlideWithMany(deck.id, slide.slideId, split.slides);
    touchDeck(deck.id, { status: 'outlined' });
    return reply<'splitSlide'>(
      getDeckState(userId, deck.id),
      { provider: split.provider, into: split.slides.length },
      200,
    );
  },

  updateSlide: async ({ userId, deckId }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('updateSlide', factsOf(deck));
    const params = intent.params;
    const { slideId, structuredContent } = params;
    // 形状与上限由解析器回答；DSL 语法与内容保真属于动作自己的业务校验
    if (structuredContent !== undefined) {
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
  },

  commitVersion: async ({ userId, deckId }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('commitVersion', factsOf(deck));
    const { slideId, versionId } = intent.params;
    setActiveVersion(deck.id, slideId, versionId);
    // 若此前有失败页，版本回退把它救活了：全部成功则整单转 generated
    const slides = listSlides(deck.id);
    if (deck.status === 'partial' && slides.every((slide) => slide.genStatus === 'succeeded')) {
      touchDeck(deck.id, { status: 'generated', error: '' });
    }
    return reply<'commitVersion'>(getDeckState(userId, deck.id), {}, 200);
  },

  structureSlides: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    const slides = listSlides(deck.id);
    assertDeckIntent('structureSlides', factsOf(deck, () => slides));
    const force = intent.params.force === true;
    const targets = slides.filter((slide) => force || slide.structureStatus !== 'ok');
    if (targets.length === 0) {
      return reply<'structureSlides'>(getDeckState(userId, deck.id), { reused: true }, 200);
    }
    return applyStructure({ userId, deckId: deck.id, deps }, 'structureSlides', targets);
  },

  structureSlide: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    const slides = listSlides(deck.id);
    assertDeckIntent('structureSlide', factsOf(deck, () => slides));
    return applyStructure({ userId, deckId: deck.id, deps }, 'structureSlide', [
      getSlide(deck.id, intent.params.slideId),
    ]);
  },

  confirmStructure: async ({ userId, deckId }) => {
    const deck = getOwnedDeck(userId, deckId);
    const slides = listSlides(deck.id);
    assertDeckIntent('confirmStructure', factsOf(deck, () => slides));
    touchDeck(deck.id, { status: 'confirmed', confirmedAt: Date.now(), error: '' });
    return reply<'confirmStructure'>(getDeckState(userId, deck.id), {}, 200);
  },

  unlockStructure: async ({ userId, deckId }) => {
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
  },

  setStyle: async ({ userId, deckId }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('setStyle', factsOf(deck));
    const { stylePackId } = intent.params;
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
  },

  setReferenceImage: async ({ userId, deckId }, intent) => {
    // 设为参考图：不生图不扣费，把某页已生成图记为全套风格锚点；slideId 为空即取消
    const deck = getOwnedDeck(userId, deckId);
    const slideId = intent.params.slideId ?? '';
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
  },

  generateSlides: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    assertDeckIntent('generateSlides', factsOf(deck));
    return startGeneration({ userId, deckId: deck.id, deps }, {
      forceRegenerate: intent.params.forceRegenerate === true,
      kind: 'deck-generate',
    });
  },

  retryFailedSlides: async ({ userId, deckId, deps }) => {
    const deck = getOwnedDeck(userId, deckId);
    const slides = listSlides(deck.id);
    assertDeckIntent('retryFailedSlides', factsOf(deck, () => slides));
    const failedIds = slides
      .filter((slide) => slide.genStatus === 'failed')
      .map((slide) => slide.slideId);
    return startGeneration({ userId, deckId: deck.id, deps }, { slideIds: failedIds, kind: 'deck-generate' });
  },

  generateSlide: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    return startGeneration({ userId, deckId: deck.id, deps }, {
      slideIds: [intent.params.slideId],
      kind: 'deck-slide',
    });
  },

  refineSlide: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    requireRefineSlide({ userId, deckId: deck.id, deps }, intent.params.slideId);
    return startGeneration({ userId, deckId: deck.id, deps }, {
      slideIds: [intent.params.slideId],
      kind: 'deck-refine',
      refine: { kind: 'instruction', instruction: intent.params.editInstruction },
    });
  },

  eraseSlide: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    requireRefineSlide({ userId, deckId: deck.id, deps }, intent.params.slideId);
    const markImage = dataUrlToBuffer(intent.params.markImageDataUrl, '涂抹标记图', 2 * 1024 * 1024);
    // 涂抹话术（指令 + 灾备丢图降级）归视觉计划，动作只传意图与标记图
    return startGeneration({ userId, deckId: deck.id, deps }, {
      slideIds: [intent.params.slideId],
      kind: 'deck-refine',
      refine: { kind: 'erase' },
      refineExtraImages: [markImage],
    });
  },

  editSlideText: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    requireRefineSlide({ userId, deckId: deck.id, deps }, intent.params.slideId);
    return startGeneration({ userId, deckId: deck.id, deps }, {
      slideIds: [intent.params.slideId],
      kind: 'deck-refine',
      refine: { kind: 'edit-text', instruction: intent.params.editInstruction },
    });
  },

  fuseSlide: async ({ userId, deckId, deps }, intent) => {
    const deck = getOwnedDeck(userId, deckId);
    const slide = requireRefineSlide({ userId, deckId: deck.id, deps }, intent.params.slideId);
    // 取融合包同页型样张作第二参考图，无同页型时按 mapping 兜底链（末位首页）
    const { fusionPackId } = intent.params;
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
    return startGeneration({ userId, deckId: deck.id, deps }, {
      slideIds: [slide.slideId],
      kind: 'deck-refine',
      refine: {
        kind: 'fuse',
        templateName: fusionPack.name,
        visualKeywords: fusionPack.visualKeywords,
        instruction: intent.params.editInstruction,
      },
      refineExtraImages: [dataUrlToBuffer(sampleDataUrl, '融合样张', 8 * 1024 * 1024)],
    });
  },
};

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
  // 图片级编辑工具的开关硬门放调度入口：off 时与未知意图一样摸不到
  const editToolFlag = EDIT_INTENT_FLAGS[intent.kind];
  if (editToolFlag) assertFeatureVisible(editToolFlag, findUserById(userId));
  // 注册表按 kind 索引得到的是联合调用面：这里是唯一一处抹平 kind 的断言（注册表已按 kind 钉住每项）
  const handler = DECK_INTENT_HANDLERS[intent.kind] as DeckIntentHandler<K>;
  return handler({ userId, deckId, deps }, intent);
}
