#!/usr/bin/env node
// 生成链（阶段 C）lib 层全链路测试。node 直跑：
//   node scripts/test-generation.mjs
// 引擎 / LLM / 生图上游全部用 mock fetcher，绝不真实调用付费上游。
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerTsHooks } from './ts-hooks.mjs';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'anppt-v2-gen-test-'));
process.env.ANPPT_V2_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ANPPT_V2_DATA_DIR = path.join(tmpDir, 'data');
process.env.OTP_DEV_ECHO = 'true';
process.env.NODE_ENV = 'test';

registerTsHooks();

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectThrows(name, fn, code) {
  try {
    await fn();
    check(name, false, '未抛出预期错误');
  } catch (error) {
    check(name, error?.code === code, `实际错误 ${error?.code || error?.message}`);
  }
}

// ---------- mock fetcher ----------
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeMockFetcher(handlers) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const handler of handlers) {
      if (u.includes(handler.match)) {
        const payload = typeof handler.payload === 'function' ? handler.payload(init) : handler.payload;
        if (payload instanceof Response) return payload;
        return jsonResponse(payload, handler.status || 200);
      }
    }
    throw new Error(`mock fetcher 未命中: ${u}`);
  };
  fetcher.calls = calls;
  return fetcher;
}

const imageOkHandler = {
  match: '/images/generations',
  payload: (init) => {
    const body = JSON.parse(init.body);
    if (body.prompt.includes('失败页')) {
      return jsonResponse({ error: { message: 'mock upstream 500' } }, 500);
    }
    return { data: [{ b64_json: PNG_1X1_B64 }] };
  },
};
const editsOkHandler = { match: '/images/edits', payload: { data: [{ b64_json: PNG_1X1_B64 }] } };

const OUTLINE_FIXTURE = [
  {
    pageIndex: 0,
    role: 'cover',
    chapter: '',
    pageType: '封面',
    title: '年度销售汇报',
    goal: '开场',
    mustKeep: ['年度销售汇报'],
    rawText: '2025 年销售额 1200 万元，同比增长 20%。',
    summary: ['年度销售汇报'],
    visualNote: '',
  },
  {
    pageIndex: 1,
    role: 'content',
    chapter: '业绩',
    pageType: '数据图表',
    title: '失败页演示',
    goal: '展示业绩',
    mustKeep: ['1200 万元'],
    rawText: '2025 年销售额 1200 万元，同比增长 20%。',
    summary: ['销售额 1200 万元'],
    visualNote: '柱状图',
  },
];

const DSL_FIXTURE = (slide) => [
  `【标题】${slide.title}`,
  '【模块标题】核心数据',
  '【正文】销售额同比增长 20%',
  '【数据】1200 万元',
].join('\n');

const engineHandlers = [
  { match: '/internal/ppt/outline', payload: { ok: true, data: { outline: OUTLINE_FIXTURE } } },
  {
    match: '/internal/ppt/structure',
    payload: (init) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        data: { pages: body.slides.map((s) => ({ pageIndex: s.pageIndex, structuredContent: DSL_FIXTURE(s) })) },
      };
    },
  },
  {
    match: '/internal/ppt/structure-slide',
    payload: (init) => {
      const body = JSON.parse(init.body);
      return { ok: true, data: { pageIndex: body.slide.pageIndex, structuredContent: DSL_FIXTURE(body.slide) } };
    },
  },
];

// ---------- 最小 DOCX / PDF 素材 ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const DOCX_BUFFER = makeZip([
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
  ['word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>2025 年销售额 1200 万元</w:t></w:r></w:p><w:p><w:r><w:t>同比增长 20%</w:t></w:r></w:p></w:body></w:document>'],
]);

const PDF_BUFFER = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 24 Tf 100 700 Td (Hello PDF World) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n',
);

// ---------- 开始 ----------
const auth = await import('../src/lib/server/auth.ts');
const credits = await import('../src/lib/server/credits.ts');
const documents = await import('../src/lib/server/documents.ts');
const engine = await import('../src/lib/server/engine.ts');
const dsl = await import('../src/lib/server/generation/dsl.ts');
const configMod = await import('../src/lib/server/generation/config.ts');
const decks = await import('../src/lib/server/generation/decks.ts');
const actions = await import('../src/lib/server/generation/actions.ts');
const exportsLib = await import('../src/lib/server/exports.ts');
const singlePages = await import('../src/lib/server/generation/single-pages.ts');
const projects = await import('../src/lib/server/generation/projects.ts');
const { STYLE_PACKS } = await import('../src/data/style-packs.ts');

