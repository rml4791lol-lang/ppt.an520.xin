// deck 工作台前端契约测试：意图请求体、按意图收窄的响应、可用性推导、链路静态约束。
// 纯客户端：mock globalThis.fetch，不连数据库、不打真实接口。由 scripts/test-generation.mjs 汇总调用。
import { captureFetch, jsonResponse, source } from './client-test-helpers.mjs';

// ts hooks 由 scripts/test-generation.mjs 在加载本文件前注册，动态引入才能解析 src 下的 .ts
let deckGates = null;

// 只填可用性推导会读到的字段，其余留空（真实形状由 src/lib/client/deck-api.ts 定义）
function makeState(overrides = {}) {
  const base = {
    deck: {
      id: 'd1',
      title: '工作台测试',
      status: 'parsed',
      stylePackId: '',
      qualityTier: 'standard',
      durationMinutes: 10,
      targetPageCount: 2,
      sourceFileName: '',
      error: '',
      anchorSlideId: '',
      confirmedAt: null,
      createdAt: 1,
      updatedAt: 1,
    },
    slides: [],
    activeJob: null,
    pageSummary: { total: 0, idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0, stale: 0 },
    contentLocked: false,
  };
  const state = {
    ...base,
    ...overrides,
    deck: { ...base.deck, ...(overrides.deck || {}) },
    pageSummary: { ...base.pageSummary, ...(overrides.pageSummary || {}) },
  };
  // 与服务端同源：可用集合由 deck-gates 按同一份事实算出（fixture 不手写顺序约束）
  state.availableIntents = deckGates.availableIntentsOf(deckGates.deckGateFacts({
    status: state.deck.status,
    stylePackId: state.deck.stylePackId,
    slides: () => state.slides,
    hasActiveJob: Boolean(state.activeJob),
  }));
  return state;
}

function makeSlide(structureStatus, genStatus) {
  return { slideId: `${structureStatus}-${genStatus}`, structureStatus, genStatus };
}

const DECK_CHAIN = [
  'src/app/api/deck/[id]/route.ts',
  'src/lib/client/deck-api.ts',
  'src/lib/client/deck-availability.ts',
  'src/components/deck/deck-workbench.tsx',
  'src/components/deck/step-outline.tsx',
  'src/components/deck/step-structure.tsx',
  'src/components/deck/step-style.tsx',
  'src/components/deck/step-generate.tsx',
];

