// 单页动作目录 + 统一执行器：busy 作用域、互斥、401/402 归一、失败文案只在这里生成。
// 纯函数：dispatch / 提示 / 页面判活全部注入，可脱离 DOM 测试（scripts/tests/single-page-actions.test.mjs）。
// 机制与取舍见 docs/DEBUG-HANDBOOK.md §7。
import type { SpPage } from "./single-page-store";
import { ApiClientError } from "./api";

/** 走执行器的三个单页动作（图片版/可编辑导出各有独立入口与轮询，不进这里） */
export type SinglePageActionKind = "generatePage" | "refinePage" | "selectVersion";

export type SinglePageBilling = "charged" | "free";

export interface SinglePageActionDefinition {
  billing: SinglePageBilling;
  /** 失败文案（服务端没有原话时使用；收费动作自带未扣星承诺） */
  failure: string;
  /** 同一页上哪些在飞动作会拦住本动作——互斥规则只在这里声明一次 */
  blockedBy?: readonly SinglePageActionKind[];
  /** 被拦住时的提示（缺省静默：同一动作重复点击不提示） */
  blockedNotice?: string;
}

const SINGLE_PAGE_ACTIONS: Record<SinglePageActionKind, SinglePageActionDefinition> = {
  generatePage: {
    billing: "charged",
    failure: "生图模型繁忙，本次生图失败，不扣除星星，可重新生成。",
  },
  refinePage: {
    billing: "charged",
    failure: "图片优化失败，本次失败不扣除星星，可稍后重新优化。",
  },
  selectVersion: {
    billing: "free",
    failure: "切换版本失败，请重新尝试",
    blockedBy: ["generatePage", "refinePage"],
    blockedNotice: "页面正在生成中，请稍候再切换版本",
  },
};

export function singlePageActionDefinition(kind: SinglePageActionKind): SinglePageActionDefinition {
  return SINGLE_PAGE_ACTIONS[kind];
}

/** 页面状态「生成中」按哪个动作并入在飞：恢复现场/服务端仍在生成时，切版本同样要等 */
const PAGE_RUNNING_AS: SinglePageActionKind = "generatePage";

export interface SinglePageInflight {
  kind: SinglePageActionKind;
  /** 锁定的页面：忙与互斥都按「动作类型 + pageId」派生 */
  entityId: string;
  /** 切版本时正在切换的版本 id（只用于「切换中…」文案） */
  versionId?: string;
}

export type SinglePageActionState = "idle" | "running" | "blocked";

/**
 * 派生的「忙」唯一规则：同动作同页在飞 = running；被目录声明的互斥动作、
 * 或「本页仍在生成」拦下 = blocked。两者都算忙，但只有 blocked 需要提示。
 */
export function singlePageActionState(
  inflight: readonly SinglePageInflight[],
  kind: SinglePageActionKind,
  pageId: string,
  pageRunning = false,
): SinglePageActionState {
  if (inflight.some((action) => action.kind === kind && action.entityId === pageId)) return "running";
  const blockedBy = SINGLE_PAGE_ACTIONS[kind].blockedBy ?? [];
  if (blockedBy.some((blocker) => inflight.some((action) => action.kind === blocker && action.entityId === pageId))) {
    return "blocked";
  }
  return pageRunning && blockedBy.includes(PAGE_RUNNING_AS) ? "blocked" : "idle";
}

export function isSinglePageActionBusy(
  inflight: readonly SinglePageInflight[],
  kind: SinglePageActionKind,
  pageId: string,
  pageRunning = false,
): boolean {
  return singlePageActionState(inflight, kind, pageId, pageRunning) !== "idle";
}

export interface SinglePageGenerateAction {
  kind: "generatePage";
  pageId: string;
  /** 点击时的页面快照：上传原稿、拼内容、失败回退都读它 */
  page: SpPage;
  /** 本次要生成的版本数（1/2/4，逐版本串行） */
  versions: number;
}

export interface SinglePageRefineAction {
  kind: "refinePage";
  pageId: string;
  instruction: string;
}

export interface SinglePageSelectVersionAction {
  kind: "selectVersion";
  pageId: string;
  versionId: string;
}

