// 底座任务的中断结算入口：ppt_to_base_jobs 只由本模块读写，平台恢复只调度。
// 本模块是一个「运行源」——只列本域在途行与结算动作；判活口径（paid-run 在飞注册表 +
// 心跳过期）由恢复入口经 RunSourceContext 注入，模块不自读时间；补退与置 failed 顺序归
// paid-run.failPaidRun（先退款、再置终态）。
import { getGenDb, nowMs } from '@/lib/server/generation/db';
import type { InterruptedRun, RunSource } from '@/lib/server/generation/run-source';

/** 在途底座任务：平台恢复入口按扣费键判活、先补退再置 failed。 */
export const pptToBaseRunSource: RunSource = {
  domain: 'ppt-to-base',
  listRuns(userId, ctx): InterruptedRun[] {
    const rows = getGenDb()
      .prepare("SELECT id, request_id, charge_key, updated_at FROM ppt_to_base_jobs WHERE user_id = ? AND status = 'running'")
      .all(userId) as Array<{ id: string; request_id: string; charge_key: string; updated_at: number }>;
    return rows.map((row) => {
      const jobId = String(row.id);
      const chargeKey = String(row.charge_key || '');
      return {
        key: jobId,
        domain: 'ppt-to-base',
        userId,
        // 在飞注册表在 paid-run 里以扣费键为 runId；心跳只兜底跨进程残留
        interrupted: !ctx.isLive(chargeKey, Number(row.updated_at)),
        settle: () => {
          getGenDb()
            .prepare("UPDATE ppt_to_base_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
            .run('failed', '生成中断（服务重启），已自动退回', nowMs(), jobId);
        },
        chargeKey,
        refundReason: '底座生成中断退回',
        refType: 'ppt-to-base',
        refId: String(row.request_id || jobId),
      };
    });
  },
};
