// [4i] 单页动作执行器（src/lib/client/single-page-actions.ts）前端契约：
// 忙 = 动作类型 + 页、互斥规则只声明一次、401/402 归一、失败文案只生成一处。
// 纯客户端：注入 dispatch / 提示 / 页面判活，不连数据库、不打真实接口、不渲染 DOM。
// 由 scripts/test-generation.mjs 汇总调用。
import path from 'node:path';
import { repoRoot, source, walkSourceFiles } from './client-test-helpers.mjs';

/** 本套件断言过的单页文案：只允许出现在 src/lib/client/single-page-actions.ts。 */
const PAGE_RUNNING_NOTICE = '页面正在生成中，请稍候再切换版本';
const GENERATE_FAILURE = '生图模型繁忙，本次生图失败，不扣除星星，可重新生成。';
const REFINE_FAILURE = '图片优化失败，本次失败不扣除星星，可稍后重新优化。';
const SWITCH_FAILURE = '切换版本失败，请重新尝试';

const SINGLE_PAGE_UI = [
  'src/components/single-page/single-page-client.tsx',
  'src/components/single-page/sp-panels.tsx',
];

/** 三个动作的最小夹具（真实形状见 src/lib/client/single-page-store.ts 的 SpPage）。 */
function page(overrides = {}) {
  return {
    pageId: 'p1',
    kind: 'text',
    text: '这一页的正文',
    stylePackId: 'pack-a',
    status: 'ready',
    versions: [],
    ...overrides,
  };
}

function generateAction(pageId = 'p1') {
  return { kind: 'generatePage', pageId, page: page({ pageId }), versions: 1 };
}

function refineAction(pageId = 'p1') {
  return { kind: 'refinePage', pageId, instruction: '标题放大' };
}

function switchAction(pageId = 'p1', versionId = 'v2') {
  return { kind: 'selectVersion', pageId, versionId };
}

/** 执行器夹具：dispatch / 提示 / 402 / 401 / 页面判活 / busy 全部可观测。 */
function harness(api, options = {}) {
  const calls = {
    dispatched: [],
    toasts: [],
    insufficient: [],
    unauthorized: 0,
    busy: [],
  };
  const runner = api.createSinglePageActionRunner({
    dispatch: async (action) => {
      calls.dispatched.push(action);
      return options.dispatch ? options.dispatch(action) : {};
    },
    onUnauthorized: () => {
      calls.unauthorized += 1;
    },
    onInsufficientCredits: (message) => calls.insufficient.push(message),
    toast: (text) => calls.toasts.push(text),
    onBusyChange: (inflight) => calls.busy.push(inflight.map((a) => `${a.kind}:${a.entityId}`)),
    isPageRunning: (pageId) => (options.running ?? []).includes(pageId),
  });
  return { runner, calls };
}

/** 一直被挂起的 dispatch：用来观察在飞集合与并行规则。 */
function deferredDispatch() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    dispatch: async () => {
      await gate;
      return {};
    },
  };
}

