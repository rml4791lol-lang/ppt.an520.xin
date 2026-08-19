// PPT 引擎客户端（契约 §2）+ 引擎不可达时的本地直连 LLM 兜底。
// 配置来自 process.env（PPT_ENGINE_BASE_URL / PPT_ENGINE_INTERNAL_TOKEN /
// ANPPT_V2_LLM_*），见 generation/config.ts 的注释（env.ts 归另一代理所有）。
//
// 兜底说明：PPT_ENGINE_INTERNAL_TOKEN 未配置或引擎不可达时，outline/structure
// 改用 ANPPT_V2_LLM_* 直连 OpenAI 兼容 /chat/completions 本地实现。
// ⚠️ 引擎就绪后此兜底仅作灾备，正式链路以引擎为准（契约 §1 分工）。
import { ApiError } from './http';
import { getGenerationConfig, type GenerationConfig } from './generation/config';
import { DSL_TAG_SET_TEXT, validateTaggedDsl } from './generation/dsl';
import { cleanString, normalizeOutlineSlide, type OutlineSlide } from './generation/types';

export interface EngineDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
}

export type EngineProvider = 'engine' | 'llm-fallback' | 'local';

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

const ENGINE_TIMEOUT_MS = 120_000;
const LLM_TIMEOUT_MS = 120_000;

function engineConfigured(config: GenerationConfig): boolean {
  return Boolean(config.engineInternalToken);
}

function llmConfigured(config: GenerationConfig): boolean {
  return Boolean(config.llmBaseUrl && config.llmApiKey);
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new EngineUnavailableError(`上游返回非 JSON（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      const message = cleanString((payload?.error as Record<string, unknown>)?.message ?? payload?.message, 300);
      throw new EngineUnavailableError(`HTTP ${response.status}${message ? `: ${message}` : ''}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof EngineUnavailableError) throw error;
    throw new EngineUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** 调引擎内部端点；payload 须为契约 §2 的 {ok:true,data} 包裹 */
async function callEngine(
  path: string,
  body: unknown,
  deps: EngineDeps,
): Promise<Record<string, unknown>> {
  const config = deps.config ?? getGenerationConfig();
  if (!engineConfigured(config)) throw new EngineUnavailableError('PPT_ENGINE_INTERNAL_TOKEN 未配置');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const payload = await postJson(
    `${config.engineBaseUrl}${path}`,
    body,
    { Authorization: `Bearer ${config.engineInternalToken}` },
    ENGINE_TIMEOUT_MS,
    fetchImpl,
  );
  if (payload.ok !== true) {
    const err = (payload.error || {}) as Record<string, unknown>;
    throw new EngineUnavailableError(cleanString(err.message, 300) || `引擎 ${path} 返回失败`);
  }
  return (payload.data || {}) as Record<string, unknown>;
}

// ---------- 本地直连 LLM 兜底（引擎就绪后仅作灾备） ----------

const OUTLINE_SYSTEM_PROMPT = `你是专业的中文 PPT 大纲策划师。根据用户提供的原始文档规划整套汇报 PPT 的大纲。
只输出一个 JSON 数组（不要输出任何其他文字、解释或代码块标记），每个元素是一页，字段严格如下：
- pageIndex: 从 0 开始的连续整数
- role: 只能是 "cover" | "toc" | "section" | "content" | "ending" 之一
- chapter: 所属章节名（无则为空字符串）
- pageType: 版式页型（如 封面 / 目录 / 章节页 / 要点罗列 / 数据图表 / 对比页 / 流程页 / 时间线 / 结尾页 等）
- title: 页标题（不超过 20 字）
- goal: 本页表达目标（一句话）
- mustKeep: 字符串数组，本页必须逐字保留的要点/数据
- rawText: 原文锚点——本页内容对应的原文逐字摘录（供数据保真校验，不得改写）
- summary: 字符串数组，2-6 条要点（每条不超过 40 字）
- visualNote: 配图/版式建议（可空字符串）
规则：第 1 页 role=cover，最后 1 页 role=ending；所有数据与表述必须来自原文，不得编造。`;

const STRUCTURE_SYSTEM_PROMPT = `你是 PPT 内容梳理师。把给定的大纲页素材整理为 tagged-text DSL，供下游排版与生图使用。
合法标签集（只允许使用这些标签，每行一个标签）：${DSL_TAG_SET_TEXT}
格式规则：
- 每行格式为【标签】内容；【区域：xx】必须带区域名参数。
- 【表格】独占一个块，块内每行是 markdown 管道行（| 分隔），必须含 |---| 分隔行，且所有行列数一致。
- 【数据】【数据组】【表格】中出现的每个数字都必须逐字来自 rawText，不得编造、不得四舍五入。
- 第一行必须是【标题】。
- 只输出 DSL 文本本身，不要输出任何解释或代码块标记。`;

function extractJson(text: string): unknown {
  const cleaned = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through：截取首个 [ 到最后一个 ] / { 到 }
  }
  const startArr = cleaned.indexOf('[');
  const endArr = cleaned.lastIndexOf(']');
  if (startArr >= 0 && endArr > startArr) {
    try {
      return JSON.parse(cleaned.slice(startArr, endArr + 1));
    } catch {
      // continue
    }
  }
  const startObj = cleaned.indexOf('{');
  const endObj = cleaned.lastIndexOf('}');
  if (startObj >= 0 && endObj > startObj) {
    try {
      return JSON.parse(cleaned.slice(startObj, endObj + 1));
    } catch {
      // continue
    }
  }
  throw new EngineUnavailableError('LLM 兜底返回内容不是有效 JSON');
}