export async function runDeckWorkbenchTests({ check }) {
  deckGates = await import('../../src/lib/deck-gates.ts');
  const { deckIntentAction } = await import('../../src/lib/client/deck-api.ts');
  const { deriveDeckAvailability } = await import('../../src/lib/client/deck-availability.ts');

  console.log('\n[4e] deck 工作台：意图请求体 / 按意图收窄响应 / 可用性推导');

  // ---------- 请求体只有意图 ----------
  {
    const mock = captureFetch(() =>
      jsonResponse(makeState({ deck: { status: 'structured' }, failedSlides: ['s1'] })));
    try {
      const result = await deckIntentAction('d 1', { kind: 'structureSlides', params: {} });
      const call = mock.calls[0];
      const body = JSON.parse(call.body);
      check('意图请求：POST /api/deck/{id}，body 只有 {intent:{kind,params}}',
        call.url === '/api/deck/d%201' && call.method === 'POST'
          && call.headers['x-anppt-action'] === '1'
          && body.intent?.kind === 'structureSlides'
          && body.intent.params && !('action' in body),
        JSON.stringify(body));
      check('响应按意图收窄：state 与 failedSlides 同层透出',
        result.deck.status === 'structured' && result.failedSlides?.[0] === 's1');
    } finally {
      mock.restore();
    }
  }

  // ---------- 参数原样进意图 ----------
  {
    const mock = captureFetch(() =>
      jsonResponse(makeState({ deck: { status: 'generating' }, job: { jobId: 'j1', status: 'queued', total: 2 } })));
    try {
      const result = await deckIntentAction('d1', { kind: 'generateSlides', params: { forceRegenerate: true } });
      const body = JSON.parse(mock.calls[0].body);
      check('生成意图：forceRegenerate 原样进 params，响应带 job 句柄',
        body.intent?.kind === 'generateSlides' && body.intent.params?.forceRegenerate === true
          && result.job?.jobId === 'j1' && result.job?.total === 2,
        JSON.stringify(body));
    } finally {
      mock.restore();
    }
  }

  // ---------- 可用性由 deck 状态推导 ----------
  const availabilityAt = (overrides) => deriveDeckAvailability(makeState(overrides));

  const outlined = availabilityAt({
    deck: { status: 'outlined' },
    slides: [makeSlide('pending', 'idle'), makeSlide('ok', 'idle')],
    pageSummary: { total: 2, idle: 2 },
  });
  check('可用性：未梳理未冻结 → 可编辑、不可生成/导出',
    outlined.contentEditable === true && outlined.canGenerate === false
      && outlined.pendingStructure === 1 && outlined.structureReady === false
      && outlined.canExport === false && outlined.generating === false,
    JSON.stringify(outlined));

  const structured = availabilityAt({
    deck: { status: 'structured' },
    slides: [makeSlide('ok', 'idle')],
    pageSummary: { total: 1, idle: 1 },
  });
  check('可用性：全部页梳理完成 → structureReady',
    structured.structureReady === true && structured.pendingStructure === 0);

  const emptyStructured = availabilityAt({ deck: { status: 'structured' } });
  check('可用性：零页不算梳理完成（防止空 deck 确认冻结）', emptyStructured.structureReady === false);

  const confirmed = availabilityAt({
    deck: { status: 'confirmed' },
    contentLocked: true,
    slides: [makeSlide('ok', 'idle')],
    pageSummary: { total: 1, idle: 1 },
  });
  check('可用性：冻结后可发起生成、内容只读',
    confirmed.canGenerate === true && confirmed.contentEditable === false
      && confirmed.pendingGeneration === 1);

  const generating = availabilityAt({
    deck: { status: 'confirmed', stylePackId: 'pack-x' },
    contentLocked: true,
    activeJob: {
      jobId: 'j1', kind: 'deck-generate', status: 'running',
      total: 1, succeeded: 0, failed: 1, createdAt: 1, updatedAt: 1,
    },
    slides: [makeSlide('ok', 'failed')],
    pageSummary: { total: 1, failed: 1 },
  });
  check('可用性：活动任务在跑即算生成中（状态未变也一样），且期间不可重试',
    generating.generating === true && generating.canRetryFailed === false);

  const generated = availabilityAt({
    deck: { status: 'generated' },
    contentLocked: true,
    slides: [makeSlide('ok', 'succeeded')],
    pageSummary: { total: 1, succeeded: 1 },
  });
  check('可用性：整套生成成功 → 可导出 / allGenerated / hasGenerated',
    generated.canExport === true && generated.allGenerated === true
      && generated.hasGenerated === true && generated.pendingGeneration === 0);

  const partial = availabilityAt({
    deck: { status: 'partial', stylePackId: 'pack-x' },
    contentLocked: true,
    slides: [makeSlide('ok', 'succeeded'), makeSlide('ok', 'failed')],
    pageSummary: { total: 2, succeeded: 1, failed: 1 },
  });
  check('可用性：部分失败 → 可重试、非 allGenerated、仍可导出成功页',
    partial.canRetryFailed === true && partial.allGenerated === false
      && partial.hasGenerated === true && partial.canExport === true
      && partial.pendingGeneration === 1);

  // ---------- 顺序约束读服务端可用集合 ----------
  const locked = availabilityAt({
    deck: { status: 'confirmed', stylePackId: 'pack-x' },
    contentLocked: true,
    slides: [makeSlide('ok', 'idle')],
    pageSummary: { total: 1, idle: 1 },
  });
  check('可用性：冻结后内容不可改，可用集合把内容类意图换成 unlock',
    locked.contentEditable === false
      && !locked.availableIntents.includes('updateSlide')
      && locked.availableIntents.includes('unlockStructure')
      && locked.availableIntents.includes('generateSlides'),
    JSON.stringify(locked.availableIntents));
  const failedNoStyle = availabilityAt({
    deck: { status: 'partial' },
    contentLocked: true,
    slides: [makeSlide('ok', 'failed')],
    pageSummary: { total: 1, failed: 1 },
  });
  check('可用性：重试按钮跟可用集合走（缺风格时不算可重试）',
    failedNoStyle.canRetryFailed === false && failedNoStyle.availableIntents.length >= 0);

  // ---------- 静态约束：链路不再出现无类型请求体 ----------
  const rawBodies = DECK_CHAIN.filter((rel) => source(rel).includes('Record<string, unknown>'));
  check('deck 路由与工作台链路不再出现 Record<string, unknown> 请求体',
    rawBodies.length === 0, rawBodies.join(', '));

  const stringActions = DECK_CHAIN
    .filter((rel) => rel.startsWith('src/components/deck/'))
    .filter((rel) => /run\(\s*"/.test(source(rel)));
  check('工作台四步只发意图（无 run("action") 字符串调用）',
    stringActions.length === 0, stringActions.join(', '));

  const legacyHelpers = DECK_CHAIN.filter((rel) => /\bdeckAction\(/.test(source(rel)));
  check('客户端不再暴露无类型 deckAction（只留意图通道）',
    legacyHelpers.length === 0, legacyHelpers.join(', '));

  const indexSignatures = DECK_CHAIN.filter((rel) =>
    /\[\s*key:\s*string\s*\]\s*:\s*unknown/.test(source(rel)));
  check('响应类型不再用索引签名兜未知字段（按意图收窄）',
    indexSignatures.length === 0, indexSignatures.join(', '));
}
