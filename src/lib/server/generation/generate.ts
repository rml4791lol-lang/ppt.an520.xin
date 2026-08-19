// 逐页生图管线：估价 → 整单余额校验（不足 402）→ 建持久化 job → 逐页并发（上限 3）
// debit（幂等键 deck-generate:{deckId}:{jobId}:{slideId}）→ 成功落盘 / 失败 refund。
import { ApiError } from '../http';
import { debitCredits, estimateCredits, getBalance, refundCredits } from '../credits';
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
import { buildSlideImagePrompt, loadStyleReferenceDataUrl, resolveStylePack, type DeckContext } from './style-packs';
import { extractCopyFromDsl } from './dsl';
import { cleanString, type JobKind } from './types';

export interface GenerateDeps extends ImageDeps {}

export interface StartedJob {
  jobId: string;
  status: 'queued' | 'running';
  total: number;
  /** 测试用：等待整批结束。路由默认后台执行（void）。 */
  done: Promise<void>;
}

function assertGeneratable(deck: DeckRow): void {
  if (deck.status === 'generating') {
    throw new ApiError('GENERATION_RUNNING', '生成正在进行中，请稍候', 409, true);
  }
  if (!['confirmed', 'generated', 'partial'].includes(deck.status)) {
    throw new ApiError('STRUCTURE_NOT_CONFIRMED', '请先完成内容梳理并确认结构', 409, false);
  }
  if (!deck.stylePackId) {
    throw new ApiError('STYLE_REQUIRED', '请先选择设计风格', 400, false);
  }
}

function promptForSlide(
  slide: DeckSlideRow,
  stylePackId: string,
  refineInstruction?: string,
  deckContext?: DeckContext,
): { prompt: string; withReference: boolean } {
  const pack = resolveStylePack(stylePackId);
  const copy = extractCopyFromDsl(slide.structuredContent);
  const copyLines = copy.lines.length > 0 ? copy.lines : slide.summary;
  const title = copy.title || slide.title;
  const withReference = slide.pageIndex === 0 || slide.role === 'cover';
  const prompt = buildSlideImagePrompt(
    {
      role: slide.role,
      pageType: slide.pageType,
      title,
      goal: slide.goal,
      copyLines,
      visualNote: slide.visualNote,
    },
    pack,
    {
      withStyleReferenceHint: withReference,
      deckContext: deckContext ?? {
        totalPages: 1,
        pageIndex: slide.pageIndex,
        chapter: slide.chapter,
      },
    },
  );
  if (!refineInstruction) return { prompt, withReference };
  return {
    prompt: `${prompt}\n\n改图要求（在保持整体风格与版式的前提下执行）：${cleanString(refineInstruction, 1000)}`,
    withReference,
  };
}

async function runSlideGeneration(
  deck: DeckRow,
  slide: DeckSlideRow,
  jobId: string,
  kind: JobKind,
  opts: { refineInstruction?: string; deckContext?: DeckContext },
  deps: GenerateDeps,
): Promise<'succeeded' | 'failed'> {
  const config = deps.config ?? getGenerationConfig();
  const unitPrice = estimateCredits({ action: 'deck_page_generate', pages: 1 }).unitPrice;
  // 幂等键含 jobId（契约口径 deck-generate:{deckId}:{jobId}，逐页追加 slideId 保证唯一）
  const chargeKey = `deck-generate:${deck.id}:${jobId}:${slide.slideId}`;
  const refundKey = `${chargeKey}:refund`;
  const { prompt, withReference } = promptForSlide(slide, deck.stylePackId, opts.refineInstruction, opts.deckContext);
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
      image = await editImage(
        { image: source, instruction: opts.refineInstruction || '' },
        deps,
      );
    } else {
      const pack = resolveStylePack(deck.stylePackId);
      const referenceImages = withReference
        ? [loadStyleReferenceDataUrl(pack)].filter((item): item is string => Boolean(item))
        : [];
      image = await generateImage({ prompt, referenceImages }, deps);
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
      console.error('[anppt-v2][generation] refund failed:', refundError);
    }
    return 'failed';
  }
}

export interface StartGenerationOptions {
  /** 指定页（generate-slide / refine-slide / retry-failed）；空 = 按 forceRegenerate 决定范围 */
  slideIds?: string[];
  forceRegenerate?: boolean;
  refineInstruction?: string;
  kind?: JobKind;
}

export async function startDeckGeneration(
  userId: string,
  deckId: string,
  options: StartGenerationOptions = {},
  deps: GenerateDeps = {},
): Promise<StartedJob> {
  const config = deps.config ?? getGenerationConfig();
  const deck = getOwnedDeck(userId, deckId);
  assertGeneratable(deck);
  const allSlides = listSlides(deck.id);
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
  const estimate = estimateCredits({ action: 'deck_page_generate', pages: targets.length });
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
    let succeeded = 0;
    let failed = 0;
    // 逐页并发，上限 config.generateConcurrency（默认 3）
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const slide = targets[cursor];
        cursor += 1;
        const result = await runSlideGeneration(deck, slide, job.jobId, kind, {
          refineInstruction: options.refineInstruction,
          deckContext: { totalPages: allSlides.length, pageIndex: slide.pageIndex, chapter: slide.chapter },
        }, deps);
        if (result === 'succeeded') succeeded += 1;
        else failed += 1;
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
    // 管线级异常（非页面级）：job 标记失败，页面保持 queued/running 由 retry-failed 恢复
    console.error('[anppt-v2][generation] pipeline crashed:', error);
    updateJob(job.jobId, { status: 'failed', error: '生成管线异常中断，请重试失败页' });
    touchDeck(deck.id, { status: 'partial' });
  });

  return { jobId: job.jobId, status: 'running', total: targets.length, done };
}
