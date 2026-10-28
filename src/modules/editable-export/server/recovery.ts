// 可编辑导出的运行源：本模块的在途行与结算动作只在这里暴露，平台恢复入口只调度。
//
// 判活口径 = paid-run 在飞注册表（键 = 扣费键）+ export_jobs.updated_at 心跳：
// 480s 上传/转换期间没有进度落库，靠的是在飞登记；跨进程残留靠心跳（jobStaleMs）。
// 结算口径 = 续跑（不退款）：有扣费且未退款的行续跑管线（已有可恢复上游任务时先推进它，
// 不重新上传/建任务）；未扣费的中途行（claim 后进程死亡）按失败收敛，不白跑一次上游；
// 退款已落账、置终态前崩溃的行只补 failed 终态——续跑等于免费交付一次。
import { deriveRefundKey } from '@/lib/server/credits';
import { getGenDb, nowMs } from '@/lib/server/generation/db';
import type { InterruptedRun, RunSource } from '@/lib/server/generation/run-source';
import { editableChargeKey } from './charge-keys';
import { resumeInterruptedExport } from './editable';

/**
 * 不可续跑的中途行置 failed：
 * - 未扣费（claim 后进程死亡）：钱没扣，重新发起即可；
 * - 已退款（退款已落账、置终态前崩溃）：续跑等于免费交付一次，只补终态。
 */
function failInterruptedExport(exportId: string, refunded: boolean): void {
  const now = nowMs();
  getGenDb()
    .prepare(
      `UPDATE export_jobs SET status = 'failed', stage = 'failed', error = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'processing')`,
    )
    .run(
      refunded ? '转换中断，星星已退回，请重新转换' : '转换尚未开始（服务重启），星星未扣，请重新转换',
      now,
      now,
      exportId,
    );
}

/** 退款是否已落账：决定「续跑」还是「只补终态」——已退款的行绝不能续跑（否则免费交付）。 */
function refundAlreadyIssued(chargeKey: string): boolean {
  return Boolean(
    getGenDb().prepare('SELECT 1 FROM credit_ledger WHERE idempotency_key = ?').get(deriveRefundKey(chargeKey)),
  );
}

export const editableRunSource: RunSource = {
  domain: 'editable',
  listRuns(userId, ctx): InterruptedRun[] {
    const rows = getGenDb()
      .prepare(
        `SELECT id, kind, ref_type, ref_id, charged_credits, updated_at FROM export_jobs
         WHERE user_id = ? AND status IN ('pending', 'processing') AND kind IN ('editable', 'editable_text')`,
      )
      .all(userId) as Array<{
        id: string;
        kind: string;
        ref_type: string;
        ref_id: string;
        charged_credits: number;
        updated_at: number;
      }>;
    return rows.map((row) => {
      const exportId = String(row.id);
      const chargeKey = editableChargeKey({
        kind: row.kind,
        refId: String(row.ref_id || ''),
        exportId,
      });
      const refunded = refundAlreadyIssued(chargeKey);
      const resumable = Number(row.charged_credits) > 0 && !refunded;
      return {
        key: exportId,
        domain: 'editable',
        userId,
        interrupted: !ctx.isLive(chargeKey, Number(row.updated_at)),
        // 有扣费且未退款 = 续跑（不退星，结算只启动管线）；否则按失败收敛（钱已不在或从未扣）
        settlement: resumable ? 'resume' : 'refund',
        chargeKey,
        refundReason: '可编辑导出中断退回',
        refType: String(row.ref_type || 'deck'),
        refId: String(row.ref_id || ''),
        settle: () => {
          if (resumable) {
            resumeInterruptedExport(exportId);
            return;
          }
          failInterruptedExport(exportId, refunded);
        },
      };
    });
  },
};
