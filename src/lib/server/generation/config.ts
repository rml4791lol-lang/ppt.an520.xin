// 生成链配置。注意：src/lib/server/env.ts 归另一代理所有，本模块按约定直接读
// process.env（ env.ts 不感知的生成链专用配置都集中在这里），新增项同步追加到
// .env.example。所有取值在调用时读取，方便测试用 process.env 覆盖。
import path from 'node:path';
import { getEffectiveGenerationEnv } from '../admin-config';

export type LlmReasoningEffort = 'low' | 'high' | 'max' | 'off';
export type EditableProvider = 'codia' | 'image2ppt' | 'auto';

const LLM_REASONING_EFFORTS: readonly LlmReasoningEffort[] = ['low', 'high', 'max', 'off'];

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
  /** DeepSeek V4 思考强度。默认 low；off = 关闭思考。其它 OpenAI 兼容上游忽略此字段。 */
  llmReasoningEffort: LlmReasoningEffort;
  /** LLM 跨站备份：主站全部模型失败后才尝试（如官方 API）。三项同时配置才生效。 */
  llmBackupBaseUrl: string;
  llmBackupApiKey: string;
  llmBackupModel: string;
  /** gpt-image-2 生图上游（OpenAI 兼容 /images/generations + /images/edits） */
  imageBaseUrl: string;
  imageApiKey: string;
  imageModel: string;
  /** 改图（/images/edits）专用模型；不配置则与 imageModel 同——seedream 这类文生图/编辑
   *  分模型名的渠道必须分开配置（如 text-to-image / edit 一对） */
  imageEditModel: string;
  /** 生图跨站灾备（贵渠道，如 gpt-image-2）：主站失败（402/5xx/超时等）后自动切换。
   *  base/key/model 三项齐备才挂上；editModel 不配则与 backupModel 同。 */
  imageBackupBaseUrl: string;
  imageBackupApiKey: string;
  imageBackupModel: string;
  imageBackupEditModel: string;
  imageSize: string;
  imageTimeoutMs: number;
  /** 单套 PPT 内逐页生图并发上限 */
  generateConcurrency: number;
  /** 全站生图最大在途请求数 */
  imageGlobalConcurrency: number;
  /** 全站每分钟最多启动的生图请求数 */
  imageStartsPerMinute: number;
  /** 单用户同时在途生图上限（多用户公平调度） */
  imagePerUserConcurrency: number;
  /** 单用户每分钟最多启动的生图请求数（多用户公平调度） */
  imageStartsPerUserPerMinute: number;
  /** 429/5xx/网络抖动的后台自动重试次数 */
  imageMaxRetries: number;
  /** 自动重试基础退避毫秒数 */
  imageRetryBaseMs: number;
  /** 生成 job 心跳卡死判定阈值：超过即视为进程中断，懒恢复可收敛（默认生图超时+2min，下限 5min） */
  jobStaleMs: number;
  /** Codia 开放 API（图片版 PPT 转可编辑 PPTX 上游） */
  codiaApiKey: string;
  codiaBaseUrl: string;
  /** 可编辑转换主通道：codia / image2ppt / auto（auto 优先 image2ppt，失败回退 Codia） */
  editableProvider: EditableProvider;
  /** Image2PPT 开放 API（原生文字/形状/表格重建） */
  image2pptApiKey: string;
  image2pptBaseUrl: string;
  image2pptWebhookSecret: string;
  /** 单页生成器单价（🌟/张）。env.ts 的 CREDIT_ACTION_PRICES 尚无 single 动作，
   *  这里自带默认值；deck 页价走 credits.estimateCredits('deck_page_generate')。 */
  singlePageCredits: number;
  /** 上游成本估算单价（单位：分）。0 = 未配置，计量只记真实单位（tokens/次数）不估钱。 */
  costLlmInputFenPerMtok: number;
  costLlmOutputFenPerMtok: number;
  costLlmBackupInputFenPerMtok: number;
  costLlmBackupOutputFenPerMtok: number;
  costImageFenPerCall: number;
  costImageBackupFenPerCall: number;
  costCodiaFenPerCall: number;
  costImage2PptFenPerPage: number;
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

