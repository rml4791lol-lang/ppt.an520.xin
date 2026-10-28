// 可编辑转换通道接口：start / advance / save / cleanup + 能力声明；管线与恢复只依赖本接口。
// 共享文案与有限数解析也只在这里一份——三个通道各写一套说辞会让同一失败给出不同解释。
// 通道名只允许出现在 registry 与各适配器文件；机制见 docs/DEBUG-HANDBOOK.md §28。
import { ApiError } from '@/lib/server/http';
import type { GenerationConfig } from '@/lib/server/generation/config';

export type EditableProviderId = 'wps' | 'image2ppt' | 'codia';

export type ProviderStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

/** 导出中心阶段键（唯一映射见 stageForStatus；客户端按这些键取文案）。 */
export type ProviderStage = 'waiting' | 'converting' | 'downloading' | 'failed';

/** 统一通道视图：状态、进度、完成页、总页、阶段、错误。 */
export interface EditableProviderView {
  status: ProviderStatus;
  /** 0-100；终态成功由统一落库补成 100 */
  progress: number;
  completedPages: number;
  totalPages: number;
  stage: ProviderStage;
  error: string;
}

/** 通道产物：URL 需由管线带鉴权头下载，bytes 是通道内已拿到的文件。 */
export type EditableProviderProduct =
  | { kind: 'url'; url: string; headers?: Record<string, string> }
  | { kind: 'bytes'; bytes: Buffer };

export interface EditableProviderStep {
  view: EditableProviderView;
  /** 上游任务 id（同步通道为空串）；管线写入 export_jobs.upstream_task_id */
  taskId: string;
  /** 一旦给出产物，推进结束 */
  product: EditableProviderProduct | null;
}

export interface EditableProviderDeps {
  fetchImpl?: typeof fetch;
  config: GenerationConfig;
  retryDelayMs?: number;
}

/** 管线注入给适配器的能力：进度回写与落盘都只有管线这一份实现。 */
export interface EditableProviderContext {
  exportId: string;
  userId: string;
  pageCount: number;
  deps: EditableProviderDeps;
  /** 同步通道的分段进度（WPS SSE）；与轮询进度走同一份落库。 */
  report(view: Partial<EditableProviderView>): void;
  saveUrl(url: string, headers?: Record<string, string>): Promise<void>;
  saveBytes(bytes: Buffer): Promise<void>;
}

export interface EditableProviderStartInput {
  pdf: Buffer;
  filename: string;
  pageCount: number;
  /** 第几次提交（0 起）：适配器据此派生幂等键 */
  attempt: number;
}

export interface EditableProviderCapabilities {
  /** 单任务页数上限：registry 按请求页数剔除接不住的通道 */
  maxPages: number;
  /** 是否有可查询的任务端点；false = 中断只能重跑整条管线 */
  resumable: boolean;
  /** 同一次运行的提交次数（Codia 首次失败后用 -retry1 重建一次） */
  attempts: number;
  configured(config: GenerationConfig): boolean;
}

export interface EditableProvider {
  readonly id: EditableProviderId;
  readonly capabilities: EditableProviderCapabilities;
  start(ctx: EditableProviderContext, input: EditableProviderStartInput): Promise<EditableProviderStep>;
  advance(ctx: EditableProviderContext, taskId: string): Promise<EditableProviderStep>;
  save(ctx: EditableProviderContext, product: EditableProviderProduct): Promise<void>;
  cleanup(ctx: EditableProviderContext): Promise<void>;
}

/** 阶段映射唯一实现：上游状态 → 导出中心阶段键。 */
export function stageForStatus(status: ProviderStatus): ProviderStage {
  if (status === 'failed') return 'failed';
  if (status === 'succeeded') return 'downloading';
  if (status === 'pending') return 'waiting';
  return 'converting';
}

/** 幂等键唯一形状：重试追加 -retryN（Codia 的历史键 -retry1 由此保持）。 */
export function editableSubmissionKey(exportId: string, attempt: number): string {
  return `anppt-editable-${exportId}${attempt > 0 ? `-retry${attempt}` : ''}`;
}

// ---------- 共享常量与容错（接口层唯一来源） ----------

/** 上游繁忙/不可达时对内的统一说明（用户侧只看到下载中心与退星文案）。 */
export const UPSTREAM_BUSY_MESSAGE = '可编辑转换服务暂时开小差了，系统会继续检查；完成后可在下载中心查看。';
export const UPSTREAM_AUTH_MESSAGE = '可编辑转换服务配置异常，请联系管理员。';
export const UPSTREAM_NO_CREDITS_MESSAGE = '可编辑转换服务额度暂时不足，请联系管理员。';
export const UPSTREAM_FAILED_MESSAGE = '上游任务失败';
export const UPSTREAM_NO_RESULT_MESSAGE = '上游未返回可下载文件';
export const UNCONFIGURED_MESSAGE = '可编辑转换服务尚未配置，请联系管理员';

export function notConfiguredError(): ApiError {
  return new ApiError('EDITABLE_EXPORT_UNAVAILABLE', UNCONFIGURED_MESSAGE, 503, false);
}

/** 上游有限数解析唯一实现：非有限或负数一律归零，调用方再决定回退值。 */
export function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
