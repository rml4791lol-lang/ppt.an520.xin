// 生成链配置。注意：src/lib/server/env.ts 归另一代理所有，本模块按约定直接读
// process.env（ env.ts 不感知的生成链专用配置都集中在这里），新增项同步追加到
// .env.example。所有取值在调用时读取，方便测试用 process.env 覆盖。
import path from 'node:path';

export interface GenerationConfig {
  /** 数据根目录：uploads/generated/exports 都在其下（默认 <cwd>/data，与 env.ts 的 dbPath 同级） */
  dataDir: string;
  uploadsDir: string;
  generatedDir: string;
  exportsDir: string;
  /** 上传大小上限（字节，默认 30MB） */
  uploadMaxBytes: number;
  /** 文档内容截断（字，默认 100,000） */
  sourceTextMaxChars: number;
  /** PPT 引擎内部 API */
  engineBaseUrl: string;
  engineInternalToken: string;
  /** 引擎不可达时的本地直连 LLM 兜底（OpenAI 兼容 /chat/completions） */
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** 主模型失败（超时/HTTP 错误/空响应）时的回退模型链，按序尝试 */
  llmFallbackModels: string[];
  /** gpt-image-2 生图上游（OpenAI 兼容 /images/generations + /images/edits） */
  imageBaseUrl: string;
  imageApiKey: string;
  imageModel: string;
  imageSize: string;
  imageTimeoutMs: number;
  /** 单套 PPT 内逐页生图并发上限 */
  generateConcurrency: number;
  /** 全站生图最大在途请求数 */
  imageGlobalConcurrency: number;
  /** 全站每分钟最多启动的生图请求数 */
  imageStartsPerMinute: number;
  /** 429/5xx/网络抖动的后台自动重试次数 */
  imageMaxRetries: number;
  /** 自动重试基础退避毫秒数 */
  imageRetryBaseMs: number;
  /** 生成 job 心跳卡死判定阈值：超过即视为进程中断，懒恢复可收敛（默认生图超时+2min，下限 5min） */
  jobStaleMs: number;
  /** Codia 开放 API（图片版 PPT 转可编辑 PPTX 上游） */
  codiaApiKey: string;
  codiaBaseUrl: string;
  /** 单页生成器单价（🌟/张）。env.ts 的 CREDIT_ACTION_PRICES 尚无 single 动作，
   *  这里自带默认值；deck 页价走 credits.estimateCredits('deck_page_generate')。 */
  singlePageCredits: number;
  /** 项目保留天数（仅作为元信息透出给前端文案用，删除动作一律软删） */
  projectRetentionDays: number;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function intFrom(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeIntFrom(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getGenerationConfig(env: NodeJS.ProcessEnv = process.env): GenerationConfig {
  const dataDir = trim(env.ANPPT_V2_DATA_DIR) || path.resolve(process.cwd(), 'data');
  const imageTimeoutMs = intFrom(env.ANPPT_V2_IMAGE_TIMEOUT_MS, 480_000);
  return {
    dataDir,
    uploadsDir: trim(env.ANPPT_V2_UPLOADS_DIR) || path.join(dataDir, 'uploads'),
    generatedDir: trim(env.ANPPT_V2_GENERATED_DIR) || path.join(dataDir, 'generated'),
    exportsDir: trim(env.ANPPT_V2_EXPORTS_DIR) || path.join(dataDir, 'exports'),
    uploadMaxBytes: intFrom(env.ANPPT_V2_UPLOAD_MAX_BYTES, 30 * 1024 * 1024),
    sourceTextMaxChars: intFrom(env.ANPPT_V2_SOURCE_TEXT_MAX_CHARS, 100_000),
    engineBaseUrl: stripTrailingSlash(trim(env.PPT_ENGINE_BASE_URL) || 'http://127.0.0.1:3002'),
    engineInternalToken: trim(env.PPT_ENGINE_INTERNAL_TOKEN),
    llmBaseUrl: stripTrailingSlash(trim(env.ANPPT_V2_LLM_BASE_URL) || 'http://127.0.0.1:6800/v1'),
    llmApiKey: trim(env.ANPPT_V2_LLM_API_KEY),
    llmModel: trim(env.ANPPT_V2_LLM_MODEL) || 'deepseek-v4-flash',
    llmFallbackModels: (trim(env.ANPPT_V2_LLM_FALLBACK_MODELS) || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, 3),
    imageBaseUrl: stripTrailingSlash(trim(env.ANPPT_V2_IMAGE_BASE_URL)),
    imageApiKey: trim(env.ANPPT_V2_IMAGE_API_KEY),
    imageModel: trim(env.ANPPT_V2_IMAGE_MODEL) || 'gpt-image-2',
    imageSize: trim(env.ANPPT_V2_IMAGE_SIZE) || '1536x864',
    imageTimeoutMs,
    generateConcurrency: Math.min(12, intFrom(env.ANPPT_V2_GENERATE_CONCURRENCY, 6)),
    imageGlobalConcurrency: Math.min(40, intFrom(env.ANPPT_V2_IMAGE_GLOBAL_CONCURRENCY, 20)),
    imageStartsPerMinute: Math.min(120, intFrom(env.ANPPT_V2_IMAGE_STARTS_PER_MINUTE, 24)),
    imageMaxRetries: Math.min(3, nonNegativeIntFrom(env.ANPPT_V2_IMAGE_MAX_RETRIES, 2)),
    imageRetryBaseMs: Math.min(30_000, intFrom(env.ANPPT_V2_IMAGE_RETRY_BASE_MS, 2_000)),
    jobStaleMs: intFrom(env.ANPPT_V2_JOB_STALE_MS, Math.max(5 * 60_000, imageTimeoutMs + 120_000)),
    codiaApiKey: trim(env.ANPPT_V2_CODIA_API_KEY),
    codiaBaseUrl: stripTrailingSlash(trim(env.ANPPT_V2_CODIA_BASE_URL) || 'https://openapi.codia.ai'),
    singlePageCredits: intFrom(env.ANPPT_V2_SINGLE_PAGE_CREDITS, 10),
    projectRetentionDays: intFrom(env.ANPPT_V2_PROJECT_RETENTION_DAYS, 7),
  };
}
