// 逐页生图管线：估价 → 整单余额校验（不足 402）→ 建持久化 job → 按配置逐页并发
// debit（幂等键 deck-generate:{deckId}:{jobId}:{slideId}）→ 成功落盘 / 失败 refund。
import { ApiError } from '../http';
import { logProblem } from '../problem-log';
import { chargeRefundKeys, debitCredits, estimateCredits, getBalance, refundCredits } from '../credits';
import { getGenerationConfig } from './config';
import { getGenDb } from './db';
import {
  createJob,
  createSlideVersion,
  getOwnedDeck,
  getSlide,
  listSlides,
  touchDeck,
  updateJob,
  updateSlideGen,
  updateSlideVersion,
  type DeckRow,
  type DeckSlideRow,
} from './decks';
import { editImage, generateImage, toPublicImageError, type ImageDeps } from './images';
import { readSiteFile, saveFile } from './storage';
import {
  buildSlideImagePrompt,
  loadStyleReferenceDataUrl,
  resolveStylePack,
  selectStyleReferencePath,
  type DeckContext,
  type SlidePromptInput,
} from './style-packs';
import { markJobActive, markJobDone } from './recovery';
import { deckGateFacts, generationPrecondition } from '../../deck-gates';
import { ensureDeckBlueprint } from './blueprint';
import { buildOutlinePageMapping, resolveTemplateReferenceImage, type TemplateRouteContext } from './mapping';
import { getTemplate, getTemplatePages, resolveTemplateKind } from '../templates';
import { extractCopyFromDsl } from './dsl';
import { cleanString, type JobKind } from './types';

export type GenerateDeps = ImageDeps;

export interface StartedJob {
  jobId: string;
  status: 'queued' | 'running';
  total: number;
  /** 测试用：等待整批结束。路由默认后台执行（void）。 */
  done: Promise<void>;
}

function promptForSlide(
  slide: DeckSlideRow,
  stylePackId: string,
  refineInstruction?: string,
  deckContext?: DeckContext,
  template?: TemplateRouteContext | null,
  anchorImagePath?: string,
): { prompt: string; referencePath: string | null; anchorReference: boolean } {
  const pack = resolveStylePack(stylePackId);
  const copy = extractCopyFromDsl(slide.structuredContent);
  const copyLines = copy.lines.length > 0 ? copy.lines : slide.summary;
  const slideInput: SlidePromptInput = {
    role: slide.role,
    pageType: slide.pageType,
    title: copy.title || slide.title,
    goal: slide.goal,
    copyLines,
    visualNote: slide.visualNote,
  };
  const resolvedDeckContext = deckContext ?? {
    totalPages: 1,
    pageIndex: slide.pageIndex,
    chapter: slide.chapter,
  };
  // 双路线分流：真模板按 outline_page_mapping 取对应模板页参考图（版式高保真灌内容）；
  // 风格包走 design-dna 参考样张（只借风格）。模板未命中页回退风格参考。
  // 用户显式「设为参考图」的风格锚点优先于两条路线。
  let referencePath: string | null = anchorImagePath || null;
  let referenceMode: 'style' | 'template' = 'style';
  if (!referencePath && template && template.mapping.length > 0) {
    referencePath = resolveTemplateReferenceImage(template.pages, template.mapping, slide.pageIndex);
    if (referencePath) referenceMode = 'template';
  }
  if (!referencePath) {
    referencePath = selectStyleReferencePath(slideInput, pack, resolvedDeckContext);
  }
  const anchorReference = Boolean(anchorImagePath) && referencePath === anchorImagePath;
  const prompt = buildSlideImagePrompt(slideInput, pack, {
    withStyleReferenceHint: Boolean(referencePath),
    deckContext: resolvedDeckContext,
    referenceMode,
  });
  if (!refineInstruction) return { prompt, referencePath, anchorReference };
  return {
    prompt: `${prompt}

改图要求（在保持整体风格与版式的前提下执行）：${cleanString(refineInstruction, 1000)}`,
    referencePath,
    anchorReference,
  };
}