export async function runSinglePageActionTests({ check }) {
  const api = await import('../../src/lib/client/single-page-actions.ts');
  const { ApiClientError } = await import('../../src/lib/client/api.ts');

  console.log('\n[4i] 单页动作执行器：忙作用域 / 互斥 / 401·402 归一 / 失败文案 / 组件零手写');

  // ---------- 忙作用域：动作类型 + 页 ----------
  {
    const gated = deferredDispatch();
    const { runner, calls } = harness(api, { dispatch: gated.dispatch });
    const pending = runner.run(generateAction('p1'));
    const inflight = runner.inflight();
    check('忙键 = 动作类型 + 页（生成只锁该页）',
      inflight.length === 1 && inflight[0].kind === 'generatePage' && inflight[0].entityId === 'p1',
      JSON.stringify(inflight));
    check('同一动作同一页在飞 → 该动作忙',
      api.isSinglePageActionBusy(inflight, 'generatePage', 'p1') === true);
    check('不同动作不共享一个布尔：优化/切版本仍按规则判定',
      api.isSinglePageActionBusy(inflight, 'refinePage', 'p1') === false
        && api.isSinglePageActionBusy(inflight, 'selectVersion', 'p1') === true);
    check('同一动作换一页不互斥', api.isSinglePageActionBusy(inflight, 'generatePage', 'p2') === false);

    const duplicate = await runner.run(generateAction('p1'));
    check('同一动作对同一页不重复提交（第二次直接返回 null）',
      duplicate === null && calls.dispatched.length === 1, `dispatched=${calls.dispatched.length}`);
    check('重复提交静默（不弹「生成中」提示）', calls.toasts.length === 0, calls.toasts.join(' | '));

    const parallel = runner.run(refineAction('p1'));
    const both = runner.inflight().map((a) => `${a.kind}:${a.entityId}`).sort().join(',');
    check('不同动作可并行（优化不被生成锁住，与现状一致）',
      both === 'generatePage:p1,refinePage:p1', both);

    gated.release();
    await pending;
    await parallel;
    check('在飞动作结束后 busy 清空', runner.inflight().length === 0, JSON.stringify(runner.inflight()));
    check('busy 变化对外发布（渲染态由 hook 镜像）',
      calls.busy.length === 4 && calls.busy[0].join(',') === 'generatePage:p1'
        && calls.busy[calls.busy.length - 1].length === 0,
      JSON.stringify(calls.busy));
  }

  // ---------- 互斥规则：切版本等本页生成/优化结束 ----------
  {
    const gated = deferredDispatch();
    const { runner, calls } = harness(api, { dispatch: gated.dispatch });
    const generating = runner.run(generateAction('p1'));
    const generatingSwitch = await runner.run(switchAction('p1'));
    check('生成在飞时切版本被拦下：不派发、弹同一句提示',
      generatingSwitch === null && calls.dispatched.length === 1
        && calls.toasts.join(' | ') === PAGE_RUNNING_NOTICE,
      JSON.stringify({ dispatched: calls.dispatched.length, toasts: calls.toasts }));

    gated.release();
    await generating;

    const refining = runner.run(refineAction('p1'));
    const refiningSwitch = await runner.run(switchAction('p1'));
    check('优化在飞时切版本同样被拦下',
      refiningSwitch === null && calls.dispatched.length === 2
        && calls.toasts[calls.toasts.length - 1] === PAGE_RUNNING_NOTICE,
      JSON.stringify(calls.toasts));
    await refining;
  }

  // ---------- 互斥是单向声明：切版本不锁生成/优化（与现状一致） ----------
  {
    const switchingGate = deferredDispatch();
    const { runner, calls } = harness(api, { dispatch: switchingGate.dispatch });
    const switching = runner.run(switchAction('p1', 'v3'));
    const secondSwitch = await runner.run(switchAction('p1', 'v4'));
    check('切版本按页去重（同一页同时只允许一次切换）',
      secondSwitch === null && calls.dispatched.length === 1,
      JSON.stringify({ dispatched: calls.dispatched.map((a) => a.kind) }));
    const duringSwitch = runner.run(generateAction('p1'));
    check('互斥是单向声明的（切版本不锁生成，与现状一致）',
      calls.dispatched.length === 2,
      JSON.stringify({ dispatched: calls.dispatched.map((a) => a.kind) }));
    switchingGate.release();
    await switching;
    await duringSwitch;
  }

  // ---------- 页面状态「生成中」（恢复现场/服务端仍在跑）并入同一忙规则 ----------
  {
    const { runner, calls } = harness(api, { running: ['p1'] });
    const blockedSwitch = await runner.run(switchAction('p1'));
    check('页面仍在生成（无本地在飞动作）时切版本被拦下',
      blockedSwitch === null && calls.dispatched.length === 0
        && calls.toasts.join(' | ') === PAGE_RUNNING_NOTICE,
      JSON.stringify({ dispatched: calls.dispatched.length, toasts: calls.toasts }));
    const allowedRefine = await runner.run(refineAction('p1'));
    const allowedGenerate = await runner.run(generateAction('p1'));
    check('页面生成中不拦优化/生成（现状：各自独立动作）',
      allowedRefine !== null && allowedGenerate !== null && calls.dispatched.length === 2,
      JSON.stringify({ dispatched: calls.dispatched.map((a) => a.kind) }));

    const switchOnly = api.singlePageActionState([], 'selectVersion', 'p1', false);
    const switchRunning = api.singlePageActionState([], 'selectVersion', 'p1', true);
    check('派生状态：idle / running / blocked 只有这一处规则',
      switchOnly === 'idle' && switchRunning === 'blocked'
        && api.singlePageActionState([{ kind: 'generatePage', entityId: 'p1' }], 'generatePage', 'p1') === 'running');
  }

  // ---------- 402 归一：弹充值引导，不弹 toast ----------
  {
    const { runner, calls } = harness(api, {
      dispatch: async () => {
        throw new ApiClientError('INSUFFICIENT_CREDITS', '🌟 星星不足，请充值后继续', 402);
      },
    });
    const result = await runner.run(generateAction('p1'));
    check('402 归一：走充值引导且不弹 toast',
      result === null && calls.insufficient.length === 1 && calls.toasts.length === 0,
      JSON.stringify({ insufficient: calls.insufficient, toasts: calls.toasts }));
    check('402 带服务端文案', calls.insufficient[0] === '🌟 星星不足，请充值后继续', calls.insufficient[0]);
    check('402 后 busy 清空', runner.inflight().length === 0);
  }

  // ---------- 401：跳登录，保留服务端原话，不弹退款提示 ----------
  {
    const { runner, calls } = harness(api, {
      dispatch: async () => {
        throw new ApiClientError('UNAUTHORIZED', '请先登录后再操作', 401);
      },
    });
    let failure;
    const result = await runner.run(generateAction('p1'), { onFailure: (item) => { failure = item; } });
    check('401 统一跳登录、不弹 toast、不弹充值引导',
      result === null && calls.unauthorized === 1 && calls.toasts.length === 0 && calls.insufficient.length === 0,
      JSON.stringify(calls));
    check('401 不把服务端原话写成页面错误（保持原行为：跳转后停在登录）', failure === undefined);
  }

  // ---------- 失败文案：目录是唯一生成处，服务端原话优先 ----------
  {
    const { runner, calls } = harness(api, {
      dispatch: async () => {
        throw new ApiClientError('GENERATION_RUNNING', '生成正在进行中，请稍候', 409);
      },
    });
    await runner.run(refineAction('p1'));
    check('服务端有原话时用原话（与现状一致）',
      calls.toasts.length === 1 && calls.toasts[0] === '生成正在进行中，请稍候', calls.toasts.join(' | '));

    const fallback = harness(api, {
      dispatch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await fallback.runner.run(refineAction('p1'));
    check('无服务端原话（网络异常）：用目录的收费失败文案',
      fallback.calls.toasts[0] === REFINE_FAILURE, fallback.calls.toasts.join(' | '));
    await fallback.runner.run(switchAction('p1'));
    check('免费动作失败：用目录的重试文案',
      fallback.calls.toasts[1] === SWITCH_FAILURE, fallback.calls.toasts.join(' | '));

    const silent = harness(api, {
      dispatch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    let silentFailure;
    const silentResult = await silent.runner.run(generateAction('p1'), {
      silent: true,
      onFailure: (failure) => { silentFailure = failure; },
    });
    check('silent：失败不弹 toast、由调用方渲染进页面，仍返回 null',
      silentResult === null && silent.calls.toasts.length === 0
        && silentFailure?.message === GENERATE_FAILURE,
      JSON.stringify({ toasts: silent.calls.toasts, failure: silentFailure }));
  }

  // ---------- 域内失败（HTTP 200 但不是成功）：提示仍由执行器生成 ----------
  {
    const { runner, calls } = harness(api, {
      dispatch: async () => ({ failure: { message: '上游模型繁忙' } }),
    });
    const result = await runner.run(refineAction('p1'));
    check('域内失败：服务端原话优先、返回 null',
      result === null && calls.toasts.join(' | ') === '上游模型繁忙', calls.toasts.join(' | '));

    const noMessage = harness(api, { dispatch: async () => ({ failure: {} }) });
    await noMessage.runner.run(refineAction('p1'));
    check('域内失败无原话：回退目录文案', noMessage.calls.toasts[0] === REFINE_FAILURE, noMessage.calls.toasts.join(' | '));
  }

  // ---------- 动作目录：计费语义 + 互斥声明只出现一次 ----------
  {
    check('动作目录：生成/优化是收费动作，切版本免费',
      api.singlePageActionDefinition('generatePage')?.billing === 'charged'
        && api.singlePageActionDefinition('refinePage')?.billing === 'charged'
        && api.singlePageActionDefinition('selectVersion')?.billing === 'free');
    check('收费失败文案自带未扣星承诺、免费文案只提示重试',
      api.singlePageActionDefinition('generatePage').failure.includes('不扣除星星')
        && api.singlePageActionDefinition('refinePage').failure.includes('不扣除星星')
        && api.singlePageActionDefinition('selectVersion').failure === SWITCH_FAILURE);
    check('互斥规则只声明一次：只有切版本声明 blockedBy = 生成 + 优化',
      JSON.stringify(api.singlePageActionDefinition('selectVersion').blockedBy) === '["generatePage","refinePage"]'
        && api.singlePageActionDefinition('generatePage').blockedBy === undefined
        && api.singlePageActionDefinition('refinePage').blockedBy === undefined
        && api.singlePageActionDefinition('selectVersion').blockedNotice === PAGE_RUNNING_NOTICE);
    check('互斥声明在源码里只出现一次（新增动作只能改目录，不能另写 if）',
      source('src/lib/client/single-page-actions.ts').split('blockedBy: [').length === 2,
      `出现 ${source('src/lib/client/single-page-actions.ts').split('blockedBy: [').length - 1} 次`);
  }

  // ---------- 静态约束：三套 Set 与手写文案只在执行器一处 ----------
  {
    const sources = walkSourceFiles(path.join(repoRoot, 'src')).map((full) => {
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      return { rel, text: source(rel) };
    });

    check('三套 busy Set（generatingIds/refiningIds/switchingIds）已从源码消失',
      sources.every(({ text }) => !/generatingIds|refiningIds|switchingIds/.test(text)),
      sources.filter(({ text }) => /generatingIds|refiningIds|switchingIds/.test(text)).map(({ rel }) => rel).join(', '));

    const executor = 'src/lib/client/single-page-actions.ts';
    const onlyInExecutor = (copy) => sources.filter(({ text }) => text.includes(copy)).map(({ rel }) => rel);
    check('「页面生成中」提示只由动作目录生成',
      onlyInExecutor(PAGE_RUNNING_NOTICE).join(',') === executor, onlyInExecutor(PAGE_RUNNING_NOTICE).join(','));
    check('生成失败文案只由动作目录生成',
      onlyInExecutor(GENERATE_FAILURE).join(',') === executor, onlyInExecutor(GENERATE_FAILURE).join(','));
    check('优化失败文案只由动作目录生成',
      onlyInExecutor(REFINE_FAILURE).join(',') === executor, onlyInExecutor(REFINE_FAILURE).join(','));
    check('切版本失败文案只由动作目录生成',
      onlyInExecutor(SWITCH_FAILURE).join(',') === executor, onlyInExecutor(SWITCH_FAILURE).join(','));

    const client = source(SINGLE_PAGE_UI[0]);
    check('单页客户端三个动作都走执行器',
      /run\(\s*\{\s*kind: "generatePage"/.test(client)
        && /run\(\s*\{\s*kind: "refinePage"/.test(client)
        && /run\(\s*\{\s*kind: "selectVersion"/.test(client),
      SINGLE_PAGE_UI[0]);
    check('界面「忙」从执行器派生（三个动作都读 busy）',
      ['generatePage', 'refinePage', 'selectVersion'].every((kind) => client.includes(`busy("${kind}"`)),
      ['generatePage', 'refinePage', 'selectVersion'].filter((kind) => !client.includes(`busy("${kind}"`)).join(', '));

    const panels = source(SINGLE_PAGE_UI[1]);
    check('版本条不再自己读 page.status 判断忙（忙由执行器传入）',
      !panels.includes('=== "generating"') && panels.includes('busy && !active'),
      panels.includes('=== "generating"') ? 'sp-panels 仍有 page.status 忙判断' : 'sp-panels 无 busy 入参');
    check('版本条不再手写「切换中」以外的手势（判重交给执行器）',
      !/switchingIds/.test(panels));
  }
}
