// 恢复运行源（RunSource）契约与注册表：每个生成域只列「在途运行 + 结算动作 + 扣费键」，
// 平台恢复入口（recovery.ts）只做过期判定、按 ledger 实扣退款、日志与计数——不 import 模块、
// 不出现按域分支。判活时钟与 paid-run 在飞注册表经 RunSourceContext 注入，来源不自读时间。
// 域在装配期登记：平台两源随本模块导入登记，模块源由顶层 src/recovery-assembly.ts 注入
// （平台件不得 import 模块，见 docs/DEVELOPMENT.md §1）。

/** 一段被判定为中断的在途任务。判活结论由运行源给出（用 ctx 的口径），收敛与补退统一走 reconcileInterrupted。 */
export interface InterruptedRun {
  /** 日志用稳定标识（slideId / pageId / exportId） */
  key: string;
  /** 生成类型：deck | single-page | editable | ppt-to-base */
  domain: string;
  userId: string;
  /** 已判定中断（无人认领且心跳过期）；false = 仍在途，一概不动 */
  interrupted: boolean;
  /** 已扣费键：有则按 ledger 实扣金额补退（退款键定长派生，重复执行不双退） */
  chargeKey?: string;
  refundReason?: string;
  refType: string;
  refId: string;
  /**
   * 结算方式：refund（默认）= 先按实扣金额退星再置终态；resume = 续跑（不退星）。
   * 续跑的结算动作只启动管线、不等待：同一运行由域内去重保证最多一条管线。
   */
  settlement?: 'refund' | 'resume';
  /** 收敛动作（幂等）：refund 型置 failed；resume 型启动续跑管线后立即返回 */
  settle: () => void;
}

/** 判活口径由恢复入口注入（时钟可注入给崩溃测试）：运行源不碰 paid-run 在飞注册表，也不读真实时间。 */
export interface RunSourceContext {
  /** 该运行的心跳是否已超过 jobStaleMs（用注入时钟） */
  isStale(heartbeatMs: number): boolean;
  /** 本进程是否仍在跑这条运行（paid-run 在飞注册表；整套批次键 = jobId，逐页键 = 扣费键） */
  isInFlight(runId: string): boolean;
  /** 仍在途 = 本进程在跑，或心跳未过期（跨进程残留在心跳窗口内不误收敛） */
  isLive(runId: string, heartbeatMs: number): boolean;
}

/** 一个生成域的在途运行来源：只列行与给出结算动作，扣费/退款/终态顺序归 paid-run。 */
export interface RunSource {
  /** 域标识（deck / single-page / ppt-to-base / editable） */
  domain: string;
  listRuns(userId: string, ctx: RunSourceContext): InterruptedRun[];
}

// instrumentation 与路由各是一套 webpack 入口、模块级缓存各有一份：注册表挂进程级，
// 否则启动钩子登记的模块源在路由入口里看不见（与 plugin/default.ts、db.ts 同一做法）。
const globalRef = globalThis as typeof globalThis & { __anpptV2RunSources?: RunSource[] };

function runSources(): RunSource[] {
  if (!globalRef.__anpptV2RunSources) globalRef.__anpptV2RunSources = [];
  return globalRef.__anpptV2RunSources;
}

/** 装配期登记运行源（不在请求期登记）；同域重复登记以最后一次为准，热重载与测试替换都幂等。 */
export function registerRunSources(sources: RunSource[]): void {
  const registered = runSources();
  for (const source of sources) {
    const domain = String(source?.domain || '').trim();
    if (!domain) throw new Error('运行源缺少域标识');
    const index = registered.findIndex((entry) => entry.domain === domain);
    if (index >= 0) registered[index] = source;
    else registered.push(source);
  }
}

/** 当前已登记的运行源（顺序 = 登记顺序 = 收敛顺序）。 */
export function listRunSources(): RunSource[] {
  return [...runSources()];
}
