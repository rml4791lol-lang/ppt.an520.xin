// 逐页生图管线：估价 → 整单余额校验（不足 402）→ 建持久化 job → 按配置逐页并发。
// 每页的扣费/退款/终态顺序归 paid-run.ts；键形归 charge-keys.ts。
import { ApiError } from '../http';
import { logProblem } from '../problem-log';
import { estimateCredits, getBalance } from '../credits';
import { getGenerationConfig, type GenerationConfig } from './config';
import { deckChargeKey } from './charge-keys';
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
  type SlideVersionRow,
} from './decks';
import { editImage, generateImage, toPublicImageError, type ImageDeps } from './images';
import { readSiteFile, saveFile } from './storage';
import {
  loadStyleReferenceDataUrl,
  resolveStylePack,
  type DeckContext,
  type ResolvedStylePack,
} from './style-packs';
import { beginPaidRun, withInFlightRun, type PaidRunStore } from './paid-run';
import { deckGateFacts, generationPrecondition } from '../../deck-gates';
import { buildOutlinePageMapping, type TemplateRouteContext } from './mapping';
import {
  buildVisualPlan,
  ensureVisualPlanBlueprint,
  resolveVisualPlanPageTypes,
  type VisualPlanReference,
} from './visual-plan';
import { getTemplate, getTemplatePages, resolveTemplateKind } from '../templates';
import { cleanString, type JobKind } from './types';
import type { PageTypeSpec } from './page-types';

export type GenerateDeps = ImageDeps;

export interface StartedJob {
  jobId: string;
  status: 'queued' | 'running';
  total: number;
  /** 测试用：等待整批结束。路由默认后台执行（void）。 */
  done: Promise<void>;
}

