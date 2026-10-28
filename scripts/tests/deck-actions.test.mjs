// [4h] deck 动作执行器（src/lib/client/deck-actions.ts）前端契约：
// 402 归一、busy 作用域（动作类型 + 实体）、成功清理与余额刷新、退款承诺文案只生成一处。
// 纯客户端：注入 dispatch / 余额刷新 / toast，不连数据库、不打真实接口、不渲染 DOM。
// 由 scripts/test-generation.mjs 汇总调用。
import { source } from './client-test-helpers.mjs';

const DECK_COMPONENTS = [
  'src/components/deck/deck-workbench.tsx',
  'src/components/deck/step-generate.tsx',
  'src/components/deck/step-outline.tsx',
  'src/components/deck/step-structure.tsx',
  'src/components/deck/step-style.tsx',
];

/** 本套件断言过的「失败会退星」句：只允许出现在 src/lib/client/deck-actions.ts。 */
const REFUND_PROMISE = '本次未扣除星星，可重新尝试。';

/** 只填执行器会碰到的字段（真实形状由 src/lib/client/deck-api.ts 定义）。 */
function deckState(extra = {}) {
  return {
    deck: {
      id: 'd1',
      title: '执行器测试',
      status: 'generated',
      stylePackId: 'pack-x',
      qualityTier: 'standard',
      durationMinutes: 10,
      targetPageCount: 2,
      sourceFileName: '',
      error: '',
      anchorSlideId: '',
      confirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    slides: [],
    activeJob: null,
    pageSummary: { total: 0, idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0, stale: 0 },
    contentLocked: true,
    availableIntents: [],
    ...extra,
  };
}

/** 执行器夹具：dispatch / 状态 / 余额 / 402 / toast / busy 全部可观测。 */
function harness(options = {}) {
  const actions = options.actions;
  const calls = {
    dispatched: [],
    states: [],
    credits: 0,
    insufficient: [],
    toasts: [],
    busy: [],
    cleaned: [],
  };
  const runner = actions.createDeckActionRunner({
    deckId: options.deckId ?? 'd1',
    dispatch: async (intent) => {
      calls.dispatched.push(intent);
      if (options.dispatch) return options.dispatch(intent);
      return deckState();
    },
    onState: (state) => calls.states.push(state),
    onCreditsChanged: () => {
      calls.credits += 1;
    },
    onInsufficientCredits: (message) => calls.insufficient.push(message),
    toast: (text) => calls.toasts.push(text),
    onBusyChange: (keys) => calls.busy.push([...keys]),
  });
  return { runner, calls };
}

/** 一直被挂起的 dispatch：用来观察在飞动作集合。 */
function deferredDispatch() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    dispatch: async () => {
      await gate;
      return deckState();
    },
  };
}