const baseConfig = configMod.getGenerationConfig();
const imageConfig = { ...baseConfig, imageBaseUrl: 'http://mock-image', imageApiKey: 'sk-mock' };
const engineConfig = { ...imageConfig, engineInternalToken: 'tok', engineBaseUrl: 'http://mock-engine' };
const llmConfig = {
  ...imageConfig,
  engineInternalToken: '',
  llmBaseUrl: 'http://mock-llm/v1',
  llmApiKey: 'sk-mock',
};

const reg = await auth.registerWithPassword(
  { account: 'genuser', password: 'password123', confirmPassword: 'password123' },
  '127.0.0.1',
);
const uid = reg.user.id;
check('注册送 100🌟', credits.getBalance(uid) === 100);

console.log('\n[1] 文档解析（txt/md/docx/pdf 真实解析）');
{
  const txt = await documents.parseDocument(Buffer.from('纯文本内容 1200 万元', 'utf8'), 'note.txt');
  check('txt 直读', txt.text.includes('1200 万元') && txt.format === 'txt');
  const md = await documents.parseDocument(Buffer.from('# 标题\n\n正文 20%', 'utf8'), 'note.md');
  check('md 直读', md.text.includes('标题') && md.format === 'md');
  const docx = await documents.parseDocument(DOCX_BUFFER, 'report.docx');
  check('docx 走 mammoth 解析出文字', docx.text.includes('1200 万元'), `实际: ${docx.text.slice(0, 40)}`);
  const pdf = await documents.parseDocument(PDF_BUFFER, 'report.pdf');
  check('pdf 走 pdfjs 解析出文字', pdf.text.includes('Hello PDF World'), `实际: ${pdf.text.slice(0, 40)}`);
  const truncated = documents.truncateSourceText('x'.repeat(100001), 100000);
  check('10 万字截断', truncated.truncated && truncated.text.length === 100000);
  await expectThrows('不支持的格式被拒', () => documents.parseDocument(Buffer.from('x'), 'a.exe'), 'UNSUPPORTED_FILE_TYPE');
}

console.log('\n[2] tagged DSL 校验');
{
  const good = dsl.validateTaggedDsl(
    '【标题】业绩\n【模块标题】数据\n【正文】增长\n【表格】\n| 指标 | 值 |\n| --- | --- |\n| 销售额 | 1200 万元 |',
    { rawText: '销售额 1200 万元' },
  );
  check('合法 DSL 通过', good.ok, good.errors.join(';'));
  const badTag = dsl.validateTaggedDsl('【正文】a\n【花里胡哨】b');
  check('非法标签被拒', !badTag.ok && badTag.errors.some((e) => e.includes('未知标签')));
  const unbalanced = dsl.validateTaggedDsl('【表格】\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |');
  check('表格不配平被拒', !unbalanced.ok && unbalanced.errors.some((e) => e.includes('不配平')));
  const noDivider = dsl.validateTaggedDsl('【表格】\n| a | b |\n| 1 | 2 |');
  check('缺分隔行被拒', !noDivider.ok);
  const fidelity = dsl.validateTaggedDsl('【数据】9999 亿元', { rawText: '销售额 1200 万元' });
  check('数据保真 diff 生效', !fidelity.ok && fidelity.errors.some((e) => e.includes('9999')));
  const copy = dsl.extractCopyFromDsl('【标题】T\n【区域：左栏】\n【正文】要点一');
  check('DSL 提取文案段', copy.title === 'T' && copy.lines.some((l) => l.includes('要点一')));
}