async function loadPlannedReference(
  reference: VisualPlanReference,
  pack: ResolvedStylePack | null,
  config: GenerationConfig,
): Promise<string | null> {
  if (reference.source === 'anchor') {
    // 锚点存站点存储（非 public 样张）；读失败返回 null，调用方顺延到下一候选
    const anchor = await readSiteFile(reference.path, config);
    return anchor ? `data:image/png;base64,${anchor.toString('base64')}` : null;
  }
  return loadStyleReferenceDataUrl(pack, reference.path);
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
    /** 整套路径已解析页型（映射与提示词读同一键）；单页路径缺省。 */
    pageType?: PageTypeSpec;
    /** 任务启动时估价的单价快照：逐页扣费与退款都按它，不重新读价 */
    unitPrice: number;
  },
  deps: GenerateDeps,
): Promise<'succeeded' | 'failed'> {
  const config = deps.config ?? getGenerationConfig();
  const { unitPrice } = opts;
  // 扣费键形状归 charge-keys（前缀是历史账本契约）；claim/扣费/退款/终态顺序归 paid-run
  const chargeKey = deckChargeKey({ deckId: deck.id, jobId, slideId: slide.slideId });
  const pack = resolveStylePack(deck.stylePackId);
  const plan = buildVisualPlan({
    slide,
    deckContext: opts.deckContext ?? {
      totalPages: 1,
      pageIndex: slide.pageIndex,
      chapter: slide.chapter,
    },
    stylePack: pack,
    template: opts.template,
    anchorImagePath: deck.anchorImagePath || undefined,
    mode: kind === 'deck-refine' ? 'refine' : 'generate',
    refineInstruction: opts.refineInstruction,
    pageType: opts.pageType,
  });
  const store: PaidRunStore<SlideVersionRow, { imagePath: string; imageUrl: string }> = {
    claim: (key) => createSlideVersion(slide, {
      kind: kind === 'deck-refine' ? 'refine' : 'generate',
      prompt: plan.prompt,
      jobId,
      chargeKey: key,
    }),
    markRunning: (version) => {
      updateSlideGen(deck.id, slide.slideId, { genStatus: 'running', genError: '' });
      updateSlideVersion(version.versionId, { status: 'running' });
    },
    markSucceeded: (version, saved) => {
      updateSlideVersion(version.versionId, { status: 'succeeded', imagePath: saved.imagePath, imageUrl: saved.imageUrl });
      updateSlideGen(deck.id, slide.slideId, {
        genStatus: 'succeeded',
        genError: '',
        activeVersionId: version.versionId,
      });
    },
    markFailed: (version, failure) => {
      const insufficient = failure.code === 'INSUFFICIENT_CREDITS';
      const chargeFailed = failure.code === 'CHARGE_FAILED';
      const detail = `${failure.code}: ${failure.message}`;
      updateSlideVersion(version.versionId, {
        status: 'failed',
        error: insufficient ? 'INSUFFICIENT_CREDITS: 🌟 星星不足' : chargeFailed ? '扣费失败' : detail,
      });
      updateSlideGen(deck.id, slide.slideId, {
        genStatus: 'failed',
        genError: insufficient
          ? 'INSUFFICIENT_CREDITS: 🌟 星星不足，请充值后重试本页'
          : chargeFailed
            ? '扣费失败，请重试'
            : detail,
      });
    },
  };
  const began = beginPaidRun({
    domain: 'deck',
    userId: deck.userId,
    action: kind === 'deck-refine' ? 'deck_page_refine' : 'deck_page_generate',
    unitPrice,
    chargeKey,
    refType: 'deck',
    refId: deck.id,
    reason: `生成第 ${slide.pageIndex + 1} 页`,
    refundReason: `第 ${slide.pageIndex + 1} 页生成失败退回`,
    store,
  });
  if (!began.charged) return 'failed';
  const version = began.run.row;
  let saved: { relPath: string; url: string };
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
      // 参考图按计划优先级读取；某个候选读失败就顺延，不再整条丢弃参考
      let referenceImages: string[] = [];
      for (const reference of plan.references) {
        const dataUrl = await loadPlannedReference(reference, pack, config);
        if (dataUrl) {
          referenceImages = [dataUrl];
          break;
        }
      }
      image = await generateImage({ prompt: plan.prompt, referenceImages, userKey: deck.userId }, deps);
    }
    saved = await saveFile(
      'generated',
      deck.userId,
      image,
      { kind: deck.id, ext: '.png', id: version.versionId },
      config,
    );
  } catch (error) {
    // 失败先退款再置 failed（顺序归 paid-run；退款键由扣费键定长派生，重复执行不双退）
    began.run.fail(toPublicImageError(error));
    return 'failed';
  }
  began.run.succeed({ imagePath: saved.relPath, imageUrl: saved.url });
  return 'succeeded';
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

  // 整单估价 + 余额校验：不足整单 402，不建 job 不扣费。
  // 单价在这里定格一次，后续逐页扣费/退款都按快照走，避免任务跑动中被换价导致估价与实扣漂移。
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

  const done = withInFlightRun({ runId: job.jobId, domain: 'deck', userId, action: kind }, async () => {
    try {
      // 全局视觉规范：每套一次 LLM（平台吸收），缓存命中则零成本；失败在视觉计划接口内降级为空串
      const blueprint = await ensureVisualPlanBlueprint(deck, allSlides, runDeps);
      // 双路线分流：真模板（kind=template）先算 outline_page_mapping，整批复用
      const stylePackRecord = getTemplate(deck.stylePackId);
      const templatePages =
        stylePackRecord && resolveTemplateKind(stylePackRecord) === 'template'
          ? getTemplatePages(stylePackRecord)
          : [];
      // 页型只解析一次：映射与逐页提示词都读这里的键
      const pageTypes = resolveVisualPlanPageTypes(allSlides);
      const template: TemplateRouteContext | null =
        templatePages.length > 0
          ? { pages: templatePages, mapping: buildOutlinePageMapping(allSlides, templatePages, pageTypes) }
          : null;
      const pageTypeByPageIndex = new Map(allSlides.map((item, index) => [item.pageIndex, pageTypes[index]]));
      let succeeded = 0;
      let failed = 0;
      // 逐页并发，上限 config.generateConcurrency（默认 6）
      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const slide = targets[cursor];
          cursor += 1;
          const result = await runSlideGeneration(deck, slide, job.jobId, kind, {
            unitPrice: estimate.unitPrice,
            refineInstruction: options.refineInstruction,
            refineExtraImages: options.refineExtraImages,
            refineExtraNote: options.refineExtraNote,
            template,
            pageType: pageTypeByPageIndex.get(slide.pageIndex),
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
    } catch (error) {
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
      updateJob(job.jobId, { status: 'failed', error: '生成管线异常中断，请重试失败页' });
    }
  });

  return { jobId: job.jobId, status: 'running', total: targets.length, done };
}
