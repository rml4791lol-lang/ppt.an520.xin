// 底座任务的中断结算入口：ppt_to_base_jobs 只由本模块读写，平台 recovery 只调度。
// 判活口径（paid-run 在飞注册表 + 心跳过期）由平台注入——恢复入口反过来要 import 本模块，
// 直接互导会成环。退款与置终态的顺序归 paid-run.failPaidRun（先退款、再置 failed）。
import { getGenDb, nowMs } from '@/lib/server/generation/db';
import type { InterruptedRun } from '@/lib/server/generation/recovery';

/** 平台注入的在途判定：运行仍在跑（注册表命中或心跳未过期）返回 true。runId = 扣费键。 */
export type RunLivenessCheck = (runId: string, heartbeatMs: number) => boolean;

/**
 * 列出本用户的在途底座任务，并给出结算动作与退款描述（平台统一收敛与补退时调度）。
 * 结算语义与模块内失败分支一致：按 charge_key 由平台先补退、再置 failed。
 */
export function interruptedPptToBaseRuns(userId: string, isLive: RunLivenessCheck): InterruptedRun[] {
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
      interrupted: !isLive(chargeKey, Number(row.updated_at)),
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
}
