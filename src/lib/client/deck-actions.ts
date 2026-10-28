// deck 动作目录 + 统一执行器：402 归一、余额刷新、busy 作用域、成功/失败文案只在这里生成。
// 组件只声明动作与成功清理；「失败会退星」的承诺由动作的计费语义统一拼出（见 docs/DEBUG-HANDBOOK.md §7）。
import type { DeckIntent, DeckIntentKind } from "../deck-intents";
import { ApiClientError } from "./api";
import type { DeckIntentResult, DeckState } from "./deck-api";

/** 动作的计费语义：收费动作失败必须承诺未扣星；免费动作只提示可以重试。 */
export type DeckBilling = "charged" | "free";

export interface DeckActionDefinition<Result> {
  billing: DeckBilling;
  /** 失败文案主语（退款承诺由目录统一拼在后面） */
  failure: string;
  /** 成功文案：固定句，或按响应附带字段生成（缺省不提示） */
  success?: string | ((result: Result) => string);
}

type DeckActionTable = {
  [K in DeckIntentKind]?: DeckActionDefinition<DeckIntentResult<K>>;
};

const REFUND_PROMISE: Record<DeckBilling, string> = {
  charged: "，本次未扣除星星，可重新尝试。",
  free: "，请重试。",
};

/**
 * 动作目录：kind → 计费语义（决定退款承诺）+ 失败/成功文案。
 * 收费动作（整套生成 / 重试失败页 / 六种页级改图）必须登记，失败才有未扣星承诺；
 * 免费动作（大纲/梳理/拆页/参考图/切版本）只提示重试。未登记的动作回退服务端文案。
 */
const DECK_ACTIONS: DeckActionTable = {
  generateOutline: {
    billing: "free",
    failure: "大纲生成失败",
  },
  structureSlides: {
    billing: "free",
    failure: "内容梳理失败",
    success: (result) =>
      (result.failedSlides?.length ?? 0) > 0
        ? `内容梳理完成，${result.failedSlides?.length} 页失败（可对失败页重试）`
        : "内容梳理完成",
  },
  structureSlide: {
    billing: "free",
    failure: "本页梳理失败",
  },
  splitSlide: {
    billing: "free",
    failure: "拆页失败",
    success: (result) => `已拆分为 ${result.into} 页`,
  },
  generateSlides: {
    billing: "charged",
    failure: "整套生成提交失败",
    success: "已开始生成整套页面，完成后自动更新",
  },
  retryFailedSlides: {
    billing: "charged",
    failure: "重试失败页提交失败",
    success: "已开始重试失败页，完成后自动更新",
  },
  generateSlide: {
    billing: "charged",
    failure: "重新生成提交失败",
    success: "已开始重新生成本页，完成后自动更新",
  },
  refineSlide: {
    billing: "charged",
    failure: "微调提交失败",
    success: "已开始微调本页，完成后自动更新",
  },
  eraseSlide: {
    billing: "charged",
    failure: "高精清除提交失败",
    success: "已开始高精清除，完成后自动更新",
  },
  editSlideText: {
    billing: "charged",
    failure: "图上改字提交失败",
    success: "已开始图上改字，完成后自动更新",
  },
  fuseSlide: {
    billing: "charged",
    failure: "模板融合提交失败",
    success: "已开始模板融合，完成后自动更新",
  },
  setReferenceImage: {
    billing: "free",
    failure: "参考图设置失败",
    success: (result) =>
      result.anchorCleared
        ? "已取消全套参考图"
        : "已设为全套参考图，后续生成与改图将优先对齐本页风格",
  },
  commitVersion: {
    billing: "free",
    failure: "切换版本失败",
  },
};

export function deckActionDefinition<K extends DeckIntentKind>(
  kind: K,
): DeckActionDefinition<DeckIntentResult<K>> | undefined {
  return DECK_ACTIONS[kind] as DeckActionDefinition<DeckIntentResult<K>> | undefined;
}

/** busy 键 = 动作类型 + 实体 id：不同动作、不同页互不阻塞 */
function deckActionKey(kind: DeckIntentKind, entityId: string): string {
  return `${kind}:${entityId}`;
}

/** 动作锁定的实体：带 slideId 的页级意图锁该页，其余锁整套 */
export function deckActionEntity(intent: DeckIntent, deckId: string): string {
  const slideId = "slideId" in intent.params ? intent.params.slideId : null;
  return typeof slideId === "string" && slideId ? slideId : deckId;
}

export function isDeckActionBusy(
  keys: readonly string[],
  kind: DeckIntentKind,
  entityId: string,
): boolean {
  return keys.includes(deckActionKey(kind, entityId));
}

