// 单页 / 导出 / 后台 typed intent 契约测试：意图→路由分发、解析护栏、服务器适配器，
// 以及三条真实路由（单页版本选择 / 导出报价 / 后台配置保存）的端到端。
// 由 scripts/test-generation.mjs 与 scripts/test-backend.mjs 汇总调用，全程 mock。

export async function runSurfaceIntentTests(ctx) {
  const {
    check, expectThrows, auth, singlePages, credits, uid,
    makeMockFetcher, editsOkHandler, PNG_1X1_B64, imageConfig, deck,
  } = ctx;
  const sp = await import('../../src/lib/single-page-intents.ts');
  const ex = await import('../../src/lib/export-intents.ts');
  const envelope = await import('../../src/lib/intent-envelope.ts');
  const server = await import('../../src/lib/server/intents.ts');

  console.log('\n[4f] 单页 / 导出 typed intent 契约');

  const spCalls = [
    { kind: 'generatePage', params: { pageId: 'p', content: 'c' } },
    { kind: 'refinePage', params: { pageId: 'p', editInstruction: 'x' } },
    { kind: 'selectVersion', params: { pageId: 'p', versionId: 'v' } },
    { kind: 'exportImagePptx', params: { projectId: 'pr' } },
    { kind: 'exportEditablePptx', params: { projectId: 'pr' } },
  ].map((intent) => sp.toSinglePageActionCall(intent));
  check('单页 5 个意图全部落在既有路由且路径互不重复',
    spCalls.length === 5
      && new Set(spCalls.map((call) => call.path)).size === 5
      && spCalls.every((call) => call.method === 'POST' && call.path.startsWith('/api/single-page/')),
    JSON.stringify(spCalls.map((call) => call.path)));
  check('单页意图分发：生成/优化/选版/两条导出各自路由固定',
    spCalls[0].path === '/api/single-page/generate'
      && spCalls[1].path === '/api/single-page/refine'
      && spCalls[2].path === '/api/single-page/select-version'
      && spCalls[3].path === '/api/single-page/export-image-pptx'
      && spCalls[4].path === '/api/single-page/export-editable-pptx');

  const exCalls = [
    { kind: 'exportDeckImage', params: { deckId: 'deck/1' } },
    { kind: 'exportDeckEditable', params: { deckId: 'deck/1', force: true } },
    { kind: 'exportDeckTextEditable', params: { deckId: 'deck/1' } },
  ].map((intent) => ex.toExportActionCall(intent));
  check('导出 3 个意图：deck 三条导出，路径互不重复（报价意图已删除）',
    new Set(exCalls.map((call) => call.path)).size === 3
      && exCalls.every((call) => call.path.startsWith('/api/deck/')));
  check('导出意图把 deckId 编码进路径（斜杠不逃逸出路由段）',
    exCalls[0].path === '/api/deck/deck%2F1/export-image'
      && exCalls[1].path === '/api/deck/deck%2F1/export-editable'
      && exCalls[2].path === '/api/deck/deck%2F1/export-editable-text',
    exCalls[0].path);

  check('单页解析：合法意图 / 可选参数缺省 / 必填缺失拒绝 / 未知 kind / 非对象参数',
    envelope.parseIntent({ kind: 'selectVersion', params: { pageId: 'p', versionId: 'v' } }, sp.SINGLE_PAGE_INTENT_PARAMS)?.kind === 'selectVersion'
      && envelope.parseIntent({ kind: 'exportImagePptx', params: {} }, sp.SINGLE_PAGE_INTENT_PARAMS)?.ok === true
      && envelope.parseIntent({ kind: 'selectVersion' }, sp.SINGLE_PAGE_INTENT_PARAMS)?.ok === false
      && envelope.parseIntent({ kind: 'drop-database', params: {} }, sp.SINGLE_PAGE_INTENT_PARAMS)?.ok === false
      && envelope.parseIntent({ kind: 'selectVersion', params: [] }, sp.SINGLE_PAGE_INTENT_PARAMS)?.ok === false
      && envelope.parseIntent(null, sp.SINGLE_PAGE_INTENT_PARAMS)?.ok === false);
  check('导出解析：合法意图 / 未知 kind / 数组参数拒绝',
    envelope.parseIntent({ kind: 'exportDeckEditable', params: { deckId: 'd' } }, ex.EXPORT_INTENT_PARAMS)?.kind === 'exportDeckEditable'
      && envelope.parseIntent({ kind: 'exportDeckImage', params: [] }, ex.EXPORT_INTENT_PARAMS)?.ok === false
      && envelope.parseIntent({ kind: 'nope' }, ex.EXPORT_INTENT_PARAMS)?.ok === false);
  check('路由侧 expected kind 拒绝错配（不把别的动作参数当自己的）',
    envelope.parseIntent({ kind: 'selectVersion', params: {} }, sp.SINGLE_PAGE_INTENT_PARAMS, 'generatePage')?.ok === false
      && envelope.parseIntent({ kind: 'exportDeckImage', params: { deckId: 'd' } }, ex.EXPORT_INTENT_PARAMS, 'exportDeckEditable')?.ok === false);

  await expectThrows('服务器适配器：无 intent 信封一律 400（旧 body 直通已删除）', () =>
    server.readIntentParams({ pageId: 'legacy-page' }, sp.SINGLE_PAGE_INTENT_PARAMS, 'selectVersion'), 'VALIDATION_ERROR');
  check('服务器适配器：意图信封解出本路由参数',
    server.readIntentParams(
      { intent: { kind: 'selectVersion', params: { pageId: 'p', versionId: 'v' } } },
      sp.SINGLE_PAGE_INTENT_PARAMS,
      'selectVersion',
    ).params.versionId === 'v');
  await expectThrows('服务器适配器：未知意图 → VALIDATION_ERROR（不降级到旧入口）', () =>
    server.readIntentParams(
      { intent: { kind: 'nope', params: {} } },
      sp.SINGLE_PAGE_INTENT_PARAMS,
      'selectVersion',
    ), 'VALIDATION_ERROR');
  await expectThrows('服务器适配器：错配意图 → VALIDATION_ERROR', () =>
    server.readIntentParams(
      { intent: { kind: 'generatePage', params: {} } },
      sp.SINGLE_PAGE_INTENT_PARAMS,
      'selectVersion',
    ), 'VALIDATION_ERROR');

  // ---------- 端到端：单页版本选择经意图通道 ----------
  credits.refundCredits(uid, 30, { reason: '测试补贴', idempotencyKey: 'test-topup-surface-intent' });
  const deps = {
    fetchImpl: makeMockFetcher([
      { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
      editsOkHandler,
    ]),
    config: imageConfig,
  };
  const generated = await singlePages.generateSinglePage(
    uid, { pageId: 'pg-intent-sel', content: '意图通道版本选择' }, deps,
  );
  await singlePages.refineSinglePage(uid, { pageId: 'pg-intent-sel', editInstruction: '加深对比' }, deps);
  const detail = singlePages.getSingleProjectDetail(uid, generated.page.projectId);
  const genVersion = detail.pages[0].versions.find((version) => version.kind === 'generate');
  const refineVersion = detail.pages[0].versions.find((version) => version.kind === 'refine');

  const token = auth.createSessionForUser(uid);
  const post = (url, body) => new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-anppt-action': '1',
      cookie: `anppt_v2_session=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify(body),
  });
  const routeContext = { params: Promise.resolve({}) };
  const selectRoute = await import('../../src/app/api/single-page/select-version/route.ts');

  const viaIntent = await selectRoute.POST(post('http://localhost/api/single-page/select-version', {
    intent: { kind: 'selectVersion', params: { pageId: 'pg-intent-sel', versionId: genVersion.versionId } },
  }), routeContext);
  const viaIntentJson = await viaIntent.json();
  check('单页版本选择经意图通道生效且响应形状不变',
    viaIntent.status === 200 && viaIntentJson?.data?.activeVersionId === genVersion.versionId,
    `实际 ${viaIntent.status}`);

  const viaLegacy = await selectRoute.POST(post('http://localhost/api/single-page/select-version', {
    pageId: 'pg-intent-sel',
    versionId: refineVersion.versionId,
  }), routeContext);
  const viaLegacyJson = await viaLegacy.json();
  const afterLegacy = singlePages.getSingleProjectDetail(uid, generated.page.projectId);
  check('单页版本选择旧 body 被拒（400 缺意图，且不落旧通道）',
    viaLegacy.status === 400 && viaLegacyJson?.error?.code === 'VALIDATION_ERROR'
      && afterLegacy.pages[0].activeVersionId === genVersion.versionId,
    `实际 ${viaLegacy.status} ${viaLegacyJson?.error?.code}`);

  const mismatched = await selectRoute.POST(post('http://localhost/api/single-page/select-version', {
    intent: { kind: 'generatePage', params: {} },
  }), routeContext);
  const mismatchedJson = await mismatched.json();
  check('单页路由拒绝错配意图：400 且不落旧通道',
    mismatched.status === 400 && mismatchedJson?.error?.code === 'VALIDATION_ERROR');

  const missingVersion = await selectRoute.POST(post('http://localhost/api/single-page/select-version', {
    intent: { kind: 'selectVersion', params: { pageId: 'pg-intent-sel' } },
  }), routeContext);
  const missingVersionJson = await missingVersion.json();
  check('单页路由把解析器文案原样套成 400（缺 versionId 不改版本）',
    missingVersion.status === 400
      && missingVersionJson?.error?.code === 'VALIDATION_ERROR'
      && missingVersionJson?.error?.message === '缺少 pageId 或 versionId'
      && singlePages.getSingleProjectDetail(uid, generated.page.projectId).pages[0].activeVersionId === genVersion.versionId,
    `实际 ${missingVersion.status} ${missingVersionJson?.error?.message}`);

  // ---------- 端到端：导出路由经意图通道（解析失败在动作前拒绝） ----------
  const exportEditableRoute = await import('../../src/app/api/deck/[id]/export-editable/route.ts');
  const deckContext = { params: Promise.resolve({ id: deck.id }) };
  const badForce = await exportEditableRoute.POST(post(`http://localhost/api/deck/${deck.id}/export-editable`, {
    intent: { kind: 'exportDeckEditable', params: { deckId: deck.id, force: 'maybe' } },
  }), deckContext);
  const badForceJson = await badForce.json();
  check('导出路由拒绝非法参数：400 VALIDATION_ERROR 且不发起转换',
    badForce.status === 400
      && badForceJson?.error?.code === 'VALIDATION_ERROR'
      && badForceJson?.error?.message === 'force 必须是布尔值',
    `实际 ${badForce.status} ${badForceJson?.error?.message}`);
  check('报价路由已删除：同一信封不再有可分发路径',
    !ex.EXPORT_INTENT_PARAMS.quoteExport
      && !('quoteExport' in ex.EXPORT_INTENT_PARAMS));
}