async function runSlideGeneration(
  deck: DeckRow,
  slide: DeckSlideRow,
  jobId: string,
  kind: JobKind,
  opts: {
    refineInstruction?: string;
    refineExtraImages?: Buffer[];
    refineExtraNote?: string;
    deckContext?: DeckContext;
    template?: TemplateRouteContext | null;
  },
  deps: GenerateDeps,
): Promise<'succeeded' | 'failed'> {
  const config = deps.config ?? getGenerationConfig();
  const unitPrice = estimateCredits({
    action: kind === 'deck-refine' ? 'deck_page_refine' : 'deck_page_generate',
    pages: 1,
  }).unitPrice;
  // 幂等键含 jobId（契约口径 deck-generate:{deckId}:{jobId}，逐页追加 slideId 保证唯一）
  const { chargeKey, refundKey } = chargeRefundKeys(`deck-generate:${deck.id}:${jobId}:${slide.slideId}`);
  const { prompt, referencePath, anchorReference } = promptForSlide(
    slide,
    deck.stylePackId,
    opts.refineInstruction,
    opts.deckContext,
    opts.template,
    deck.anchorImagePath || undefined,
  );
  const version = createSlideVersion(slide, {
    kind: kind === 'deck-refine' ? 'refine' : 'generate',
    prompt,
    jobId,
  });

  try {
    debitCredits(deck.userId, unitPrice, {
      reason: `生成第 ${slide.pageIndex + 1} 页`,
      idempotencyKey: chargeKey,
      refType: 'deck',
      refId: deck.id,
    });
  } catch (error) {
    const insufficient = error instanceof ApiError && error.code === 'INSUFFICIENT_CREDITS';
    updateSlideVersion(version.versionId, {
      status: 'failed',
      error: insufficient ? 'INSUFFICIENT_CREDITS: 🌟 星星不足' : '扣费失败',
    });
    updateSlideGen(deck.id, slide.slideId, {
      genStatus: 'failed',
      genError: insufficient ? 'INSUFFICIENT_CREDITS: 🌟 星星不足，请充值后重试本页' : '扣费失败，请重试',
    });
    return 'failed';
  }

  updateSlideGen(deck.id, slide.slideId, { genStatus: 'running', genError: '' });
  updateSlideVersion(version.versionId, { status: 'running' });
  try {
    let image: Buffer;
    if (kind === 'deck-refine') {
      const current = slide.activeVersionId
        ? getGenDb().prepare('SELECT image_path FROM slide_versions WHERE id = ?').get(slide.activeVersionId)
        : null;
      const source = current ? await readSiteFile(String(current.image_path || ''), config) : null;
      if (!source) throw new Error('原图不存在，无法改图');
      // erase/fuse 自带第二图（标记图/融合样张）；指令微调与图上改字则附风格锚点作第二参考图
      let extraImages = opts.refineExtraImages;
      let instruction = opts.refineInstruction || '';
      if (!extraImages && deck.anchorImagePath) {
        const anchor = await readSiteFile(deck.anchorImagePath, config);
        if (anchor) {
          extraImages = [anchor];
          instruction = `${instruction}\n\n第二张图是全套风格锚点参考：仅对齐其配色、版式与装饰语言，不得复制其文字内容。`;
        }
      }
      image = await editImage(
        {
          image: source,
          instruction,
          extraImages,
          extraImageNote: opts.refineExtraNote,
          userKey: deck.userId,
        },
        deps,
      );
    } else {
      const pack = resolveStylePack(deck.stylePackId);
      let referenceImages: string[] = [];
      if (referencePath) {
        if (anchorReference) {
          // 锚点存站点存储（非 public 样张），读取失败降级为无参考，不阻塞生成
          const anchor = await readSiteFile(referencePath, config);
          if (anchor) referenceImages = [`data:image/png;base64,${anchor.toString('base64')}`];
        } else {
          referenceImages = [loadStyleReferenceDataUrl(pack, referencePath)].filter((item): item is string => Boolean(item));
        }
      }
      image = await generateImage({ prompt, referenceImages, userKey: deck.userId }, deps);
    }
    const saved = await saveFile(
      'generated',
      deck.userId,
      image,
      { kind: deck.id, ext: '.png', id: version.versionId },
      config,
    );
    updateSlideVersion(version.versionId, { status: 'succeeded', imagePath: saved.relPath, imageUrl: saved.url });
    updateSlideGen(deck.id, slide.slideId, {
      genStatus: 'succeeded',
      genError: '',
      activeVersionId: version.versionId,
    });
    return 'succeeded';
  } catch (error) {
    const publicError = toPublicImageError(error);
    updateSlideVersion(version.versionId, {
      status: 'failed',
      error: `${publicError.code}: ${publicError.message}`,
    });
    updateSlideGen(deck.id, slide.slideId, {
      genStatus: 'failed',
      genError: `${publicError.code}: ${publicError.message}`,
    });
    // 失败自动退还（幂等：refund 键唯一，重复执行不重复返还）
    try {
      refundCredits(deck.userId, unitPrice, {
        reason: `第 ${slide.pageIndex + 1} 页生成失败退回`,
        idempotencyKey: refundKey,
        refType: 'deck',
        refId: deck.id,
      });
    } catch (refundError) {
      logProblem({
        category: 'generation',
        level: 'error',
        message: `第 ${slide.pageIndex + 1} 页生成失败退款失败`,
        detail: refundError,
        userId: deck.userId,
        refType: 'deck',
        refId: deck.id,
      });
    }
    return 'failed';
  }
}