console.log('\n[2b] 页型归一 + 生图 prompt 版式/整套一致性注入');
{
  const pageTypes = await import('../src/lib/server/generation/page-types.ts');
  const stylePacks = await import('../src/lib/server/generation/style-packs.ts');
  check('role 优先：cover 直接封面页', pageTypes.resolvePageType('数据图表', 'cover').key === 'cover');
  check('role 优先：ending 直接结尾页', pageTypes.resolvePageType('', 'ending').key === 'ending');
  check('关键词命中：数据图表 → data-chart', pageTypes.resolvePageType('数据图表', 'content').key === 'data-chart');
  check('最长关键词胜出：大数字指标 → big-number', pageTypes.resolvePageType('大数字指标', 'content').key === 'big-number');
  check('时间轴/流程/对比/表格各自命中',
    pageTypes.resolvePageType('时间轴', 'content').key === 'timeline'
    && pageTypes.resolvePageType('实施步骤', 'content').key === 'process'
    && pageTypes.resolvePageType('竞品对比', 'content').key === 'comparison'
    && pageTypes.resolvePageType('参数表格', 'content').key === 'table');
  check('自由文本兜底通用内容页', pageTypes.resolvePageType('随便写点什么', 'content').key === 'content');
  check('空 pageType 兜底通用内容页', pageTypes.resolvePageType('', 'content').key === 'content');

  const pack = stylePacks.resolveStylePack(STYLE_PACKS[0].id);
  const slide = { role: 'content', pageType: '数据图表', title: 'T', goal: '', copyLines: ['一行'], visualNote: '' };
  const p1 = stylePacks.buildSlideImagePrompt(slide, pack, {
    deckContext: { totalPages: 10, pageIndex: 2, chapter: '背景' },
  });
  check('prompt 含页型版式指令', p1.includes('版式要求（页型：数据图表页）'));
  check('prompt 含整套一致性段（总页数+页码+章节）', p1.includes('全套 10 页中的第 3 页') && p1.includes('「背景」章节'));
  check('prompt 保留易转可编辑条款', p1.includes(stylePacks.EDITABLE_FRIENDLY_CLAUSE));
  const p2 = stylePacks.buildSlideImagePrompt(slide, pack, { deckContext: { totalPages: 1, pageIndex: 0, chapter: '' } });
  check('单页整套不注入一致性段', !p2.includes('整套一致性要求'));
  const p3 = stylePacks.buildSlideImagePrompt(slide, pack);
  check('无 deckContext 不注入一致性段', !p3.includes('整套一致性要求'));
  const p4 = stylePacks.buildSlideImagePrompt({ ...slide, visualNote: '放柱状图' }, pack, { withStyleReferenceHint: true });
  check('参考图提示与 visualNote 框架约束共存', p4.includes('随附风格参考图') && p4.includes('在上述页型版式框架内执行'));
  check('styleDirective 注入视觉关键词行', stylePacks.styleDirective(pack).includes('视觉关键词：'));
  check('resolveStylePack 透出包数据视觉关键词', Array.isArray(pack.visualKeywords) && pack.visualKeywords.length >= 6);
}

console.log('\n[3] outline：引擎成功 + LLM 兜底两路');
{
  const engineFetcher = makeMockFetcher(engineHandlers);
  const viaEngine = await engine.generateOutline(
    { sourceText: '2025 年销售额 1200 万元', targetPageCount: 2 },
    { fetchImpl: engineFetcher, config: engineConfig },
  );
  check('引擎路 provider=engine 且 2 页', viaEngine.provider === 'engine' && viaEngine.slides.length === 2);
  check('引擎收到 Bearer token', engineFetcher.calls[0].init.headers.Authorization === 'Bearer tok');

  const llmFetcher = makeMockFetcher([
    {
      match: '/chat/completions',
      payload: { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(OUTLINE_FIXTURE)}\n\`\`\`` } }] },
    },
  ]);
  const viaLlm = await engine.generateOutline(
    { sourceText: '2025 年销售额 1200 万元', targetPageCount: 2 },
    { fetchImpl: llmFetcher, config: llmConfig },
  );
  check('无 token 走 llm-fallback 且解析出大纲', viaLlm.provider === 'llm-fallback' && viaLlm.slides.length === 2);

  const downThenLlm = makeMockFetcher([
    { match: '/internal/ppt/outline', payload: new Response('boom', { status: 502 }) },
    {
      match: '/chat/completions',
      payload: { choices: [{ message: { content: JSON.stringify(OUTLINE_FIXTURE) } }] },
    },
  ]);
  const viaRescue = await engine.generateOutline(
    { sourceText: 'x', targetPageCount: 2 },
    { fetchImpl: downThenLlm, config: { ...engineConfig, llmBaseUrl: 'http://mock-llm/v1', llmApiKey: 'sk' } },
  );
  check('引擎不可达自动降级 LLM 兜底', viaRescue.provider === 'llm-fallback');

  // 拆页：引擎未配时回退段落均分（local）
  const split = await engine.splitSlide(
    { ...OUTLINE_FIXTURE[1], rawText: '段落一\n段落二\n段落三' },
    2,
    { fetchImpl: makeMockFetcher([]), config: llmConfig },
  );
  check('split-slide 本地段落均分 2 页', split.provider === 'local' && split.slides.length === 2);
}

console.log('\n[4] deck 状态机全链路（outline→structure→confirm→style→generate）');
const deck = decks.createDeck(uid, {
  title: '测试汇报',
  sourceFileName: 'report.docx',
  sourceText: '2025 年销售额 1200 万元，同比增长 20%。',
  durationMinutes: 15,
  targetPageCount: 2,
  qualityTier: 'standard',
  stylePackId: '',
});
check('parse 后 status=parsed', deck.status === 'parsed');

