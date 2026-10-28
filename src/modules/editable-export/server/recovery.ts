// 可编辑导出的运行源：本模块的在途行只在这里暴露，平台恢复入口与读路径都只调度。
// 判活与结算口径（心跳 + 在飞注册表、已退款不续跑）与读路径共用 editable.ts 的
// interruptedEditableRun——同一份结算，不在这里复制（见 docs/DEBUG-HANDBOOK.md §4/§6）。
import { getGenDb } from '@/lib/server/generation/db';
import type { InterruptedRun, RunSource } from '@/lib/server/generation/run-source';
import { interruptedEditableRun, resumeInterruptedExport } from './editable';

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
    return rows.map((row) => interruptedEditableRun(row, ctx, resumeInterruptedExport));
  },
};
