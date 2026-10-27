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
    { kind: 'quoteExport', params: { deckId: 'deck/1' } },
  ].map((intent) => ex.toExportActionCall(intent));
  check('导出 4 个意图：deck 三条导出 + 报价，路径互不重复',
    new Set(exCalls.map((call) => call.path)).size === 4
      && exCalls[3].path === '/api/pptx-exports/quote');
  check('导出意图把 deckId 编码进路径（斜杠不逃逸出路由段）',
    exCalls[0].path === '/api/deck/deck%2F1/export-image'
      && exCalls[1].path === '/api/deck/deck%2F1/export-editable'
      && exCalls[2].path === '/api/deck/deck%2F1/export-editable-text',
    exCalls[0].path);

  check('单页解析：合法意图 / 缺省 params / 未知 kind / 非对象参数',
    sp.parseSinglePageIntent({ kind: 'selectVersion', params: { pageId: 'p', versionId: 'v' } })?.kind === 'selectVersion'
      && JSON.stringify(sp.parseSinglePageIntent({ kind: 'selectVersion' })?.params) === '{}'
      && sp.parseSinglePageIntent({ kind: 'drop-database', params: {} }) === null
      && sp.parseSinglePageIntent({ kind: 'selectVersion', params: [] }) === null
      && sp.parseSinglePageIntent(null) === null);
  check('导出解析：合法意图 / 未知 kind / 数组参数拒绝',
    ex.parseExportIntent({ kind: 'quoteExport', params: { projectId: 'p' } })?.kind === 'quoteExport'
      && ex.parseExportIntent({ kind: 'exportDeckImage', params: [] }) === null
      && ex.parseExportIntent({ kind: 'nope' }) === null);
  check('路由侧 extractor 拒绝错配 kind（不把别的动作参数当自己的）',
    sp.singlePageIntentParams('generatePage', { kind: 'selectVersion', params: {} }) === null
      && ex.exportIntentParams('quoteExport', { kind: 'exportDeckImage', params: { deckId: 'd' } }) === null);

  check('服务器适配器：旧 body 原样直通（兼容分支未改语义）',
    server.readActionParams({ pageId: 'legacy-page' }, () => null).pageId === 'legacy-page');
  check('服务器适配器：意图信封解出本路由参数',
    server.readActionParams(
      { intent: { kind: 'selectVersion', params: { pageId: 'p', versionId: 'v' } } },
      (value) => sp.singlePageIntentParams('selectVersion', value),
    ).versionId === 'v');
  await expectThrows('服务器适配器：未知意图 → VALIDATION_ERROR（不降级到旧入口）', () =>
    server.readActionParams(
      { intent: { kind: 'nope', params: {} } },
      (value) => sp.singlePageIntentParams('selectVersion', value),
    ), 'VALIDATION_ERROR');
  await expectThrows('服务器适配器：错配意图 → VALIDATION_ERROR', () =>
    server.readActionParams(
      { intent: { kind: 'generatePage', params: {} } },
      (value) => sp.singlePageIntentParams('selectVersion', value),
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
  check('单页版本选择旧 body 仍可用（两条通道同语义）',
    viaLegacy.status === 200 && viaLegacyJson?.data?.activeVersionId === refineVersion.versionId);

  const mismatched = await selectRoute.POST(post('http://localhost/api/single-page/select-version', {
    intent: { kind: 'generatePage', params: {} },
  }), routeContext);
  const mismatchedJson = await mismatched.json();
  check('单页路由拒绝错配意图：400 且不落旧通道',
    mismatched.status === 400 && mismatchedJson?.error?.code === 'VALIDATION_ERROR');

  // ---------- 端到端：导出报价经意图通道 ----------
  const editableExport = await import('../../src/modules/editable-export/server/editable.ts');
  const quoteRoute = await import('../../src/app/api/pptx-exports/quote/route.ts');
  const legacyQuote = editableExport.quoteExport(uid, { deckId: deck.id });
  const quoteResponse = await quoteRoute.POST(post('http://localhost/api/pptx-exports/quote', {
    intent: { kind: 'quoteExport', params: { deckId: deck.id } },
  }), routeContext);
  const quoteJson = await quoteResponse.json();
  check('导出报价经意图通道与旧路径结果一致',
    quoteResponse.status === 200
      && quoteJson?.data?.pageCount === legacyQuote.pageCount
      && JSON.stringify(quoteJson?.data?.quotes) === JSON.stringify(legacyQuote.quotes),
    `实际 ${quoteResponse.status}`);
  const wrongQuote = await quoteRoute.POST(post('http://localhost/api/pptx-exports/quote', {
    intent: { kind: 'exportDeckImage', params: { deckId: deck.id } },
  }), routeContext);
  check('导出报价拒绝错配意图：400', wrongQuote.status === 400);
}

export async function runAdminIntentTests(ctx) {
  const { check, expectThrows, adminRequest, configRoute } = ctx;
  const intents = await import('../../src/lib/admin-intents.ts');
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
  check('后台解析：合法 / 缺省 params / 未知 kind / 数组参数',
    intents.parseAdminIntent({ kind: 'setFeatureFlag', params: { key: 'k', state: 'beta' } })?.kind === 'setFeatureFlag'
      && JSON.stringify(intents.parseAdminIntent({ kind: 'setFeatureFlag' })?.params) === '{}'
      && intents.parseAdminIntent({ kind: 'drop-database' }) === null
      && intents.parseAdminIntent({ kind: 'setFeatureFlag', params: [1] }) === null);
  check('后台路由侧 extractor 拒绝错配 kind',
    intents.adminIntentParams('updateRuntimeConfig', { kind: 'setFeatureFlag', params: {} }) === null);
  await expectThrows('后台适配器：未知意图 → VALIDATION_ERROR', () =>
    server.readActionParams(
      { intent: { kind: 'nope', params: {} } },
      (value) => intents.adminIntentParams('updateRuntimeConfig', value),
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
}
