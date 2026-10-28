// WPS 适配器：内部链路同步转换（上传 + SSE + 下载都在一次调用里），没有任务查询端点。
// 因此 resumable=false：进程中断后只能重跑整条管线（管道用同一幂等键重提交，不会重复扣星）。
import { ApiError } from '@/lib/server/http';
import { convertPdfWithWpsAippt } from '../wps-aippt';
import {
  stageForStatus,
  type EditableProvider,
  type EditableProviderContext,
  type EditableProviderProduct,
} from './types';

export const wpsProvider: EditableProvider = {
  id: 'wps',
  capabilities: {
    maxPages: 50,
    resumable: false,
    attempts: 1,
    configured: (config) => Boolean(config.wpsAipptCookie),
  },
  async start(ctx, input) {
    const converted = await convertPdfWithWpsAippt(input.pdf, input.filename, {
      fetchImpl: ctx.deps.fetchImpl,
      config: ctx.deps.config,
      onProgress: (progress) => {
        ctx.report({
          progress,
          completedPages: Math.min(ctx.pageCount, Math.round((progress / 100) * ctx.pageCount)),
        });
      },
    });
    return {
      view: {
        status: 'succeeded',
        progress: 100,
        completedPages: input.pageCount,
        totalPages: input.pageCount,
        stage: stageForStatus('succeeded'),
        error: '',
      },
      taskId: converted.docId ? `wps:${converted.docId}` : '',
      product: { kind: 'bytes', bytes: converted.bytes },
    };
  },
  async advance() {
    throw new ApiError('WPS_AIPPT_UNAVAILABLE', 'WPS 通道没有可查询的任务端点，中断只能重跑整条管线。', 502, false);
  },
  async save(ctx: EditableProviderContext, product: EditableProviderProduct) {
    if (product.kind !== 'bytes') throw new Error('WPS 产物应为文件字节');
    await ctx.saveBytes(product.bytes);
  },
  async cleanup() {
    // 上游没有取消端点：没有需要回收的通道侧资源。
  },
};
