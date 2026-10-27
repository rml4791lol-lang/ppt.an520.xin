// deck 顺序约束的唯一声明：意图 → 前置条件 + 拒绝理由。
// 服务端用同一份规则拒绝动作并算出 state.availableIntents，客户端按钮状态读这份集合，
// 所以「先解锁才能改结构」既不在错误文案里，也不在文档里——只有这里一处定义。
import { DECK_INTENT_KINDS, type DeckIntentKind } from './deck-intents';

/** 已冻结的状态（确认结构及之后）：内容类意图一律拒绝，改内容需先解锁结构。 */
const CONTENT_LOCKED_STATUSES = ['confirmed', 'generating', 'generated', 'partial'];

export function isDeckContentLocked(status: string): boolean {
  return CONTENT_LOCKED_STATUSES.includes(status);
}

/** 规则只读页的两列状态；server 行与 client 视图结构兼容 */
export interface DeckGateSlide {
  structureStatus: string;
  genStatus: string;
  pageIndex: number;
}

export interface DeckGateFacts {
  contentLocked: boolean;
  generating: boolean;
  styleSelected: boolean;
  slideCount: number;
  /** 未完成梳理的页序号（1 起），用于拼拒绝文案 */
  pendingStructurePages: number[];
  failedSlideCount: number;
}

/**
 * facts 由调用方按自己的状态构造。slides 用惰性函数：规则不读页信息时不触发查询
 * （内容类意图只关心冻结标志，不该为它多查一次页表）。
 */
export function deckGateFacts(input: {
  status: string;
  stylePackId: string;
  slides: () => readonly DeckGateSlide[];
  hasActiveJob?: boolean;
}): DeckGateFacts {
  let cached: readonly DeckGateSlide[] | null = null;
  const list = (): readonly DeckGateSlide[] => (cached ??= input.slides());
  return {
    contentLocked: isDeckContentLocked(input.status),
    generating: input.status === 'generating' || Boolean(input.hasActiveJob),
    styleSelected: input.stylePackId !== '',
    get slideCount() {
      return list().length;
    },
    get pendingStructurePages() {
      return list()
        .filter((slide) => slide.structureStatus !== 'ok')
        .map((slide) => slide.pageIndex + 1);
    },
    get failedSlideCount() {
      return list().filter((slide) => slide.genStatus === 'failed').length;
    },
  };
}

export interface DeckGateDenial {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
}

type Deny = (facts: DeckGateFacts) => DeckGateDenial | null;

function firstDenial(denies: readonly Deny[]): Deny {
  return (facts) => {
    for (const deny of denies) {
      const denial = deny(facts);
      if (denial) return denial;
    }
    return null;
  };
}

const contentLocked: Deny = (facts) =>
  facts.contentLocked
    ? {
        code: 'CONTENT_LOCKED',
        message: '内容已冻结：请先解锁结构再修改（解锁将作废已生成的页面图）',
        status: 409,
        retryable: false,
      }
    : null;

const needsSlides: Deny = (facts) =>
  facts.slideCount === 0
    ? { code: 'NO_SLIDES', message: '请先生成大纲', status: 400, retryable: false }
    : null;

const structureComplete: Deny = (facts) =>
  facts.pendingStructurePages.length === 0
    ? null
    : {
        code: 'STRUCTURE_INCOMPLETE',
        message: `还有 ${facts.pendingStructurePages.length} 页未完成内容梳理（第 ${facts.pendingStructurePages.join('、')} 页），请先重梳或删除`,
        status: 409,
        retryable: false,
      };

const structureConfirmed: Deny = (facts) =>
  facts.contentLocked
    ? null
    : {
        code: 'STRUCTURE_NOT_CONFIRMED',
        message: '请先完成内容梳理并确认结构',
        status: 409,
        retryable: false,
      };

const styleRequired: Deny = (facts) =>
  facts.styleSelected
    ? null
    : { code: 'STYLE_REQUIRED', message: '请先选择设计风格', status: 400, retryable: false };

const generationRunning = (message: string): Deny => (facts) =>
  facts.generating
    ? { code: 'GENERATION_RUNNING', message, status: 409, retryable: true }
    : null;

const versionTooEarly: Deny = (facts) =>
  facts.contentLocked
    ? null
    : {
        code: 'VERSION_SELECT_TOO_EARLY',
        message: '请先确认内容并生成页面',
        status: 409,
        retryable: false,
      };

const noFailedSlides: Deny = (facts) =>
  facts.failedSlideCount > 0
    ? null
    : { code: 'VALIDATION_ERROR', message: '没有失败的页面', status: 400, retryable: false };

/** 生成前置：生成中 → 未确认 → 未选风格；generate.ts 启动校验也用它，措辞不分叉。 */
export function generationPrecondition(facts: DeckGateFacts): DeckGateDenial | null {
  return firstDenial([
    generationRunning('生成正在进行中，请稍候'),
    structureConfirmed,
    styleRequired,
  ])(facts);
}

interface DeckGate {
  /** 不满足即拒绝（码/文案/HTTP 状态都由规则给出） */
  deny?: Deny;
  /** 是否在状态上宣告可用；缺省 = 无拒绝即可用。用于「调用是无害 no-op 但按钮该隐藏」的意图 */
  offered?: (facts: DeckGateFacts) => boolean;
}

// 只登记有 deck 级顺序约束的意图；改图/参考图/单页生成依赖具体页状态，逐页判断，不在此集合内。
const DECK_GATES: Partial<Record<DeckIntentKind, DeckGate>> = {
  generateOutline: { deny: contentLocked },
  addSlide: { deny: contentLocked },
  removeSlide: { deny: contentLocked },
  reorderSlides: { deny: contentLocked },
  splitSlide: { deny: contentLocked },
  updateSlide: { deny: contentLocked },
  structureSlides: { deny: firstDenial([contentLocked, needsSlides]) },
  structureSlide: { deny: firstDenial([contentLocked, needsSlides]) },
  confirmStructure: { deny: firstDenial([contentLocked, needsSlides, structureComplete]) },
  unlockStructure: {
    deny: generationRunning('生成进行中，请等待完成后再解锁'),
    offered: (facts) => facts.contentLocked && !facts.generating,
  },
  setStyle: { deny: generationRunning('生成进行中，暂不能切换风格') },
  generateSlides: { deny: generationPrecondition },
  retryFailedSlides: { deny: firstDenial([noFailedSlides, generationPrecondition]) },
  commitVersion: {
    deny: firstDenial([generationRunning('生成进行中，请稍后再切换版本'), versionTooEarly]),
  },
};

/** 该意图当前被哪条前置拒绝（null = 放行） */
export function deckGateDenial(kind: DeckIntentKind, facts: DeckGateFacts): DeckGateDenial | null {
  return DECK_GATES[kind]?.deny?.(facts) ?? null;
}

/** deck 级顺序约束当前允许的意图（被拒的不在集合里；页级意图不登记则恒不出现） */
export function availableIntentsOf(facts: DeckGateFacts): DeckIntentKind[] {
  return DECK_INTENT_KINDS.filter((kind) => {
    const gate = DECK_GATES[kind];
    if (!gate) return false;
    if (gate.deny?.(facts)) return false;
    return gate.offered ? gate.offered(facts) : true;
  });
}