export async function runDeckActionTests({ check }) {
  const actions = await import('../../src/lib/client/deck-actions.ts');
  const { ApiClientError } = await import('../../src/lib/client/api.ts');

  console.log('\n[4h] deck 动作执行器：402 归一 / busy 作用域 / 退款承诺 / 成功清理');

  // ---------- busy 作用域：动作类型 + 实体 ----------
  {
    const gated = deferredDispatch();
    const { runner, calls } = harness({ actions, dispatch: gated.dispatch });
    const pending = runner.run({
      kind: 'refineSlide',
      params: { slideId: 's1', editInstruction: '标题放大' },
    });
    const keys = runner.inflight();
    check('busy 键 = 动作类型 + 实体（改进图只锁该页）', keys.join(',') === 'refineSlide:s1', keys.join(','));
    check('同一动作同一页在飞 → 该动作忙',
      actions.isDeckActionBusy(keys, 'refineSlide', 's1') === true);
    check('不同动作不共享一个布尔：同一页的擦除/改字/参考图仍可点',
      actions.isDeckActionBusy(keys, 'eraseSlide', 's1') === false
        && actions.isDeckActionBusy(keys, 'editSlideText', 's1') === false
        && actions.isDeckActionBusy(keys, 'setReferenceImage', 's1') === false);
    check('同一动作换一页不互斥', actions.isDeckActionBusy(keys, 'refineSlide', 's2') === false);
    check('整套动作不被页级动作锁住', actions.isDeckActionBusy(keys, 'generateSlides', 'd1') === false);

    const duplicate = await runner.run({
      kind: 'refineSlide',
      params: { slideId: 's1', editInstruction: '标题放大' },
    });
    check('同一动作对同一实体不重复提交（第二次直接返回 null）',
      duplicate === null && calls.dispatched.length === 1, `dispatched=${calls.dispatched.length}`);

    const parallel = runner.run({ kind: 'setReferenceImage', params: { slideId: 's1' } });
    const inFlight = runner.inflight();
    check('不同价位动作可并行（免费参考图不被收费微调锁住）',
      inFlight.slice().sort().join(',') === 'refineSlide:s1,setReferenceImage:s1', inFlight.join(','));

    gated.release();
    await pending;
    await parallel;
    check('在飞动作结束后 busy 清空', runner.inflight().length === 0, runner.inflight().join(','));
    check('busy 变化对外发布（渲染态由 hook 镜像）',
      calls.busy.length === 4 && calls.busy[0].join(',') === 'refineSlide:s1'
        && calls.busy[calls.busy.length - 1].length === 0,
      JSON.stringify(calls.busy));
  }

  // ---------- 402 归一：弹充值引导，不弹 toast ----------
  {
    const { runner, calls } = harness({
      actions,
      dispatch: async () => {
        throw new ApiClientError('INSUFFICIENT_CREDITS', '🌟 星星不足，请充值后继续', 402);
      },
    });
    const result = await runner.run({ kind: 'refineSlide', params: { slideId: 's1', editInstruction: 'x' } });
    check('402 归一：走充值引导且不弹 toast',
      result === null && calls.insufficient.length === 1 && calls.toasts.length === 0,
      JSON.stringify({ insufficient: calls.insufficient, toasts: calls.toasts }));
    check('402 带服务端文案', calls.insufficient[0] === '🌟 星星不足，请充值后继续', calls.insufficient[0]);
    check('402 后 busy 清空且不刷新余额',
      runner.inflight().length === 0 && calls.credits === 0 && calls.states.length === 0);
  }

  // ---------- 失败文案：收费动作承诺未扣星，免费动作只提示重试 ----------
  {
    const { runner, calls } = harness({
      actions,
      dispatch: async () => {
        throw new ApiClientError('GENERATION_RUNNING', '生成正在进行中，请稍候', 409);
      },
    });
    await runner.run({ kind: 'eraseSlide', params: { slideId: 's1', markImageDataUrl: 'data:image/png;base64,x' } });
    check('收费动作失败：文案含退款承诺且只弹一条',
      calls.toasts.length === 1 && calls.toasts[0] === `高精清除提交失败，${REFUND_PROMISE}`,
      calls.toasts.join(' | '));
    check('失败不应用状态、不刷新余额', calls.states.length === 0 && calls.credits === 0);

    await runner.run({ kind: 'setReferenceImage', params: { slideId: 's1' } });
    check('免费动作失败：只提示重试、不提退款',
      calls.toasts[1] === '参考图设置失败，请重试。', calls.toasts.join(' | '));

    await runner.run({ kind: 'generateSlides', params: {} });
    check('整套生成失败：已登记为收费动作，文案带未扣星承诺（不再回退服务端原话）',
      calls.toasts[2] === `整套生成提交失败，${REFUND_PROMISE}`, calls.toasts.join(' | '));

    await runner.run({ kind: 'retryFailedSlides', params: {} });
    check('重试失败页失败：收费动作同样承诺未扣星',
      calls.toasts[3] === `重试失败页提交失败，${REFUND_PROMISE}`, calls.toasts.join(' | '));

    await runner.run({ kind: 'structureSlides', params: {} });
    check('内容梳理失败：免费动作只提示重试，不误报退款',
      calls.toasts[4] === '内容梳理失败，请重试。', calls.toasts.join(' | '));

    await runner.run({ kind: 'updateSlide', params: { slideId: 's1', title: '新标题' } });
    check('未登记动作失败：沿用服务端文案（行为不变）',
      calls.toasts[5] === '生成正在进行中，请稍候', calls.toasts.join(' | '));

    const silent = harness({
      actions,
      dispatch: async () => {
        throw new ApiClientError('LLM_RATE_LIMITED', '请求过于频繁', 429);
      },
    });
    const notices = [];
    const silentResult = await silent.runner.run(
      { kind: 'generateOutline', params: {} },
      { silent: true, onFailure: (_failure, message) => notices.push(message) },
    );
    check('silent + onFailure：错误屏拿到与 toast 同一份文案，不弹提示',
      silentResult === null && silent.calls.toasts.length === 0
        && notices[0] === '大纲生成失败，请重试。', JSON.stringify({ notices, toasts: silent.calls.toasts }));
    check('动作目录：支付/免费语义覆盖全部已迁移 handler',
      ['generateSlides', 'retryFailedSlides', 'generateSlide', 'refineSlide', 'eraseSlide', 'editSlideText', 'fuseSlide']
        .every((kind) => actions.deckActionDefinition(kind)?.billing === 'charged')
        && ['generateOutline', 'structureSlides', 'structureSlide', 'splitSlide', 'setReferenceImage', 'commitVersion']
          .every((kind) => actions.deckActionDefinition(kind)?.billing === 'free'));
    check('页面级错误展示复用同一承诺（组件不手写第二份文案）',
      actions.deckChargeNotice('generateSlide', '生成服务超时或返回异常。')
        === '生成服务超时或返回异常，本次未扣除星星，可重新尝试。'
        && actions.deckChargeNotice('structureSlide', '梳理服务超时') === '梳理服务超时，请重试。');
  }

  // ---------- 登录态失效：用服务端原话，不拼退款承诺 ----------
  {
    const { runner, calls } = harness({
      actions,
      dispatch: async () => {
        throw new ApiClientError('UNAUTHORIZED', '请先登录后再操作', 401);
      },
    });
    await runner.run({ kind: 'commitVersion', params: { slideId: 's1', versionId: 'v1' } });
    check('401：提示登录原话且不误报退款', calls.toasts.length === 1 && calls.toasts[0] === '请先登录后再操作',
      calls.toasts.join(' | '));
    check('401 不走充值引导', calls.insufficient.length === 0);
  }

  // ---------- 成功：应用状态 + 余额刷新 + 目录文案 + 清理动作 ----------
  {
    const { runner, calls } = harness({ actions });
    let cleaned = 0;
    const result = await runner.run(
      { kind: 'refineSlide', params: { slideId: 's1', editInstruction: '标题放大' } },
      { onSuccess: () => { cleaned += 1; } },
    );
    check('成功：应用响应状态', result !== null && calls.states.length === 1 && calls.states[0].deck.status === 'generated');
    check('成功：收费动作由执行器刷新余额', calls.credits === 1, `credits=${calls.credits}`);
    check('成功文案由动作目录生成', calls.toasts.length === 1 && calls.toasts[0] === '已开始微调本页，完成后自动更新',
      calls.toasts.join(' | '));
    check('成功清理动作由执行器调度一次', cleaned === 1);
    check('成功后 busy 清空', runner.inflight().length === 0);
  }

  // ---------- 参考图：成功文案随响应字段变化，免费动作不刷余额 ----------
  {
    const setAnchor = harness({ actions });
    await setAnchor.runner.run({ kind: 'setReferenceImage', params: { slideId: 's1' } });
    check('设参考图：成功文案来自响应字段',
      setAnchor.calls.toasts[0] === '已设为全套参考图，后续生成与改图将优先对齐本页风格',
      setAnchor.calls.toasts.join(' | '));
    check('免费动作成功不刷新余额', setAnchor.calls.credits === 0, `credits=${setAnchor.calls.credits}`);

    const clearAnchor = harness({
      actions,
      dispatch: async () => deckState({ deck: { ...deckState().deck, anchorSlideId: '' }, anchorCleared: true }),
    });
    await clearAnchor.runner.run({ kind: 'setReferenceImage', params: { slideId: null } });
    check('取消参考图：成功文案跟随响应（anchorCleared）',
      clearAnchor.calls.toasts[0] === '已取消全套参考图', clearAnchor.calls.toasts.join(' | '));
  }

  // ---------- 成功文案可被调用点抑制（同一动作在不同入口的提示不同） ----------
  {
    const { runner, calls } = harness({ actions });
    await runner.run({ kind: 'generateSlide', params: { slideId: 's1' } }, { success: false });
    check('success:false：不提示但仍应用状态、刷新余额',
      calls.toasts.length === 0 && calls.states.length === 1 && calls.credits === 1,
      JSON.stringify({ toasts: calls.toasts, states: calls.states.length, credits: calls.credits }));
  }

  // ---------- 动作目录：收费/免费语义 + 实体推导 ----------
  {
    for (const kind of ['refineSlide', 'eraseSlide', 'editSlideText', 'fuseSlide', 'generateSlide', 'generateSlides', 'retryFailedSlides']) {
      const definition = actions.deckActionDefinition(kind);
      check(`动作目录：${kind} 登记为收费（失败承诺未扣星）`, definition?.billing === 'charged',
        JSON.stringify(definition));
    }
    for (const kind of ['generateOutline', 'structureSlides', 'structureSlide', 'splitSlide', 'setReferenceImage', 'commitVersion']) {
      const definition = actions.deckActionDefinition(kind);
      check(`动作目录：${kind} 登记为免费（失败只提示重试）`, definition?.billing === 'free',
        JSON.stringify(definition));
    }
    const entityOf = (intent) => actions.deckActionEntity(intent, 'd1');
    check('实体推导：带 slideId 的意图锁该页，其余锁整套',
      entityOf({ kind: 'refineSlide', params: { slideId: 's9', editInstruction: 'x' } }) === 's9'
        && entityOf({ kind: 'reorderSlides', params: { order: ['a'] } }) === 'd1'
        && entityOf({ kind: 'setReferenceImage', params: { slideId: null } }) === 'd1');
  }

  // ---------- 静态约束：退款承诺与忙碌不变量只有一处 ----------
  {
    const handRolled402 = DECK_COMPONENTS.filter((rel) => source(rel).includes('isInsufficientCredits'));
    check('402 归一只有一处：组件不再各自判断星星不足', handRolled402.length === 0, handRolled402.join(', '));

    const scattered = DECK_COMPONENTS.filter((rel) => source(rel).includes(REFUND_PROMISE));
    check('退款承诺不在组件里手写（只在动作目录生成）', scattered.length === 0, scattered.join(', '));

    // 任何「不扣除星星 / 未扣除星星」句都只允许由动作目录生成
    const legacyPromises = DECK_COMPONENTS.filter((rel) => /不扣除星星|未扣除星星/.test(source(rel)));
    check('组件不再手写任何退款/未扣星承诺（文案只在动作目录）',
      legacyPromises.length === 0, legacyPromises.join(', '));

    const executor = source('src/lib/client/deck-actions.ts');
    check('动作目录是退款承诺的唯一来源', executor.includes(REFUND_PROMISE));
    check('页面级错误展示走 deckChargeNotice（同一承诺）', executor.includes('export function deckChargeNotice'));

    const slideEditor = source('src/components/deck/step-generate.tsx');
    check('单页编辑器不再用本地 submitting 布尔表示忙', !/setSubmitting/.test(slideEditor));
    check('单页编辑器不再用 retryingId 布尔表示忙', !/\bretryingId\b/.test(slideEditor));
    check('单页编辑器按「动作 + 页」取 busy（六个动作同一执行器）',
      ['refineSlide', 'eraseSlide', 'editSlideText', 'fuseSlide', 'setReferenceImage', 'generateSlide']
        .every((kind) => slideEditor.includes(`busy("${kind}", slide.slideId)`)),
      ['refineSlide', 'eraseSlide', 'editSlideText', 'fuseSlide', 'setReferenceImage', 'generateSlide']
        .filter((kind) => !slideEditor.includes(`busy("${kind}", slide.slideId)`)).join(', '));

    const workbench = source('src/components/deck/deck-workbench.tsx');
    check('工作台不再用 busyKind 单布尔表示在飞动作', !/\bbusyKind\b/.test(workbench));
    check('工作台的在飞状态由执行器派生（busy 读动作键）',
      /busy\("generateOutline"\)/.test(workbench) && /busy\("structureSlides"\)/.test(workbench));

    const deckHook = source('src/components/deck/use-deck-actions.ts');
    check('deck 执行器实例跨渲染稳定（latest-ref 读取回调，不在 useMemo 里重建）',
      deckHook.includes('useRef(input)') && deckHook.includes('runner.current')
        && !/useMemo\(/.test(deckHook),
      deckHook.slice(0, 120));
    check('单页执行器同样用 latest-ref（两个 hook 同一去重口径）',
      source('src/components/single-page/use-single-page-actions.ts').includes('useRef(input)'));
  }
}
