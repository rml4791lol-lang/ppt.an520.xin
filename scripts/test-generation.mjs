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