export interface StartGenerationOptions {
  /** 指定页（generate-slide / refine-slide / retry-failed）；空 = 按 forceRegenerate 决定范围 */
  slideIds?: string[];
  forceRegenerate?: boolean;
  refineInstruction?: string;
  /** 改图类 action 的附加图（erase 标记图 / fuse 融合样张），逐页复用 */
  refineExtraImages?: Buffer[];
  /** 灾备丢图时的第二图文字描述（见 images.ts extraImageNote） */
  refineExtraNote?: string;
  kind?: JobKind;
}

export async function startDeckGeneration(
  userId: string,
  deckId: string,
  options: StartGenerationOptions = {},
  deps: GenerateDeps = {},
): Promise<StartedJob> {
  const config = deps.config ?? getGenerationConfig();
  const runDeps: GenerateDeps = { ...deps, config };
  const deck = getOwnedDeck(userId, deckId);
  const allSlides = listSlides(deck.id);
  // 生成前置与 deck 动作前置同一份规则（deck-gates）：措辞与顺序不分叉
  const denial = generationPrecondition(
    deckGateFacts({ status: deck.status, stylePackId: deck.stylePackId, slides: () => allSlides }),
  );
  if (denial) throw new ApiError(denial.code, denial.message, denial.status, denial.retryable);
  if (allSlides.length === 0) throw new ApiError('NO_SLIDES', '大纲为空，请先生成大纲', 400, false);

  let targets: DeckSlideRow[];
  const kind: JobKind = options.kind || 'deck-generate';
  if (options.slideIds && options.slideIds.length > 0) {
    targets = options.slideIds.map((id) => getSlide(deck.id, id));
    for (const slide of targets) {
      if (slide.genStatus === 'running' || slide.genStatus === 'queued') {
        throw new ApiError('GENERATION_RUNNING', `第 ${slide.pageIndex + 1} 页正在生成中`, 409, true);
      }
      if (slide.structureStatus !== 'ok') {
        throw new ApiError('STRUCTURE_NOT_READY', `第 ${slide.pageIndex + 1} 页尚未完成内容梳理`, 409, false);
      }
    }
  } else if (options.forceRegenerate) {
    targets = allSlides;
  } else {
    targets = allSlides.filter((slide) => ['idle', 'failed', 'stale'].includes(slide.genStatus));
  }
  if (targets.length === 0) {
    throw new ApiError('NOTHING_TO_GENERATE', '所有页面都已生成完毕，无需重复生成；如需重做请在风格页使用「重新生成」', 400, false);
  }

  // 整单估价 + 余额校验：不足整单 402，不建 job 不扣费
  const estimate = estimateCredits({
    action: kind === 'deck-refine' ? 'deck_page_refine' : 'deck_page_generate',
    pages: targets.length,
  });
  const balance = getBalance(userId);
  if (balance < estimate.credits) {
    throw new ApiError(
      'INSUFFICIENT_CREDITS',
      `🌟 星星不足：本次需 ${estimate.credits}（${estimate.unitPrice}/页 × ${targets.length} 页），当前余额 ${balance}`,
      402,
      false,
    );
  }

  const job = createJob(userId, deck.id, kind, targets.length);
  for (const slide of targets) {
    updateSlideGen(deck.id, slide.slideId, { genStatus: 'queued', genError: '' });
  }
  touchDeck(deck.id, { status: 'generating', error: '' });
  updateJob(job.jobId, { status: 'running' });

  const done = (async () => {
    markJobActive(job.jobId);
    // 全局视觉规范：每套一次 LLM（平台吸收），缓存命中则零成本；失败降级为空串不阻塞生成
    const blueprint = await ensureDeckBlueprint(deck, allSlides, runDeps).catch((error: unknown) => {
      console.warn(
        '[anppt-v2][generation] 全局视觉规范生成失败，本次不带规范继续:',
        error instanceof Error ? error.message : error,
      );
      return '';
    });
    // 双路线分流：真模板（kind=template）先算 outline_page_mapping，整批复用
    const stylePackRecord = getTemplate(deck.stylePackId);
    const templatePages =
      stylePackRecord && resolveTemplateKind(stylePackRecord) === 'template'
        ? getTemplatePages(stylePackRecord)
        : [];
    const template: TemplateRouteContext | null =
      templatePages.length > 0
        ? { pages: templatePages, mapping: buildOutlinePageMapping(allSlides, templatePages) }
        : null;
    let succeeded = 0;
    let failed = 0;
    // 逐页并发，上限 config.generateConcurrency（默认 6）
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const slide = targets[cursor];
        cursor += 1;
        const result = await runSlideGeneration(deck, slide, job.jobId, kind, {
          refineInstruction: options.refineInstruction,
          refineExtraImages: options.refineExtraImages,
          refineExtraNote: options.refineExtraNote,
          template,
          deckContext: {
            totalPages: allSlides.length,
            pageIndex: slide.pageIndex,
            chapter: slide.chapter,
            deckTitle: deck.title,
            sourceContext: cleanString(deck.sourceText, 6_000),
            blueprint: blueprint || undefined,
          },
        }, runDeps);
        if (result === 'succeeded') succeeded += 1;
        else failed += 1;
        // 心跳：每页完成即刷新 job.updated_at，供崩溃恢复区分「在跑」与「已死」
        updateJob(job.jobId, {});
      }
    };
    const workers = Array.from({ length: Math.min(config.generateConcurrency, targets.length) }, () => worker());
    await Promise.all(workers);
    updateJob(job.jobId, {
      status: failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial',
      succeeded,
      failed,
      error: failed > 0 ? `${failed} 页生成失败，已自动退回积分，可点「重试失败页」` : '',
    });
    touchDeck(deck.id, {
      status: failed === 0 ? 'generated' : 'partial',
      error: '',
    });
  })().catch((error) => {
    // 管线级异常（非页面级）：job 置终态后走统一恢复——卡 queued/running 的页
    // 收敛为 failed、孤儿扣费补退款、deck 状态收敛（见 recovery.ts）
    logProblem({
      category: 'generation',
      level: 'error',
      message: '生成管线异常中断',
      detail: error,
      userId: deck.userId,
      refType: 'deck',
      refId: deck.id,
    });
    markJobDone(job.jobId);
    updateJob(job.jobId, { status: 'failed', error: '生成管线异常中断，请重试失败页' });
  }).finally(() => {
    markJobDone(job.jobId);
  });

  return { jobId: job.jobId, status: 'running', total: targets.length, done };
}