/** 失败归一：星星不足走充值引导，未登录保留服务端原话，其余文案可重试。 */
export interface DeckActionFailure {
  insufficient: boolean;
  unauthorized: boolean;
  message: string;
}

export function normalizeDeckActionError(error: unknown): DeckActionFailure {
  const err =
    error instanceof ApiClientError
      ? error
      : new ApiClientError("UNKNOWN", "操作失败，请重新尝试", 0, true);
  return {
    insufficient: err.isInsufficientCredits,
    unauthorized: err.isUnauthorized,
    message: err.isInsufficientCredits ? err.message || "🌟 星星不足，请充值后继续" : err.message,
  };
}

/** 失败文案唯一生成处：收费动作带未扣星承诺，免费动作只提示重试，未登记动作用服务端文案。 */
function deckActionFailureText(kind: DeckIntentKind, failure: DeckActionFailure): string {
  if (failure.unauthorized) return failure.message;
  const action = deckActionDefinition(kind);
  return action ? `${action.failure}${REFUND_PROMISE[action.billing]}` : failure.message;
}

/**
 * 页面级错误（服务端给的 genError 等）在客户端展示时复用同一条计费承诺：
 * 组件只提供错误详情，不再手写「未扣除星星」之类第二份文案。
 */
export function deckChargeNotice(kind: DeckIntentKind, detail: string): string {
  const action = deckActionDefinition(kind);
  const text = detail.trim().replace(/[。.\s]+$/u, "");
  return action ? `${text}${REFUND_PROMISE[action.billing]}` : text;
}

export interface DeckActionRunOptions<K extends DeckIntentKind> {
  /** 成功清理：清空输入、退出涂抹模式等；余额刷新由执行器统一调度 */
  onSuccess?: (result: DeckIntentResult<K>) => void;
  /** 成功提示覆盖：false = 不提示（同一动作在不同入口的提示不同） */
  success?: string | ((result: DeckIntentResult<K>) => string) | false;
  /** 失败静默：调用方自己展示（如大纲错误屏） */
  silent?: boolean;
  /** 失败回调：调用方要展示全屏错误/页内提示时，直接用执行器生成的同一份文案 */
  onFailure?: (failure: DeckActionFailure, message: string) => void;
}

export type DeckActionRun = <K extends DeckIntentKind>(
  intent: Extract<DeckIntent, { kind: K }>,
  opts?: DeckActionRunOptions<K>,
) => Promise<DeckIntentResult<K> | null>;

export interface DeckActionRunnerDeps {
  deckId: string;
  dispatch: <K extends DeckIntentKind>(
    intent: Extract<DeckIntent, { kind: K }>,
  ) => Promise<DeckIntentResult<K>>;
  onState: (state: DeckState) => void;
  onCreditsChanged: () => void;
  onInsufficientCredits: (message: string) => void;
  toast: (text: string) => void;
  /** 在飞集合变化（hook 镜像成渲染态；执行器内部同步判重，不依赖渲染） */
  onBusyChange: (keys: readonly string[]) => void;
}

export interface DeckActionRunner {
  run: DeckActionRun;
  /** 在飞动作键快照（key = 动作类型 + 实体） */
  inflight: () => readonly string[];
}

export function createDeckActionRunner(deps: DeckActionRunnerDeps): DeckActionRunner {
  const keys = new Set<string>();
  const publish = () => deps.onBusyChange([...keys]);

  const run: DeckActionRun = async (intent, opts = {}) => {
    const key = deckActionKey(intent.kind, deckActionEntity(intent, deps.deckId));
    if (keys.has(key)) return null;
    keys.add(key);
    publish();
    try {
      const result = await deps.dispatch(intent);
      const action = deckActionDefinition(intent.kind);
      deps.onState(result);
      if (action?.billing === "charged") deps.onCreditsChanged();
      const text =
        opts.success === false
          ? ""
          : typeof opts.success === "function"
            ? opts.success(result)
            : (opts.success ?? successText(action, result));
      if (text) deps.toast(text);
      opts.onSuccess?.(result);
      return result;
    } catch (error) {
      const failure = normalizeDeckActionError(error);
      const message = deckActionFailureText(intent.kind, failure);
      if (failure.insufficient) deps.onInsufficientCredits(failure.message);
      else if (!opts.silent) deps.toast(message);
      opts.onFailure?.(failure, message);
      return null;
    } finally {
      keys.delete(key);
      publish();
    }
  };

  return { run, inflight: () => [...keys] };
}

function successText<K extends DeckIntentKind>(
  action: DeckActionDefinition<DeckIntentResult<K>> | undefined,
  result: DeckIntentResult<K>,
): string {
  if (!action?.success) return "";
  return typeof action.success === "string" ? action.success : action.success(result);
}
