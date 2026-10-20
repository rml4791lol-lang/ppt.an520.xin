import { mergeAdminConfigDraft } from './admin-config';
import { getGenerationConfig } from './generation/config';
import { ApiError, validationError } from './http';

export type AdminIntegrationKind = 'llm' | 'image' | 'editable';

export interface AdminIntegrationCheckResult {
  kind: AdminIntegrationKind;
  ok: true;
  latencyMs: number;
  endpoint: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

const CHECK_TIMEOUT_MS = 12_000;

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function configured(value: string, label: string): string {
  if (!value) throw new ApiError('INTEGRATION_NOT_CONFIGURED', `${label}尚未配置`, 409, false);
  return value;
}

async function readJsonIfPresent(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export async function checkAdminIntegration(
  kind: AdminIntegrationKind,
  draftValues?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<AdminIntegrationCheckResult> {
  if (kind !== 'llm' && kind !== 'image' && kind !== 'editable') {
    throw validationError('不支持的连接检查类型');
  }
  const config = getGenerationConfig(mergeAdminConfigDraft(draftValues));
  let url = '';
  let apiKey = '';
  let editableProvider: 'codia' | 'image2ppt' = 'codia';
  if (kind === 'llm') {
    url = endpoint(configured(config.llmBaseUrl, 'LLM API 地址'), '/models');
    apiKey = configured(config.llmApiKey, 'LLM API 密钥');
  } else if (kind === 'image') {
    url = endpoint(configured(config.imageBaseUrl, '生图 API 地址'), '/models');
    apiKey = configured(config.imageApiKey, '生图 API 密钥');
  } else {
    const codiaAvailable = Boolean(config.codiaApiKey);
    const image2pptAvailable = Boolean(config.image2pptApiKey);
    editableProvider = config.editableProvider === 'codia'
      ? (codiaAvailable ? 'codia' : 'image2ppt')
      : (image2pptAvailable ? 'image2ppt' : 'codia');
    if (editableProvider === 'image2ppt') {
      url = endpoint(configured(config.image2pptBaseUrl, 'Image2PPT API 地址'), '/api/v1/account');
      apiKey = configured(config.image2pptApiKey, 'Image2PPT API 密钥');
    } else {
      url = endpoint(configured(config.codiaBaseUrl, 'Codia API 地址'), '/v2/open/credits');
      apiKey = configured(config.codiaApiKey, 'Codia API 密钥');
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      cache: 'no-store',
      // 连接检查必须停留在预期只读端点，拒绝跟随上游重定向到未知路径。
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError('INTEGRATION_CHECK_TIMEOUT', '连接检查超时，上游暂时没有响应', 504, true);
    }
    throw new ApiError('INTEGRATION_CHECK_FAILED', '无法连接上游，请检查地址、网络和密钥', 502, true);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - startedAt;
  const payload = await readJsonIfPresent(response);
  if (!response.ok) {
    const authFailure = response.status === 401 || response.status === 403;
    throw new ApiError(
      authFailure ? 'INTEGRATION_AUTH_FAILED' : 'INTEGRATION_CHECK_FAILED',
      authFailure ? '上游拒绝鉴权，请替换密钥后再检查' : `上游返回 HTTP ${response.status}`,
      502,
      response.status === 429 || response.status >= 500,
    );
  }

  if (kind === 'editable') {
    if (editableProvider === 'image2ppt') {
      const credits = finiteNumber(payload.credits);
      return {
        kind,
        ok: true,
        latencyMs,
        endpoint: '/api/v1/account',
        message: credits == null ? 'Image2PPT 连接正常，未创建任何转换任务' : `Image2PPT 连接正常，可用额度 ${credits}`,
        details: { provider: 'image2ppt', credits },
      };
    }
    const code = payload.code;
    if (code != null && Number(code) !== 0) {
      throw new ApiError('INTEGRATION_CHECK_FAILED', 'Codia 返回业务错误，请检查账号状态', 502, false);
    }
    const data = payload.data && typeof payload.data === 'object'
      ? payload.data as Record<string, unknown>
      : payload;
    const credits = finiteNumber(data.credits ?? data.balance ?? data.remaining_credits ?? data.remaining);
    return {
      kind,
      ok: true,
      latencyMs,
      endpoint: '/v2/open/credits',
      message: credits == null ? 'Codia 连接正常，未创建任何转换任务' : `Codia 连接正常，可用额度 ${credits}`,
      details: { provider: 'codia', credits },
    };
  }

  const models = Array.isArray(payload.data) ? payload.data : [];
  const expectedModel = kind === 'llm' ? config.llmModel : config.imageModel;
  const modelFound = models.some((item) => {
    if (!item || typeof item !== 'object') return false;
    return String((item as Record<string, unknown>).id ?? '') === expectedModel;
  });
  return {
    kind,
    ok: true,
    latencyMs,
    endpoint: '/models',
    message: `连接正常，读取到 ${models.length} 个可用模型`,
    details: {
      model: expectedModel,
      modelFound: models.length > 0 ? modelFound : null,
      availableModels: models.length,
    },
  };
}