export type SinglePageAction =
  | SinglePageGenerateAction
  | SinglePageRefineAction
  | SinglePageSelectVersionAction;

/** 动作结果：只有域内失败（HTTP 200 但不是成功）需要执行器生成提示 */
export interface SinglePageActionOutcome {
  failure?: { message?: string };
}

export type SinglePageDispatch = (action: SinglePageAction) => Promise<SinglePageActionOutcome>;

export interface SinglePageActionFailure {
  unauthorized: boolean;
  insufficient: boolean;
  message: string;
}

/** 失败归一：401 跳登录（保留服务端原话）、402 走充值引导，其余按动作目录兜底文案。 */
export function normalizeSinglePageActionError(
  error: unknown,
  kind: SinglePageActionKind,
): SinglePageActionFailure {
  const err = error instanceof ApiClientError ? error : null;
  return {
    unauthorized: err?.isUnauthorized ?? false,
    insufficient: err?.isInsufficientCredits ?? false,
    message: err?.message || SINGLE_PAGE_ACTIONS[kind].failure,
  };
}

export interface SinglePageActionRunnerDeps {
  dispatch: SinglePageDispatch;
  onUnauthorized: () => void;
  onInsufficientCredits: (message: string) => void;
  toast: (text: string) => void;
  /** 在飞集合变化（hook 镜像成渲染态；判重仍由执行器同步完成） */
  onBusyChange: (inflight: readonly SinglePageInflight[]) => void;
  /** 本页是否仍在生成（服务端状态/恢复现场）：按目录规则并入在飞 */
  isPageRunning?: (pageId: string) => boolean;
}

export interface SinglePageRunOptions {
  /** 失败静默：调用方把同一份文案渲染进页面（生成失败的错误屏），不弹 toast */
  silent?: boolean;
  /** 失败回调：调用方自行落地展示；文案仍只由执行器生成一次 */
  onFailure?: (failure: SinglePageActionFailure) => void;
}

export type SinglePageRun = (
  action: SinglePageAction,
  opts?: SinglePageRunOptions,
) => Promise<SinglePageActionOutcome | null>;

export interface SinglePageActionRunner {
  run: SinglePageRun;
  /** 在飞动作快照（key = 动作类型 + 页） */
  inflight: () => readonly SinglePageInflight[];
}

export function createSinglePageActionRunner(deps: SinglePageActionRunnerDeps): SinglePageActionRunner {
  const inflight = new Map<string, SinglePageInflight>();
  const publish = () => deps.onBusyChange([...inflight.values()]);
  const pageRunning = (pageId: string) => deps.isPageRunning?.(pageId) ?? false;

  const run: SinglePageRun = async (action, opts = {}) => {
    const definition = SINGLE_PAGE_ACTIONS[action.kind];
    const state = singlePageActionState(
      [...inflight.values()],
      action.kind,
      action.pageId,
      pageRunning(action.pageId),
    );
    if (state !== "idle") {
      if (state === "blocked" && definition.blockedNotice) deps.toast(definition.blockedNotice);
      return null;
    }

    const key = `${action.kind}:${action.pageId}`;
    inflight.set(key, {
      kind: action.kind,
      entityId: action.pageId,
      versionId: action.kind === "selectVersion" ? action.versionId : undefined,
    });
    publish();
    try {
      const outcome = await deps.dispatch(action);
      if (outcome?.failure) {
        const failure: SinglePageActionFailure = {
          unauthorized: false,
          insufficient: false,
          message: outcome.failure.message || definition.failure,
        };
        opts.onFailure?.(failure);
        if (!opts.silent) deps.toast(failure.message);
        return null;
      }
      return outcome ?? {};
    } catch (error) {
      const failure = normalizeSinglePageActionError(error, action.kind);
      if (failure.unauthorized) {
        deps.onUnauthorized();
        return null;
      }
      if (failure.insufficient) deps.onInsufficientCredits(failure.message);
      else if (!opts.silent) deps.toast(failure.message);
      opts.onFailure?.(failure);
      return null;
    } finally {
      inflight.delete(key);
      publish();
    }
  };

  return { run, inflight: () => [...inflight.values()] };
}