export async function runAdminIntentTests(ctx) {
  const { check, expectThrows, adminRequest, configRoute } = ctx;
  const intents = await import('../../src/lib/admin-intents.ts');
  const envelope = await import('../../src/lib/intent-envelope.ts');
  const server = await import('../../src/lib/server/intents.ts');

  console.log('\n[10b] 后台管理 typed intent 契约');

  const calls = [
    { kind: 'updateRuntimeConfig', params: { values: { ANPPT_V2_LLM_MODEL: 'm' } } },
    { kind: 'setFeatureFlag', params: { key: 'k', state: 'off' } },
    { kind: 'generateRedemptionCodes', params: { credits: 1000, count: 1 } },
    { kind: 'checkIntegration', params: { kind: 'llm' } },
    { kind: 'setUserRole', params: { userId: 'u/1', role: 'tester' } },
  ].map((intent) => intents.toAdminActionCall(intent));
  check('后台 5 个写意图：方法与路径齐全且互不重复',
    new Set(calls.map((call) => `${call.method} ${call.path}`)).size === 5
      && calls[0].path === '/api/admin/config' && calls[0].method === 'PUT'
      && calls[1].path === '/api/admin/feature-flags' && calls[1].method === 'PUT'
      && calls[2].path === '/api/admin/redemption-codes' && calls[2].method === 'POST'
      && calls[3].path === '/api/admin/integrations/check' && calls[3].method === 'POST',
    JSON.stringify(calls.map((call) => `${call.method} ${call.path}`)));
  check('后台角色意图把 userId 编码进路径',
    calls[4].path === '/api/admin/users/u%2F1/role' && calls[4].method === 'POST');
  check('后台解析：合法 / 必填缺失拒绝 / 未知 kind / 数组参数',
    envelope.parseIntent({ kind: 'setFeatureFlag', params: { key: 'k', state: 'beta' } }, intents.ADMIN_INTENT_PARAMS)?.kind === 'setFeatureFlag'
      && envelope.parseIntent({ kind: 'setFeatureFlag' }, intents.ADMIN_INTENT_PARAMS)?.ok === false
      && envelope.parseIntent({ kind: 'drop-database' }, intents.ADMIN_INTENT_PARAMS)?.ok === false
      && envelope.parseIntent({ kind: 'setFeatureFlag', params: [1] }, intents.ADMIN_INTENT_PARAMS)?.ok === false);
  check('后台路由侧 expected kind 拒绝错配',
    envelope.parseIntent({ kind: 'setFeatureFlag', params: {} }, intents.ADMIN_INTENT_PARAMS, 'updateRuntimeConfig')?.ok === false);
  await expectThrows('后台适配器：未知意图 → VALIDATION_ERROR', () =>
    server.readIntentParams(
      { intent: { kind: 'nope', params: {} } },
      intents.ADMIN_INTENT_PARAMS,
      'updateRuntimeConfig',
    ), 'VALIDATION_ERROR');

  const intentPut = await configRoute.PUT(adminRequest('http://localhost/api/admin/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({
      intent: {
        kind: 'updateRuntimeConfig',
        params: { values: { ANPPT_V2_LLM_MODEL: 'runtime-main-model' } },
      },
    }),
  }));
  const intentPutJson = await intentPut.json();
  check('管理员配置保存经意图通道生效且响应形状不变',
    intentPut.status === 200 && intentPutJson?.ok === true && Array.isArray(intentPutJson?.data?.config?.fields),
    `实际 ${intentPut.status}`);

  const mismatchedPut = await configRoute.PUT(adminRequest('http://localhost/api/admin/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({
      intent: { kind: 'setFeatureFlag', params: { key: 'magic_erase', state: 'off' } },
    }),
  }));
  const mismatchedJson = await mismatchedPut.json();
  check('配置路由拒绝错配意图：400 且不落旧通道',
    mismatchedPut.status === 400 && mismatchedJson?.error?.code === 'VALIDATION_ERROR');

  const badValuesPut = await configRoute.PUT(adminRequest('http://localhost/api/admin/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({
      intent: { kind: 'updateRuntimeConfig', params: { values: [] } },
    }),
  }));
  const badValuesJson = await badValuesPut.json();
  check('配置路由把解析器文案原样套成 400（values 不是对象）',
    badValuesPut.status === 400
      && badValuesJson?.error?.code === 'VALIDATION_ERROR'
      && badValuesJson?.error?.message === 'values 格式不正确',
    `实际 ${badValuesPut.status} ${badValuesJson?.error?.message}`);
}
