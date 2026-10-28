// deck typed intent 契约测试：意图是唯一入口；顺序约束由 src/lib/deck-gates.ts 一份不变量生成，
// 拒绝码/文案与 state.availableIntents 同源。由 scripts/test-generation.mjs 汇总调用，全程 mock。
import { readFileSync } from 'node:fs';

export async function runDeckIntentTests(ctx) {
  const { check, auth, decks, fullDeps } = ctx;
  const intents = await import('../../src/lib/deck-intents.ts');
  const envelope = await import('../../src/lib/intent-envelope.ts');
  const gates = await import('../../src/lib/deck-gates.ts');
  const actions = await import('../../src/lib/server/generation/actions.ts');
  const { STYLE_PACKS } = await import('../../src/data/style-packs.ts');
  const { DECK_INTENT_KINDS } = intents;
  // 解析器只有一份：用 deck 的 (kind → 参数校验器) 表走共享意图解析
  const parseDeckIntent = (value) => envelope.parseIntent(value, intents.DECK_INTENT_PARAMS);

  console.log('\n[4d] deck typed intent：唯一入口 / 前置不变量 / 可用集合');

  // ---------- 契约：dispatch 覆盖全部 kind，旧 action 词汇消失 ----------
  const actionsSrc = readFileSync(new URL('../../src/lib/server/generation/actions.ts', import.meta.url), 'utf8');
  const routeSrc = readFileSync(new URL('../../src/app/api/deck/[id]/route.ts', import.meta.url), 'utf8');
  const switchKinds = [...new Set([...actionsSrc.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1]))];
  check('dispatch 的 case 覆盖全部意图（源码 switch ↔ DECK_INTENT_KINDS 双向齐全）',
    switchKinds.length === 20 && DECK_INTENT_KINDS.length === 20
      && DECK_INTENT_KINDS.every((kind) => switchKinds.includes(kind))
      && switchKinds.every((kind) => DECK_INTENT_KINDS.includes(kind)),
    `switch=${switchKinds.length} kinds=${DECK_INTENT_KINDS.length}`);
  check('意图 kind 唯一（无重复登记）', new Set(DECK_INTENT_KINDS).size === 20);
  check('无类型入口已删除：dispatch 不再有 dispatchDeckAction / body.action',
    !actionsSrc.includes('dispatchDeckAction') && !actionsSrc.includes('body.action'));
  check('路由边界只解意图（readIntentParams + deck 表），不再收 action 信封',
    routeSrc.includes('readIntentParams') && routeSrc.includes('DECK_INTENT_PARAMS')
      && !routeSrc.includes('parseDeckRequest'));

  check('解析：合法意图收窄通过',
    parseDeckIntent({ kind: 'commitVersion', params: { slideId: 's1', versionId: 'v1' } })?.kind === 'commitVersion');
  check('解析：缺省 params 按空对象（无参意图可裸发）',
    JSON.stringify(parseDeckIntent({ kind: 'unlockStructure' })?.params) === '{}');
  check('解析：未知 kind 拒绝', parseDeckIntent({ kind: 'drop-database', params: {} })?.ok === false);
  check('解析：非对象 / 数组参数拒绝',
    parseDeckIntent(null)?.ok === false
      && parseDeckIntent('confirmStructure')?.ok === false
      && parseDeckIntent({ kind: 'confirmStructure', params: [] })?.ok === false);

  // ---------- 不变量：同一份规则给出拒绝理由与可用集合 ----------
  const factsOf = (state) => gates.deckGateFacts({
    status: state.deck.status,
    stylePackId: state.deck.stylePackId,
    slides: () => state.slides,
    hasActiveJob: Boolean(state.activeJob),
  });
  const dispatch = (userId, deckId, kind, params = {}) =>
    actions.dispatchDeckIntent(userId, deckId, { kind, params }, fullDeps);
  const catchError = async (fn) => {
    try {
      await fn();
      return null;
    } catch (error) {
      return error;
    }
  };

  const user = await auth.registerWithPassword(
    { account: 'intentuser', password: 'password123', confirmPassword: 'password123' },
    '127.0.0.41',
  );
  const uid = user.user.id;
  const deck = decks.createDeck(uid, {
    title: '意图通道测试',
    sourceFileName: 'intent.docx',
    sourceText: '2025 年营收 1200 万元，同比增长 20%。',
    durationMinutes: 15,
    targetPageCount: 2,
    qualityTier: 'standard',
    stylePackId: '',
  });
  await dispatch(uid, deck.id, 'generateOutline');

  // 大纲出来但未梳理：confirmStructure 被不变量标记不可用，拒绝文案逐字来自它
  let state = decks.getDeckState(uid, deck.id);
  const incompleteDenial = gates.deckGateDenial('confirmStructure', factsOf(state));
  check('未完成梳理时 confirmStructure 不在可用集合（理由由不变量给出）',
    incompleteDenial?.code === 'STRUCTURE_INCOMPLETE'
      && !state.availableIntents.includes('confirmStructure')
      && state.availableIntents.includes('structureSlides'),
    JSON.stringify({ denial: incompleteDenial, available: state.availableIntents }));
  const incompleteError = await catchError(() => dispatch(uid, deck.id, 'confirmStructure'));
  check('未完成梳理直接提交结构 → 拒绝理由逐字来自不变量',
    incompleteError?.code === incompleteDenial?.code
      && incompleteError?.message === incompleteDenial?.message,
    `实际 ${incompleteError?.code} ${incompleteError?.message}`);

  // 全页梳理完成 → confirmStructure 进入可用集合
  await dispatch(uid, deck.id, 'structureSlides');
  state = decks.getDeckState(uid, deck.id);
  check('全部梳理完成后 confirmStructure 进入可用集合',
    state.availableIntents.includes('confirmStructure')
      && gates.deckGateDenial('confirmStructure', factsOf(state)) === null);

  // 确认冻结：内容类意图整体退出可用集合，unlockStructure 进入
  const confirmed = await dispatch(uid, deck.id, 'confirmStructure');
  state = confirmed.state;
  const lockedIntents = [
    'generateOutline', 'addSlide', 'removeSlide', 'reorderSlides', 'splitSlide',
    'updateSlide', 'structureSlides', 'structureSlide', 'confirmStructure',
  ];
  check('确认后内容类意图全部退出可用集合、unlockStructure 进入',
    confirmed.status === 200 && state.contentLocked === true
      && lockedIntents.every((kind) => !state.availableIntents.includes(kind))
      && state.availableIntents.includes('unlockStructure'),
    JSON.stringify(state.availableIntents));

  // 未解锁就改结构 → CONTENT_LOCKED，文案来自同一条不变量
  const lockedDenial = gates.deckGateDenial('updateSlide', factsOf(state));
  const lockedError = await catchError(() =>
    dispatch(uid, deck.id, 'updateSlide', { slideId: state.slides[0].slideId, title: '未解锁改名' }));
  check('冻结后改结构 → CONTENT_LOCKED 且拒绝文案来自不变量',
    lockedError?.code === 'CONTENT_LOCKED' && lockedError?.message === lockedDenial?.message,
    `实际 ${lockedError?.code} ${lockedError?.message}`);

  // 生成前置：未选风格不可生成；选风格后进入可用集合
  check('未选风格时 generateSlides 不在可用集合（理由来自生成前置）',
    !state.availableIntents.includes('generateSlides')
      && gates.deckGateDenial('generateSlides', factsOf(state))?.code === 'STYLE_REQUIRED');
  await dispatch(uid, deck.id, 'setStyle', { stylePackId: STYLE_PACKS[0].id });
  state = decks.getDeckState(uid, deck.id);
  check('选风格后 generateSlides 进入可用集合',
    state.availableIntents.includes('generateSlides'));

  // 解锁：内容动作回到可用集合，unlock 退出
  const unlocked = await dispatch(uid, deck.id, 'unlockStructure');
  check('解锁后内容类意图回到可用集合、unlock 退出',
    unlocked.status === 200 && unlocked.extra.invalidated === 0
      && unlocked.state.contentLocked === false
      && unlocked.state.availableIntents.includes('updateSlide')
      && !unlocked.state.availableIntents.includes('unlockStructure'));

  const unlockedAgain = await dispatch(uid, deck.id, 'unlockStructure');
  check('已解锁时再次 unlock 是幂等 no-op（不新增拒绝面）',
    unlockedAgain.status === 200 && unlockedAgain.extra.alreadyUnlocked === true);
  check('页级意图不登记 deck 级可用集合（改图/参考图逐页判断）',
    !unlocked.state.availableIntents.includes('refineSlide')
      && !unlocked.state.availableIntents.includes('setReferenceImage'));
  check('响应类型无索引签名兜底：dispatch 的 extra 按 kind 收窄',
    !actionsSrc.includes('Record<string, unknown>')
      && actionsSrc.includes('extra: DeckIntentExtra[K]'));
  check('调度器不再清洗请求字段：解析器是唯一清洗点（无 cleanIdList / cleanString(params.*)）',
    !actionsSrc.includes('cleanIdList')
      && !/cleanString\(\s*(?:intent\.)?params\./.test(actionsSrc));

  // ---------- 路由边界：同一条 POST 只服务意图 ----------
  const routeDeck = decks.createDeck(uid, {
    title: '路由信封测试',
    sourceFileName: '',
    sourceText: '路由只做鉴权、收窄参数、调业务层。',
    durationMinutes: 10,
    targetPageCount: 2,
    qualityTier: 'standard',
    stylePackId: '',
  });
  await dispatch(uid, routeDeck.id, 'generateOutline');
  const routeSlideId = decks.getDeckState(uid, routeDeck.id).slides[0].slideId;
  const deckRoute = await import('../../src/app/api/deck/[id]/route.ts');
  const token = auth.createSessionForUser(uid);
  const callRoute = (body) =>
    deckRoute.POST(
      new Request(`http://localhost/api/deck/${routeDeck.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `anppt_v2_session=${token}`,
          'x-anppt-action': '1',
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: routeDeck.id }) },
    );

  const intentRes = await callRoute({
    intent: { kind: 'updateSlide', params: { slideId: routeSlideId, title: '路由改名' } },
  });
  const intentBody = await intentRes.json();
  check('路由：意图通道返回全量 state + 该意图 extra + 可用集合',
    intentRes.status === 200 && intentBody.data.deck && Array.isArray(intentBody.data.slides)
      && intentBody.data.contentChanged === true && intentBody.data.slides[0].title === '路由改名'
      && Array.isArray(intentBody.data.availableIntents),
    JSON.stringify({ status: intentRes.status, extra: intentBody.data?.contentChanged }));

  const legacyRes = await callRoute({ action: 'add-slide' });
  const legacyBody = await legacyRes.json();
  check('路由：旧 {action} 信封被删除（400 缺少意图）',
    legacyRes.status === 400 && legacyBody?.error?.code === 'VALIDATION_ERROR'
      && legacyBody?.error?.message.includes('意图'),
    `实际 ${legacyRes.status} ${legacyBody?.error?.message}`);

  const badIntentRes = await callRoute({ intent: { kind: 'nope' } });
  const badIntentBody = await badIntentRes.json();
  check('路由：未知意图 400 且错误码不变',
    badIntentRes.status === 400 && badIntentBody?.error?.code === 'VALIDATION_ERROR');

  // ---------- 解析失败经路由返回统一 400，且不落任何动作 ----------
  const slidesBeforeReject = decks.getDeckState(uid, routeDeck.id).slides.length;
  const missingFieldRes = await callRoute({ intent: { kind: 'removeSlide', params: {} } });
  const missingFieldBody = await missingFieldRes.json();
  check('路由：字段解析失败 → 400 VALIDATION_ERROR + 解析器文案，deck 不变',
    missingFieldRes.status === 400
      && missingFieldBody?.ok === false
      && missingFieldBody?.error?.code === 'VALIDATION_ERROR'
      && missingFieldBody?.error?.retryable === false
      && missingFieldBody?.error?.message === '缺少 slideId'
      && decks.getDeckState(uid, routeDeck.id).slides.length === slidesBeforeReject,
    `实际 ${missingFieldRes.status} ${missingFieldBody?.error?.code} ${missingFieldBody?.error?.message}`);

  // ---------- 路由只解析一次：kind 解析器单次调用，动作直接用类型化参数 ----------
  const originalUpdateParser = intents.DECK_INTENT_PARAMS.updateSlide;
  let parseCalls = 0;
  intents.DECK_INTENT_PARAMS.updateSlide = (params) => {
    parseCalls += 1;
    return originalUpdateParser(params);
  };
  let onceRes = null;
  try {
    onceRes = await callRoute({
      intent: { kind: 'updateSlide', params: { slideId: routeSlideId, chapter: '第一章' } },
    });
    await onceRes.json();
  } finally {
    intents.DECK_INTENT_PARAMS.updateSlide = originalUpdateParser;
  }
  check('路由只解析一次（解析器恰调用 1 次）',
    onceRes?.status === 200 && parseCalls === 1, `status=${onceRes?.status} calls=${parseCalls}`);

  // ---------- 业务硬门仍在动作里：解析器不替动作做业务判断 ----------
  const unknownPackRes = await callRoute({ intent: { kind: 'setStyle', params: { stylePackId: 'no-such-pack' } } });
  const unknownPackBody = await unknownPackRes.json();
  check('业务硬门仍在动作里：未知风格包解析通过、动作回 400「风格包不存在」',
    unknownPackRes.status === 400 && unknownPackBody?.error?.message === '风格包不存在',
    `实际 ${unknownPackRes.status} ${unknownPackBody?.error?.message}`);

  const refineNoImageRes = await callRoute({
    intent: { kind: 'refineSlide', params: { slideId: routeSlideId, editInstruction: '放大标题' } },
  });
  const refineNoImageBody = await refineNoImageRes.json();
  check('业务硬门仍在动作里：形状合法的改图意图因无生成图 → 409 REFINE_NEEDS_IMAGE',
    refineNoImageRes.status === 409 && refineNoImageBody?.error?.code === 'REFINE_NEEDS_IMAGE',
    `实际 ${refineNoImageRes.status} ${refineNoImageBody?.error?.code}`);
}
