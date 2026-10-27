// deck typed intent 影子通道契约测试：意图↔动作名双射、适配器原样透传、线上解析护栏、
// 一条真实路径（结构提交）端到端。由 scripts/test-generation.mjs 汇总调用，全程 mock。
import { readFileSync } from 'node:fs';

export async function runDeckIntentTests(ctx) {
  const { check, expectThrows, auth, decks, fullDeps } = ctx;
  const intents = await import('../../src/lib/deck-intents.ts');
  const actions = await import('../../src/lib/server/generation/actions.ts');
  const { DECK_INTENT_ACTIONS, toDeckActionCall, parseDeckIntent } = intents;

  console.log('\n[4d] deck typed intent 影子通道');
  // 动作名清单直接读路由源码的 switch，避免维护第三份手抄清单
  const actionsSrc = readFileSync(new URL('../../src/lib/server/generation/actions.ts', import.meta.url), 'utf8');
  const legacyActions = [...new Set([...actionsSrc.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]))];
  const mappedActions = Object.values(DECK_INTENT_ACTIONS);
  check('意图覆盖 body.action 全部 20 个动作名（源码 switch ↔ 映射表双向齐全）',
    legacyActions.length === 20
      && mappedActions.length === 20
      && legacyActions.every((name) => mappedActions.includes(name))
      && mappedActions.every((name) => legacyActions.includes(name)),
    `legacy=${legacyActions.length} mapped=${mappedActions.length}`);
  check('20 个意图一一对应动作名（无双射塌陷）', new Set(mappedActions).size === 20);

  const call1 = toDeckActionCall({ kind: 'confirmStructure', params: {} });
  check('适配器：无参意图 → action=confirm-structure + 空参数',
    call1.action === 'confirm-structure' && JSON.stringify(call1.params) === '{}');
  const call2 = toDeckActionCall({ kind: 'setStyle', params: { stylePackId: 'pack-a' } });
  check('适配器：参数原样透传（不裁剪不补默认值）',
    call2.action === 'style' && JSON.stringify(call2.params) === '{"stylePackId":"pack-a"}');
  const markImage = 'data:image/png;base64,AAAA';
  const call3 = toDeckActionCall({ kind: 'eraseSlide', params: { slideId: 's1', markImageDataUrl: markImage } });
  check('适配器：多参意图原样还原动作名与参数',
    call3.action === 'erase-slide'
      && call3.params.slideId === 's1' && call3.params.markImageDataUrl === markImage);

  check('解析：合法意图收窄通过',
    parseDeckIntent({ kind: 'commitVersion', params: { slideId: 's1', versionId: 'v1' } })?.kind === 'commitVersion');
  check('解析：缺省 params 按空对象（无参意图可裸发）',
    JSON.stringify(parseDeckIntent({ kind: 'unlockStructure' })?.params) === '{}');
  check('解析：未知 kind 拒绝', parseDeckIntent({ kind: 'drop-database', params: {} }) === null);
  check('解析：非对象 / 数组参数拒绝',
    parseDeckIntent(null) === null
      && parseDeckIntent('confirmStructure') === null
      && parseDeckIntent({ kind: 'confirmStructure', params: [] }) === null);

  // ---------- 端到端：结构提交走意图通道 ----------
  const user = await auth.registerWithPassword(
    { account: 'intentuser', password: 'password123', confirmPassword: 'password123' },
    '127.0.0.41',
  );
  const deck = decks.createDeck(user.user.id, {
    title: '意图通道测试',
    sourceFileName: 'intent.docx',
    sourceText: '2025 年营收 1200 万元，同比增长 20%。',
    durationMinutes: 15,
    targetPageCount: 2,
    qualityTier: 'standard',
    stylePackId: '',
  });
  await actions.dispatchDeckAction(user.user.id, deck.id, { action: 'outline' }, fullDeps);
  await actions.dispatchDeckAction(user.user.id, deck.id, { action: 'structure' }, fullDeps);

  const confirmed = await actions.dispatchDeckRequest(
    user.user.id, deck.id, { intent: { kind: 'confirmStructure', params: {} } }, fullDeps);
  check('结构提交经意图通道 → confirmed 且内容冻结',
    confirmed.status === 200 && confirmed.state.deck.status === 'confirmed' && confirmed.state.contentLocked === true,
    `实际 ${confirmed.state.deck.status}`);
  await expectThrows('意图确认后仍套用同一冻结门（legacy outline 被拒）', () =>
    actions.dispatchDeckRequest(user.user.id, deck.id, { action: 'outline', force: true }, fullDeps), 'CONTENT_LOCKED');
  await expectThrows('意图同样受开关板硬门约束（erase-slide 未开放 → NOT_FOUND）', () =>
    actions.dispatchDeckRequest(user.user.id, deck.id, { intent: { kind: 'eraseSlide', params: { slideId: 'x', markImageDataUrl: markImage } } }, fullDeps), 'NOT_FOUND');
  await expectThrows('未知意图 → VALIDATION_ERROR（不静默降级成旧入口）', () =>
    actions.dispatchDeckRequest(user.user.id, deck.id, { intent: { kind: 'nope', params: {} } }, fullDeps), 'VALIDATION_ERROR');

  // ---------- 旧入口经统一入口仍然可用 ----------
  const legacyDeck = decks.createDeck(user.user.id, {
    title: '旧入口回归',
    sourceFileName: 'legacy.docx',
    sourceText: '旧入口仍然可用。',
    durationMinutes: 10,
    targetPageCount: 2,
    qualityTier: 'standard',
    stylePackId: '',
  });
  await actions.dispatchDeckAction(user.user.id, legacyDeck.id, { action: 'outline' }, fullDeps);
  await actions.dispatchDeckAction(user.user.id, legacyDeck.id, { action: 'structure' }, fullDeps);
  const legacyConfirmed = await actions.dispatchDeckRequest(
    user.user.id, legacyDeck.id, { action: 'confirm-structure' }, fullDeps);
  check('旧无类型入口经统一入口仍可用（语义未改）',
    legacyConfirmed.status === 200 && legacyConfirmed.state.deck.status === 'confirmed');
}
