// 单页 / 导出 / 后台三张意图表的解析器契约测试：kind → 解析器是「什么 payload 合法」的唯一回答。
// 解析器是纯函数（前后端共用、不含 IO）：类型、字符串上限、布尔归一、数组/对象清洗、枚举在它内部；
// 计费/幂等/权限/开关/资源存在性等业务硬门仍由路由或动作决定。报价路径已删除（无客户端消费方）。
// 由 scripts/test-generation.mjs 与 scripts/test-backend.mjs 汇总调用。

import { existsSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

export async function runSurfaceIntentParserTests({ check }) {
  const sp = await import('../../src/lib/single-page-intents.ts');
  const ex = await import('../../src/lib/export-intents.ts');
  const envelope = await import('../../src/lib/intent-envelope.ts');
  const server = await import('../../src/lib/server/intents.ts');
  const editable = await import('../../src/modules/editable-export/server/editable.ts');
  const parseSp = (kind, params) => envelope.parseIntent({ kind, params }, sp.SINGLE_PAGE_INTENT_PARAMS);
  const parseEx = (kind, params) => envelope.parseIntent({ kind, params }, ex.EXPORT_INTENT_PARAMS);

  console.log('\n[4i] 单页 / 导出意图解析器：kind → 解析（类型 / 上限 / 布尔 / 数组）');

  // ---------- 表结构：三表迁移完成、报价 kind 不再登记 ----------
  const spKinds = Object.keys(sp.SINGLE_PAGE_INTENT_PARAMS);
  const exKinds = Object.keys(ex.EXPORT_INTENT_PARAMS);
  check('单页表 5 个 kind、导出表 3 个 kind 全为解析器函数（报价 kind 已删除）',
    spKinds.length === 5 && new Set(spKinds).size === 5
      && spKinds.every((kind) => typeof sp.SINGLE_PAGE_INTENT_PARAMS[kind] === 'function')
      && exKinds.length === 3 && new Set(exKinds).size === 3
      && exKinds.every((kind) => typeof ex.EXPORT_INTENT_PARAMS[kind] === 'function')
      && !exKinds.includes('quoteExport'),
    `${spKinds.join(',')} | ${exKinds.join(',')}`);

  // ---------- 合法 payload 全通过 ----------
  const LEGAL_SINGLE = {
    generatePage: { pageId: 'page-1', content: '一页正文' },
    refinePage: { pageId: 'page-1', editInstruction: '对比度再高一点' },
    selectVersion: { pageId: 'page-1', versionId: 'version-1' },
    exportImagePptx: { projectId: 'project-1' },
    exportEditablePptx: { projectId: 'project-1', force: true },
  };
  const spLegalFailures = spKinds.filter((kind) => parseSp(kind, LEGAL_SINGLE[kind])?.ok !== true);
  check('单页 5 个 kind 的合法 payload 全部解析通过', spLegalFailures.length === 0, spLegalFailures.join(', '));

  const LEGAL_EXPORT = {
    exportDeckImage: { deckId: 'deck-1' },
    exportDeckEditable: { deckId: 'deck-1', force: true },
    exportDeckTextEditable: { deckId: 'deck-1' },
  };
  const exLegalFailures = exKinds.filter((kind) => parseEx(kind, LEGAL_EXPORT[kind])?.ok !== true);
  check('导出 3 个 kind 的合法 payload 全部解析通过', exLegalFailures.length === 0, exLegalFailures.join(', '));

  // ---------- 非法 payload：每个 kind 都有可解释的拒绝面 ----------
  const ILLEGAL_SINGLE = {
    generatePage: {},
    refinePage: {},
    selectVersion: { pageId: 'page-1' },
    exportImagePptx: { pageIds: 'page-1' },
    exportEditablePptx: {},
  };
  const spIllegalSurvivors = spKinds.filter((kind) => parseSp(kind, ILLEGAL_SINGLE[kind])?.ok !== false);
  check('单页 5 个 kind 的非法 payload 全部拒绝', spIllegalSurvivors.length === 0, spIllegalSurvivors.join(', '));

  const ILLEGAL_EXPORT = {
    exportDeckImage: {},
    exportDeckEditable: { deckId: 'deck-1', force: 'maybe' },
    exportDeckTextEditable: { deckId: { id: 'deck-1' } },
  };
  const exIllegalSurvivors = exKinds.filter((kind) => parseEx(kind, ILLEGAL_EXPORT[kind])?.ok !== false);
  check('导出 3 个 kind 的非法 payload 全部拒绝', exIllegalSurvivors.length === 0, exIllegalSurvivors.join(', '));

  // ---------- 清洗与归一：类型 / 上限 / 布尔 / 数组 / 必填文案 ----------
  const generated = parseSp('generatePage', {
    pageId: ' pg-1 ',
    content: ' 正文 ',
    title: 't'.repeat(300),
    stylePackId: ' pack-1 ',
    imagePath: ' uploads/u/one.png ',
    requestId: ' req-1 ',
    mode: ' replicate ',
    colorMode: ' new-theme ',
    structure: { title: '结构卡' },
    unknown: '丢弃',
  })?.params;
  check('generatePage：字段洗空白+上限（title 120 / mode 20），structure 只在出现时保留，未知字段丢弃',
    generated?.pageId === 'pg-1' && generated?.content === '正文'
      && generated?.title.length === 120 && generated?.mode === 'replicate'
      && generated?.colorMode === 'new-theme' && generated?.requestId === 'req-1'
      && JSON.stringify(generated?.structure) === '{"title":"结构卡"}'
      && !('unknown' in (generated || {})),
    JSON.stringify(generated));
  check('generatePage：pageId / content 必填（400 文案固定）',
    parseSp('generatePage', { content: '正文' })?.message === '缺少 pageId'
      && parseSp('generatePage', { pageId: 'pg-1' })?.message === '页面内容不能为空');
  check('refinePage / selectVersion：必填与上限（editInstruction 1000）',
    parseSp('refinePage', { pageId: 'p' })?.message === '缺少 editInstruction'
      && parseSp('refinePage', { pageId: 'p', editInstruction: ' x '.repeat(1200) })?.params?.editInstruction.length === 1000
      && parseSp('selectVersion', { pageId: 'p' })?.message === '缺少 pageId 或 versionId');
  check('exportImagePptx：pageIds 去空白/丢空项，非数组拒绝；projectId/title 洗空白',
    JSON.stringify(parseSp('exportImagePptx', { projectId: ' pr ', pageIds: [' p1 ', '', 'p2'] })?.params?.pageIds) === '["p1","p2"]'
      && parseSp('exportImagePptx', { pageIds: 'p1' })?.message === 'pageIds 必须是数组'
      && parseSp('exportImagePptx', { title: ' 合集 ' })?.params?.title === '合集');
  check('导出可编辑：布尔归一（"true"/1 → true，"false"/0 → false，其余拒绝）',
    parseSp('exportEditablePptx', { projectId: 'p', force: 'true' })?.params?.force === true
      && parseSp('exportEditablePptx', { projectId: 'p', force: 1 })?.params?.force === true
      && parseSp('exportEditablePptx', { projectId: 'p', force: 'FALSE' })?.params?.force === false
      && parseSp('exportEditablePptx', { projectId: 'p', force: 0 })?.params?.force === false
      && parseSp('exportEditablePptx', { projectId: 'p', force: 'yes' })?.message === 'force 必须是布尔值');
  check('deck 导出：deckId 清洗进类型化参数（路径侧仍以路由 id 为准）',
    parseEx('exportDeckEditable', { deckId: ' deck-1 ', force: '0' })?.params?.deckId === 'deck-1'
      && parseEx('exportDeckEditable', { deckId: 'deck-1', force: '0' })?.params?.force === false
      && parseEx('exportDeckImage', { deckId: 'deck-1' })?.params?.deckId === 'deck-1'
      && parseEx('exportDeckImage', {})?.message === '缺少 deckId');

  // ---------- 解析器是纯函数：垃圾输入不抛异常，结果恒为 {ok} ----------
  const garbage = [null, 1, 'x', [], { pageId: {} }, { projectId: [1] }, { force: 'maybe' }, { pageIds: [1] }];
  const allParsers = [
    ...spKinds.map((kind) => sp.SINGLE_PAGE_INTENT_PARAMS[kind]),
    ...exKinds.map((kind) => ex.EXPORT_INTENT_PARAMS[kind]),
  ];
  const garbageSurvivors = allParsers.filter((parser) => garbage.some((params) => {
    try {
      const result = parser(params);
      return !result || typeof result.ok !== 'boolean';
    } catch {
      return true;
    }
  }));
  check('垃圾 payload 不抛异常、结果恒为 {ok}（解析器是纯函数）',
    garbageSurvivors.length === 0, `survivors=${garbageSurvivors.length}`);

  // ---------- 服务器适配器：解析失败统一 400 + 解析器文案 ----------
  const rejection = (run) => {
    try {
      run();
      return null;
    } catch (error) {
      return error;
    }
  };
  const adapterRejection = rejection(() =>
    server.readIntentParams({ intent: { kind: 'selectVersion', params: { pageId: 'p' } } }, sp.SINGLE_PAGE_INTENT_PARAMS, 'selectVersion'));
  check('服务器适配器：解析失败套成统一 400（VALIDATION_ERROR + 解析器文案）',
    adapterRejection?.code === 'VALIDATION_ERROR' && adapterRejection?.status === 400
      && adapterRejection?.message === '缺少 pageId 或 versionId',
    `${adapterRejection?.code} ${adapterRejection?.status} ${adapterRejection?.message}`);

  // ---------- 报价死路径：kind / 路由 / 响应契约 / 模块函数一起删除 ----------
  const quoteRoute = new URL('../../src/app/api/pptx-exports/quote/route.ts', import.meta.url);
  check('报价死路径已删：kind/表项/模块函数/路由文件均不存在',
    !exKinds.includes('quoteExport')
      && !Object.prototype.hasOwnProperty.call(ex.EXPORT_INTENT_PARAMS, 'quoteExport')
      && typeof editable.quoteExport === 'undefined'
      && !existsSync(quoteRoute));
  const exCalls = exKinds.map((kind) => ex.toExportActionCall({ kind, params: LEGAL_EXPORT[kind] }));
  check('导出 3 个意图只分发到 deck 三条导出，路径互不重复',
    exCalls.length === 3 && new Set(exCalls.map((call) => call.path)).size === 3
      && exCalls.every((call) => call.method === 'POST' && call.path.startsWith('/api/deck/')),
    JSON.stringify(exCalls.map((call) => call.path)));

  // ---------- 路由契约：每条路由只解一次意图，不再手写字段清洗 ----------
  const routeSources = [
    '../../src/app/api/single-page/generate/route.ts',
    '../../src/app/api/single-page/refine/route.ts',
    '../../src/app/api/single-page/select-version/route.ts',
    '../../src/app/api/single-page/export-image-pptx/route.ts',
    '../../src/app/api/single-page/export-editable-pptx/route.ts',
    '../../src/app/api/deck/[id]/export-image/route.ts',
    '../../src/app/api/deck/[id]/export-editable/route.ts',
    '../../src/app/api/deck/[id]/export-editable-text/route.ts',
  ].map((rel) => read(rel));
  check('单页/导出路由：只调一次 readIntentParams，无 cleanString / String(body) / Math.floor(Number) 手写清洗',
    routeSources.every((src) => (src.match(/readIntentParams\(/g) || []).length === 1
      && !src.includes('cleanString(')
      && !src.includes('String(body')
      && !src.includes('Math.floor(Number(')));
}

export async function runAdminSurfaceIntentParserTests({ check }) {
  const intents = await import('../../src/lib/admin-intents.ts');
  const envelope = await import('../../src/lib/intent-envelope.ts');
  const server = await import('../../src/lib/server/intents.ts');
  const table = intents.ADMIN_INTENT_PARAMS;
  const parse = (kind, params) => envelope.parseIntent({ kind, params }, table);

  console.log('\n[10c] 后台意图解析器：kind → 解析（类型 / 枚举 / 整数 / 对象）');

  const kinds = Object.keys(table);
  check('后台表 5 个 kind 全为解析器函数',
    kinds.length === 5 && new Set(kinds).size === 5
      && kinds.every((kind) => typeof table[kind] === 'function'),
    kinds.join(','));

  const LEGAL = {
    updateRuntimeConfig: { values: { ANPPT_V2_LLM_MODEL: 'm' }, clearKeys: ['ANPPT_V2_LLM_API_KEY'] },
    setFeatureFlag: { key: 'magic_erase', state: 'beta' },
    generateRedemptionCodes: { credits: 1000, count: 2, batch: 'admin', expiresDays: 30 },
    checkIntegration: { kind: 'llm', values: { ANPPT_V2_LLM_MODEL: 'm' } },
    setUserRole: { userId: 'user-1', role: 'tester' },
  };
  const legalFailures = kinds.filter((kind) => parse(kind, LEGAL[kind])?.ok !== true);
  check('后台 5 个 kind 的合法 payload 全部解析通过', legalFailures.length === 0, legalFailures.join(', '));

  const ILLEGAL = {
    updateRuntimeConfig: { values: [] },
    setFeatureFlag: { key: 'magic_erase', state: 'sometimes' },
    generateRedemptionCodes: { credits: 0, count: 2 },
    checkIntegration: { kind: 'nope' },
    setUserRole: { userId: 'user-1', role: 'admin' },
  };
  const illegalSurvivors = kinds.filter((kind) => parse(kind, ILLEGAL[kind])?.ok !== false);
  check('后台 5 个 kind 的非法 payload 全部拒绝', illegalSurvivors.length === 0, illegalSurvivors.join(', '));

  const config = parse('updateRuntimeConfig', { values: { ANPPT_V2_LLM_MODEL: 'm' }, clearKeys: [' A ', ''] })?.params;
  check('updateRuntimeConfig：values 只接受对象、clearKeys 去空白/丢空项并拒绝非数组',
    JSON.stringify(config?.values) === '{"ANPPT_V2_LLM_MODEL":"m"}'
      && JSON.stringify(config?.clearKeys) === '["A"]'
      && parse('updateRuntimeConfig', { values: 'x' })?.message === 'values 格式不正确'
      && parse('updateRuntimeConfig', { clearKeys: 'A' })?.message === 'clearKeys 格式不正确');
  check('setFeatureFlag：key 洗空白、state 只认 off/beta/public',
    parse('setFeatureFlag', { key: ' magic_erase ', state: 'off' })?.params?.key === 'magic_erase'
      && parse('setFeatureFlag', { key: 'magic_erase', state: 'public' })?.ok === true
      && parse('setFeatureFlag', { key: 'magic_erase', state: 'sometimes' })?.message === '开关状态必须是 off/beta/public');
  const codes = parse('generateRedemptionCodes', { credits: 1000, count: 2, batch: ' b ', expiresDays: '' })?.params;
  check('generateRedemptionCodes：整数/上限/批次清洗，expiresDays 空串与 null 归为永久',
    codes?.credits === 1000 && codes?.count === 2 && codes?.batch === 'b' && codes?.expiresDays === null
      && parse('generateRedemptionCodes', { credits: 1000, expiresDays: null })?.params?.expiresDays === null
      && parse('generateRedemptionCodes', { credits: 1000, expiresDays: 30 })?.params?.expiresDays === 30);
  check('generateRedemptionCodes：越界与非整数一律 400 且文案固定',
    parse('generateRedemptionCodes', { credits: 0 })?.message === '每张兑换码积分需为 1–1000000 的整数'
      && parse('generateRedemptionCodes', { credits: 1000, count: 101 })?.message === '单次生成数量需为 1–100 的整数'
      && parse('generateRedemptionCodes', { credits: 1000, expiresDays: 0 })?.message === '有效期需为 1–3650 天'
      && parse('generateRedemptionCodes', { credits: '1000' })?.message === 'credits 必须是整数');
  check('checkIntegration：kind 只认 llm/image/editable，values 只接受对象',
    parse('checkIntegration', { kind: 'editable' })?.ok === true
      && parse('checkIntegration', { kind: 'nope' })?.message === '不支持的连接检查类型'
      && parse('checkIntegration', { kind: 'llm', values: [] })?.message === 'values 格式不正确');
  check('setUserRole：role 只认 tester/user，userId 洗空白',
    parse('setUserRole', { userId: ' u1 ', role: 'user' })?.params?.userId === 'u1'
      && parse('setUserRole', { userId: 'u1', role: 'admin' })?.message === 'role 只能是 tester 或 user');

  const garbage = [null, 1, 'x', [], { values: [] }, { clearKeys: [1] }, { credits: 1.5 }, { role: {} }];
  const garbageSurvivors = kinds.filter((kind) => garbage.some((params) => {
    try {
      const result = table[kind](params);
      return !result || typeof result.ok !== 'boolean';
    } catch {
      return true;
    }
  }));
  check('后台解析器：垃圾 payload 不抛异常、结果恒为 {ok}',
    garbageSurvivors.length === 0, garbageSurvivors.join(', '));

  const adapterRejection = (() => {
    try {
      server.readIntentParams({ intent: { kind: 'setFeatureFlag', params: { key: 'k', state: 'sometimes' } } }, table, 'setFeatureFlag');
      return null;
    } catch (error) {
      return error;
    }
  })();
  check('后台适配器：解析失败套成统一 400（VALIDATION_ERROR + 解析器文案）',
    adapterRejection?.code === 'VALIDATION_ERROR' && adapterRejection?.status === 400
      && adapterRejection?.message === '开关状态必须是 off/beta/public',
    `${adapterRejection?.code} ${adapterRejection?.status} ${adapterRejection?.message}`);

  const routeSources = [
    '../../src/app/api/admin/config/route.ts',
    '../../src/app/api/admin/feature-flags/route.ts',
    '../../src/app/api/admin/redemption-codes/route.ts',
    '../../src/app/api/admin/integrations/check/route.ts',
    '../../src/app/api/admin/users/[id]/role/route.ts',
  ].map((rel) => read(rel));
  check('后台路由：只调一次 readIntentParams，无 cleanString / Math.floor(Number) / String(body) 手写清洗',
    routeSources.every((src) => (src.match(/readIntentParams\(/g) || []).length === 1
      && !src.includes('cleanString(')
      && !src.includes('String(body')
      && !src.includes('Math.floor(Number(')));
}
