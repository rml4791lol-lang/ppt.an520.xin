// Codia 适配器：uploads → pdf_to_ppt 任务 → 轮询 → 带 URL 落盘。
import { createPdfToPptTask, getTask, uploadPdf, type CodiaTaskView } from '../codia';
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

function providerStatus(view: CodiaTaskView): ProviderStatus {
  if (view.status === 'succeeded') return 'succeeded';
  if (view.status === 'processing') return 'processing';
  if (view.status === 'failed' || view.status === 'canceled') return 'failed';
  return 'pending';
}

function stepOf(upstream: CodiaTaskView, fallbackPages: number, taskId: string): EditableProviderStep {
  const totalPages = upstream.totalPages || upstream.pageCount || fallbackPages;
  const status = providerStatus(upstream);
  const view: EditableProviderView = {
    status,
    progress: status === 'succeeded' ? 100 : upstream.progress,
    completedPages: status === 'succeeded' ? totalPages : upstream.completedPages,
    totalPages,
    stage: stageForStatus(status),
    error: status === 'failed'
      ? upstream.error || (upstream.status === 'canceled' ? '上游任务被取消' : UPSTREAM_FAILED_MESSAGE)
      : '',
  };
  if (status === 'succeeded' && !upstream.pptUrl) {
    return {
      view: { ...view, status: 'failed', stage: 'failed', error: UPSTREAM_NO_RESULT_MESSAGE },
      taskId,
      product: null,
    };
  }
  return {
    view,
    taskId,
    product: status === 'succeeded' ? { kind: 'url', url: upstream.pptUrl } : null,
  };
}

export const codiaProvider: EditableProvider = {
  id: 'codia',
  capabilities: {
    maxPages: 20,
    resumable: true,
    attempts: 2,
    configured: (config) => Boolean(config.codiaApiKey),
  },
  async start(ctx, input) {
    const { uploadId } = await uploadPdf(input.pdf, input.filename, ctx.deps);
    const pageNo = Array.from({ length: input.pageCount }, (_, index) => index);
    const task = await createPdfToPptTask({
      uploadId,
      pageNo,
      title: `anppt-editable-${ctx.exportId}`,
      idempotencyKey: editableSubmissionKey(ctx.exportId, input.attempt),
    }, ctx.deps);
    return {
      view: {
        status: 'pending',
        progress: 0,
        completedPages: 0,
        totalPages: input.pageCount,
        stage: stageForStatus('pending'),
        error: '',
      },
      taskId: task.taskId,
      product: null,
    };
  },
  async advance(ctx: EditableProviderContext, taskId: string) {
    return stepOf(await getTask(taskId, ctx.deps), ctx.pageCount, taskId);
  },
  async save(ctx: EditableProviderContext, product: EditableProviderProduct) {
    if (product.kind !== 'url') throw new Error('Codia 产物应为下载地址');
    await ctx.saveUrl(product.url);
  },
  async cleanup() {
    // 上游没有取消/删除端点：没有需要回收的通道侧资源。
  },
};
