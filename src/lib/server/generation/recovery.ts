// 生成链崩溃恢复（懒触发）。
// 背景：deploy 重启/进程崩溃会打断在途生成——deck 卡 generating（409 死锁）、
// 页面卡 queued/running（不在默认重生成范围）、已扣费页没有退款（退款逻辑在
// 内存 catch 里，进程死了不执行）。收敛放在带身份的请求入口（requireUser），
// 读/写路径只表达业务，不必各自记得恢复。
// 判定依据：job 心跳（每页完成时更新 updated_at）超时或已终态 = 进程已死；
// 在飞注册表归 paid-run.ts，本进程活跃任务绝不被收敛。
// 分域知识归运行源（run-source.ts 的注册表 + platform-run-sources.ts / 模块源）：
// 恢复入口只遍历注册表、注入判活时钟（reconcileUser(userId, now)）、统一退款与日志。
import { failPaidRun, isInFlight } from './paid-run';
import { nowMs } from './db';
import { getGenerationConfig } from './config';
import {
  listRunSources,
  type InterruptedRun,
  type RunSourceContext,
} from './run-source';
import { registerPlatformRunSources } from './platform-run-sources';

export type { InterruptedRun } from './run-source';

// 平台两源随本模块导入登记（装配期，不在请求期）；模块源由顶层 src/recovery-assembly.ts 注入。
registerPlatformRunSources();

/** 心跳过期判定：超过 jobStaleMs 视为原进程已死（懒恢复唯一的时间口径；时钟可注入给崩溃测试） */
export function isStale(heartbeatMs: number, now: () => number = nowMs): boolean {
  return Number(heartbeatMs) < now() - getGenerationConfig().jobStaleMs;
}

/**
 * 唯一收敛实现：中断任务 → 先按实扣金额补退 → 再置 failed，返回收敛条数。
 * 顺序归 paid-run.failPaidRun：先退款再置终态，崩在中间仍是在途态、恢复能重试退款。
 * resume 型（可编辑导出）是续跑不是失败：不退星，结算动作只启动管线、hub 不等待。
 * 调用方（运行源）只负责列出在途任务；重复调用幂等。
 */
export function reconcileInterrupted(runs: InterruptedRun[]): number {
  const healed = runs.filter((run) => run.interrupted);
  for (const run of healed) {
    if (run.settlement === 'resume') {
      // 续跑：settle 启动后台管线后立即返回；同一运行最多一条管线由域内去重保证
      run.settle();
      continue;
    }
    failPaidRun({
      userId: run.userId,
      chargeKey: run.chargeKey,
      refundReason: run.refundReason ?? '生成中断退回',
      refType: run.refType,
      refId: run.refId,
      settle: run.settle,
    });
  }
  if (healed.length > 0) {
    const refs = [...new Set(healed.map((run) => `${run.refType}:${run.refId}`))];
    console.warn(`[anppt-v2][recovery] 收敛中断任务 ${healed.length} 条（${refs.join('、')}）`);
  }
  return healed.length;
}

/** 判活上下文：两个恢复入口共用同一口径（时钟可注入给崩溃测试）。 */
export function runSourceContext(now: () => number = nowMs): RunSourceContext {
  return {
    isStale: (heartbeatMs) => isStale(heartbeatMs, now),
    isInFlight: (runId) => isInFlight(runId),
    isLive: (runId, heartbeatMs) => isInFlight(runId) || !isStale(heartbeatMs, now),
  };
}

/**
 * 单条收敛入口（恢复保留两个入口）：读路径手上有这一行时直接收敛，不等整批心跳扫描。
 * 结算实现与整批入口完全相同——只是把同一份 reconcileInterrupted 喂一条，不复制逻辑。
 */
export function reconcileInterruptedRun(run: InterruptedRun): number {
  return reconcileInterrupted([run]);
}

/**
 * 整批恢复入口：按注册表收敛该用户全部生成域的在途任务，返回收敛条数。
 * 由 requireUser 在鉴权门调用——新增读/写路径只要走这道门，就不用再接恢复。
 * 判活时钟经 ctx 注入每个运行源（测试构造崩溃现场不必再改数据库时间戳）；
 * 新增域 = 装配期登记一个运行源，本函数与结算顺序都不动。
 */
export function reconcileUser(userId: string, now: () => number = nowMs): number {
  const ctx = runSourceContext(now);
  return reconcileInterrupted(listRunSources().flatMap((source) => source.listRuns(userId, ctx)));
}