async function chatCompletion(
  messages: { role: string; content: string }[],
  deps: EngineDeps,
): Promise<string> {
  const config = deps.config ?? getGenerationConfig();
  if (!llmConfigured(config)) {
    throw new EngineUnavailableError('引擎未配置且 LLM 兜底未配置（ANPPT_V2_LLM_BASE_URL/API_KEY）');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const payload = await postJson(
    `${config.llmBaseUrl}/chat/completions`,
    { model: config.llmModel, messages, stream: false, temperature: 0.3 },
    { Authorization: `Bearer ${config.llmApiKey}` },
    LLM_TIMEOUT_MS,
    fetchImpl,
  );
  const choices = payload.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : '';
  if (!text.trim()) throw new EngineUnavailableError('LLM 兜底返回空内容');
  return text;
}

// ---------- 对外能力 ----------

export interface OutlineInput {
  sourceText: string;
  durationMinutes?: number;
  targetPageCount?: number;
  stylePackId?: string;
  force?: boolean;
}

export interface OutlineResult {
  slides: OutlineSlide[];
  provider: EngineProvider;
}

function normalizeOutlineList(raw: unknown): OutlineSlide[] {
  const list = Array.isArray(raw) ? raw : [];
  const slides = list.map((item, index) => normalizeOutlineSlide(item, index));
  slides.sort((a, b) => a.pageIndex - b.pageIndex);
  return slides.map((slide, index) => ({ ...slide, pageIndex: index }));
}

export async function generateOutline(input: OutlineInput, deps: EngineDeps = {}): Promise<OutlineResult> {
  const config = deps.config ?? getGenerationConfig();
  if (engineConfigured(config)) {
    try {
      const data = await callEngine(
        '/internal/ppt/outline',
        {
          sourceText: input.sourceText,
          durationMinutes: input.durationMinutes,
          targetPageCount: input.targetPageCount,
          stylePackId: input.stylePackId || undefined,
          force: input.force === true,
        },
        deps,
      );
      const slides = normalizeOutlineList(data.outline);
      if (slides.length === 0) throw new EngineUnavailableError('引擎返回空大纲');
      return { slides, provider: 'engine' };
    } catch (error) {
      if (!(error instanceof EngineUnavailableError) || !llmConfigured(config)) throw engineFailure(error);
      // 引擎不可达 → 落兜底
    }
  }
  const userPrompt = [
    `汇报时长：${input.durationMinutes || 15} 分钟`,
    `目标页数：${input.targetPageCount || 10} 页`,
    '',
    '原始文档全文：',
    input.sourceText,
  ].join('\n');
  const text = await chatCompletion(
    [
      { role: 'system', content: OUTLINE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    deps,
  );
  const slides = normalizeOutlineList(extractJson(text));
  if (slides.length === 0) throw new ApiError('OUTLINE_FAILED', '大纲生成失败，请重试', 502, true);
  return { slides, provider: 'llm-fallback' };
}

export interface StructuredPageResult {
  pageIndex: number;
  ok: boolean;
  structuredContent: string;
  warnings: string[];
  errors: string[];
}

export interface StructureResult {
  pages: StructuredPageResult[];
  provider: EngineProvider;
}

async function structureSlideViaLlm(slide: OutlineSlide, deps: EngineDeps): Promise<string> {
  const userPrompt = [
    `页标题：${slide.title}`,
    slide.goal ? `本页目标：${slide.goal}` : '',
    slide.mustKeep.length > 0 ? `必保留要点：\n${slide.mustKeep.map((s) => `- ${s}`).join('\n')}` : '',
    slide.summary.length > 0 ? `要点摘要：\n${slide.summary.map((s) => `- ${s}`).join('\n')}` : '',
    `rawText（原文锚点）：\n${slide.rawText || '(无)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return chatCompletion(
    [
      { role: 'system', content: STRUCTURE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    deps,
  );
}

/**
 * 单页内容梳理（tagged DSL），带服务端校验：标签合法、表格配平、数据保真；
 * 校验未过自动重试一次，仍失败则该页标记失败（不阻塞其它页）。
 */
export async function structureOneSlide(slide: OutlineSlide, deps: EngineDeps = {}): Promise<StructuredPageResult> {
  const config = deps.config ?? getGenerationConfig();
  const attempts: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    let content = '';
    try {
      if (engineConfigured(config)) {
        try {
          const data = await callEngine('/internal/ppt/structure-slide', { slide }, deps);
          content = cleanString(data.structuredContent ?? data.structured_content, 20000);
        } catch (error) {
          if (!(error instanceof EngineUnavailableError) || !llmConfigured(config)) throw error;
          content = await structureSlideViaLlm(slide, deps);
        }
      } else {
        content = await structureSlideViaLlm(slide, deps);
      }
    } catch (error) {
      attempts.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const validation = validateTaggedDsl(content, { rawText: slide.rawText });
    if (validation.ok) {
      return { pageIndex: slide.pageIndex, ok: true, structuredContent: content, warnings: [], errors: [] };
    }
    attempts.push(...validation.errors);
  }
  return {
    pageIndex: slide.pageIndex,
    ok: false,
    structuredContent: '',
    warnings: [],
    errors: attempts.slice(0, 6),
  };
}

export async function structureSlides(slides: OutlineSlide[], deps: EngineDeps = {}): Promise<StructureResult> {
  const config = deps.config ?? getGenerationConfig();
  if (engineConfigured(config)) {
    try {
      const data = await callEngine('/internal/ppt/structure', { slides }, deps);
      const rawPages = Array.isArray(data.pages) ? (data.pages as Record<string, unknown>[]) : [];
      const byIndex = new Map<number, Record<string, unknown>>();
      for (const page of rawPages) {
        const idx = Number(page.pageIndex ?? page.page_index);
        if (Number.isInteger(idx)) byIndex.set(idx, page);
      }
      const pages: StructuredPageResult[] = [];
      for (const slide of slides) {
        const raw = byIndex.get(slide.pageIndex);
        const content = cleanString(raw?.structuredContent ?? raw?.structured_content, 20000);
        if (!raw || !content) {
          pages.push(await structureOneSlide(slide, deps)); // 引擎缺页 → 单页兜底
          continue;
        }
        const validation = validateTaggedDsl(content, { rawText: slide.rawText });
        if (validation.ok) {
          const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((w) => cleanString(w, 200)) : [];
          pages.push({ pageIndex: slide.pageIndex, ok: true, structuredContent: content, warnings, errors: [] });
        } else {
          pages.push(await structureOneSlide(slide, deps)); // 校验未过 → 单页重梳一次
        }
      }
      return { pages, provider: 'engine' };
    } catch (error) {
      if (!(error instanceof EngineUnavailableError) || !llmConfigured(config)) throw engineFailure(error);
      // 落兜底：逐页直连 LLM
    }
  }
  const pages: StructuredPageResult[] = [];
  for (const slide of slides) {
    pages.push(await structureOneSlide(slide, deps));
  }
  return { pages, provider: 'llm-fallback' };
}

export interface SplitResult {
  slides: OutlineSlide[];
  provider: EngineProvider;
}

/** 段落均分回退（契约 §2：split-slide 失败可回退段落均分） */
function splitByParagraphs(slide: OutlineSlide, into: number): OutlineSlide[] {
  const chunks = (items: string[]): string[][] => {
    const out: string[][] = Array.from({ length: into }, () => []);
    items.forEach((item, index) => out[Math.min(into - 1, Math.floor((index * into) / Math.max(1, items.length)))].push(item));
    return out;
  };
  const paragraphs = (slide.rawText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const rawChunks = chunks(paragraphs.length > 0 ? paragraphs : [slide.rawText || slide.title]);
  const summaryChunks = chunks(slide.summary);
  return rawChunks.map((rawLines, offset) => ({
    ...slide,
    pageIndex: slide.pageIndex + offset,
    title: offset === 0 ? slide.title : `${slide.title}（续 ${offset}）`,
    rawText: rawLines.join('\n'),
    summary: summaryChunks[offset] || [],
    mustKeep: offset === 0 ? slide.mustKeep : [],
  }));
}

export async function splitSlide(slide: OutlineSlide, into: number, deps: EngineDeps = {}): Promise<SplitResult> {
  const config = deps.config ?? getGenerationConfig();
  const count = Math.min(5, Math.max(2, Math.floor(into) || 2));
  if (engineConfigured(config)) {
    try {
      const data = await callEngine('/internal/ppt/split-slide', { slide, into: count }, deps);
      const slides = normalizeOutlineList(data.slides);
      if (slides.length >= 2) return { slides, provider: 'engine' };
    } catch {
      // 回退段落均分
    }
  }
  return { slides: splitByParagraphs(slide, count), provider: 'local' };
}

function engineFailure(error: unknown): Error {
  if (error instanceof EngineUnavailableError) {
    return new ApiError('ENGINE_UNAVAILABLE', `PPT 引擎暂不可用：${error.message}`, 503, true);
  }
  return error instanceof Error ? error : new Error(String(error));
}
