// gpt-image-2 生图上游客户端（OpenAI 兼容 /images/generations + /images/edits）。
// 配置：ANPPT_V2_IMAGE_BASE_URL / ANPPT_V2_IMAGE_API_KEY / ANPPT_V2_IMAGE_MODEL。
// 全部走依赖注入 fetcher（deps.fetchImpl），测试 mock 上游，禁止真实调用付费上游。
import { getGenerationConfig, type GenerationConfig } from './config';
import { cleanString } from './types';

export interface ImageDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
}

export class ImageUpstreamError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ImageUpstreamError';
    this.status = status;
  }
}

/** 上游/配置错误 → 对外口径（参考旧版 publicErrorMessage） */
export function toPublicImageError(error: unknown): { code: string; message: string; status: number } {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/未配置/.test(message)) {
    return { code: 'IMAGE_NOT_CONFIGURED', message: '生图服务尚未配置，请联系管理员', status: 503 };
  }
  if (/401|403/.test(message)) {
    return { code: 'IMAGE_UPSTREAM_UNAVAILABLE', message: '图片服务暂时不可用，请稍后重试', status: 502 };
  }
  if (/400|413/.test(message)) {
    return { code: 'IMAGE_REQUEST_INVALID', message: '本页素材或文字内容可能过长，请简化后重试', status: 400 };
  }
  if (/429/.test(message)) {
    return { code: 'IMAGE_RATE_LIMITED', message: '图片服务当前繁忙，请稍后重试', status: 429 };
  }
  if (/abort|timeout|超时/i.test(message)) {
    return { code: 'IMAGE_TIMEOUT', message: '图片生成超时，请重试', status: 504 };
  }
  return { code: 'IMAGE_GENERATION_FAILED', message: '图片生成没有完成，请显式重试', status: 502 };
}

interface ImageResponsePayload {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

async function parseImageResponse(
  response: Response,
  deps: ImageDeps,
): Promise<Buffer> {
  const text = await response.text();
  let payload: ImageResponsePayload = {};
  try {
    payload = text ? (JSON.parse(text) as ImageResponsePayload) : {};
  } catch {
    throw new ImageUpstreamError(`HTTP ${response.status}: 上游返回非 JSON`, response.status || 502);
  }
  if (!response.ok) {
    throw new ImageUpstreamError(
      `HTTP ${response.status}: ${cleanString(payload?.error?.message, 300) || 'upstream error'}`,
      response.status,
    );
  }
  const item = payload.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const imageResponse = await fetchImpl(item.url);
    if (!imageResponse.ok) throw new ImageUpstreamError(`HTTP ${imageResponse.status}: 图片下载失败`, 502);
    return Buffer.from(await imageResponse.arrayBuffer());
  }
  throw new ImageUpstreamError('上游未返回图片数据', 502);
}

function requireImageConfig(config: GenerationConfig): { baseUrl: string; apiKey: string } {
  if (!config.imageBaseUrl || !config.imageApiKey) {
    throw new ImageUpstreamError('生图服务未配置（ANPPT_V2_IMAGE_BASE_URL/API_KEY）', 503);
  }
  return { baseUrl: config.imageBaseUrl, apiKey: config.imageApiKey };
}

export interface GenerateImageInput {
  prompt: string;
  /** 风格参考图（data URL 或可公开访问的 URL；上游若忽略则仅靠 prompt 里的风格描述） */
  referenceImages?: string[];
  size?: string;
}

export async function generateImage(input: GenerateImageInput, deps: ImageDeps = {}): Promise<Buffer> {
  const config = deps.config ?? getGenerationConfig();
  const { baseUrl, apiKey } = requireImageConfig(config);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.imageTimeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.imageModel,
        prompt: input.prompt,
        size: input.size || config.imageSize,
        n: 1,
        ...(input.referenceImages && input.referenceImages.length > 0
          ? { reference_images: input.referenceImages.map((url) => ({ url })) }
          : {}),
      }),
      signal: controller.signal,
    });
    return await parseImageResponse(response, deps);
  } finally {
    clearTimeout(timer);
  }
}

export interface EditImageInput {
  /** 源图（当前生效版本），走 /images/edits multipart */
  image: Buffer;
  instruction: string;
  size?: string;
}

export async function editImage(input: EditImageInput, deps: ImageDeps = {}): Promise<Buffer> {
  const config = deps.config ?? getGenerationConfig();
  const { baseUrl, apiKey } = requireImageConfig(config);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('model', config.imageModel);
  form.append('prompt', input.instruction);
  form.append('size', input.size || config.imageSize);
  form.append('image', new Blob([new Uint8Array(input.image)], { type: 'image/png' }), 'source.png');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.imageTimeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    return await parseImageResponse(response, deps);
  } finally {
    clearTimeout(timer);
  }
}