function llmReasoningEffortFrom(value: unknown): LlmReasoningEffort {
  const effort = trim(value).toLowerCase();
  return (LLM_REASONING_EFFORTS as readonly string[]).includes(effort)
    ? (effort as LlmReasoningEffort)
    : 'low';
}

function editableProviderFrom(value: unknown): EditableProvider {
  const provider = trim(value).toLowerCase();
  return provider === 'image2ppt' || provider === 'auto' ? provider : 'codia';
}

export function getGenerationConfig(env: NodeJS.ProcessEnv = process.env): GenerationConfig {
  // 管理端保存的运行时覆盖只作用于后续新请求；显式传入 env 的测试与调用仍保持纯函数。
  const effectiveEnv = env === process.env ? getEffectiveGenerationEnv(env) : env;
  const dataDir = trim(effectiveEnv.ANPPT_V2_DATA_DIR) || path.resolve(process.cwd(), 'data');
  const imageTimeoutMs = intFrom(effectiveEnv.ANPPT_V2_IMAGE_TIMEOUT_MS, 480_000);
  const imageModel = trim(effectiveEnv.ANPPT_V2_IMAGE_MODEL) || 'gpt-image-2';
  return {
    dataDir,
    uploadsDir: trim(effectiveEnv.ANPPT_V2_UPLOADS_DIR) || path.join(dataDir, 'uploads'),
    generatedDir: trim(effectiveEnv.ANPPT_V2_GENERATED_DIR) || path.join(dataDir, 'generated'),
    exportsDir: trim(effectiveEnv.ANPPT_V2_EXPORTS_DIR) || path.join(dataDir, 'exports'),
    uploadMaxBytes: intFrom(effectiveEnv.ANPPT_V2_UPLOAD_MAX_BYTES, 30 * 1024 * 1024),
    sourceTextMaxChars: intFrom(effectiveEnv.ANPPT_V2_SOURCE_TEXT_MAX_CHARS, 100_000),
    engineBaseUrl: stripTrailingSlash(trim(effectiveEnv.PPT_ENGINE_BASE_URL) || 'http://127.0.0.1:3002'),
    engineInternalToken: trim(effectiveEnv.PPT_ENGINE_INTERNAL_TOKEN),
    llmBaseUrl: stripTrailingSlash(trim(effectiveEnv.ANPPT_V2_LLM_BASE_URL) || 'https://api.deepseek.com/v1'),
    llmApiKey: trim(effectiveEnv.ANPPT_V2_LLM_API_KEY),
    llmModel: trim(effectiveEnv.ANPPT_V2_LLM_MODEL) || 'deepseek-v4-flash',
    llmFallbackModels: trim(effectiveEnv.ANPPT_V2_LLM_FALLBACK_MODELS)
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, 3),
    llmReasoningEffort: llmReasoningEffortFrom(effectiveEnv.ANPPT_V2_LLM_REASONING_EFFORT),
    llmBackupBaseUrl: stripTrailingSlash(trim(effectiveEnv.ANPPT_V2_LLM_BACKUP_BASE_URL)),
    llmBackupApiKey: trim(effectiveEnv.ANPPT_V2_LLM_BACKUP_API_KEY),
    llmBackupModel: trim(effectiveEnv.ANPPT_V2_LLM_BACKUP_MODEL),
    imageBaseUrl: stripTrailingSlash(trim(effectiveEnv.ANPPT_V2_IMAGE_BASE_URL)),
    imageApiKey: trim(effectiveEnv.ANPPT_V2_IMAGE_API_KEY),
    imageModel,
    imageEditModel: trim(effectiveEnv.ANPPT_V2_IMAGE_EDIT_MODEL) || imageModel,
    imageBackupBaseUrl: stripTrailingSlash(trim(effectiveEnv.ANPPT_V2_IMAGE_BACKUP_BASE_URL)),
    imageBackupApiKey: trim(effectiveEnv.ANPPT_V2_IMAGE_BACKUP_API_KEY),
    imageBackupModel: trim(effectiveEnv.ANPPT_V2_IMAGE_BACKUP_MODEL),
    imageBackupEditModel:
      trim(effectiveEnv.ANPPT_V2_IMAGE_BACKUP_EDIT_MODEL) || trim(effectiveEnv.ANPPT_V2_IMAGE_BACKUP_MODEL),
    imageSize: trim(effectiveEnv.ANPPT_V2_IMAGE_SIZE) || '1536x864',
    imageTimeoutMs,
    generateConcurrency: Math.min(12, intFrom(effectiveEnv.ANPPT_V2_GENERATE_CONCURRENCY, 6)),
    imageGlobalConcurrency: Math.min(40, intFrom(effectiveEnv.ANPPT_V2_IMAGE_GLOBAL_CONCURRENCY, 20)),
    imageStartsPerMinute: Math.min(120, intFrom(effectiveEnv.ANPPT_V2_IMAGE_STARTS_PER_MINUTE, 24)),
    imagePerUserConcurrency: Math.min(20, intFrom(effectiveEnv.ANPPT_V2_IMAGE_PER_USER_CONCURRENCY, 6)),
    imageStartsPerUserPerMinute: Math.min(60, intFrom(effectiveEnv.ANPPT_V2_IMAGE_STARTS_PER_USER_PER_MINUTE, 16)),
    imageMaxRetries: Math.min(3, nonNegativeIntFrom(effectiveEnv.ANPPT_V2_IMAGE_MAX_RETRIES, 2)),
    imageRetryBaseMs: Math.min(30_000, intFrom(effectiveEnv.ANPPT_V2_IMAGE_RETRY_BASE_MS, 2_000)),
    jobStaleMs: intFrom(effectiveEnv.ANPPT_V2_JOB_STALE_MS, Math.max(5 * 60_000, imageTimeoutMs + 120_000)),
    codiaApiKey: trim(effectiveEnv.ANPPT_V2_CODIA_API_KEY),
    codiaBaseUrl: stripTrailingSlash(trim(effectiveEnv.ANPPT_V2_CODIA_BASE_URL) || 'https://openapi.codia.ai'),
    editableProvider: editableProviderFrom(effectiveEnv.ANPPT_V2_EDITABLE_PROVIDER),
    image2pptApiKey: trim(effectiveEnv.ANPPT_V2_IMAGE2PPT_API_KEY),
    image2pptBaseUrl: stripTrailingSlash(trim(effectiveEnv.ANPPT_V2_IMAGE2PPT_BASE_URL) || 'https://image2ppt.com'),
    image2pptWebhookSecret: trim(effectiveEnv.ANPPT_V2_IMAGE2PPT_WEBHOOK_SECRET),
    singlePageCredits: intFrom(effectiveEnv.ANPPT_V2_SINGLE_PAGE_CREDITS, 10),
    costLlmInputFenPerMtok: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_LLM_INPUT_FEN_PER_MTOK, 0),
    costLlmOutputFenPerMtok: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_LLM_OUTPUT_FEN_PER_MTOK, 0),
    costLlmBackupInputFenPerMtok: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_LLM_BACKUP_INPUT_FEN_PER_MTOK, 0),
    costLlmBackupOutputFenPerMtok: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_LLM_BACKUP_OUTPUT_FEN_PER_MTOK, 0),
    costImageFenPerCall: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_IMAGE_FEN_PER_CALL, 0),
    costImageBackupFenPerCall: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_IMAGE_BACKUP_FEN_PER_CALL, 0),
    costCodiaFenPerCall: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_CODIA_FEN_PER_CALL, 0),
    costImage2PptFenPerPage: nonNegativeIntFrom(effectiveEnv.ANPPT_V2_COST_IMAGE2PPT_FEN_PER_PAGE, 0),
    projectRetentionDays: intFrom(effectiveEnv.ANPPT_V2_PROJECT_RETENTION_DAYS, 7),
  };
}