const fullFetcher = makeMockFetcher([...engineHandlers, imageOkHandler, editsOkHandler]);
const fullDeps = { fetchImpl: fullFetcher, config: engineConfig };

{
  const r1 = await actions.dispatchDeckAction(uid, deck.id, { action: 'outline' }, fullDeps);
  check('outline 后 status=outlined、2 页', r1.state.deck.status === 'outlined' && r1.state.slides.length === 2);
  const r1b = await actions.dispatchDeckAction(uid, deck.id, { action: 'outline' }, fullDeps);
  check('重复 outline（无 force）复用', r1b.extra.reused === true);

  const r2 = await actions.dispatchDeckAction(uid, deck.id, { action: 'structure' }, fullDeps);
  check('structure 后 status=structured 且全部 ok', r2.state.deck.status === 'structured' && r2.state.slides.every((s) => s.structureStatus === 'ok'));
  check('structuredContent 已存库', r2.state.slides.every((s) => s.structuredContent.includes('【标题】')));

  const r3 = await actions.dispatchDeckAction(uid, deck.id, { action: 'confirm-structure' }, fullDeps);
  check('confirm 后 status=confirmed、contentLocked=true', r3.state.deck.status === 'confirmed' && r3.state.contentLocked === true);

  await expectThrows('冻结后 outline 被拒', () =>
    actions.dispatchDeckAction(uid, deck.id, { action: 'outline', force: true }, fullDeps), 'CONTENT_LOCKED');
  await expectThrows('冻结后 add-slide 被拒', () =>
    actions.dispatchDeckAction(uid, deck.id, { action: 'add-slide' }, fullDeps), 'CONTENT_LOCKED');
  await expectThrows('冻结后 delete-slide 被拒', () =>
    actions.dispatchDeckAction(uid, deck.id, { action: 'delete-slide', slideId: r3.state.slides[0].slideId }, fullDeps), 'CONTENT_LOCKED');

  await expectThrows('未选风格 generate 被拒', () =>
    actions.dispatchDeckAction(uid, deck.id, { action: 'generate' }, fullDeps), 'STYLE_REQUIRED');

  const r4 = await actions.dispatchDeckAction(uid, deck.id, { action: 'style', stylePackId: STYLE_PACKS[0].id }, fullDeps);
  check('style 选中风格包', r4.state.deck.stylePackId === STYLE_PACKS[0].id);

  const before = credits.getBalance(uid);
  const r5 = await actions.dispatchDeckAction(uid, deck.id, { action: 'generate' }, fullDeps);
  check('generate 返回 202 + job', r5.status === 202 && Boolean(r5.job));
  await r5.job.done;
  const s5 = decks.getDeckState(uid, deck.id);
  check('部分失败 → status=partial', s5.deck.status === 'partial', `实际 ${s5.deck.status}`);
  check('第 1 页成功且有图 URL', s5.slides[0].genStatus === 'succeeded' && s5.slides[0].versions[0]?.imageUrl.startsWith('/api/files/generated/'));
  check('第 2 页失败并带错误码', s5.slides[1].genStatus === 'failed' && s5.slides[1].genError.length > 0);
  const afterGen = credits.getBalance(uid);
  check('扣费 2×10、失败页退 10 → 净扣 10', before - afterGen === 10, `before=${before} after=${afterGen}`);
  const jobId = r5.job.jobId;
  const ledgerRowsDb = await import('../src/lib/server/db.ts');
  const rows = ledgerRowsDb.getDb().prepare('SELECT idempotency_key, delta, event_type FROM credit_ledger WHERE user_id = ? ORDER BY created_at').all(uid);
  const keys = rows.map((r) => String(r.idempotency_key));
  const slideIds = s5.slides.map((s) => s.slideId);
  check('逐页 debit 键 = deck-generate:{deckId}:{jobId}:{slideId}',
    slideIds.every((sid) => keys.includes(`deck-generate:${deck.id}:${jobId}:${sid}`)));
  check('失败页 refund 键唯一且只退一次',
    keys.filter((k) => k === `deck-generate:${deck.id}:${jobId}:${slideIds[1]}:refund`).length === 1);

  const genPrompts = fullFetcher.calls
    .filter((c) => c.url.includes('/images/generations'))
    .map((c) => JSON.parse(c.init.body).prompt);
  check('链路 prompt 实含页型版式指令（封面页+数据图表页）',
    genPrompts.some((p) => p.includes('版式要求（页型：封面页）')) && genPrompts.some((p) => p.includes('版式要求（页型：数据图表页）')));
  check('链路 prompt 实含整套一致性（总页数+页码+章节）',
    genPrompts.some((p) => p.includes('全套 2 页中的第 2 页') && p.includes('「业绩」章节')));

  await expectThrows('生成后（非 generating）内容仍冻结', () =>
    actions.dispatchDeckAction(uid, deck.id, { action: 'reorder-slides', order: slideIds }, fullDeps), 'CONTENT_LOCKED');

  // 失败重试：mock 不再失败（临时移除失败标记页标题不可行，换 forceRegenerate 整单重试）
  const retryFetcher = makeMockFetcher([...engineHandlers, { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
  const r6 = await actions.dispatchDeckAction(uid, deck.id, { action: 'retry-failed' }, { fetchImpl: retryFetcher, config: engineConfig });
  await r6.job.done;
  const s6 = decks.getDeckState(uid, deck.id);
  check('retry-failed 后全绿 status=generated', s6.deck.status === 'generated', `实际 ${s6.deck.status}`);
  check('失败页重试后 succeeded 且版本保留（≥2 版）', s6.slides[1].genStatus === 'succeeded' && s6.slides[1].versions.length >= 2);

  // refine-slide（i2i，保留旧版本）
  const r7 = await actions.dispatchDeckAction(uid, deck.id,
    { action: 'refine-slide', slideId: s6.slides[0].slideId, editInstruction: '把标题放大一点' },
    { fetchImpl: retryFetcher, config: engineConfig });
  await r7.job.done;
  const s7 = decks.getDeckState(uid, deck.id);
  check('refine-slide 走 /images/edits 且产生新版本',
    retryFetcher.calls.some((c) => c.url.includes('/images/edits')) && s7.slides[0].versions.length >= 2);

  // unlock-structure：作废已生成页
  const r8 = await actions.dispatchDeckAction(uid, deck.id, { action: 'unlock-structure' }, fullDeps);
  check('unlock 后 status=structured 且页变 stale', r8.state.deck.status === 'structured' && r8.state.slides.every((s) => s.genStatus === 'stale'));
  check('unlock 返回作废提示', String(r8.extra.warning || '').includes('作废'));
}

console.log('\n[4b] 按页录入路由（POST /api/deck/paged-copy-v2）');
{
  const pagedRoute = await import('../src/app/api/deck/paged-copy-v2/route.ts');
  const pagedToken = auth.createSessionForUser(uid);
  const pagedCall = (body, headers = {}) =>
    pagedRoute.POST(
      new Request('http://localhost/api/deck/paged-copy-v2', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `anppt_v2_session=${pagedToken}`, ...headers },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );

  const okRes = await pagedCall(
    { pages: [{ title: '年度规划', rawText: '2026 年三大方向' }, { rawText: '第一季度营收 1200 万元' }] },
    { 'x-anppt-action': '1' },
  );
  check('按页录入返回 201', okRes.status === 201, `实际 ${okRes.status}`);
  const okBody = await okRes.json();
  const pagedState = decks.getDeckState(uid, okBody.data.deckId);
  check('直接 outlined、2 页、内容未冻结',
    pagedState.deck.status === 'outlined' && pagedState.slides.length === 2 && pagedState.contentLocked === false);
  check('rawText 入库、缺标题页补默认标题',
    pagedState.slides[0].rawText === '2026 年三大方向' && pagedState.slides[1].title === '第 2 页');

  const noCsrf = await pagedCall({ pages: [{ rawText: '内容' }] });
  check('缺 CSRF 头 403', noCsrf.status === 403, `实际 ${noCsrf.status}`);
  const noAuth = await pagedRoute.POST(
    new Request('http://localhost/api/deck/paged-copy-v2', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
      body: JSON.stringify({ pages: [{ rawText: '内容' }] }),
    }),
    { params: Promise.resolve({}) },
  );
  check('未登录 401', noAuth.status === 401, `实际 ${noAuth.status}`);
  const emptyPage = await pagedCall({ pages: [{ rawText: '  ' }] }, { 'x-anppt-action': '1' });
  check('空页 400', emptyPage.status === 400, `实际 ${emptyPage.status}`);
  const tooLongRes = await pagedCall({ pages: [{ rawText: '字'.repeat(1501) }] }, { 'x-anppt-action': '1' });
  const tooLongBody = await tooLongRes.json();
  check('单页超 1500 字 → PAGE_TOO_LONG', tooLongRes.status === 400 && tooLongBody?.error?.code === 'PAGE_TOO_LONG',
    `实际 ${tooLongRes.status} ${tooLongBody?.error?.code}`);
}

console.log('\n[4c] update-slide / select-slide-version');
{
  const d3 = decks.createDeck(uid, {
    title: '编辑测试', sourceFileName: '', sourceText: 'Alpha 段落一。Beta 段落二。',
    durationMinutes: 5, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
  });
  const okFetcher = makeMockFetcher([...engineHandlers, { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
  const okDeps = { fetchImpl: okFetcher, config: engineConfig };
  await actions.dispatchDeckAction(uid, d3.id, { action: 'outline' }, okDeps);
  const s0 = decks.getDeckState(uid, d3.id).slides[0].slideId;

  const u1 = await actions.dispatchDeckAction(uid, d3.id,
    { action: 'update-slide', slideId: s0, title: '新标题', rawText: '第一季度销售额 1200 万元，同比增长 20%' }, okDeps);
  check('update-slide 标题/原文入库',
    u1.state.slides[0].title === '新标题' && u1.state.slides[0].rawText.includes('1200 万元'));

  await actions.dispatchDeckAction(uid, d3.id, { action: 'structure' }, okDeps);
  const u2 = await actions.dispatchDeckAction(uid, d3.id, { action: 'update-slide', slideId: s0, chapter: '第二章' }, okDeps);
  check('仅改章节：deck 不回退且梳理结果保留',
    u2.state.deck.status === 'structured' && u2.state.slides[0].structureStatus === 'ok' && u2.state.slides[0].chapter === '第二章');
  const u3 = await actions.dispatchDeckAction(uid, d3.id,
    { action: 'update-slide', slideId: s0, rawText: '销售额 1200 万元，同比增长 20%，补充第二季度展望' }, okDeps);
  check('改原文：页打回 pending、deck 回 outlined',
    u3.state.slides[0].structureStatus === 'pending' && u3.state.deck.status === 'outlined');

  await actions.dispatchDeckAction(uid, d3.id, { action: 'structure' }, okDeps);
  await actions.dispatchDeckAction(uid, d3.id, { action: 'confirm-structure' }, okDeps);
  await expectThrows('冻结后 update-slide 被拒', () =>
    actions.dispatchDeckAction(uid, d3.id, { action: 'update-slide', slideId: s0, title: 'x' }, okDeps), 'CONTENT_LOCKED');

  await actions.dispatchDeckAction(uid, d3.id, { action: 'style', stylePackId: STYLE_PACKS[0].id }, okDeps);
  const g = await actions.dispatchDeckAction(uid, d3.id, { action: 'generate' }, okDeps);
  await g.job.done;
  const st1 = decks.getDeckState(uid, d3.id);
  check('生成全绿 generated', st1.deck.status === 'generated', `实际 ${st1.deck.status}`);
  const v1 = st1.slides[0].versions.find((v) => v.versionNo === 1);

  const failEdit = makeMockFetcher([{ match: '/images/edits', payload: jsonResponse({ error: { message: 'mock i2i 500' } }, 500) }]);
  const rf = await actions.dispatchDeckAction(uid, d3.id,
    { action: 'refine-slide', slideId: s0, editInstruction: '改背景' },
    { fetchImpl: failEdit, config: engineConfig });
  await rf.job.done;
  const st2 = decks.getDeckState(uid, d3.id);
  check('refine 失败 → deck partial 且旧版本仍在', st2.deck.status === 'partial' && st2.slides[0].versions.length >= 2,
    `实际 ${st2.deck.status}`);

  const vFailed = decks.listVersions(s0).find((v) => v.status === 'failed');
  await expectThrows('failed 版本不可选', () =>
    actions.dispatchDeckAction(uid, d3.id, { action: 'select-slide-version', slideId: s0, versionId: vFailed.versionId }, okDeps), 'VERSION_NOT_READY');

  const sv = await actions.dispatchDeckAction(uid, d3.id,
    { action: 'select-slide-version', slideId: s0, versionId: v1.versionId }, okDeps);
  check('回退 v1：activeVersion 生效且整单回 generated',
    sv.state.slides[0].activeVersionId === v1.versionId && sv.state.deck.status === 'generated',
    `实际 ${sv.state.slides[0].activeVersionId} / ${sv.state.deck.status}`);

  const d4 = decks.createDeck(uid, {
    title: '早', sourceFileName: '', sourceText: 'x',
    durationMinutes: 5, targetPageCount: 1, qualityTier: 'standard', stylePackId: '',
  });
  await expectThrows('未确认内容切版本被拒', () =>
    actions.dispatchDeckAction(uid, d4.id, { action: 'select-slide-version', slideId: 'x', versionId: 'y' }, okDeps), 'VERSION_SELECT_TOO_EARLY');
}

console.log('\n[5] 余额不足整单 402');
{
  const poor = await auth.registerWithPassword(
    { account: 'pooruser', password: 'password123', confirmPassword: 'password123' },
    '127.0.0.1',
  );
  credits.debitCredits(poor.user.id, 95, { reason: '测试花掉', idempotencyKey: 'test-drain' });
  const d2 = decks.createDeck(poor.user.id, {
    title: '穷人项目', sourceFileName: 'a.txt', sourceText: '内容',
    durationMinutes: 15, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
  });
  await actions.dispatchDeckAction(poor.user.id, d2.id, { action: 'outline' }, fullDeps);
  await actions.dispatchDeckAction(poor.user.id, d2.id, { action: 'structure' }, fullDeps);
  await actions.dispatchDeckAction(poor.user.id, d2.id, { action: 'confirm-structure' }, fullDeps);
  await actions.dispatchDeckAction(poor.user.id, d2.id, { action: 'style', stylePackId: STYLE_PACKS[0].id }, fullDeps);
  await expectThrows('余额 5 < 20 → 402 INSUFFICIENT_CREDITS', async () => {
    try {
      await actions.dispatchDeckAction(poor.user.id, d2.id, { action: 'generate' }, fullDeps);
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
    }
  }, 'INSUFFICIENT_CREDITS');
  check('402 后 deck 仍 confirmed 且无 job', decks.getDeckState(poor.user.id, d2.id).deck.status === 'confirmed'
    && decks.latestJob(d2.id) === null);
}

console.log('\n[6] 导出：图片版 pptx 真产出 + editable 501 + 导出中心');
{
  // deck 在 [4] 末尾被 unlock 后重新生成一页用于导出
  const okFetcher = makeMockFetcher([...engineHandlers, { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
  const okDeps = { fetchImpl: okFetcher, config: engineConfig };
  await actions.dispatchDeckAction(uid, deck.id, { action: 'confirm-structure' }, okDeps);
  const rg = await actions.dispatchDeckAction(uid, deck.id, { action: 'generate', forceRegenerate: true }, okDeps);
  await rg.job.done;
  const s = decks.getDeckState(uid, deck.id);
  check('重新生成全绿', s.deck.status === 'generated', `实际 ${s.deck.status}`);

  const result = await exportsLib.exportDeckImagePptx(uid, deck.id, { config: baseConfig });
  check('导出返回 url + pageCount=2', result.pageCount === 2 && result.url.startsWith('/api/files/exports/'));
  const rel = result.url.replace('/api/files/', '');
  const fileBuf = readFileSync(path.join(baseConfig.exportsDir, rel.split('/').slice(1).join('/')));
  // zip 里文件名会在 local header / central directory / [Content_Types].xml 多出現，按去重文件名计页数
  const slideNames = new Set(fileBuf.toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g) || []);
  check('pptx zip 内含 2 页 slide', slideNames.size === 2, `实际 ${slideNames.size}`);

  const list = exportsLib.listExports(uid, {});
  check('导出中心列出记录', list.items.some((item) => item.exportId === result.exportId));
  const one = exportsLib.getExport(uid, result.exportId);
  check('导出详情可取', one.url === result.url);

  const quote = exportsLib.quoteExport(uid, { deckId: deck.id });
  check('quote：image 免费可用、editable 占位', quote.pageCount === 2
    && quote.quotes.find((q) => q.kind === 'image')?.credits === 0
    && quote.quotes.find((q) => q.kind === 'editable')?.code === 'EDITABLE_EXPORT_COMING_SOON');
  check('editable 导出 501', (() => {
    try {
      exportsLib.exportEditablePptx();
      return false;
    } catch (error) {
      return error?.code === 'EDITABLE_EXPORT_COMING_SOON' && error?.status === 501;
    }
  })());
}

console.log('\n[7] 单页生成器（generate/refine/失败退还/导出）');
{
  const okFetcher = makeMockFetcher([{ match: '/images/generations', payload: (init) => {
    const body = JSON.parse(init.body);
    if (body.prompt.includes('会失败的内容')) return jsonResponse({ error: { message: 'mock 500' } }, 500);
    return { data: [{ b64_json: PNG_1X1_B64 }] };
  } }, editsOkHandler]);
  const okDeps = { fetchImpl: okFetcher, config: imageConfig };

  const before = credits.getBalance(uid);
  const g1 = await singlePages.generateSinglePage(uid, {
    pageId: 'page-001', title: '单页一', content: '第一季度营收 1200 万元', stylePackId: STYLE_PACKS[0].id,
  }, okDeps);
  check('单页生成成功出图', g1.status === 'succeeded' && g1.imageUrl.startsWith('/api/files/generated/'));
  check('单页扣 10🌟', before - g1.balance === 10, `before=${before} after=${g1.balance}`);

  const g2 = await singlePages.refineSinglePage(uid, { pageId: 'page-001', editInstruction: '改成深色背景' }, okDeps);
  check('单页改图成功且走 edits', g2.status === 'succeeded' && okFetcher.calls.some((c) => c.url.includes('/images/edits')));

  const f1 = await singlePages.generateSinglePage(uid, { pageId: 'page-002', content: '会失败的内容' }, okDeps);
  check('单页失败自动退还（余额不变）', f1.status === 'failed' && credits.getBalance(uid) === g2.balance, `实际 ${credits.getBalance(uid)} vs ${g2.balance}`);

  const exp = await exportsLib.exportSinglePagesImagePptx(uid, { projectId: g1.page.projectId }, { config: baseConfig });
  check('单页项目导出图片版 pptx（仅成功页 1 页）', exp.pageCount === 1);
}

console.log('\n[7b] 单页项目详情 / 版本选择 / i2i 原稿重设计');
{
  credits.refundCredits(uid, 100, { reason: '测试补贴', idempotencyKey: 'test-topup-7b' });
  const storage = await import('../src/lib/server/generation/storage.ts');
  const okFetcher2 = makeMockFetcher([{ match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
  const deps2 = { fetchImpl: okFetcher2, config: imageConfig };
  const g1 = await singlePages.generateSinglePage(uid, { pageId: 'pg-a', title: 'P1', content: '营收 1200 万元' }, deps2);
  const g2 = await singlePages.refineSinglePage(uid, { pageId: 'pg-a', editInstruction: '加深对比' }, deps2);
  check('生成+改图两个成功版本', g1.status === 'succeeded' && g2.status === 'succeeded');

  const detail = singlePages.getSingleProjectDetail(uid, g1.page.projectId);
  check('项目详情含 1 页 2 版本', detail.pages.length === 1 && detail.pages[0].versions.length === 2);
  check('他人取项目详情 404', (() => {
    try {
      singlePages.getSingleProjectDetail('other-user', g1.page.projectId);
      return false;
    } catch (error) {
      return error?.code === 'PROJECT_NOT_FOUND';
    }
  })());

  const v1 = detail.pages[0].versions.find((v) => v.kind === 'generate');
  const sel = singlePages.selectSinglePageVersion(uid, 'pg-a', v1.versionId);
  check('版本回退生效', sel.activeVersionId === v1.versionId);
  await expectThrows('不存在版本 404', () => singlePages.selectSinglePageVersion(uid, 'pg-a', 'ver_nope'), 'VERSION_NOT_FOUND');

  const saved = await storage.saveFile('uploads', uid, Buffer.from(PNG_1X1_B64, 'base64'), { kind: 'draft', ext: '.png' }, imageConfig);
  const editsBefore = okFetcher2.calls.filter((c) => c.url.includes('/images/edits')).length;
  const before3 = credits.getBalance(uid);
  const g3 = await singlePages.generateSinglePage(uid, { pageId: 'pg-b', content: '原稿重设计一页', imagePath: saved.relPath }, deps2);
  check('i2i 原稿重设计走 /images/edits 且成功',
    g3.status === 'succeeded' && okFetcher2.calls.filter((c) => c.url.includes('/images/edits')).length === editsBefore + 1);
  check('i2i 正常扣 10🌟', before3 - g3.balance === 10, `before=${before3} after=${g3.balance}`);
  await expectThrows('他人原稿图 403', () =>
    singlePages.generateSinglePage(uid, { pageId: 'pg-c', content: 'x', imagePath: saved.relPath.replace(uid, 'other-user') }, deps2), 'FILE_FORBIDDEN');
}

console.log('\n[8] 项目列表 / 改名 / 软删');
{
  const list = projects.listProjects(uid, {});
  check('列表含 deck + single-page', list.items.some((i) => i.projectType === 'deck') && list.items.some((i) => i.projectType === 'single-page'));
  check('透出 retentionDays=7', list.retentionDays === 7);
  const onlyDecks = projects.listProjects(uid, { projectType: 'deck' });
  check('projectType=deck 过滤', onlyDecks.items.every((i) => i.projectType === 'deck'));
  const renamed = projects.renameProject(uid, deck.id, '新标题');
  check('PATCH 改标题', renamed.title === '新标题' && renamed.projectType === 'deck');
  projects.deleteProject(uid, deck.id);
  check('DELETE 软删后列表不再出现', !projects.listProjects(uid, {}).items.some((i) => i.id === deck.id));
  check('软删后 getOwnedDeck 404', (() => {
    try {
      decks.getOwnedDeck(uid, deck.id);
      return false;
    } catch (error) {
      return error?.code === 'DECK_NOT_FOUND';
    }
  })());
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
