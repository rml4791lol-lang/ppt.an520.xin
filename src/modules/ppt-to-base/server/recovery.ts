// 底座任务的中断结算入口：ppt_to_base_jobs 只由本模块读写，平台 recovery 只调度。
// 判活口径（本进程注册表 + 心跳过期）由平台注入——恢复入口反过来要 import 本模块，直接互导会成环。
import { getGenDb, nowMs } from '@/lib/server/generation/db';
import type { InterruptedRun } from '@/lib/server/generation/recovery';

/** 平台注入的在途判定：任务仍在跑（注册表命中或心跳未过期）返回 true。 */
export type JobLivenessCheck = (jobId: string, heartbeatMs: number) => boolean;

/**
 * 列出本用户的在途底座任务，并给出结算动作与退款描述（平台统一收敛与补退时调度）。
 * 结算语义与模块内失败分支一致：置 failed、超时残留行按 charge_key 补退款。
 */
export function interruptedPptToBaseRuns(userId: string, isLive: JobLivenessCheck): InterruptedRun[] {
  const rows = getGenDb()
    .prepare("SELECT id, request_id, charge_key, updated_at FROM ppt_to_base_jobs WHERE user_id = ? AND status = 'running'")
    .all(userId) as Array<{ id: string; request_id: string; charge_key: string; updated_at: number }>;
  return rows.map((row) => {
    const jobId = String(row.id);
    return {
      key: jobId,
      domain: 'ppt-to-base',
      userId,
      interrupted: !isLive(jobId, Number(row.updated_at)),
      settle: () => {
        getGenDb()
          .prepare("UPDATE ppt_to_base_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
          .run('failed', '生成中断（服务重启），已自动退回', nowMs(), jobId);
      },
      chargeKey: String(row.charge_key || ''),
      refundReason: '底座生成中断退回',
      refType: 'ppt-to-base',
      refId: String(row.request_id || jobId),
    };
  });
}
