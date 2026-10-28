// Image2PPT 适配器：提交 jobs → 轮询 → 带 Bearer 下载落盘。
import {
  getJob,
  image2PptAuthHeaders,
  image2PptCallbackUrl,
  submitJob,
  type Image2PptJobView,
} from '../image2ppt';
import {
  editableSubmissionKey,
  stageForStatus,
  UPSTREAM_FAILED_MESSAGE,
  UPSTREAM_NO_RESULT_MESSAGE,
  type EditableProvider,
  type EditableProviderContext,
  type EditableProviderProduct,
  type EditableProviderStep,
  type EditableProviderView,
  type ProviderStatus,
} from './types';

function providerStatus(view: Image2PptJobView): ProviderStatus {
  if (view.status === 'completed') return 'succeeded';
  if (view.status === 'failed') return 'failed';
  if (view.status === 'processing') return 'processing';
  return 'pending';
}

function stepOf(
  upstream: Image2PptJobView,
  fallbackPages: number,
  taskId: string,
  headers: Record<string, string>,
): EditableProviderStep {
  const totalPages = upstream.slideCount || fallbackPages;
  const status = providerStatus(upstream);
  const completedPages = status === 'succeeded'
    ? totalPages
    : Math.min(totalPages, Math.round((upstream.progress / 100) * totalPages));
  const view: EditableProviderView = {
    status,
    progress: status === 'succeeded' ? 100 : upstream.progress,
    completedPages,
    totalPages,
    stage: stageForStatus(status),
    error: status === 'failed' ? upstream.error || UPSTREAM_FAILED_MESSAGE : '',
  };
  if (status === 'succeeded' && !upstream.downloadUrl) {
    return {
      view: { ...view, status: 'failed', stage: 'failed', error: UPSTREAM_NO_RESULT_MESSAGE },
      taskId,
      product: null,
    };
  }
  return {
    view,
    taskId,
    product: status === 'succeeded' ? { kind: 'url', url: upstream.downloadUrl, headers } : null,
  };
}

export const image2PptProvider: EditableProvider = {
  id: 'image2ppt',
  capabilities: {
    maxPages: 50,
    resumable: true,
    attempts: 1,
    configured: (config) => Boolean(config.image2pptApiKey),
  },
  async start(ctx, input) {
    const job = await submitJob({
      pdf: input.pdf,
      filename: input.filename,
      pageCount: input.pageCount,
      idempotencyKey: editableSubmissionKey(ctx.exportId, input.attempt),
      callbackUrl: image2PptCallbackUrl(),
    }, ctx.deps);
    return {
      view: {
        status: 'pending',
        progress: 0,
        completedPages: 0,
        totalPages: job.slideCount || input.pageCount,
        stage: stageForStatus('pending'),
        error: '',
      },
      taskId: job.jobId,
      product: null,
    };
  },
  async advance(ctx: EditableProviderContext, taskId: string) {
    return stepOf(
      await getJob(taskId, ctx.deps),
      ctx.pageCount,
      taskId,
      image2PptAuthHeaders(ctx.deps.config),
    );
  },
  async save(ctx: EditableProviderContext, product: EditableProviderProduct) {
    if (product.kind !== 'url') throw new Error('Image2PPT 产物应为下载地址');
    await ctx.saveUrl(product.url, product.headers);
  },
  async cleanup() {
    // 上游没有取消端点：没有需要回收的通道侧资源。
  },
};
