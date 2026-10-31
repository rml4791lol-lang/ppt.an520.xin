#!/usr/bin/env node
// 生成链（阶段 C）lib 层全链路测试。node 直跑：
//   node scripts/test-generation.mjs
// 引擎 / LLM / 生图 / WPS / Image2PPT / Codia 上游全部用 mock fetcher，绝不真实调用付费上游。
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerTsHooks } from './ts-hooks.mjs';
import { acquireTestLock, releaseTestLock } from './test-lock.mjs';
import { runPptReplicateTests } from './tests/ppt-replicate.test.mjs';
import { runEditableExportTests } from './tests/editable-export.test.mjs';
import { runImage2PptTests } from './tests/image2ppt.test.mjs';
import { runWpsAipptTests } from './tests/wps-aippt.test.mjs';
import { runEditableProviderTests } from './tests/editable-providers.test.mjs';
import { runPluginRuntimeTests } from './tests/plugin-runtime.test.mjs';
import { runPptToBaseTests, runPptToBaseServerTests } from './tests/ppt-to-base.test.mjs';
import { runDeckIntentTests } from './tests/deck-intents.test.mjs';
import { runDeckIntentParserTests } from './tests/deck-intent-parsers.test.mjs';
import { runDeckWorkbenchTests } from './tests/deck-workbench.test.mjs';
import { runDeckActionTests } from './tests/deck-actions.test.mjs';
import { runSinglePageActionTests } from './tests/single-page-actions.test.mjs';
import { runSurfaceIntentTests } from './tests/surface-intents.test.mjs';
import { runPaidRunTests } from './tests/paid-run.test.mjs';
import { runSinglePagePaidRunTests } from './tests/single-page-paid-run.test.mjs';
import { runVisualPlanTests } from './tests/visual-plan.test.mjs';
import { runSurfaceIntentParserTests } from './tests/surface-intent-parsers.test.mjs';
import { runRecoveryRegistryTests } from './tests/recovery-registry.test.mjs';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'anppt-v2-gen-test-'));
process.env.ANPPT_V2_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ANPPT_V2_DATA_DIR = path.join(tmpDir, 'data');
process.env.ANPPT_V2_CODIA_API_KEY = 'sk-test';
process.env.OTP_DEV_ECHO = 'true';
process.env.NODE_ENV = 'test';

acquireTestLock('generation 套件');
registerTsHooks();

// 进程启动钩子（src/instrumentation.ts）同源的装配点：恢复运行源含模块源，套件跑前登记一次。
const { registerGenerationRecoverySources } = await import('../src/recovery-assembly.ts');
registerGenerationRecoverySources();

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
        if (payload instanceof Response) return payload.clone();
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

// 中文 CID 字体（STSong-Light，未嵌入），用于验证服务端 CMap 资源路径。
const PDF_CMAP_BUFFER = Buffer.from(
  'JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYSAvRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iagozIDAgb2JqCjw8Ci9CYXNlRm9udCAvU1RTb25nLUxpZ2h0IC9EZXNjZW5kYW50Rm9udHMgWyA8PAovQmFzZUZvbnQgL1NUU29uZy1MaWdodCAvQ0lEU3lzdGVtSW5mbyA8PAovT3JkZXJpbmcgKEdCMSkgL1JlZ2lzdHJ5IChBZG9iZSkgL1N1cHBsZW1lbnQgMAo+PiAvRFcgMTAwMCAvRm9udERlc2NyaXB0b3IgPDwKL0FzY2VudCA3NTIgL0NhcEhlaWdodCA3MzcgL0Rlc2NlbnQgLTI3MSAvRmxhZ3MgNiAvRm9udEJCb3ggWyAtMjUgLTI1NCAxMDAwIDg4MCBdIC9Gb250TmFtZSAvU1RTb25nU3RkLUxpZ2h0IAogIC9JdGFsaWNBbmdsZSAwIC9MZWFkaW5nIDE0OCAvTWF4V2lkdGggMTAwMCAvTWlzc2luZ1dpZHRoIDUwMCAvU3RlbUggOTEgL1N0ZW1WIDU4IAogIC9UeXBlIC9Gb250RGVzY3JpcHRvciAvWEhlaWdodCA1NTMKPj4gL1N1YnR5cGUgL0NJREZvbnRUeXBlMCAvVHlwZSAvRm9udCAKICAvVyBbIDEgWyAyMDcgMjcwIDM0MiA0NjcgNDYyIDc5NyA3MTAgMjM5IDM3NCBdIDEwIFsgMzc0IDQyMyA2MDUgMjM4IDM3NSAyMzggMzM0IDQ2MiBdIDE4IDI2IDQ2MiAyNyAyOCAyMzggCiAgMjkgMzEgNjA1IDMyIFsgMzQ0IDc0OCA2ODQgNTYwIDY5NSA3MzkgNTYzIDUxMSA3MjkgNzkzIAogIDMxOCAzMTIgNjY2IDUyNiA4OTYgNzU4IDc3MiA1NDQgNzcyIDYyOCAKICA0NjUgNjA3IDc1MyA3MTEgOTcyIDY0NyA2MjAgNjA3IDM3NCAzMzMgCiAgMzc0IDYwNiA1MDAgMjM5IDQxNyA1MDMgNDI3IDUyOSA0MTUgMjY0IAogIDQ0NCA1MTggMjQxIDIzMCA0OTUgMjI4IDc5MyA1MjcgNTI0IF0gODEgWyA1MjQgNTA0IDMzOCAzMzYgMjc3IDUxNyA0NTAgNjUyIDQ2NiA0NTIgCiAgNDA3IDM3MCAyNTggMzcwIDYwNSBdIF0KPj4gXSAvRW5jb2RpbmcgL1VuaUdCLVVDUzItSCAvTmFtZSAvRjIgL1N1YnR5cGUgL1R5cGUwIC9UeXBlIC9Gb250Cj4+CmVuZG9iago0IDAgb2JqCjw8Ci9Db250ZW50cyA4IDAgUiAvTWVkaWFCb3ggWyAwIDAgNTk1LjI3NTYgODQxLjg4OTggXSAvUGFyZW50IDcgMCBSIC9SZXNvdXJjZXMgPDwKL0ZvbnQgMSAwIFIgL1Byb2NTZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0KPj4gL1JvdGF0ZSAwIC9UcmFucyA8PAoKPj4gCiAgL1R5cGUgL1BhZ2UKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1BhZ2VNb2RlIC9Vc2VOb25lIC9QYWdlcyA3IDAgUiAvVHlwZSAvQ2F0YWxvZwo+PgplbmRvYmoKNiAwIG9iago8PAovQXV0aG9yIChhbm9ueW1vdXMpIC9DcmVhdGlvbkRhdGUgKEQ6MjAyNjEwMTkxMTQ2NTgrMDgnMDAnKSAvQ3JlYXRvciAoYW5vbnltb3VzKSAvS2V5d29yZHMgKCkgL01vZERhdGUgKEQ6MjAyNjEwMTkxMTQ2NTgrMDgnMDAnKSAvUHJvZHVjZXIgKFJlcG9ydExhYiBQREYgTGlicmFyeSAtIFwob3BlbnNvdXJjZVwpKSAKICAvU3ViamVjdCAodW5zcGVjaWZpZWQpIC9UaXRsZSAodW50aXRsZWQpIC9UcmFwcGVkIC9GYWxzZQo+PgplbmRvYmoKNyAwIG9iago8PAovQ291bnQgMSAvS2lkcyBbIDQgMCBSIF0gL1R5cGUgL1BhZ2VzCj4+CmVuZG9iago4IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDI2Ngo+PgpzdHJlYW0KR2Fybk9ZdGRZQCUsQ15wW2lkdGxMT0lIcEJjMDJqZEEhQUIrQ1REYyFYLEdAKWFCQXM6Xl4vdVBkPkVrVDItVk1bLEdVKVMvN10lLj9sNyxkKnNBK0NMITAmaXNEVSpGNCplVl1gKSJBSmZNNzklaypKXFM9NWE9OFQ6ckFFXGoyRz9kPFBFcVgtO2Y/Oidlb24nJDBMaDc3KiZJLDZqLVNCTlN1JmtaK21lXy9FWWRdWSNIRF5hV0pDJXUmKEM7Z09jbGhVcmpJdFZCS1FYL3M7SUozVjo2MnVzJl5jWDsoL2c+JzZlNVJwMV0uci1ebSpPTkVrRktZQnI5LjQiTjRvOWc7Y3FOfj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA5CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMTAyIDAwMDAwIG4gCjAwMDAwMDAyMDkgMDAwMDAgbiAKMDAwMDAwMTE0MiAwMDAwMCBuIAowMDAwMDAxMzQ1IDAwMDAwIG4gCjAwMDAwMDE0MTMgMDAwMDAgbiAKMDAwMDAwMTY3NCAwMDAwMCBuIAowMDAwMDAxNzMzIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPGEyNzJlMWZmM2E4MGE4ZDRjN2I2ZWM2N2Y2MjI0ZWEzPjxhMjcyZTFmZjNhODBhOGQ0YzdiNmVjNjdmNjIyNGVhMz5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNiAwIFIKL1Jvb3QgNSAwIFIKL1NpemUgOQo+PgpzdGFydHhyZWYKMjA4OQolJUVPRgo=',
  'base64',
);

// ---------- 开始 ----------
const auth = await import('../src/lib/server/auth.ts');
const credits = await import('../src/lib/server/credits.ts');
const documents = await import('../src/lib/server/documents.ts');
const engine = await import('../src/lib/server/engine.ts');
const dsl = await import('../src/lib/server/generation/dsl.ts');
const clientDsl = await import('../src/lib/client/dsl.ts');
const codia = await import('../src/modules/editable-export/server/codia.ts');
const configMod = await import('../src/lib/server/generation/config.ts');
const generationDb = await import('../src/lib/server/generation/db.ts');
const decks = await import('../src/lib/server/generation/decks.ts');
const actions = await import('../src/lib/server/generation/actions.ts');
const exportsLib = await import('../src/lib/server/exports.ts');
const editableExportLib = await import('../src/modules/editable-export/server/editable.ts');
const singlePages = await import('../src/lib/server/generation/single-pages.ts');
const projects = await import('../src/lib/server/generation/projects.ts');
const paidRun = await import('../src/lib/server/generation/paid-run.ts');
const { STYLE_PACKS } = await import('../src/data/style-packs.ts');

const baseConfig = configMod.getGenerationConfig();
const documentedDefaults = configMod.getGenerationConfig({});
check('默认 LLM 链与生产文档一致',
  documentedDefaults.llmModel === 'deepseek-v4-flash'
    && documentedDefaults.llmFallbackModels.length === 0
    && documentedDefaults.llmBaseUrl === 'https://api.deepseek.com/v1'
    && documentedDefaults.llmReasoningEffort === 'low');
check('生图自动重试可通过环境变量显式关闭', configMod.getGenerationConfig({ ...process.env, ANPPT_V2_IMAGE_MAX_RETRIES: '0' }).imageMaxRetries === 0);
const imageConfig = {
  ...baseConfig,
  imageBaseUrl: 'http://mock-image',
  imageApiKey: 'sk-mock',
  imageGlobalConcurrency: 100,
  imageStartsPerMinute: 10000,
  imagePerUserConcurrency: 100,
  imageStartsPerUserPerMinute: 10000,
  imageMaxRetries: 0,
  imageRetryBaseMs: 1,
};
const engineConfig = { ...imageConfig, engineInternalToken: 'tok', engineBaseUrl: 'http://mock-engine' };
const llmConfig = {
  ...imageConfig,
  engineInternalToken: '',
  llmBaseUrl: 'http://mock-llm/v1',
  llmApiKey: 'sk-mock',
  llmModel: 'deepseek-v4-flash',
  llmFallbackModels: [],
  llmReasoningEffort: 'low',
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
  const cnPdf = await documents.parseDocument(PDF_CMAP_BUFFER, 'chinese.pdf');
  check('中文 CID PDF 走本地 CMap 解析出文字', cnPdf.text.includes('四个机制') && cnPdf.text.includes('1200 万元'), `实际: ${cnPdf.text.slice(0, 40)}`);
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
  const clientParsed = clientDsl.parseDsl('【标题】T\n【区域：左栏】\n【模块标题】要点\n【正文】内容');
  const clientRoundTrip = clientDsl.parseDsl(clientDsl.serializeDsl(clientParsed.blocks));
  check('浏览器可视化 DSL 序列化往返稳定',
    clientParsed.errors.length === 0
      && clientRoundTrip.errors.length === 0
      && clientRoundTrip.blocks.map((block) => `${block.tag}:${block.arg}:${block.content}`).join('|')
        === clientParsed.blocks.map((block) => `${block.tag}:${block.arg}:${block.content}`).join('|'));
  const multilineBlocks = clientDsl.parseDsl('【标题】T\n【正文】第一段').blocks;
  multilineBlocks[1].content = '第一段\n第二段';
  const multilineRoundTrip = clientDsl.parseDsl(clientDsl.serializeDsl(multilineBlocks));
  check('可视化正文换行保存后仍是合法 DSL',
    multilineRoundTrip.errors.length === 0 && multilineRoundTrip.blocks[1].content === '第一段 第二段');
}

console.log('\n[2a] Codia 网络抖动安全降级与自动恢复（全 mock）');
{
  const config = { ...baseConfig, codiaBaseUrl: 'http://mock-codia', codiaApiKey: 'sk-codia-test' };
  let networkCalls = 0;
  try {
    await codia.getTask('network-down', {
      config,
      retryDelayMs: 0,
      fetchImpl: async () => {
        networkCalls += 1;
        throw new TypeError('fetch failed: 44.247.196.94:443');
      },
    });
    check('Codia 网络错误映射为可重试安全错误', false, '未抛出错误');
  } catch (error) {
    check('Codia 网络错误映射为可重试安全错误',
      error?.code === 'CODIA_UPSTREAM_UNAVAILABLE'
        && error?.retryable === true
        && !String(error?.message).includes('44.247.196.94')
        && String(error?.message).includes('下载中心'));
  }
  check('Codia GET 网络错误自动短退避重试 2 次', networkCalls === 3, `实际请求 ${networkCalls} 次`);

  let gatewayCalls = 0;
  try {
    await codia.getTask('gateway-down', {
      config,
      retryDelayMs: 0,
      fetchImpl: async () => {
        gatewayCalls += 1;
        return new Response('<html>504 Gateway Timeout</html>', { status: 504 });
      },
    });
    check('Codia 504 不泄露 HTML 错误页', false, '未抛出错误');
  } catch (error) {
    check('Codia 504 不泄露 HTML 错误页',
      error?.code === 'CODIA_UPSTREAM_UNAVAILABLE'
        && error?.retryable === true
        && !String(error?.message).includes('<html>'));
  }
  check('Codia 504 自动恢复请求次数受控', gatewayCalls === 3, `实际请求 ${gatewayCalls} 次`);

  let badRequestCalls = 0;
  try {
    await codia.getTask('bad-input', {
      config, retryDelayMs: 0,
      fetchImpl: async () => {
        badRequestCalls += 1;
        return new Response('<html>400 Bad Request</html>', { status: 400 });
      },
    });
    check('Codia 非 JSON 400 不盲目重试', false, '未抛出错误');
  } catch (error) {
    check('Codia 非 JSON 400 不盲目重试',
      error?.code === 'CODIA_BAD_REQUEST' && error?.retryable === false && badRequestCalls === 1);
  }

  try {
    await codia.getTask('auth-private', {
      config, retryDelayMs: 0,
      fetchImpl: async () => jsonResponse({ message: 'private gateway 10.0.0.8 token detail' }, 401),
    });
    check('Codia 鉴权错误对普通用户隐藏供应商与网关细节', false, '未抛出错误');
  } catch (error) {
    check('Codia 鉴权错误对普通用户隐藏供应商与网关细节',
      error?.code === 'UPSTREAM_AUTH'
        && !/Codia|10\.0\.0\.8|token detail/i.test(String(error?.message)));
  }

  let recoveryCalls = 0;
  const recovered = await codia.getTask('recover', {
    config,
    retryDelayMs: 0,
    fetchImpl: async () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) return jsonResponse({ message: 'temporary' }, 502);
      return jsonResponse({ code: 0, data: { status: 'succeeded', result: { ppt_url: 'http://files/ok.pptx', page_count: 2 } } });
    },
  });
  check('Codia 短暂 502 后自动恢复成功',
    recovered.status === 'succeeded' && recovered.pptUrl.endsWith('/ok.pptx') && recoveryCalls === 2);

  const taskCalls = [];
  await codia.createPdfToPptTask(
    { uploadId: 'upl', pageNo: [0], title: '测试', idempotencyKey: 'idem-safe' },
    {
      config,
      retryDelayMs: 0,
      fetchImpl: async (_url, init) => {
        taskCalls.push(init?.headers?.['Idempotency-Key']);
        if (taskCalls.length === 1) return jsonResponse({ message: 'temporary' }, 502);
        return jsonResponse({ code: 0, data: { task_id: 'task-ok', status: 'pending' } });
      },
    },
  );
  check('Codia 建任务重试始终复用 Idempotency-Key', taskCalls.length === 2 && taskCalls.every((key) => key === 'idem-safe'));
}

console.log('\n[2b] 页型归一 + 场景推断 + 原创风格 DNA + 逐页参考图');
{
  const pageTypes = await import('../src/lib/server/generation/page-types.ts');
  const stylePacks = await import('../src/lib/server/generation/style-packs.ts');
  const styleDna = await import('../src/data/style-design-dna.ts');
  check('role 优先：cover 直接封面页', pageTypes.resolvePageType('数据图表', 'cover').key === 'cover');
  check('role 优先：ending 直接结尾页', pageTypes.resolvePageType('', 'ending').key === 'ending');
  check('关键词命中：数据图表 → data-chart', pageTypes.resolvePageType('数据图表', 'content').key === 'data-chart');
  check('最长关键词胜出：大数字指标 → big-number', pageTypes.resolvePageType('大数字指标', 'content').key === 'big-number');
  check('时间轴/流程/对比/表格各自命中',
    pageTypes.resolvePageType('时间轴', 'content').key === 'timeline'
    && pageTypes.resolvePageType('实施步骤', 'content').key === 'process'
    && pageTypes.resolvePageType('竞品对比', 'content').key === 'comparison'
    && pageTypes.resolvePageType('参数表格', 'content').key === 'table');
  check('赛事高价值页型覆盖解决方案/技术路线/商业模式/社会价值/技能展示',
    pageTypes.resolvePageType('bp_solution', 'content').key === 'solution'
    && pageTypes.resolvePageType('核心技术路线', 'content').key === 'technical-route'
    && pageTypes.resolvePageType('商业模式', 'content').key === 'business-model'
    && pageTypes.resolvePageType('社会价值', 'content').key === 'social-impact'
    && pageTypes.resolvePageType('技能演示', 'content').key === 'skills-showcase');
  check('页型注册表从通用 16 型扩展为 30+ 信息任务', pageTypes.PAGE_TYPES.length >= 30, `实际 ${pageTypes.PAGE_TYPES.length}`);
  check('自由文本兜底通用内容页', pageTypes.resolvePageType('随便写点什么', 'content').key === 'content');
  check('空 pageType 兜底通用内容页', pageTypes.resolvePageType('', 'content').key === 'content');
  // 原孤儿脚本 test-page-types.mjs 的别名回归表（本文件是唯一副本）
  const pageTypeAliasCases = [
    ['市场痛点', 'pain-analysis'],
    ['bp_skill_demo', 'skills-showcase'],
    ['bp_cover', 'cover'],
    ['工作流程', 'workflow'],
    ['技能要点', 'skill'],
    ['项目成果', 'outcomes'],
    ['项目设计', 'design'],
    ['应用价值', 'value'],
    ['创新点', 'innovation'],
    ['股权结构', 'funding-plan'],
    ['封面', 'cover'],
    ['目录', 'toc'],
    ['技术路线', 'technical-route'],
    ['产教融合', 'education-impact'],
    ['流程', 'process'],
    ['团队介绍', 'team'],
    ['解决方案', 'solution'],
  ];
  const pageTypeAliasMisses = pageTypeAliasCases.filter(
    ([pageType, expected]) => pageTypes.resolvePageType(pageType, 'content').key !== expected,
  );
  check('页型别名回归表全绿（含赛事/通用历史别名）',
    pageTypeAliasMisses.length === 0, JSON.stringify(pageTypeAliasMisses));

  const pack = stylePacks.resolveStylePack(STYLE_PACKS[0].id);
  const slide = { role: 'content', pageType: '数据图表', title: 'T', goal: '', copyLines: ['一行'], visualNote: '' };
  const p1 = stylePacks.buildSlideImagePrompt(slide, pack, {
    deckContext: { totalPages: 10, pageIndex: 2, chapter: '背景' },
  });
  check('prompt 含页型协议（信息任务+构图版式分层规则）',
    p1.includes('页型协议 · 数据图表页') && p1.includes('2. 信息任务：') && p1.includes('3. 构图与版式：'));
  check('prompt 含整套一致性段（总页数+页码+章节）', p1.includes('全套 10 页中的第 3 页') && p1.includes('「背景」章节'));
  check('prompt 保留易转可编辑条款', p1.includes(stylePacks.EDITABLE_FRIENDLY_CLAUSE));
  check('prompt 禁止通用 AI 图与虚构 Logo/奖项/数据',
    p1.includes('通用 AI 大脑') && p1.includes('不得生成页面文案未提供的 Logo') && p1.includes('不得自行生成百分比'));
  const p2 = stylePacks.buildSlideImagePrompt(slide, pack, { deckContext: { totalPages: 1, pageIndex: 0, chapter: '' } });
  check('单页整套不注入一致性段', !p2.includes('整套一致性要求'));
  const p3 = stylePacks.buildSlideImagePrompt(slide, pack);
  check('无 deckContext 不注入一致性段', !p3.includes('整套一致性要求'));
  const p4 = stylePacks.buildSlideImagePrompt({ ...slide, visualNote: '放柱状图' }, pack, { withStyleReferenceHint: true });
  check('参考图提示与 visualNote 页型约束共存', p4.includes('随附一张同风格参考样张') && p4.includes('只能在上述信息任务与页型框架内执行'));
  check('参考图提示明确禁止复制参考文字/Logo/数字',
    p4.includes('不得复制参考图的文字、Logo、数字') && p4.includes('不得把封面布局硬套到内容页'));

  const stageDefs = stylePacks.SLIDE_PROMPT_STAGE_DEFS;
  check('生图提示词钉死为八段式结构（段序与职责键不可增删）',
    stageDefs.length === 8
      && stageDefs.map((def) => def.key).join('/') === 'context-task/deck-consistency/page-role-protocol/page-copy/layout-imagery/style-dna/content-fidelity/editable-friendly'
      && stageDefs.every((def, index) => def.order === index + 1 && Boolean(def.label) && Boolean(def.focus)));
  const fullDeckContext = { totalPages: 10, pageIndex: 2, chapter: '背景', blueprint: 'BP 规范正文' };
  const fullSlide = { ...slide, visualNote: '放柱状图' };
  const fullStages = stylePacks.buildSlideImagePromptStages(fullSlide, pack, {
    deckContext: fullDeckContext,
    withStyleReferenceHint: true,
  });
  check('满配上下文（全套+规范+参考样张+版式建议）八段全部参与拼接',
    fullStages.length === 8 && fullStages.every((stage) => stage.text.length > 0));
  check('八段拼装结果与生图提示词逐字一致（段序即拼接序）',
    fullStages.map((stage) => stage.text).filter(Boolean).join('\n\n')
      === stylePacks.buildSlideImagePrompt(fullSlide, pack, { deckContext: fullDeckContext, withStyleReferenceHint: true }));
  const bareStages = stylePacks.buildSlideImagePromptStages(slide, pack);
  check('缺省上下文只跳过不适用段，段位仍固定为八段',
    bareStages.length === 8 && bareStages.filter((stage) => stage.text.length > 0).length === 6);
  check('styleDirective 注入视觉关键词行', stylePacks.styleDirective(pack).includes('现有样张视觉关键词：'));
  check('resolveStylePack 透出包数据视觉关键词', Array.isArray(pack.visualKeywords) && pack.visualKeywords.length >= 6);
  check('每个公开风格包都有原创设计 DNA 和有效封面样张', STYLE_PACKS.every((item) => {
    const dna = styleDna.getStyleDesignDna(item.id);
    return dna.palette.length >= 4 && dna.grid.length > 20 && existsSync(path.join(process.cwd(), 'public', item.previewUrl.replace(/^\/+/, '')));
  }));
  const originalCompetitionPacks = [
    { id: 'anppt-original-innovation-20260822', dir: '深海蓝创新赛事答辩风' },
    { id: 'anppt-original-skill-20260822', dir: '精密制造技能竞赛风' },
    { id: 'anppt-original-career-20260822', dir: '暖橙职业成长答辩风' },
  ];
  const expectedReferenceRoles = ['cover', 'toc', 'section', 'content', 'data', 'process'];
  const originalCompetitionEntries = originalCompetitionPacks.map(({ id, dir }) => ({
    id,
    dir,
    pack: STYLE_PACKS.find((item) => item.id === id),
  }));
  check('三套原创赛事风格包均以稳定 id 公开',
    originalCompetitionEntries.every(({ pack }) => Boolean(pack)));
  check('三套原创赛事风格包归入赛事/竞赛分类',
    originalCompetitionEntries.every(({ pack }) => pack?.category === '赛事/竞赛'));
  check('三套原创赛事风格包各有六类且文件完整的预览资产',
    originalCompetitionEntries.every(({ pack }) => pack?.previewImageUrls.length === expectedReferenceRoles.length
      && pack.previewImageUrls.every((assetUrl) => existsSync(path.join(process.cwd(), 'public', assetUrl.replace(/^\/+/, ''))))));
  check('三套原创赛事 DNA 按 cover/toc/section/content/data/process 精确映射',
    originalCompetitionEntries.every(({ id, pack }) => {
      if (!pack) return false;
      const references = styleDna.getStyleDesignDna(id).references;
      return expectedReferenceRoles.every((role, index) => references[role]?.length === 1
        && references[role][0] === index
        && path.basename(pack.previewImageUrls[index]) === `${role}.webp`);
    }));
  check('三套原创赛事资产 manifest 已通过人工视觉审核',
    originalCompetitionEntries.every(({ id, dir }) => {
      const manifestPath = path.join(process.cwd(), 'public', 'assets', 'style-packs', dir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return manifest.stylePackId === id
        && manifest.reviewStatus === 'passed-manual-visual-qc'
        && Array.isArray(manifest.files)
        && manifest.files.length === expectedReferenceRoles.length;
    }));
  check('三套原创赛事公开路径和名称不含第三方模板品牌',
    originalCompetitionEntries.every(({ pack }) => pack
      && !/(抖研|douyan)/i.test([pack.name, pack.slug, pack.previewUrl, ...pack.previewImageUrls].join(' '))));
  check('易转可编辑条款包含 Codia 元素分区硬约束',
    stylePacks.EDITABLE_FRIENDLY_CLAUSE.includes('照片区域不得承载文字')
      && stylePacks.EDITABLE_FRIENDLY_CLAUSE.includes('单页不超过 5 个主要文本组')
      && stylePacks.EDITABLE_FRIENDLY_CLAUSE.includes('避免多层透明叠加、复杂蒙版、过细描边和跨区斜切文字'));
  check('自有风格名称不再使用第三方品牌式命名',
    STYLE_PACKS.every((item) => !/(Apple|苹果|NVIDIA|Microsoft|微软)/i.test(item.name)));
  check('品牌式旧名称仍作为 legacySlugs 兼容历史链接',
    STYLE_PACKS.some((item) => item.legacySlugs?.includes('苹果商务汇报极简风格'))
    && STYLE_PACKS.some((item) => item.legacySlugs?.includes('NVIDIA式深绿光感科技风格'))
    && STYLE_PACKS.some((item) => item.legacySlugs?.includes('Microsoft Fluent磨砂玻璃风格')));

  const competitionContext = stylePacks.inferPresentationContext({
    role: 'content', pageType: '痛点分析', title: '挑战杯项目痛点', goal: '面向评委证明需求',
    copyLines: ['智慧农业赛道，服务水稻种植农户'], visualNote: '',
  }, pack);
  check('语境推断识别高校赛事 + 农业赛道',
    competitionContext.audience === 'competition' && competitionContext.domain === 'agriculture',
    `实际 ${competitionContext.audience}/${competitionContext.domain}`);
  const deckContextSignal = stylePacks.inferPresentationContext({
    role: 'content', pageType: '解决方案', title: '核心方案', goal: '说明方案',
    copyLines: ['覆盖育种、种植与服务环节'], visualNote: '',
  }, pack, {
    totalPages: 20, pageIndex: 6, deckTitle: '挑战杯智慧农业项目答辩',
    sourceContext: '面向水稻种植与乡村振兴赛道，为评委展示参赛项目证据链。',
  });
  check('整套标题与原文信号可为通用页面补足赛事/行业语境',
    deckContextSignal.audience === 'competition' && deckContextSignal.domain === 'agriculture',
    `实际 ${deckContextSignal.audience}/${deckContextSignal.domain}`);
  const publicContext = stylePacks.inferPresentationContext({
    role: 'content', pageType: '工作成效', title: '公共医疗服务年度成效', goal: '',
    copyLines: ['事业单位持续提升基层诊疗能力'], visualNote: '',
  }, pack);
  check('语境推断识别工作单位 + 医疗场景',
    publicContext.audience === 'public-sector' && publicContext.domain === 'medical',
    `实际 ${publicContext.audience}/${publicContext.domain}`);

  const coverSlide = { ...slide, role: 'cover', pageType: '封面', title: '年度经营汇报' };
  const dataSlide = { ...slide, pageType: '经营数据', title: '核心经营指标' };
  const coverRef = stylePacks.selectStyleReferencePath(coverSlide, pack, { totalPages: 10, pageIndex: 0 });
  const dataRef = stylePacks.selectStyleReferencePath(dataSlide, pack, { totalPages: 10, pageIndex: 5 });
  check('封面与数据页选择同包不同页型参考图', Boolean(coverRef) && Boolean(dataRef) && coverRef !== dataRef,
    `cover=${coverRef} data=${dataRef}`);
  check('参考图选择确定性稳定', dataRef === stylePacks.selectStyleReferencePath(dataSlide, pack, { totalPages: 10, pageIndex: 5 }));
  check('参考图可读取为 data URL', stylePacks.loadStyleReferenceDataUrl(pack, dataRef)?.startsWith('data:image/') === true);
}

console.log('\n[2c] 生图全站调度：并发上限 + 瞬态后台恢复');
{
  const images = await import('../src/lib/server/generation/images.ts');
  images.resetImageSchedulerForTests();
  let active = 0;
  let maxActive = 0;
  const concurrencyFetcher = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] });
  };
  const schedulerConfig = {
    ...imageConfig,
    imageGlobalConcurrency: 2,
    imageStartsPerMinute: 100,
    imageMaxRetries: 0,
  };
  await Promise.all(Array.from({ length: 6 }, (_, index) =>
    images.generateImage({ prompt: `调度测试 ${index}` }, { fetchImpl: concurrencyFetcher, config: schedulerConfig })));
  check('全站在途生图不超过配置上限 2', maxActive === 2, `实际 ${maxActive}`);

  images.resetImageSchedulerForTests();
  const fairnessStarted = [];
  const fairnessFetcher = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    fairnessStarted.push(String(body.prompt || ''));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] });
  };
  const fairnessConfig = {
    ...schedulerConfig,
    imageGlobalConcurrency: 2,
    imageStartsPerMinute: 10000,
    imagePerUserConcurrency: 1,
    imageStartsPerUserPerMinute: 10000,
  };
  await Promise.all([
    images.generateImage({ prompt: 'A1', userKey: 'user-A' }, { fetchImpl: fairnessFetcher, config: fairnessConfig }),
    images.generateImage({ prompt: 'A2', userKey: 'user-A' }, { fetchImpl: fairnessFetcher, config: fairnessConfig }),
    images.generateImage({ prompt: 'B1', userKey: 'user-B' }, { fetchImpl: fairnessFetcher, config: fairnessConfig }),
    images.generateImage({ prompt: 'B2', userKey: 'user-B' }, { fetchImpl: fairnessFetcher, config: fairnessConfig }),
  ]);
  check('单用户不会占满全站生图槽位（A1/B1 先启动）',
    fairnessStarted.slice(0, 2).sort().join(',') === 'A1,B1',
    `实际 ${fairnessStarted.join(',')}`);

  images.resetImageSchedulerForTests();
  let retryCalls = 0;
  const retryFetcher = async () => {
    retryCalls += 1;
    return retryCalls < 3
      ? jsonResponse({ error: { message: 'temporary' } }, 500)
      : jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] });
  };
  const recovered = await images.generateImage(
    { prompt: '瞬态恢复' },
    { fetchImpl: retryFetcher, config: { ...schedulerConfig, imageMaxRetries: 2, imageRetryBaseMs: 1 } },
  );
  check('500 瞬态错误后台恢复两次后成功', recovered.length > 0 && retryCalls === 3, `调用 ${retryCalls}`);

  images.resetImageSchedulerForTests();
  let badCalls = 0;
  try {
    await images.generateImage(
      { prompt: '请求错误不重试' },
      { fetchImpl: async () => { badCalls += 1; return jsonResponse({ error: { message: 'bad input' } }, 400); }, config: schedulerConfig },
    );
  } catch {
    // expected
  }
  check('400 请求错误不自动重试', badCalls === 1, `调用 ${badCalls}`);
  images.resetImageSchedulerForTests();
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
  const outlineRequest = JSON.parse(llmFetcher.calls[0].init.body);
  const outlineSystemPrompt = outlineRequest.messages?.find((message) => message.role === 'system')?.content || '';
  check('大纲提示包含赛事/技能/职业/企业/政企/科研六类自有叙事骨架',
    ['创新创业/挑战杯类', '技能/教学/世校赛类', '职业规划类', '企业经营类', '政企、学校行政与工作单位类', '科研学术类']
      .every((label) => outlineSystemPrompt.includes(label)));
  check('DeepSeek 大纲请求显式低思考',
    outlineRequest.model === 'deepseek-v4-flash'
      && outlineRequest.thinking?.type === 'enabled'
      && outlineRequest.reasoning_effort === 'low');
  const otherFetcher = makeMockFetcher([
    {
      match: '/chat/completions',
      payload: { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(OUTLINE_FIXTURE)}\n\`\`\`` } }] },
    },
  ]);
  await engine.generateOutline(
    { sourceText: '2025 年销售额 1200 万元', targetPageCount: 2 },
    { fetchImpl: otherFetcher, config: { ...llmConfig, llmModel: 'gemini-3.1-flash-lite' } },
  );
  const otherRequest = JSON.parse(otherFetcher.calls[0].init.body);
  check('非 DeepSeek 模型不附加 thinking 字段',
    otherRequest.model === 'gemini-3.1-flash-lite'
      && otherRequest.thinking === undefined
      && otherRequest.reasoning_effort === undefined);

  // 兜底路径失败口径：统一 ENGINE_UNAVAILABLE 503 可重试（不裸 500）
  const capture = async (fetcher) => {
    try {
      await engine.generateOutline({ sourceText: 'x', targetPageCount: 2 }, { fetchImpl: fetcher, config: llmConfig });
      return null;
    } catch (error) {
      return error;
    }
  };
  const err502 = await capture(makeMockFetcher([
    { match: '/chat/completions', payload: new Response('gateway garbage', { status: 502 }) },
  ]));
  check('LLM 兜底上游 502 → ENGINE_UNAVAILABLE 503 可重试',
    err502?.code === 'ENGINE_UNAVAILABLE' && err502?.status === 503 && err502?.retryable === true,
    `实际 ${err502?.code}/${err502?.status}`);
  const errBadJson = await capture(makeMockFetcher([
    { match: '/chat/completions', payload: { choices: [{ message: { content: '抱歉我无法输出 JSON' } }] } },
  ]));
  check('LLM 兜底返回非 JSON → ENGINE_UNAVAILABLE 503 可重试',
    errBadJson?.code === 'ENGINE_UNAVAILABLE' && errBadJson?.status === 503 && errBadJson?.retryable === true,
    `实际 ${errBadJson?.code}/${errBadJson?.status}`);
  const errEmpty = await capture(makeMockFetcher([
    { match: '/chat/completions', payload: { choices: [{ message: { content: '"不是数组"' } }] } },
  ]));
  check('兜底空大纲仍走 OUTLINE_FAILED 502（engineFailure 不吞业务错）',
    errEmpty?.code === 'OUTLINE_FAILED' && errEmpty?.status === 502, `实际 ${errEmpty?.code}/${errEmpty?.status}`);

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
  const r1 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'generateOutline', params: {} }, fullDeps);
  check('outline 后 status=outlined、2 页', r1.state.deck.status === 'outlined' && r1.state.slides.length === 2);
  const r1b = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'generateOutline', params: {} }, fullDeps);
  check('重复 outline（无 force）复用', r1b.extra.reused === true);

  const r2 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'structureSlides', params: {} }, fullDeps);
  check('structure 后 status=structured 且全部 ok', r2.state.deck.status === 'structured' && r2.state.slides.every((s) => s.structureStatus === 'ok'));
  check('structuredContent 已存库', r2.state.slides.every((s) => s.structuredContent.includes('【标题】')));

  const r3 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'confirmStructure', params: {} }, fullDeps);
  check('confirm 后 status=confirmed、contentLocked=true', r3.state.deck.status === 'confirmed' && r3.state.contentLocked === true);

  await expectThrows('冻结后 outline 被拒', () =>
    actions.dispatchDeckIntent(uid, deck.id, { kind: 'generateOutline', params: { force: true } }, fullDeps), 'CONTENT_LOCKED');
  await expectThrows('冻结后 add-slide 被拒', () =>
    actions.dispatchDeckIntent(uid, deck.id, { kind: 'addSlide', params: {} }, fullDeps), 'CONTENT_LOCKED');
  await expectThrows('冻结后 delete-slide 被拒', () =>
    actions.dispatchDeckIntent(uid, deck.id, { kind: 'removeSlide', params: { slideId: r3.state.slides[0].slideId } }, fullDeps), 'CONTENT_LOCKED');

  await expectThrows('未选风格 generate 被拒', () =>
    actions.dispatchDeckIntent(uid, deck.id, { kind: 'generateSlides', params: {} }, fullDeps), 'STYLE_REQUIRED');

  const r4 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'setStyle', params: { stylePackId: STYLE_PACKS[0].id } }, fullDeps);
  check('style 选中风格包', r4.state.deck.stylePackId === STYLE_PACKS[0].id);

  // 换实现即换价 + 启动快照：价表第一次读 10、之后读 99；若任务内重读价，净扣会被抬到 99
  const { getDefaultCtx, setDefaultCtx } = await import('../src/lib/plugin/default.ts');
  const { boot } = await import('../src/lib/plugin/profile.ts');
  const defaultCtx = getDefaultCtx();
  let priceReads = 0;
  const risingPrices = {
    'generate.page': 10, 'edit.page': 10, outline: 0, 'export.image': 0,
    'export.editable': 20, 'export.editable-text': 5, 'tool.ppt-to-base': 5,
    'generate.single-page': 10, 'edit.single-page': 10,
  };
  setDefaultCtx(await boot({
    name: 'rising-price',
    plugins: [{
      key: 'pricing-rising', version: '0.0.0-test', provides: ['pricing'],
      register(c) {
        c.register('pricing', {
          quote: (key) => risingPrices[key] ?? 0,
          table: () => (++priceReads === 1 ? risingPrices : { ...risingPrices, 'generate.page': 99 }),
        });
      },
    }],
  }));
  const before = credits.getBalance(uid);
  const r5 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'generateSlides', params: {} }, fullDeps);
  check('generate 返回 202 + job', r5.status === 202 && Boolean(r5.job));
  await r5.job.done;
  const s5 = decks.getDeckState(uid, deck.id);
  check('部分失败 → status=partial', s5.deck.status === 'partial', `实际 ${s5.deck.status}`);
  check('第 1 页成功且有图 URL', s5.slides[0].genStatus === 'succeeded' && s5.slides[0].versions[0]?.imageUrl.startsWith('/api/files/generated/'));
  check('第 2 页失败并带错误码', s5.slides[1].genStatus === 'failed' && s5.slides[1].genError.length > 0);
  const afterGen = credits.getBalance(uid);
  setDefaultCtx(defaultCtx);
  check('扣费 2×10、失败页退 10 → 净扣 10（整单只读一次价：启动快照不随中途换价漂移）',
    before - afterGen === 10 && priceReads === 1, `before=${before} after=${afterGen} reads=${priceReads}`);
  const jobId = r5.job.jobId;
  const ledgerRowsDb = await import('../src/lib/server/db.ts');
  const rows = ledgerRowsDb.getDb().prepare('SELECT idempotency_key, delta, event_type FROM credit_ledger WHERE user_id = ? ORDER BY created_at').all(uid);
  const keys = rows.map((r) => String(r.idempotency_key));
  const slideIds = s5.slides.map((s) => s.slideId);
  check('逐页 debit 键 = deck-generate:{deckId}:{jobId}:{slideId}',
    slideIds.every((sid) => keys.includes(`deck-generate:${deck.id}:${jobId}:${sid}`)));
  const deckRefundKey = credits.deriveRefundKey(`deck-generate:${deck.id}:${jobId}:${slideIds[1]}`);
  check('失败页 refund 键唯一且只退一次', keys.filter((k) => k === deckRefundKey).length === 1);
  // 版本行在扣费前记住自己的扣费键：恢复只认存储键，不再从 deck/job/slide 重拼
  const storedKeys = slideIds.map((sid) => String(
    decks.listVersions(sid).find((version) => version.jobId === jobId)?.chargeKey || '',
  ));
  check('新页版本行写入 charge_key 且与账本扣费键逐页一致',
    storedKeys.every((key, index) => key === `deck-generate:${deck.id}:${jobId}:${slideIds[index]}`),
    `实际 ${storedKeys.join(' | ')}`);

  const genPrompts = fullFetcher.calls
    .filter((c) => c.url.includes('/images/generations'))
    .map((c) => JSON.parse(c.init.body).prompt);
  check('链路 prompt 实含页型协议（封面页+数据图表页）',
    genPrompts.some((p) => p.includes('页型协议 · 封面页')) && genPrompts.some((p) => p.includes('页型协议 · 数据图表页')));
  const genBodies = fullFetcher.calls
    .filter((c) => c.url.includes('/images/generations'))
    .map((c) => JSON.parse(c.init.body));
  check('整套生成每一页都携带同风格参考图', genBodies.length === 2
    && genBodies.every((body) => Array.isArray(body.reference_images) && body.reference_images[0]?.url?.startsWith('data:image/')));
  check('封面与数据页使用不同的页型参考样张',
    new Set(genBodies.map((body) => body.reference_images?.[0]?.url)).size === 2);
  check('链路 prompt 实含整套一致性（总页数+页码+章节）',
    genPrompts.some((p) => p.includes('全套 2 页中的第 2 页') && p.includes('「业绩」章节')));

  await expectThrows('生成后（非 generating）内容仍冻结', () =>
    actions.dispatchDeckIntent(uid, deck.id, { kind: 'reorderSlides', params: { order: slideIds } }, fullDeps), 'CONTENT_LOCKED');

  // 失败重试：mock 不再失败（临时移除失败标记页标题不可行，换 forceRegenerate 整单重试）
  const retryFetcher = makeMockFetcher([...engineHandlers, { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
  const r6 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'retryFailedSlides', params: {} }, { fetchImpl: retryFetcher, config: engineConfig });
  await r6.job.done;
  const s6 = decks.getDeckState(uid, deck.id);
  check('retry-failed 后全绿 status=generated', s6.deck.status === 'generated', `实际 ${s6.deck.status}`);
  check('失败页重试后 succeeded 且版本保留（≥2 版）', s6.slides[1].genStatus === 'succeeded' && s6.slides[1].versions.length >= 2);

  // refine-slide（i2i，保留旧版本）
  const r7 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'refineSlide', params: { slideId: s6.slides[0].slideId, editInstruction: '把标题放大一点' } },
    { fetchImpl: retryFetcher, config: engineConfig });
  await r7.job.done;
  const s7 = decks.getDeckState(uid, deck.id);
  check('refine-slide 走 /images/edits 且产生新版本',
    retryFetcher.calls.some((c) => c.url.includes('/images/edits')) && s7.slides[0].versions.length >= 2);
  const refinedVersion = decks.listVersions(s7.slides[0].slideId).find((version) => version.kind === 'refine');
  check('改图新版本同样在扣费前写入 charge_key',
    refinedVersion?.chargeKey === `deck-generate:${deck.id}:${r7.job.jobId}:${s7.slides[0].slideId}`,
    `实际 ${refinedVersion?.chargeKey || ''}`);

  // 逐页重生成也走计费运行模块：执行中在飞清单可见本页扣费键与 job，收尾两者都释放
  let releaseGate;
  let gateReached;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const gateReachedPromise = new Promise((resolve) => { gateReached = resolve; });
  const gatedFetcher = async (url, init = {}) => {
    if (String(url).includes('/images/generations')) {
      gateReached();
      await gate;
    }
    return retryFetcher(url, init);
  };
  const rg = await actions.dispatchDeckIntent(
    uid, deck.id, { kind: 'generateSlide', params: { slideId: s7.slides[0].slideId } },
    { fetchImpl: gatedFetcher, config: engineConfig },
  );
  await gateReachedPromise;
  const pageChargeKey = `deck-generate:${deck.id}:${rg.job.jobId}:${s7.slides[0].slideId}`;
  check('逐页重生成在飞：模块清单透出页扣费键与 job',
    paidRun.isInFlight(pageChargeKey) && paidRun.isInFlight(rg.job.jobId),
    JSON.stringify(paidRun.listInFlight(uid)));
  releaseGate();
  await rg.job.done;
  check('逐页重生成收尾：页与 job 的在飞登记都释放',
    !paidRun.isInFlight(pageChargeKey) && !paidRun.isInFlight(rg.job.jobId));
  check('整套四类动作收尾后无在飞残留', paidRun.listInFlight(uid).length === 0, JSON.stringify(paidRun.listInFlight(uid)));

  // 锚点文件不可读：计划里排后的模板/风格候选顺延接管，不静默丢参考
  decks.setDeckAnchor(deck.id, s7.slides[0].slideId, '/generated/missing-anchor.png');
  const fallbackFetcher = makeMockFetcher([...engineHandlers, { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
  const fb = await actions.dispatchDeckIntent(
    uid, deck.id, { kind: 'generateSlide', params: { slideId: s7.slides[0].slideId } },
    { fetchImpl: fallbackFetcher, config: engineConfig },
  );
  await fb.job.done;
  const fallbackBody = JSON.parse(fallbackFetcher.calls.find((c) => c.url.includes('/images/generations')).init.body);
  check('锚点文件不可读时参考图顺延到下一候选（override 不丢参考）',
    Array.isArray(fallbackBody.reference_images) && fallbackBody.reference_images.length === 1
      && String(fallbackBody.reference_images[0]?.url || '').startsWith('data:image/'));
  decks.setDeckAnchor(deck.id, '', '');

  // unlock-structure：作废已生成页
  const r8 = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'unlockStructure', params: {} }, fullDeps);
  check('unlock 后 status=structured 且页变 stale', r8.state.deck.status === 'structured' && r8.state.slides.every((s) => s.genStatus === 'stale'));
  check('unlock 返回作废提示', String(r8.extra.warning || '').includes('作废'));
}

console.log('\n[4a] 已启动整套生成固定运行时配置快照');
{
  const snapshotUser = await auth.registerWithPassword(
    { account: 'snapshotgen', password: 'password123', confirmPassword: 'password123' },
    '127.0.0.21',
  );
  const snapshotDeck = decks.createDeck(snapshotUser.user.id, {
    title: '配置快照测试', sourceFileName: '', sourceText: '两页内容',
    durationMinutes: 10, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
  });
  await actions.dispatchDeckIntent(snapshotUser.user.id, snapshotDeck.id, { kind: 'generateOutline', params: {} }, fullDeps);
  await actions.dispatchDeckIntent(snapshotUser.user.id, snapshotDeck.id, { kind: 'structureSlides', params: {} }, fullDeps);
  await actions.dispatchDeckIntent(snapshotUser.user.id, snapshotDeck.id, { kind: 'confirmStructure', params: {} }, fullDeps);
  await actions.dispatchDeckIntent(snapshotUser.user.id, snapshotDeck.id, { kind: 'setStyle', params: { stylePackId: STYLE_PACKS[0].id } }, fullDeps);

  const envKeys = [
    'ANPPT_V2_IMAGE_BASE_URL', 'ANPPT_V2_IMAGE_API_KEY', 'ANPPT_V2_IMAGE_MODEL',
    'ANPPT_V2_GENERATE_CONCURRENCY', 'ANPPT_V2_IMAGE_MAX_RETRIES',
  ];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ANPPT_V2_IMAGE_BASE_URL: 'http://snapshot-image-a.test',
    ANPPT_V2_IMAGE_API_KEY: 'snapshot-key-a',
    ANPPT_V2_IMAGE_MODEL: 'snapshot-model-a',
    ANPPT_V2_GENERATE_CONCURRENCY: '1',
    ANPPT_V2_IMAGE_MAX_RETRIES: '0',
  });
  const requestModels = [];
  const requestUrls = [];
  const snapshotFetcher = async (url, init = {}) => {
    requestUrls.push(String(url));
    const body = JSON.parse(init.body);
    requestModels.push(body.model);
    if (requestModels.length === 1) {
      process.env.ANPPT_V2_IMAGE_BASE_URL = 'http://snapshot-image-b.test';
      process.env.ANPPT_V2_IMAGE_API_KEY = 'snapshot-key-b';
      process.env.ANPPT_V2_IMAGE_MODEL = 'snapshot-model-b';
    }
    return jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] });
  };
  try {
    const started = await actions.dispatchDeckIntent(
      snapshotUser.user.id, snapshotDeck.id, { kind: 'generateSlides', params: {} }, { fetchImpl: snapshotFetcher },
    );
    check('整套生成在飞登记由计费运行模块维护',
      paidRun.isInFlight(started.job.jobId)
        && paidRun.listInFlight(snapshotUser.user.id).some((run) => run.runId === started.job.jobId));
    await started.job.done;
    check('整套生成结束释放模块在飞登记',
      !paidRun.isInFlight(started.job.jobId)
        && paidRun.listInFlight(snapshotUser.user.id).length === 0);
    check('管理员中途改配置不影响已启动整套生成',
      requestModels.length === 2
        && requestModels.every((model) => model === 'snapshot-model-a')
        && requestUrls.every((url) => url.startsWith('http://snapshot-image-a.test/')));
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
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
  await actions.dispatchDeckIntent(uid, d3.id, { kind: 'generateOutline', params: {} }, okDeps);
  const s0 = decks.getDeckState(uid, d3.id).slides[0].slideId;

  const u1 = await actions.dispatchDeckIntent(uid, d3.id, { kind: 'updateSlide', params: { slideId: s0, title: '新标题', rawText: '第一季度销售额 1200 万元，同比增长 20%' } }, okDeps);
  check('update-slide 标题/原文入库',
    u1.state.slides[0].title === '新标题' && u1.state.slides[0].rawText.includes('1200 万元'));

  await actions.dispatchDeckIntent(uid, d3.id, { kind: 'structureSlides', params: {} }, okDeps);
  const u2 = await actions.dispatchDeckIntent(uid, d3.id, { kind: 'updateSlide', params: { slideId: s0, chapter: '第二章' } }, okDeps);
  check('仅改章节：deck 不回退且梳理结果保留',
    u2.state.deck.status === 'structured' && u2.state.slides[0].structureStatus === 'ok' && u2.state.slides[0].chapter === '第二章');
  generationDb.getGenDb().prepare("UPDATE deck_slides SET structure_warnings = '[\"旧提示\"]' WHERE id = ?").run(s0);
  const manualDsl = '【标题】人工新标题\n【区域：核心区域】\n【模块标题】人工模块\n【重点正文】人工调整后的梳理内容';
  const manual = await actions.dispatchDeckIntent(uid, d3.id, { kind: 'updateSlide', params: { slideId: s0, title: '人工新标题', structuredContent: manualDsl } }, okDeps);
  check('人工编辑梳理内容后保持 structured + 本页 ok',
    manual.state.deck.status === 'structured'
      && manual.state.slides[0].structureStatus === 'ok'
      && manual.state.slides[0].structuredContent === manualDsl);
  check('人工编辑梳理内容后清除旧 warnings', manual.state.slides[0].structureWarnings.length === 0);
  await expectThrows('人工保存非法 DSL 被拒', () =>
    actions.dispatchDeckIntent(uid, d3.id, { kind: 'updateSlide', params: { slideId: s0, structuredContent: '这不是合法 DSL' } }, okDeps), 'VALIDATION_ERROR');
  await expectThrows('人工保存空 DSL 被拒', () =>
    actions.dispatchDeckIntent(uid, d3.id, { kind: 'updateSlide', params: { slideId: s0, structuredContent: '   ' } }, okDeps), 'VALIDATION_ERROR');
  const u3 = await actions.dispatchDeckIntent(uid, d3.id, { kind: 'updateSlide', params: { slideId: s0, rawText: '销售额 1200 万元，同比增长 20%，补充第二季度展望' } }, okDeps);
  check('改原文：页打回 pending、deck 回 outlined',
    u3.state.slides[0].structureStatus === 'pending' && u3.state.deck.status === 'outlined');

  await actions.dispatchDeckIntent(uid, d3.id, { kind: 'structureSlides', params: {} }, okDeps);
  await actions.dispatchDeckIntent(uid, d3.id, { kind: 'confirmStructure', params: {} }, okDeps);
  await expectThrows('冻结后 update-slide 被拒', () =>
    actions.dispatchDeckIntent(uid, d3.id, { kind: 'updateSlide', params: { slideId: s0, title: 'x' } }, okDeps), 'CONTENT_LOCKED');

  await actions.dispatchDeckIntent(uid, d3.id, { kind: 'setStyle', params: { stylePackId: STYLE_PACKS[0].id } }, okDeps);
  const g = await actions.dispatchDeckIntent(uid, d3.id, { kind: 'generateSlides', params: {} }, okDeps);
  await g.job.done;
  const st1 = decks.getDeckState(uid, d3.id);
  check('生成全绿 generated', st1.deck.status === 'generated', `实际 ${st1.deck.status}`);
  const v1 = st1.slides[0].versions.find((v) => v.versionNo === 1);

  const failEdit = makeMockFetcher([{ match: '/images/edits', payload: jsonResponse({ error: { message: 'mock i2i 500' } }, 500) }]);
  const rf = await actions.dispatchDeckIntent(uid, d3.id, { kind: 'refineSlide', params: { slideId: s0, editInstruction: '改背景' } },
    { fetchImpl: failEdit, config: engineConfig });
  await rf.job.done;
  const st2 = decks.getDeckState(uid, d3.id);
  check('refine 失败 → deck partial 且旧版本仍在', st2.deck.status === 'partial' && st2.slides[0].versions.length >= 2,
    `实际 ${st2.deck.status}`);

  const vFailed = decks.listVersions(s0).find((v) => v.status === 'failed');
  await expectThrows('failed 版本不可选', () =>
    actions.dispatchDeckIntent(uid, d3.id, { kind: 'commitVersion', params: { slideId: s0, versionId: vFailed.versionId } }, okDeps), 'VERSION_NOT_READY');

  const sv = await actions.dispatchDeckIntent(uid, d3.id, { kind: 'commitVersion', params: { slideId: s0, versionId: v1.versionId } }, okDeps);
  check('回退 v1：activeVersion 生效且整单回 generated',
    sv.state.slides[0].activeVersionId === v1.versionId && sv.state.deck.status === 'generated',
    `实际 ${sv.state.slides[0].activeVersionId} / ${sv.state.deck.status}`);

  const d4 = decks.createDeck(uid, {
    title: '早', sourceFileName: '', sourceText: 'x',
    durationMinutes: 5, targetPageCount: 1, qualityTier: 'standard', stylePackId: '',
  });
  await expectThrows('未确认内容切版本被拒', () =>
    actions.dispatchDeckIntent(uid, d4.id, { kind: 'commitVersion', params: { slideId: 'x', versionId: 'y' } }, okDeps), 'VERSION_SELECT_TOO_EARLY');
}

await runDeckIntentTests({ check, expectThrows, auth, decks, fullDeps });
await runDeckIntentParserTests({ check });
await runSurfaceIntentParserTests({ check });
await runDeckWorkbenchTests({ check });
await runDeckActionTests({ check });
await runPaidRunTests({ check, auth, credits });
await runVisualPlanTests({ check, llmConfig });
await runSinglePageActionTests({ check });
await runSurfaceIntentTests({ check, expectThrows, auth, singlePages, credits, uid, makeMockFetcher, editsOkHandler, PNG_1X1_B64, imageConfig, deck });

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
  await actions.dispatchDeckIntent(poor.user.id, d2.id, { kind: 'generateOutline', params: {} }, fullDeps);
  await actions.dispatchDeckIntent(poor.user.id, d2.id, { kind: 'structureSlides', params: {} }, fullDeps);
  await actions.dispatchDeckIntent(poor.user.id, d2.id, { kind: 'confirmStructure', params: {} }, fullDeps);
  await actions.dispatchDeckIntent(poor.user.id, d2.id, { kind: 'setStyle', params: { stylePackId: STYLE_PACKS[0].id } }, fullDeps);
  await expectThrows('余额 5 < 20 → 402 INSUFFICIENT_CREDITS', async () => {
    try {
      await actions.dispatchDeckIntent(poor.user.id, d2.id, { kind: 'generateSlides', params: {} }, fullDeps);
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
  await actions.dispatchDeckIntent(uid, deck.id, { kind: 'confirmStructure', params: {} }, okDeps);
  const rg = await actions.dispatchDeckIntent(uid, deck.id, { kind: 'generateSlides', params: { forceRegenerate: true } }, okDeps);
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

  const list = editableExportLib.listExports(uid, {});
  check('导出中心列出记录', list.items.some((item) => item.exportId === result.exportId));
  const one = await editableExportLib.getExport(uid, result.exportId);
  check('导出详情可取', one.url === result.url);

}

await runEditableExportTests({ check, expectThrows, auth, credits, uid, llmConfig, baseConfig, decks, singlePages, makeMockFetcher, editsOkHandler, PNG_1X1_B64, deck, actions, STYLE_PACKS, engineConfig, engineHandlers, imageConfig, jsonResponse });
await runImage2PptTests({ check, baseConfig, credits, uid, deck, makeMockFetcher, jsonResponse });
// provider 套件排在 WPS 之前：WPS 段会触发进程级 10 分钟限流冷却，之后同进程再调 WPS 会被直接拒，
// provider 段的共享文案断言就看不到真实的上游响应路径。
await runEditableProviderTests({ check, baseConfig, credits, uid, deck });
await runWpsAipptTests({ check, baseConfig, credits, uid, deck, jsonResponse });

console.log('\n[7] 单页生成器（generate/refine/失败退还/导出）');
{
  const okFetcher = makeMockFetcher([{ match: '/images/generations', payload: (init) => {
    const body = JSON.parse(init.body);
    if (body.prompt.includes('会失败的内容')) return jsonResponse({ error: { message: 'mock 500' } }, 500);
    return { data: [{ b64_json: PNG_1X1_B64 }] };
  } }, editsOkHandler]);
  const okDeps = { fetchImpl: okFetcher, config: imageConfig };

  // 换实现即换价：替代 pricing 报 30/张，单页生成路径不存价格、零改动跟随
  const { getDefaultCtx, setDefaultCtx } = await import('../src/lib/plugin/default.ts');
  const { boot } = await import('../src/lib/plugin/profile.ts');
  const defaultCtx = getDefaultCtx();
  setDefaultCtx(await boot({
    name: 'triple-price',
    plugins: [{
      key: 'pricing-triple', version: '0.0.0-test', provides: ['pricing'],
      register(c) {
        c.register('pricing', {
          quote: () => 30,
          table: () => ({ 'generate.page': 30, 'generate.single-page': 30, 'edit.page': 30, 'edit.single-page': 30 }),
        });
      },
    }],
  }));
  const before = credits.getBalance(uid);
  const g1 = await singlePages.generateSinglePage(uid, {
    pageId: 'page-001', title: '单页一', content: '第一季度营收 1200 万元', stylePackId: STYLE_PACKS[0].id,
  }, okDeps);
  setDefaultCtx(defaultCtx);
  check('单页生成成功出图', g1.status === 'succeeded' && g1.imageUrl.startsWith('/api/files/generated/'));
  const singleGenerateBody = JSON.parse(okFetcher.calls.find((c) => c.url.includes('/images/generations')).init.body);
  check('单页生成也携带所选风格的内容页参考图',
    Array.isArray(singleGenerateBody.reference_images) && singleGenerateBody.reference_images[0]?.url?.startsWith('data:image/'));
  check('单选模板包时单页走视觉计划的模板参考路线（与整套同一配方）',
    singleGenerateBody.prompt.includes('真模板参考页') && singleGenerateBody.prompt.includes('把本页文案准确填入'));
  check('单页扣 ×3 实现报价 30🌟（换实现即换价）', before - g1.balance === 30, `before=${before} after=${g1.balance}`);

  const g2 = await singlePages.refineSinglePage(uid, { pageId: 'page-001', editInstruction: '改成深色背景' }, okDeps);
  check('单页改图成功且走 edits', g2.status === 'succeeded' && okFetcher.calls.some((c) => c.url.includes('/images/edits')));
  const refinePromptRow = generationDb.getGenDb()
    .prepare('SELECT prompt FROM single_page_versions WHERE id = ?')
    .get(g2.versionId);
  check('单页改图后缀归视觉计划模块（版本提示词只此一份模板）',
    String(refinePromptRow?.prompt || '').includes('改图要求（在保持整体风格与版式的前提下执行）：改成深色背景')
      && !String(refinePromptRow?.prompt || '').includes('改图要求（保持整体风格与版式）：'),
    String(refinePromptRow?.prompt || '').slice(-120));

  const f1 = await singlePages.generateSinglePage(uid, { pageId: 'page-002', content: '会失败的内容' }, okDeps);
  check('单页失败自动退还（余额不变）', f1.status === 'failed' && credits.getBalance(uid) === g2.balance, `实际 ${credits.getBalance(uid)} vs ${g2.balance}`);

  const styleOnlyPack = STYLE_PACKS.find((pack) => pack.kind !== 'template');
  const evidencePage = await singlePages.generateSinglePage(uid, {
    pageId: 'page-evidence', title: '痛点分析', content: '传统种植依赖经验', stylePackId: styleOnlyPack.id,
  }, okDeps);
  const evidenceBody = JSON.parse(
    okFetcher.calls.filter((call) => call.url.includes('/images/generations')).at(-1).init.body,
  );
  check('单页页型证据由视觉计划解析（标题命中痛点分析，提示词读同一页型）',
    evidencePage.status === 'succeeded' && evidenceBody.prompt.includes('页型协议 · 痛点分析页'),
    evidenceBody.prompt.slice(0, 120));
  check('无模板风格包走风格参考路线（不出现模板路线话术）',
    evidenceBody.prompt.includes('同风格参考样张') && !evidenceBody.prompt.includes('真模板参考页'));

  const exp = await exportsLib.exportSinglePagesImagePptx(uid, { projectId: g1.page.projectId }, { config: baseConfig });
  check('单页项目导出图片版 pptx（仅成功页 1 页）', exp.pageCount === 1);

  // requestId 重放：命中幂等键必须 409 拒绝，不重复扣费、不再调上游、失败分支也不误退首笔
  const replayBefore = credits.getBalance(uid);
  const r1 = await singlePages.generateSinglePage(uid, { pageId: 'page-003', content: '重放测试页', requestId: 'replay-001' }, okDeps);
  check('带 requestId 首次生成成功', r1.status === 'succeeded' && r1.balance === replayBefore - 10);
  await expectThrows('同 requestId 重复生成被拒', () =>
    singlePages.generateSinglePage(uid, { pageId: 'page-003', content: '重放测试页', requestId: 'replay-001' }, okDeps), 'DUPLICATE_REQUEST');
  const replayGenCalls = okFetcher.calls.filter((c) => c.url.includes('/images/generations') && String(c.init?.body || '').includes('重放测试页')).length;
  check('重放未重复扣费且上游只调 1 次', credits.getBalance(uid) === replayBefore - 10 && replayGenCalls === 1,
    `balance=${credits.getBalance(uid)} genCalls=${replayGenCalls}`);

  const editsBeforeReplay = okFetcher.calls.filter((c) => c.url.includes('/images/edits')).length;
  const r2 = await singlePages.refineSinglePage(uid, { pageId: 'page-003', editInstruction: '改成浅色背景', requestId: 'replay-002' }, okDeps);
  check('带 requestId 首次改图成功', r2.status === 'succeeded');
  await expectThrows('同 requestId 重复改图被拒', () =>
    singlePages.refineSinglePage(uid, { pageId: 'page-003', editInstruction: '改成浅色背景', requestId: 'replay-002' }, okDeps), 'DUPLICATE_REQUEST');
  const replayEditCalls = okFetcher.calls.filter((c) => c.url.includes('/images/edits')).length - editsBeforeReplay;
  check('改图重放未重复扣费且上游只调 1 次', credits.getBalance(uid) === replayBefore - 20 && replayEditCalls === 1,
    `balance=${credits.getBalance(uid)} editCalls=${replayEditCalls}`);

  const rf1 = await singlePages.generateSinglePage(uid, { pageId: 'page-004', content: '会失败的内容', requestId: 'replay-003' }, okDeps);
  check('带 requestId 首次失败已退款', rf1.status === 'failed' && credits.getBalance(uid) === replayBefore - 20);
  await expectThrows('失败页同 requestId 重放也被拒（不再误退）', () =>
    singlePages.generateSinglePage(uid, { pageId: 'page-004', content: '会失败的内容', requestId: 'replay-003' }, okDeps), 'DUPLICATE_REQUEST');
  check('重放后余额不变（无误退）', credits.getBalance(uid) === replayBefore - 20, `实际 ${credits.getBalance(uid)}`);

  // 超长 requestId（chargeKey 被 cleanKey 截到 128）：退款键必须是定长派生值，
  // 否则 `${chargeKey}:refund` 再截回扣费键、退款被 duplicate 静默吞掉，失败不退星。
  const longRequestId = `long-${'x'.repeat(200)}`;
  const longBefore = credits.getBalance(uid);
  const rfLong = await singlePages.generateSinglePage(
    uid,
    { pageId: 'pg-long-replay', content: '会失败的内容', requestId: longRequestId },
    okDeps,
  );
  check('超长 requestId 失败仍出图失败状态', rfLong.status === 'failed');
  check('超长 requestId 失败路径成功退星（余额不变）',
    credits.getBalance(uid) === longBefore, `before=${longBefore} after=${credits.getBalance(uid)}`);
  const longChargeKey = `single-page:pg-long-replay:${longRequestId}`.trim().slice(0, 128);
  const { getDb: getLedgerDb } = await import('../src/lib/server/db.ts');
  const longRows = getLedgerDb()
    .prepare('SELECT idempotency_key, delta FROM credit_ledger WHERE user_id = ?')
    .all(uid)
    .filter((r) => String(r.idempotency_key) === credits.deriveRefundKey(longChargeKey));
  check('超长 requestId 退款键与扣费键不同且只退一次',
    credits.deriveRefundKey(longChargeKey) !== longChargeKey
      && longRows.length === 1 && Number(longRows[0].delta) === 10,
    `refundRows=${longRows.length}`);
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

await runPptReplicateTests({ check, expectThrows, auth, credits, uid, llmConfig, singlePages, projects, makeMockFetcher, editsOkHandler, imageOkHandler, PNG_1X1_B64 });
await runSinglePagePaidRunTests({ check, expectThrows, auth, credits, makeMockFetcher, editsOkHandler, imageConfig, PNG_1X1_B64 });
await runRecoveryRegistryTests({ check, auth, credits, imageConfig });

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

console.log('\n[9] 生成中断恢复（重启死锁收敛 + 孤儿扣费补退）');
{
  const recovery = await import('../src/lib/server/generation/recovery.ts');
  const reg2 = await auth.registerWithPassword(
    { account: 'recoveryuser', password: 'password123', confirmPassword: 'password123' },
    '127.0.0.1',
  );
  const uid2 = reg2.user.id;
  const okImageFetcher = makeMockFetcher([imageOkHandler, editsOkHandler]);
  const okDeps2 = { fetchImpl: okImageFetcher, config: imageConfig };

  // 读路径一律走真实路由：收敛由鉴权门统一触发，测试里不写任何恢复调用
  const deckRoute = await import('../src/app/api/deck/[id]/route.ts');
  const projectsRoute = await import('../src/app/api/projects/route.ts');
  const singlePageProjectRoute = await import('../src/app/api/single-page/project/route.ts');
  const sessionCookie = { cookie: `anppt_v2_session=${encodeURIComponent(auth.createSessionForUser(uid2))}` };
  const readJson = async (response) => (await response.json()).data;
  const readDeckViaRoute = async (deckId) => readJson(await deckRoute.GET(
    new Request(`http://localhost/api/deck/${deckId}`, { headers: sessionCookie }),
    { params: Promise.resolve({ id: deckId }) },
  ));
  const readSingleProjectViaRoute = async (projectId) => readJson(await singlePageProjectRoute.GET(
    new Request(`http://localhost/api/single-page/project?projectId=${encodeURIComponent(projectId)}`, { headers: sessionCookie }),
  ));

  // --- deck：手工铺「生成中途进程死亡」现场（deck generating + 页 queued + 已扣费无退款）---
  const d9 = decks.createDeck(uid2, {
    title: '中断恢复测试', sourceFileName: 'r.txt', sourceText: '2025 年销售额 1200 万元。',
    durationMinutes: 15, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
  });
  decks.replaceSlides(d9.id, OUTLINE_FIXTURE);
  for (const slide of decks.listSlides(d9.id)) {
    decks.updateSlideStructure(d9.id, slide.slideId, { ok: true, structuredContent: '【标题】t\n【正文】b', warnings: [], errors: [] });
  }
  decks.touchDeck(d9.id, { status: 'confirmed', confirmedAt: Date.now() });
  decks.touchDeck(d9.id, { stylePackId: STYLE_PACKS[0].id });

  const job9 = decks.createJob(uid2, d9.id, 'deck-generate', 2);
  decks.updateJob(job9.jobId, { status: 'running' });
  const slides9 = decks.listSlides(d9.id);
  for (const slide of slides9) {
    decks.createSlideVersion(slide, { kind: 'generate', prompt: 'p', jobId: job9.jobId });
    decks.updateSlideGen(d9.id, slide.slideId, { genStatus: 'queued' });
    credits.debitCredits(uid2, 10, {
      reason: '生成第 1 页', idempotencyKey: `deck-generate:${d9.id}:${job9.jobId}:${slide.slideId}`, refType: 'deck', refId: d9.id,
    });
  }
  decks.touchDeck(d9.id, { status: 'generating' });
  check('中断现场：扣费后余额 80', credits.getBalance(uid2) === 80, `实际 ${credits.getBalance(uid2)}`);
  await expectThrows('未恢复前 generate 永久 409（复现死锁）', () =>
    actions.dispatchDeckIntent(uid2, d9.id, { kind: 'generateSlides', params: {} }, okDeps2), 'GENERATION_RUNNING');

  // 活跃 job（心跳新鲜）不被误收敛
  const stateLive = decks.getDeckState(uid2, d9.id);
  check('活跃生成不被误收敛', stateLive.deck.status === 'generating' && stateLive.slides.every((s) => s.genStatus === 'queued'));

  // 心跳超时（回拨 2h）→ 工作台状态读接口自动收敛（无任何恢复调用）
  const dbMod = await import('../src/lib/server/db.ts');
  const genDbMod = await import('../src/lib/server/generation/db.ts');
  const staleTs = Date.now() - 2 * 60 * 60 * 1000;
  dbMod.getDb().prepare('UPDATE generation_jobs SET updated_at = ? WHERE id = ?').run(staleTs, job9.jobId);
  const healed = await readDeckViaRoute(d9.id);
  check('恢复：deck 死锁解除（confirmed，无成功页）', healed.deck.status === 'confirmed', `实际 ${healed.deck.status}`);
  check('恢复：中断页 → failed 可重试', healed.slides.every((s) => s.genStatus === 'failed' && s.genError.length > 0));
  check('恢复：job 置 failed', decks.latestJob(d9.id).status === 'failed');
  check('恢复：孤儿扣费按实扣金额补退（余额回 100）', credits.getBalance(uid2) === 100, `实际 ${credits.getBalance(uid2)}`);
  const refundKeys = dbMod.getDb()
    .prepare('SELECT idempotency_key FROM credit_ledger WHERE user_id = ? AND delta > 0').all(uid2)
    .map((r) => String(r.idempotency_key));
  check('恢复：refund 键与正常失败退款同格式',
    slides9.every((s) => refundKeys.includes(credits.deriveRefundKey(`deck-generate:${d9.id}:${job9.jobId}:${s.slideId}`))));
  const againHealed = await readDeckViaRoute(d9.id);
  check('恢复幂等：重复读不重复退款', credits.getBalance(uid2) === 100 && againHealed.deck.status === 'confirmed');

  const retry9 = await actions.dispatchDeckIntent(uid2, d9.id, { kind: 'retryFailedSlides', params: {} }, okDeps2);
  await retry9.job.done;
  const state9 = decks.getDeckState(uid2, d9.id);
  check('恢复后 retry-failed 全部成功 → generated', state9.deck.status === 'generated' && state9.slides.every((s) => s.genStatus === 'succeeded'));
  check('恢复后重生成净扣 2×10', credits.getBalance(uid2) === 80, `实际 ${credits.getBalance(uid2)}`);

  // --- 扣费键归属（T02）：恢复按存储键退款，不按 deck/job/slide 重拼 ---
  const buildCrashDeck = async (account, ip) => {
    const reg = await auth.registerWithPassword(
      { account, password: 'password123', confirmPassword: 'password123' },
      ip,
    );
    const crashUid = reg.user.id;
    const crashDeck = decks.createDeck(crashUid, {
      title: '存储键恢复', sourceFileName: 'k.txt', sourceText: '2025 年营收 900 万元。',
      durationMinutes: 15, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
    });
    decks.replaceSlides(crashDeck.id, OUTLINE_FIXTURE);
    for (const slide of decks.listSlides(crashDeck.id)) {
      decks.updateSlideStructure(crashDeck.id, slide.slideId, { ok: true, structuredContent: '【标题】t\n【正文】b', warnings: [], errors: [] });
    }
    decks.touchDeck(crashDeck.id, { status: 'confirmed', confirmedAt: Date.now() });
    decks.touchDeck(crashDeck.id, { stylePackId: STYLE_PACKS[0].id });
    const crashJob = decks.createJob(crashUid, crashDeck.id, 'deck-generate', 1);
    decks.updateJob(crashJob.jobId, { status: 'running' });
    const crashSlide = decks.listSlides(crashDeck.id)[0];
    decks.touchDeck(crashDeck.id, { status: 'generating' });
    dbMod.getDb().prepare('UPDATE generation_jobs SET updated_at = ? WHERE id = ?').run(staleTs, crashJob.jobId);
    const cookie = { cookie: `anppt_v2_session=${encodeURIComponent(auth.createSessionForUser(crashUid))}` };
    return {
      uid: crashUid,
      deckId: crashDeck.id,
      jobId: crashJob.jobId,
      slide: crashSlide,
      readDeck: async () => readJson(await deckRoute.GET(
        new Request(`http://localhost/api/deck/${crashDeck.id}`, { headers: cookie }),
        { params: Promise.resolve({ id: crashDeck.id }) },
      )),
    };
  };
  const refundLedgerKeys = (userId) => dbMod.getDb()
    .prepare('SELECT idempotency_key FROM credit_ledger WHERE user_id = ? AND delta > 0').all(userId)
    .map((row) => String(row.idempotency_key));

  {
    // 带存储键的崩溃现场：扣费后进程死亡。存储键是写入该行时键模块的产物，
    // 若恢复改成按 deck/job/slide 重拼，就会派生出另一个退款键 → 钱扣了不退。
    const crash = await buildCrashDeck('deckkeycrash', '127.0.0.11');
    const storedKey = `deck-generate:${crash.deckId}:${crash.jobId}:${crash.slide.slideId}:key-v2`;
    decks.createSlideVersion(crash.slide, { kind: 'generate', prompt: 'p', jobId: crash.jobId, chargeKey: storedKey });
    decks.updateSlideGen(crash.deckId, crash.slide.slideId, { genStatus: 'queued' });
    credits.debitCredits(crash.uid, 10, { reason: '生成第 1 页', idempotencyKey: storedKey, refType: 'deck', refId: crash.deckId });
    const healedCrash = await crash.readDeck();
    check('存储键崩溃窗口：恢复置 failed 并按存储键退款一次',
      healedCrash.slides[0].genStatus === 'failed' && credits.getBalance(crash.uid) === 100,
      `实际 ${healedCrash.slides[0].genStatus} / ${credits.getBalance(crash.uid)}`);
    check('存储键崩溃窗口：退款键由存储键派生（与正常失败退款同格式）',
      refundLedgerKeys(crash.uid).includes(credits.deriveRefundKey(storedKey)));
    await crash.readDeck();
    check('存储键崩溃窗口：重复恢复不双退', credits.getBalance(crash.uid) === 100, `实际 ${credits.getBalance(crash.uid)}`);
  }

  {
    // 存储键指向一笔不存在的扣费：存储键权威，不得回退重拼键去退另一笔钱
    const crash = await buildCrashDeck('deckkeynodbit', '127.0.0.12');
    const chargedKey = `deck-generate:${crash.deckId}:${crash.jobId}:${crash.slide.slideId}`;
    decks.createSlideVersion(crash.slide, { kind: 'generate', prompt: 'p', jobId: crash.jobId, chargeKey: `${chargedKey}:other-run` });
    decks.updateSlideGen(crash.deckId, crash.slide.slideId, { genStatus: 'queued' });
    credits.debitCredits(crash.uid, 10, { reason: '生成第 1 页', idempotencyKey: chargedKey, refType: 'deck', refId: crash.deckId });
    const healedNoDebit = await crash.readDeck();
    check('存储键无匹配扣费：恢复不按重拼键退款（不误退别人的钱）',
      healedNoDebit.slides[0].genStatus === 'failed' && credits.getBalance(crash.uid) === 90,
      `实际 ${healedNoDebit.slides[0].genStatus} / ${credits.getBalance(crash.uid)}`);
  }

  {
    // 迁移前的老行没有 charge_key：回退到键模块函数，退款键与正常失败退款一致
    const crash = await buildCrashDeck('deckkeyold', '127.0.0.13');
    const chargedKey = `deck-generate:${crash.deckId}:${crash.jobId}:${crash.slide.slideId}`;
    decks.createSlideVersion(crash.slide, { kind: 'generate', prompt: 'p', jobId: crash.jobId });
    decks.updateSlideGen(crash.deckId, crash.slide.slideId, { genStatus: 'queued' });
    credits.debitCredits(crash.uid, 10, { reason: '生成第 1 页', idempotencyKey: chargedKey, refType: 'deck', refId: crash.deckId });
    await crash.readDeck();
    check('老行空键：回退键模块函数，退款键与正常失败退款一致',
      credits.getBalance(crash.uid) === 100 && refundLedgerKeys(crash.uid).includes(credits.deriveRefundKey(chargedKey)),
      `实际 ${credits.getBalance(crash.uid)}`);
  }

  {
    // 退款后崩溃（失败收敛改为「先退款再置 failed」后的崩溃窗口）：钱已退、行仍是在途态。
    // 恢复必须置 failed 且不重复退款——重复退款会把「已退过」的行退第二遍。
    const crash = await buildCrashDeck('deckkeyrefund', '127.0.0.14');
    const chargedKey = `deck-generate:${crash.deckId}:${crash.jobId}:${crash.slide.slideId}`;
    decks.createSlideVersion(crash.slide, { kind: 'generate', prompt: 'p', jobId: crash.jobId, chargeKey: chargedKey });
    decks.updateSlideGen(crash.deckId, crash.slide.slideId, { genStatus: 'queued' });
    credits.debitCredits(crash.uid, 10, { reason: '生成第 1 页', idempotencyKey: chargedKey, refType: 'deck', refId: crash.deckId });
    credits.refundCredits(crash.uid, 10, {
      reason: '第 1 页生成失败退回', idempotencyKey: credits.deriveRefundKey(chargedKey), refType: 'deck', refId: crash.deckId,
    });
    const healedRefunded = await crash.readDeck();
    check('退款后崩溃：恢复置 failed 且不重复退款',
      healedRefunded.slides[0].genStatus === 'failed' && credits.getBalance(crash.uid) === 100
        && refundLedgerKeys(crash.uid).filter((key) => key === credits.deriveRefundKey(chargedKey)).length === 1,
      `实际 ${healedRefunded.slides[0].genStatus} / ${credits.getBalance(crash.uid)}`);
  }

  {
    // 置终态后崩溃：页已 failed 终态、退款已完成；恢复不再把终态行当在途，不双退。
    const crash = await buildCrashDeck('deckkeyterminal', '127.0.0.15');
    const chargedKey = `deck-generate:${crash.deckId}:${crash.jobId}:${crash.slide.slideId}`;
    const failedVersion = decks.createSlideVersion(crash.slide, { kind: 'generate', prompt: 'p', jobId: crash.jobId, chargeKey: chargedKey });
    decks.updateSlideVersion(failedVersion.versionId, { status: 'failed', error: 'IMAGE_FAILED: x' });
    decks.updateSlideGen(crash.deckId, crash.slide.slideId, { genStatus: 'failed', genError: 'IMAGE_FAILED: x' });
    credits.debitCredits(crash.uid, 10, { reason: '生成第 1 页', idempotencyKey: chargedKey, refType: 'deck', refId: crash.deckId });
    credits.refundCredits(crash.uid, 10, {
      reason: '第 1 页生成失败退回', idempotencyKey: credits.deriveRefundKey(chargedKey), refType: 'deck', refId: crash.deckId,
    });
    const healedTerminal = await crash.readDeck();
    check('置终态后崩溃：终态行不再被收敛、不重复退款',
      healedTerminal.slides[0].genStatus === 'failed' && credits.getBalance(crash.uid) === 100
        && refundLedgerKeys(crash.uid).filter((key) => key === credits.deriveRefundKey(chargedKey)).length === 1,
      `实际 ${healedTerminal.slides[0].genStatus} / ${credits.getBalance(crash.uid)}`);
  }

  // --- 单页：模拟中断（页 running + 在途 version + 已扣费）---
  const sp = await singlePages.generateSinglePage(uid2, { pageId: 'pg-r1', content: '恢复测试页' }, okDeps2);
  check('单页先成功一次（余额 70）', sp.status === 'succeeded' && credits.getBalance(uid2) === 70, `实际 ${credits.getBalance(uid2)}`);
  const manualKey = 'single-page:pg-r1:job_manualcrash';
  genDbMod.getGenDb().prepare(
    "INSERT INTO single_page_versions (id, page_id, kind, prompt, status, image_path, image_url, error, job_id, charge_key, created_at, updated_at) VALUES (?, 'pg-r1', 'generate', 'p', 'queued', '', '', '', 'job_manualcrash', ?, ?, ?)",
  ).run('ver_crash', manualKey, staleTs, staleTs);
  genDbMod.getGenDb().prepare("UPDATE single_pages SET status = 'running' WHERE id = 'pg-r1'").run();
  credits.debitCredits(uid2, 10, { reason: '单页生成', idempotencyKey: manualKey, refType: 'single-page', refId: 'pg-r1' });
  check('单页中断现场：余额 60', credits.getBalance(uid2) === 60, `实际 ${credits.getBalance(uid2)}`);
  // 单页工作台详情读一眼即收敛：读点没有恢复代码
  const spHealed = await readSingleProjectViaRoute(sp.page.projectId);
  const spHealedPage = spHealed.pages.find((row) => row.pageId === 'pg-r1');
  check('单页恢复：详情读点收敛中断页（无恢复调用）', spHealedPage?.status === 'failed', `实际 ${spHealedPage?.status}`);
  const pageAfter = singlePages.getOwnedPage(uid2, 'pg-r1');
  check('单页恢复：页 → failed', pageAfter.status === 'failed');
  check('单页恢复：孤儿扣费补退（余额回 70）', credits.getBalance(uid2) === 70, `实际 ${credits.getBalance(uid2)}`);
  const spAgain = await singlePages.generateSinglePage(uid2, { pageId: 'pg-r1', content: '恢复后重新生成' }, okDeps2);
  check('单页恢复：重新生成不再 409 且成功', spAgain.status === 'succeeded');

  // --- 单一收敛实现：判活 / 收敛 / 补退集中在一处（整套 / 单页 / 可编辑导出共用）---
  {
    const settled = [];
    const drillKey = 'single-page:pg-drill:job_drill';
    credits.debitCredits(uid2, 10, { reason: '收敛实现自检', idempotencyKey: drillKey, refType: 'single-page', refId: 'pg-drill' });
    const balanceDrill = credits.getBalance(uid2);
    const healedCount = recovery.reconcileInterrupted([
      { key: 'live', domain: 'deck', userId: uid2, interrupted: false, chargeKey: drillKey, refType: 'deck', refId: 'd-live', settle: () => settled.push('live') },
      { key: 'dead', domain: 'single-page', userId: uid2, interrupted: true, chargeKey: drillKey, refundReason: '自检退回', refType: 'single-page', refId: 'pg-drill', settle: () => settled.push('dead') },
    ]);
    check('单一收敛实现：只收敛判定为中断的任务', healedCount === 1 && settled.join(',') === 'dead', `实际 ${healedCount} ${settled.join(',')}`);
    check('单一收敛实现：按实扣金额补退', credits.getBalance(uid2) === balanceDrill + 10, `实际 ${credits.getBalance(uid2)}`);
    recovery.reconcileInterrupted([
      { key: 'dead', domain: 'single-page', userId: uid2, interrupted: true, chargeKey: drillKey, refType: 'single-page', refId: 'pg-drill', settle: () => {} },
    ]);
    check('单一收敛实现：重复收敛不双退', credits.getBalance(uid2) === balanceDrill + 10, `实际 ${credits.getBalance(uid2)}`);
  }

  // --- 读点即收敛（整套链）：项目列表读一眼就解除死锁，调用方不碰恢复代码 ---
  {
    const dList = decks.createDeck(uid2, {
      title: '列表读点', sourceFileName: 'l.txt', sourceText: '2025 年营收 300 万元。',
      durationMinutes: 15, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
    });
    decks.replaceSlides(dList.id, OUTLINE_FIXTURE);
    for (const slide of decks.listSlides(dList.id)) {
      decks.updateSlideStructure(dList.id, slide.slideId, { ok: true, structuredContent: '【标题】t\n【正文】b', warnings: [], errors: [] });
    }
    decks.touchDeck(dList.id, { status: 'confirmed', confirmedAt: Date.now() });
    decks.touchDeck(dList.id, { stylePackId: STYLE_PACKS[0].id });
    const jobList = decks.createJob(uid2, dList.id, 'deck-generate', 2);
    decks.updateJob(jobList.jobId, { status: 'running' });
    for (const slide of decks.listSlides(dList.id)) {
      decks.createSlideVersion(slide, { kind: 'generate', prompt: 'p', jobId: jobList.jobId });
      decks.updateSlideGen(dList.id, slide.slideId, { genStatus: 'queued' });
      credits.debitCredits(uid2, 10, {
        reason: '列表读点扣费', idempotencyKey: `deck-generate:${dList.id}:${jobList.jobId}:${slide.slideId}`, refType: 'deck', refId: dList.id,
      });
    }
    decks.touchDeck(dList.id, { status: 'generating' });
    dbMod.getDb().prepare('UPDATE generation_jobs SET updated_at = ? WHERE id = ?').run(staleTs, jobList.jobId);
    const balanceList = credits.getBalance(uid2);
    // 读函数本身不再顺手收敛：恢复只在鉴权门，读点不必写恢复代码
    check('读函数不再顺手恢复（收敛归鉴权门）', decks.getDeckState(uid2, dList.id).deck.status === 'generating');
    // 列表读接口（不是读函数）：新增读点只要走鉴权门就自动收敛
    const listed = await readJson(await projectsRoute.GET(
      new Request('http://localhost/api/projects?projectType=deck', { headers: sessionCookie }),
    ));
    const listedItem = listed.items.find((item) => item.id === dList.id);
    check('读点：项目列表读一眼即收敛中断的整套生成', listedItem?.status === 'confirmed', `实际 ${listedItem?.status}`);
    check('读点：列表读点按实扣金额补退（无显式恢复调用）', credits.getBalance(uid2) === balanceList + 20, `实际 ${credits.getBalance(uid2)}`);
  }

  // --- 读点即收敛（单页链）：批量状态轮询读一眼就恢复 ---
  {
    const spPoll = await singlePages.generateSinglePage(uid2, { pageId: 'pg-r2', content: '轮询读点恢复页' }, okDeps2);
    const pollKey = 'single-page:pg-r2:job_pollcrash';
    genDbMod.getGenDb().prepare(
      "INSERT INTO single_page_versions (id, page_id, kind, prompt, status, image_path, image_url, error, job_id, charge_key, created_at, updated_at) VALUES (?, 'pg-r2', 'generate', 'p', 'queued', '', '', '', 'job_pollcrash', ?, ?, ?)",
    ).run('ver_poll', pollKey, staleTs, staleTs);
    genDbMod.getGenDb().prepare("UPDATE single_pages SET status = 'running' WHERE id = 'pg-r2'").run();
    credits.debitCredits(uid2, 10, { reason: '单页生成', idempotencyKey: pollKey, refType: 'single-page', refId: 'pg-r2' });
    const balancePoll = credits.getBalance(uid2);
    const polled = await readSingleProjectViaRoute(spPoll.page.projectId);
    const pollRow = polled.pages.find((row) => row.pageId === 'pg-r2');
    check('读点：批量状态轮询收敛中断页', pollRow?.status === 'failed', `实际 ${pollRow?.status}`);
    check('读点：轮询读点按实扣金额补退（无显式恢复调用）', credits.getBalance(uid2) === balancePoll + 10, `实际 ${credits.getBalance(uid2)}`);
  }

  // --- 物理清理：软删超期 → 行 + 生成图删除；账本永久保留 ---
  const ledgerBeforePurge = dbMod.getDb()
    .prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = ?').all(uid2)[0].c;
  check('有账本记录（验证清理不删账的前置）', ledgerBeforePurge > 0);

  projects.deleteProject(uid2, d9.id);
  dbMod.getDb().prepare('UPDATE decks SET deleted_at = ? WHERE id = ?').run(Date.now() - 8 * 86400e3, d9.id);
  const spProjectId = spAgain.page.projectId;
  const spImagePath = genDbMod.getGenDb()
    .prepare('SELECT image_path FROM single_page_versions WHERE id = ?').all(spAgain.versionId)[0]?.image_path;
  projects.deleteProject(uid2, spProjectId);
  dbMod.getDb().prepare('UPDATE single_page_projects SET deleted_at = ? WHERE id = ?').run(Date.now() - 8 * 86400e3, spProjectId);
  projects.listProjects(uid2, {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  const deckGone = dbMod.getDb().prepare('SELECT COUNT(*) AS c FROM decks WHERE id = ?').all(d9.id)[0].c === 0;
  const slidesGone = dbMod.getDb().prepare('SELECT COUNT(*) AS c FROM deck_slides WHERE deck_id = ?').all(d9.id)[0].c === 0;
  check('清理：超期软删 deck 行 + slides 级联删除', deckGone && slidesGone);
  check('清理：deck 生成图目录删除', !existsSync(path.join(baseConfig.generatedDir, uid2, d9.id)));
  const singleGone = dbMod.getDb().prepare('SELECT COUNT(*) AS c FROM single_page_projects WHERE id = ?').all(spProjectId)[0].c === 0;
  check('清理：超期软删单页项目行删除', singleGone);
  const spImageAbs = spImagePath
    ? path.join(baseConfig.generatedDir, String(spImagePath).split('/').slice(1).join('/'))
    : null;
  check('清理：单页版本图文件删除', spImageAbs === null || !existsSync(spImageAbs));
  const ledgerAfterPurge = dbMod.getDb().prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = ?').all(uid2)[0].c;
  check('清理：账本永不删除', ledgerAfterPurge === ledgerBeforePurge);
  const recent = projects.listProjects(uid2, {});
  check('清理后列表正常返回', Array.isArray(recent.items));
}

console.log('\n[17] 金奖版式测试包（开关板门控真模板）');
{
  const templatesMod = await import('../src/lib/server/templates.ts');
  const mapping = await import('../src/lib/server/generation/mapping.ts');
  const dbModule = await import('../src/lib/server/db.ts');
  const GOLD_PACK_ID = 'anppt-gold-tianxun-test-20260824';

  const goldPack = templatesMod.getTemplate(GOLD_PACK_ID);
  check('金奖测试包可按 id 解析且 kind=template 挂开关',
    goldPack?.id === GOLD_PACK_ID && goldPack.kind === 'template' && goldPack.featureFlag === 'gold_layouts_beta');
  const goldPages = templatesMod.getTemplatePages(goldPack);
  check('金奖包 6 页模板载体逐页标注页型',
    goldPages.length === 6
      && goldPages.map((p) => p.pageType).join(',') === 'cover,pain-analysis,comparison,competitive-analysis,big-number,ending');
  check('金奖包 6 页载体图文件均存在',
    goldPages.every((p) => existsSync(path.join(process.cwd(), 'public', p.imageUrl.replace(/^\/+/, '')))));

  const mappingRows = mapping.buildOutlinePageMapping([
    { pageIndex: 0, pageType: '', role: 'cover', title: '封面' },
    { pageIndex: 1, pageType: '痛点分析', role: 'content', title: '痛点' },
    { pageIndex: 2, pageType: '竞品对比', role: 'content', title: '竞品' },
    { pageIndex: 3, pageType: '竞争分析', role: 'content', title: '竞争' },
    { pageIndex: 4, pageType: '大数字指标', role: 'content', title: '数据' },
    { pageIndex: 5, pageType: '', role: 'ending', title: '封底' },
    { pageIndex: 6, pageType: '工作流程', role: 'content', title: '流程' },
  ], goldPages);
  check('金奖映射：六页型精确命中各自载体页',
    mappingRows.slice(0, 6).map((r) => r.templatePageIndex).join(',') === '0,1,2,3,4,5',
    `实际 ${mappingRows.map((r) => r.templatePageIndex).join(',')}`);
  check('金奖映射：未覆盖页型兜底到内容桶载体页', mappingRows[6].templatePageIndex === 1);
  check('金奖映射参考图可取回',
    mapping.resolveTemplateReferenceImage(goldPages, mappingRows, 0) === goldPages[0].imageUrl);

  // 生成链路硬门：普通用户选包 404；测试用户可选
  const goldDeck = decks.createDeck(uid, {
    title: '门控测试', sourceFileName: '', sourceText: '测试门控', durationMinutes: 15,
    targetPageCount: 1, qualityTier: 'standard', stylePackId: '',
  });
  await expectThrows('普通用户选用金奖测试包按 404 拒绝', () =>
    actions.dispatchDeckIntent(uid, goldDeck.id, { kind: 'setStyle', params: { stylePackId: GOLD_PACK_ID } }, fullDeps), 'NOT_FOUND');

  const goldTester = await auth.registerWithPassword(
    { account: 'goldtester01', password: 'password123', confirmPassword: 'password123' }, '127.0.3.1');
  dbModule.getDb().prepare("UPDATE users SET role = 'tester' WHERE id = ?").run(goldTester.user.id);
  const goldTesterDeck = decks.createDeck(goldTester.user.id, {
    title: '金奖实测', sourceFileName: '', sourceText: '测试金奖包', durationMinutes: 15,
    targetPageCount: 1, qualityTier: 'standard', stylePackId: '',
  });
  const goldStyle = await actions.dispatchDeckIntent(goldTester.user.id, goldTesterDeck.id, { kind: 'setStyle', params: { stylePackId: GOLD_PACK_ID } }, fullDeps);
  check('测试用户选用金奖测试包成功', goldStyle.state.deck.stylePackId === GOLD_PACK_ID);
}

console.log('\n[18] 图片级编辑工具（高精清除/图上改字/模板融合/设为参考图）');
{
  const flagsMod = await import('../src/lib/server/feature-flags.ts');
  const imagesMod = await import('../src/lib/server/generation/images.ts');
  const GOLD_PACK_ID = 'anppt-gold-tianxun-test-20260824';
  const EDIT_FLAG_KEYS = ['magic_erase', 'image_text_edit', 'template_fusion', 'set_as_reference'];

  const reg18 = await auth.registerWithPassword(
    { account: 'edittools01', password: 'password123', confirmPassword: 'password123' }, '127.0.4.1');
  const uid18 = reg18.user.id;
  const editFetcher = makeMockFetcher([
    ...engineHandlers,
    { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    editsOkHandler,
  ]);
  const editDeps = { fetchImpl: editFetcher, config: engineConfig };

  const d18 = decks.createDeck(uid18, {
    title: '图片编辑工具', sourceFileName: '', sourceText: '测试图片级编辑', durationMinutes: 15,
    targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
  });
  await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'generateOutline', params: {} }, editDeps);
  await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'structureSlides', params: {} }, editDeps);
  await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'confirmStructure', params: {} }, editDeps);
  await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'setStyle', params: { stylePackId: STYLE_PACKS[0].id } }, editDeps);
  const gen18 = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'generateSlides', params: {} }, editDeps);
  await gen18.job.done;
  const s18 = decks.getDeckState(uid18, d18.id);
  check('图片工具前置：两页生成成功', s18.slides.every((s) => s.genStatus === 'succeeded'));

  // 开关 off：四个 action 一律 404（不暴露功能存在性），不产生扣费
  const markDataUrl = `data:image/png;base64,${PNG_1X1_B64}`;
  const balBeforeGated = credits.getBalance(uid18);
  await expectThrows('开关 off：erase-slide 404', () =>
    actions.dispatchDeckIntent(uid18, d18.id, { kind: 'eraseSlide', params: { slideId: s18.slides[0].slideId, markImageDataUrl: markDataUrl } }, editDeps), 'NOT_FOUND');
  await expectThrows('开关 off：text-edit-slide 404', () =>
    actions.dispatchDeckIntent(uid18, d18.id, { kind: 'editSlideText', params: { slideId: s18.slides[0].slideId, editInstruction: '改字' } }, editDeps), 'NOT_FOUND');
  await expectThrows('开关 off：fuse-slide 404', () =>
    actions.dispatchDeckIntent(uid18, d18.id, { kind: 'fuseSlide', params: { slideId: s18.slides[0].slideId, fusionPackId: STYLE_PACKS[0].id } }, editDeps), 'NOT_FOUND');
  await expectThrows('开关 off：set-reference 404', () =>
    actions.dispatchDeckIntent(uid18, d18.id, { kind: 'setReferenceImage', params: { slideId: s18.slides[0].slideId } }, editDeps), 'NOT_FOUND');
  check('开关 off 时无任何扣费', credits.getBalance(uid18) === balBeforeGated);

  for (const key of EDIT_FLAG_KEYS) flagsMod.setFeatureFlag(key, 'public', uid18);
  const refineUnit = credits.estimateCredits({ action: 'deck_page_refine', pages: 1 }).unitPrice;
  const lastEditsForm = () => {
    const calls = editFetcher.calls.filter((c) => c.url.includes('/images/edits'));
    return calls[calls.length - 1]?.init?.body;
  };

  // 高精清除：双图 edits（原图+标记图），固定提示词
  const eraseBefore = credits.getBalance(uid18);
  const eraseResult = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'eraseSlide', params: { slideId: s18.slides[0].slideId, markImageDataUrl: markDataUrl } }, editDeps);
  await eraseResult.job.done;
  const eraseForm = lastEditsForm();
  const erasePrompt = eraseForm instanceof FormData ? String(eraseForm.get('prompt') || '') : '';
  check('高精清除走 /images/edits 双图（原图+标记图）',
    eraseForm instanceof FormData && eraseForm.getAll('image').length === 2);
  check('高精清除提示词含涂抹区擦除与去红约束',
    erasePrompt.includes('红色涂抹区') && erasePrompt.includes('不得出现红色标记'));
  check(`高精清除按 deck_page_refine 扣 ${refineUnit}🌟`,
    eraseBefore - credits.getBalance(uid18) === refineUnit, `实际余额 ${credits.getBalance(uid18)}`);

  // 图上改字：单图 edits，提示词 = 用户指令 + 硬约束
  const textResult = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'editSlideText', params: { slideId: s18.slides[0].slideId, editInstruction: '把标题改成「年度报告」' } }, editDeps);
  await textResult.job.done;
  const textForm = lastEditsForm();
  const textPrompt = textForm instanceof FormData ? String(textForm.get('prompt') || '') : '';
  check('图上改字提示词含用户指令与「只改指定文字…保持不变」硬约束',
    textPrompt.includes('把标题改成「年度报告」') && textPrompt.includes('只改指定文字') && textPrompt.includes('保持不变'));
  check('图上改字为单图 edits（无锚点时不附第二图）',
    textForm instanceof FormData && textForm.getAll('image').length === 1);

  // 模板融合：同页型样张作第二图；非法包 400；门控包对普通用户 404
  await expectThrows('融合包不存在按 400 拒绝', () =>
    actions.dispatchDeckIntent(uid18, d18.id, { kind: 'fuseSlide', params: { slideId: s18.slides[0].slideId, fusionPackId: 'nope-pack' } }, editDeps), 'VALIDATION_ERROR');
  await expectThrows('普通用户融合门控金奖包按 404 拒绝', () =>
    actions.dispatchDeckIntent(uid18, d18.id, { kind: 'fuseSlide', params: { slideId: s18.slides[0].slideId, fusionPackId: GOLD_PACK_ID } }, editDeps), 'NOT_FOUND');
  const fuseResult = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'fuseSlide', params: { slideId: s18.slides[1].slideId, fusionPackId: STYLE_PACKS[0].id } }, editDeps);
  await fuseResult.job.done;
  const fuseForm = lastEditsForm();
  const fusePrompt = fuseForm instanceof FormData ? String(fuseForm.get('prompt') || '') : '';
  check('模板融合走双图 edits（原图+同页型样张）',
    fuseForm instanceof FormData && fuseForm.getAll('image').length === 2);
  check('融合提示词含版式骨架保留/风格融合/文字不变约束',
    fusePrompt.includes('版式骨架保留') && fusePrompt.includes('靠拢融合') && fusePrompt.includes('文字内容保持不变'));

  // 设为参考图：0 扣费写库；锚点优先作为生成参考图；微调附带锚点第二图
  const refBefore = credits.getBalance(uid18);
  const refResult = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'setReferenceImage', params: { slideId: s18.slides[0].slideId } }, editDeps);
  check('设为参考图写库（state 透出锚点页）', refResult.state.deck.anchorSlideId === s18.slides[0].slideId);
  check('设为参考图 0 扣费', credits.getBalance(uid18) === refBefore);

  const regen18 = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'generateSlide', params: { slideId: s18.slides[1].slideId } }, editDeps);
  await regen18.job.done;
  const regenCalls = editFetcher.calls.filter((c) => c.url.includes('/images/generations'));
  const regenBody = JSON.parse(regenCalls[regenCalls.length - 1].init.body);
  check('锚点优先作为生成参考图（PNG 锚点图而非 webp 风格样张）',
    String(regenBody.reference_images?.[0]?.url || '').startsWith('data:image/png;base64,'),
    `实际 ${String(regenBody.reference_images?.[0]?.url || '').slice(0, 30)}`);

  const refine18 = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'refineSlide', params: { slideId: s18.slides[1].slideId, editInstruction: '标题放大一点' } }, editDeps);
  await refine18.job.done;
  const refineForm = lastEditsForm();
  check('指令微调附带锚点作第二参考图并带锚点提示',
    refineForm instanceof FormData && refineForm.getAll('image').length === 2
      && String(refineForm.get('prompt') || '').includes('风格锚点'));

  const clearResult = await actions.dispatchDeckIntent(uid18, d18.id, { kind: 'setReferenceImage', params: { slideId: null } }, editDeps);
  check('取消参考图后锚点清空', clearResult.state.deck.anchorSlideId === '');

  // atlascloud 灾备：多图编辑降级为单图 + 意图文字描述
  const atlasFetcher = makeMockFetcher([
    { match: '/images/edits', payload: jsonResponse({ error: { message: 'mock primary 500' } }, 500) },
    { match: '/model/generateImage', payload: { code: 200, data: { id: 'pred-18' } } },
    { match: '/model/prediction/', payload: { code: 200, data: { status: 'completed', outputs: ['http://mock-image/atlas-result-18.png'] } } },
    { match: 'atlas-result-18.png', payload: { ok: true } },
  ]);
  const atlasConfig = {
    ...imageConfig,
    imageBackupBaseUrl: 'http://mock-atlascloud',
    imageBackupApiKey: 'sk-backup',
    imageBackupModel: 'openai/gpt-image-2/edit',
  };
  const degraded = await imagesMod.editImage({
    image: Buffer.from(PNG_1X1_B64, 'base64'),
    instruction: '原改图指令',
    extraImages: [Buffer.from(PNG_1X1_B64, 'base64')],
    extraImageNote: '第二图意图文字说明',
  }, { fetchImpl: atlasFetcher, config: atlasConfig });
  const atlasBody = JSON.parse(atlasFetcher.calls.find((c) => c.url.includes('/model/generateImage')).init.body);
  check('灾备降级：丢弃第二图，意图以文字拼进 prompt',
    degraded.length > 0
      && typeof atlasBody.image === 'string'
      && atlasBody.prompt.includes('原改图指令')
      && atlasBody.prompt.includes('第二图意图文字说明'));

  for (const key of EDIT_FLAG_KEYS) flagsMod.setFeatureFlag(key, 'off', uid18);
}

// 生图回退（2026-10-04 真实故障：主站 402 余额不足拖垮整站生成）——
// 可切站的错误必须真的切到灾备站出图；400/413 是请求本身的问题，切站也必败，不浪费灾备费用。
{
  const imagesMod = await import('../src/lib/server/generation/images.ts');
  const failoverFetcher = makeMockFetcher([
    { match: 'mock-image-primary', payload: jsonResponse({ error: { message: 'insufficient balance; add credit to continue', code: 'upstream_error' } }, 402) },
    { match: 'mock-image-backup', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  const failoverConfig = {
    ...imageConfig,
    imageBaseUrl: 'http://mock-image-primary',
    imageBackupBaseUrl: 'http://mock-image-backup',
    imageBackupApiKey: 'sk-backup',
    imageBackupModel: 'gpt-image-2',
  };
  const failedOver = await imagesMod.generateImage(
    { prompt: '主站 402 时应切灾备' }, { fetchImpl: failoverFetcher, config: failoverConfig });
  check('生图回退：主站 402 → 切灾备站出图', failedOver.length > 0);
  check('生图回退：灾备站确实被调用', failoverFetcher.calls.some((c) => c.url.includes('mock-image-backup')));

  // 刚才的 402 已把主站 key 打进冷却；本条要验的是「干净池」上 400 不切站
  imagesMod.resetImagePoolForTests();
  const noFailoverFetcher = makeMockFetcher([
    { match: 'mock-image-primary', payload: jsonResponse({ error: { message: 'bad request' } }, 400) },
    { match: 'mock-image-backup', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  let noFailoverThrew = false;
  try {
    await imagesMod.generateImage(
      { prompt: '主站 400 不应切站' }, { fetchImpl: noFailoverFetcher, config: failoverConfig });
  } catch {
    noFailoverThrew = true;
  }
  check('生图回退：主站 400 不切灾备（省灾备费用）',
    noFailoverThrew && !noFailoverFetcher.calls.some((c) => c.url.includes('mock-image-backup')));

  const singleSiteFetcher = makeMockFetcher([
    { match: 'mock-image-primary', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-image-backup', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  let singleSiteThrew = false;
  try {
    await imagesMod.generateImage({ prompt: '未配灾备' }, {
      fetchImpl: singleSiteFetcher,
      config: { ...failoverConfig, imageBackupBaseUrl: '', imageBackupApiKey: '', imageBackupModel: '' },
    });
  } catch {
    singleSiteThrew = true;
  }
  check('生图回退：灾备三项不全按单站处理（不静默成功）',
    singleSiteThrew && !singleSiteFetcher.calls.some((c) => c.url.includes('mock-image-backup')));
}

// 生图池（#44）：最多三站（主站 / 灾备 / 第二灾备），按单价升序尝试；单价未配置（0）
// 视为未知，保持配置顺序排在已知单价之后。未配任何单价时与今天的「主站 → 灾备」一致。
{
  const imagesMod = await import('../src/lib/server/generation/images.ts');
  imagesMod.resetImagePoolForTests();
  const poolConfig = (prices) => ({
    ...imageConfig,
    imageBaseUrl: 'http://mock-pool-primary',
    imageApiKey: 'sk-pool-primary',
    imageModel: 'model-primary',
    imageBackupBaseUrl: 'http://mock-pool-backup',
    imageBackupApiKey: 'sk-pool-backup',
    imageBackupModel: 'model-backup',
    imageBackup2BaseUrl: 'http://mock-pool-b2',
    imageBackup2ApiKey: 'sk-pool-b2',
    imageBackup2Model: 'model-b2',
    costImageFenPerCall: prices[0],
    costImageBackupFenPerCall: prices[1],
    costImageBackup2FenPerCall: prices[2],
  });
  const poolOrder = (fetcher) => fetcher.calls
    .map((call) => call.url.match(/^http:\/\/mock-pool-([^/]+)/)?.[1] ?? call.url)
    .join(' → ');

  const unpaidFetcher = makeMockFetcher([
    { match: 'mock-pool-primary', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-pool-backup', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  const unpaidImage = await imagesMod.generateImage({ prompt: '未配单价保持配置顺序' }, {
    fetchImpl: unpaidFetcher, config: poolConfig([0, 0, 0]),
  });
  check('生图池：未配单价时保持配置顺序（主站 → 灾备 → 第二灾备）且第二灾备可兜底出图',
    unpaidImage.length > 0 && poolOrder(unpaidFetcher) === 'primary → backup → b2',
    `实际调用 ${poolOrder(unpaidFetcher) || '(无)'}`);

  // 上一条场景已把主站/灾备 key 打进冷却，排序断言需要干净的池
  imagesMod.resetImagePoolForTests();
  const pricedFetcher = makeMockFetcher([
    { match: 'mock-pool-primary', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-pool-backup', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  await imagesMod.generateImage({ prompt: '最便宜站优先' }, {
    fetchImpl: pricedFetcher, config: poolConfig([7, 3, 5]),
  });
  check('生图池：按单价升序先打到最便宜站（灾备 3 分），更贵的主站/第二灾备不被调用',
    poolOrder(pricedFetcher) === 'backup',
    `实际调用 ${poolOrder(pricedFetcher) || '(无)'}`);
  check('生图池：请求体带命中站点的模型名',
    JSON.parse(pricedFetcher.calls[0].init.body).model === 'model-backup');

  const carryFetcher = makeMockFetcher([
    { match: 'mock-pool-primary', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-pool-backup', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  const switchWarns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { switchWarns.push(args.map((arg) => String(arg)).join(' ')); };
  let carriedImage;
  try {
    carriedImage = await imagesMod.generateImage({ prompt: '最便宜站 402 顺延' }, {
      fetchImpl: carryFetcher, config: poolConfig([7, 3, 5]),
    });
  } finally {
    console.warn = originalWarn;
  }
  check('生图池：最便宜站 402 自动切到下一站出图，更贵的主站不被调用',
    carriedImage.length > 0 && poolOrder(carryFetcher) === 'backup → b2',
    `实际调用 ${poolOrder(carryFetcher) || '(无)'}`);
  // 同前缀现在还有死 key 冷却行，按切站文案定位，别被前一行抢走
  const switchWarn = switchWarns.find((line) => line.includes('失败，切换'));
  check('生图池：切站日志保留既有前缀并带出站点+模型+单价',
    Boolean(switchWarn)
      && switchWarn.includes('失败，切换')
      && switchWarn.includes('backup（model-backup，单价 3 分/张）')
      && switchWarn.includes('backup2（model-b2，单价 5 分/张）'),
    `实际日志 ${switchWarn || '(无)'}`);

  // 上一条场景把最便宜站 key 打进了冷却；400/413 不换站的断言要求先能打到它
  imagesMod.resetImagePoolForTests();
  for (const status of [400, 413]) {
    const rejectFetcher = makeMockFetcher([
      { match: 'mock-pool-primary', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
      { match: 'mock-pool-backup', payload: jsonResponse({ error: { message: 'bad request' } }, status) },
      { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    ]);
    let rejectThrew = false;
    try {
      await imagesMod.generateImage({ prompt: '最便宜站请求本身非法' }, {
        fetchImpl: rejectFetcher, config: poolConfig([7, 3, 5]),
      });
    } catch {
      rejectThrew = true;
    }
    check(`生图池：最便宜站 ${status} 不触发换站（请求本身的问题）`,
      rejectThrew && poolOrder(rejectFetcher) === 'backup',
      `实际调用 ${poolOrder(rejectFetcher) || '(无)'}`);
  }

  // 已知单价与未知单价混配：已知在前按价升序，未知按配置顺序排其后
  const mixedFetcher = makeMockFetcher([
    { match: 'mock-pool-primary', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-pool-backup', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  await imagesMod.generateImage({ prompt: '已知单价在前' }, {
    fetchImpl: mixedFetcher, config: poolConfig([0, 3, 0]),
  });
  check('生图池：已知单价先试，未知单价的站按配置顺序排其后',
    poolOrder(mixedFetcher) === 'backup → primary → b2',
    `实际调用 ${poolOrder(mixedFetcher) || '(无)'}`);

  // 已知单价场景把主站/灾备 key 打进冷却；两款不全的断言要求两站都还活着
  imagesMod.resetImagePoolForTests();
  const partialFetcher = makeMockFetcher([
    { match: 'mock-pool-primary', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-pool-backup', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
    { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  let partialThrew = false;
  try {
    await imagesMod.generateImage({ prompt: '第二灾备三项不全' }, {
      fetchImpl: partialFetcher,
      config: { ...poolConfig([0, 0, 0]), imageBackup2Model: '' },
    });
  } catch {
    partialThrew = true;
  }
  check('生图池：第二灾备三项不齐不入池（按两站处理）',
    partialThrew && poolOrder(partialFetcher) === 'primary → backup',
    `实际调用 ${poolOrder(partialFetcher) || '(无)'}`);

  // 记账：provider 按站点文案（image / image-backup / image-backup-2），cost_fen 用该站单价。
  // 前面几条兜底场景把各站 key 打进了冷却，记账断言要按「逐站失败再换站」的真实顺序跑
  imagesMod.resetImagePoolForTests();
  const savedCostEnv = {
    ANPPT_V2_COST_IMAGE_FEN_PER_CALL: process.env.ANPPT_V2_COST_IMAGE_FEN_PER_CALL,
    ANPPT_V2_COST_IMAGE_BACKUP_FEN_PER_CALL: process.env.ANPPT_V2_COST_IMAGE_BACKUP_FEN_PER_CALL,
    ANPPT_V2_COST_IMAGE_BACKUP2_FEN_PER_CALL: process.env.ANPPT_V2_COST_IMAGE_BACKUP2_FEN_PER_CALL,
  };
  process.env.ANPPT_V2_COST_IMAGE_FEN_PER_CALL = '7';
  process.env.ANPPT_V2_COST_IMAGE_BACKUP_FEN_PER_CALL = '3';
  process.env.ANPPT_V2_COST_IMAGE_BACKUP2_FEN_PER_CALL = '5';
  let costGroups = [];
  try {
    const costScenario = async (tag, handlers) => {
      const fetcher = makeMockFetcher(handlers);
      await imagesMod.generateImage({ prompt: `记账场景 ${tag}` }, {
        fetchImpl: fetcher,
        config: {
          ...poolConfig([7, 3, 5]),
          imageModel: `cost-${tag}-primary`,
          imageBackupModel: `cost-${tag}-backup`,
          imageBackup2Model: `cost-${tag}-b2`,
        },
      });
    };
    await costScenario('backup', [
      { match: 'mock-pool-backup', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    ]);
    await costScenario('b2', [
      { match: 'mock-pool-backup', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
      { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    ]);
    await costScenario('primary', [
      { match: 'mock-pool-backup', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
      { match: 'mock-pool-b2', payload: jsonResponse({ error: { message: 'insufficient balance' } }, 402) },
      { match: 'mock-pool-primary', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    ]);
    const financeMod = await import('../src/lib/server/finance-stats.ts');
    costGroups = (await financeMod.getFinanceStats()).upstreamUsage.byProvider;
  } finally {
    for (const [key, value] of Object.entries(savedCostEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const costGroupOf = (model) => costGroups.find((group) => group.model === model);
  const backupCostGroup = costGroupOf('cost-backup-backup');
  check('生图池记账：灾备站记 provider=image-backup、cost_fen 用该站单价 3 分',
    backupCostGroup?.provider === 'image-backup' && backupCostGroup?.costFen === 3,
    `实际 ${JSON.stringify(backupCostGroup)}`);
  const b2CostGroup = costGroupOf('cost-b2-b2');
  check('生图池记账：第二灾备站记 provider=image-backup-2、cost_fen 用该站单价 5 分',
    b2CostGroup?.provider === 'image-backup-2' && b2CostGroup?.costFen === 5,
    `实际 ${JSON.stringify(b2CostGroup)}`);
  const primaryCostGroup = costGroupOf('cost-primary-primary');
  check('生图池记账：主站记 provider=image、cost_fen 用该站单价 7 分',
    primaryCostGroup?.provider === 'image' && primaryCostGroup?.costFen === 7,
    `实际 ${JSON.stringify(primaryCostGroup)}`);

  const costDbMod = await import('../src/lib/server/db.ts');
  const costRows = costDbMod.getDb().prepare(
    "SELECT model, status, cost_fen FROM upstream_usage_records WHERE model LIKE 'cost-%'",
  ).all();
  const failedCostRows = costRows.filter((row) => row.status === 'error');
  check('生图池记账：失败尝试的 cost_fen 记 NULL（不按站点单价虚高）',
    failedCostRows.length === 3 && failedCostRows.every((row) => row.cost_fen === null),
    `失败 ${failedCostRows.length} 条、cost_fen ${failedCostRows.map((row) => row.cost_fen).join(',') || '(无)'}`);
  const okCostTotal = costRows
    .filter((row) => row.status === 'ok')
    .reduce((sum, row) => sum + (row.cost_fen ?? 0), 0);
  check('生图池记账：成功调用合计 15 分（3 + 5 + 7），与失败条数无关',
    okCostTotal === 15,
    `实际 ${okCostTotal}`);

  // 改图与生图共用同一站点池（imageEndpoints 单点），排序与回退口径不单独分叉
  imagesMod.resetImagePoolForTests();
  const editPoolFetcher = makeMockFetcher([
    { match: 'mock-pool-primary', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-pool-backup', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-pool-b2', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  await imagesMod.editImage({ image: Buffer.from(PNG_1X1_B64, 'base64'), instruction: '改图同池排序' }, {
    fetchImpl: editPoolFetcher, config: poolConfig([7, 3, 5]),
  });
  check('生图池：改图与生图共用同一排序（最便宜站先）',
    poolOrder(editPoolFetcher) === 'backup',
    `实际调用 ${poolOrder(editPoolFetcher) || '(无)'}`);

  // 站内多把 key：逗号分隔解析成数组，首请求从第一把开始（逐请求轮转见 #45 块）
  const multiKeyFetcher = makeMockFetcher([
    { match: 'mock-key-site', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  await imagesMod.generateImage({ prompt: '站内多 key 首请求第一把' }, {
    fetchImpl: multiKeyFetcher,
    config: { ...poolConfig([0, 0, 0]), imageBaseUrl: 'http://mock-key-site', imageApiKey: ' sk-first , sk-second ' },
  });
  check('生图池：站内逗号分隔解析为多把 key，首请求用第一把',
    multiKeyFetcher.calls[0]?.init.headers?.Authorization === 'Bearer sk-first',
    `实际 ${multiKeyFetcher.calls[0]?.init.headers?.Authorization || '(无)'}`);
}

// 轮换与冷却（#45）：同价同模型的站之间按请求轮转起点；同站多把 key 逐请求轮转；
// 401/402/403 的死 key 冷却后被跳过，到期自动恢复。轮换只在同价且同模型（文生图 + 改图）的站之间发生。
console.log('\n[2c2] 生图池：同价轮换与死键冷却');
{
  const imagesMod = await import('../src/lib/server/generation/images.ts');
  const rotationConfig = (overrides = {}) => ({
    ...imageConfig,
    imageBaseUrl: 'http://mock-rot-a',
    imageApiKey: 'sk-rot-key-aaaa',
    imageModel: 'model-shared',
    imageEditModel: 'model-shared',
    imageBackupBaseUrl: 'http://mock-rot-b',
    imageBackupApiKey: 'sk-rot-key-bbbb',
    imageBackupModel: 'model-shared',
    imageBackupEditModel: 'model-shared',
    imageBackup2BaseUrl: '',
    imageBackup2ApiKey: '',
    imageBackup2Model: '',
    costImageFenPerCall: 3,
    costImageBackupFenPerCall: 3,
    costImageBackup2FenPerCall: 0,
    ...overrides,
  });
  const stationOrder = (fetcher) => fetcher.calls
    .map((call) => call.url.match(/^http:\/\/mock-rot-([^/]+)/)?.[1] ?? call.url)
    .join(' → ');

  const rotateFetcher = makeMockFetcher([
    { match: 'mock-rot-a', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-rot-b', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  const rotateModels = [];
  for (let index = 0; index < 3; index += 1) {
    await imagesMod.generateImage({ prompt: `同价同模型轮转 ${index}` }, {
      fetchImpl: rotateFetcher, config: rotationConfig(),
    });
    rotateModels.push(JSON.parse(rotateFetcher.calls.at(-1).init.body).model);
  }
  check('轮换：同价同模型的两站按请求轮转起点（A → B → A）',
    stationOrder(rotateFetcher) === 'a → b → a',
    `实际调用 ${stationOrder(rotateFetcher) || '(无)'}`);
  check('轮换：同价同模型两站始终用同一个模型（不混模型）',
    rotateModels.length === 3 && rotateModels.every((model) => model === 'model-shared'),
    `实际 ${rotateModels.join(',')}`);

  const mixedModelFetcher = makeMockFetcher([
    { match: 'mock-rot-a', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-rot-b', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  for (let index = 0; index < 3; index += 1) {
    await imagesMod.generateImage({ prompt: `不同模型不轮转 ${index}` }, {
      fetchImpl: mixedModelFetcher,
      config: rotationConfig({ imageBackupModel: 'model-other', imageBackupEditModel: 'model-other' }),
    });
  }
  check('轮换：同价但文生图模型不同 → 不轮转（三请求都打同一站）',
    stationOrder(mixedModelFetcher) === 'a → a → a',
    `实际调用 ${stationOrder(mixedModelFetcher) || '(无)'}`);

  const mixedEditFetcher = makeMockFetcher([
    { match: 'mock-rot-a', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-rot-b', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  for (let index = 0; index < 3; index += 1) {
    await imagesMod.generateImage({ prompt: `改图模型不同仍轮转 ${index}` }, {
      fetchImpl: mixedEditFetcher,
      config: rotationConfig({ imageBackupEditModel: 'model-edit-other' }),
    });
  }
  check('轮换：生图不看改图模型，同价同文生图模型仍轮转（A → B → A）',
    stationOrder(mixedEditFetcher) === 'a → b → a',
    `实际调用 ${stationOrder(mixedEditFetcher) || '(无)'}`);

  const editModelFetcher = makeMockFetcher([
    { match: 'mock-rot-a', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-rot-b', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  for (let index = 0; index < 3; index += 1) {
    await imagesMod.editImage({ image: Buffer.from(PNG_1X1_B64, 'base64'), instruction: `改图模型不同不轮转 ${index}` }, {
      fetchImpl: editModelFetcher,
      config: rotationConfig({ imageBackupEditModel: 'model-edit-other' }),
    });
  }
  check('轮换：改图要求文生图与改图模型都相同才轮转（模型不同 → 不轮转）',
    stationOrder(editModelFetcher) === 'a → a → a',
    `实际调用 ${stationOrder(editModelFetcher) || '(无)'}`);

  const unpaidRotationFetcher = makeMockFetcher([
    { match: 'mock-rot-a', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    { match: 'mock-rot-b', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  for (let index = 0; index < 3; index += 1) {
    await imagesMod.generateImage({ prompt: `未知单价不轮转 ${index}` }, {
      fetchImpl: unpaidRotationFetcher,
      config: rotationConfig({ costImageFenPerCall: 0, costImageBackupFenPerCall: 0 }),
    });
  }
  check('轮换：单价未配置（未知）时保持配置顺序、不轮转',
    stationOrder(unpaidRotationFetcher) === 'a → a → a',
    `实际调用 ${stationOrder(unpaidRotationFetcher) || '(无)'}`);

  const keyRotationFetcher = makeMockFetcher([
    { match: 'mock-rot-keys', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
  ]);
  const keyAuths = [];
  for (let index = 0; index < 4; index += 1) {
    await imagesMod.generateImage({ prompt: `站内多 key 轮转 ${index}` }, {
      fetchImpl: keyRotationFetcher,
      config: rotationConfig({
        imageBaseUrl: 'http://mock-rot-keys',
        imageApiKey: 'sk-rot-key-aaaa, sk-rot-key-bbbb',
        imageBackupBaseUrl: '',
        imageBackupApiKey: '',
        imageBackupModel: '',
      }),
    });
    keyAuths.push(keyRotationFetcher.calls.at(-1).init.headers.Authorization);
  }
  check('轮换：同站两把 key 逐请求轮转（aaaa → bbbb → aaaa → bbbb）',
    keyAuths.join(',') === 'Bearer sk-rot-key-aaaa,Bearer sk-rot-key-bbbb,Bearer sk-rot-key-aaaa,Bearer sk-rot-key-bbbb',
    `实际 ${keyAuths.join(',')}`);

  // 按 Authorization 分流：makeMockFetcher 只按 URL 匹配，按 key 返回不同响应要自己写 fetcher
  const keyedFetcher = (respond) => {
    const calls = [];
    const fetcher = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const apiKey = String(init.headers?.Authorization || '').replace(/^Bearer /, '');
      return respond(apiKey);
    };
    fetcher.calls = calls;
    return fetcher;
  };
  const keyTailOf = (call) => String(call.init?.headers?.Authorization || '')
    .replace(/^Bearer /, '')
    .replace('sk-rot-key-', '');

  const cooldownFetcher = keyedFetcher((apiKey) => (apiKey.endsWith('dead')
    ? jsonResponse({ error: { message: 'invalid token' } }, 403)
    : jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] })));
  const cooldownConfig = rotationConfig({
    imageBaseUrl: 'http://mock-rot-cd-a',
    imageApiKey: 'sk-rot-key-dead, sk-rot-key-live',
    imageBackupBaseUrl: 'http://mock-rot-cd-b',
    imageBackupApiKey: 'sk-rot-key-backup',
    costImageFenPerCall: 3,
    costImageBackupFenPerCall: 5,
  });
  const cooldownWarns = [];
  const originalImageWarn = console.warn;
  console.warn = (...args) => { cooldownWarns.push(args.map((arg) => String(arg)).join(' ')); };
  try {
    await imagesMod.generateImage({ prompt: '死 key 冷却 1' }, { fetchImpl: cooldownFetcher, config: cooldownConfig });
    check('冷却：403 的死 key 在同一请求内让位给下一把 key（dead → live）',
      cooldownFetcher.calls.map(keyTailOf).join(',') === 'dead,live',
      `实际 ${cooldownFetcher.calls.map(keyTailOf).join(',') || '(无)'}`);

    const beforeSecondRequest = cooldownFetcher.calls.length;
    await imagesMod.generateImage({ prompt: '死 key 冷却 2' }, { fetchImpl: cooldownFetcher, config: cooldownConfig });
    const secondRequestKeys = cooldownFetcher.calls.slice(beforeSecondRequest).map(keyTailOf);
    check('冷却：冷却期内的后续请求直接跳过死 key（只打 live）',
      secondRequestKeys.join(',') === 'live',
      `实际 ${secondRequestKeys.join(',') || '(无)'}`);
  } finally {
    console.warn = originalImageWarn;
  }
  const cooldownWarn = cooldownWarns.find((line) => line.includes('冷却'));
  check('冷却：日志只写 key 指纹（末 4 位），不打印完整 key',
    Boolean(cooldownWarn) && cooldownWarn.includes('#dead') && !cooldownWarn.includes('sk-rot-key-dead'),
    `实际日志 ${cooldownWarn || '(无)'}`);

  // 冷却窗口由注入时钟判定，不依赖真实 sleep
  const deadKeysResponder = (deadKeys) => (apiKey) => (deadKeys.includes(apiKey)
    ? jsonResponse({ error: { message: 'invalid token' } }, 403)
    : jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] }));
  const fakeClock = { now: 1_700_000_000_000 };
  const expiryDead = { value: true };
  const expiryFetcher = keyedFetcher((apiKey) => {
    if (apiKey === 'sk-rot-key-dead' && expiryDead.value) {
      return jsonResponse({ error: { message: 'invalid token' } }, 403);
    }
    return jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] });
  });
  const expiryConfig = rotationConfig({
    imageBaseUrl: 'http://mock-rot-expiry',
    imageApiKey: 'sk-rot-key-dead, sk-rot-key-live',
    imageBackupBaseUrl: '',
    imageBackupApiKey: '',
    imageBackupModel: '',
  });
  const expiryDeps = { config: expiryConfig, fetchImpl: expiryFetcher, now: () => fakeClock.now };
  await imagesMod.generateImage({ prompt: '冷却注入时钟 1' }, expiryDeps);
  const beforeWindow = expiryFetcher.calls.length;
  fakeClock.now += 600_000 - 1;
  await imagesMod.generateImage({ prompt: '冷却注入时钟 2' }, expiryDeps);
  check('冷却：窗口内（600000ms - 1）仍跳过死 key',
    expiryFetcher.calls.slice(beforeWindow).map(keyTailOf).join(',') === 'live',
    `实际 ${expiryFetcher.calls.slice(beforeWindow).map(keyTailOf).join(',') || '(无)'}`);

  fakeClock.now += 1;
  expiryDead.value = false;
  const beforeExpired = expiryFetcher.calls.length;
  await imagesMod.generateImage({ prompt: '冷却注入时钟 3' }, expiryDeps);
  check('冷却：窗口到期后死 key 自动恢复、重新参与轮转',
    expiryFetcher.calls.slice(beforeExpired).map(keyTailOf).join(',') === 'dead',
    `实际 ${expiryFetcher.calls.slice(beforeExpired).map(keyTailOf).join(',') || '(无)'}`);

  const cooldownConfigMod = await import('../src/lib/server/generation/config.ts');
  check('冷却：默认窗口 600000ms，0 关闭，空值回落默认',
    cooldownConfigMod.getGenerationConfig({ ...process.env, ANPPT_V2_IMAGE_KEY_COOLDOWN_MS: '' }).imageKeyCooldownMs === 600_000
      && cooldownConfigMod.getGenerationConfig({ ...process.env, ANPPT_V2_IMAGE_KEY_COOLDOWN_MS: '0' }).imageKeyCooldownMs === 0
      && cooldownConfigMod.getGenerationConfig({ ...process.env, ANPPT_V2_IMAGE_KEY_COOLDOWN_MS: '1500' }).imageKeyCooldownMs === 1500);

  const disabledFetcher = keyedFetcher(deadKeysResponder(['sk-rot-key-dead']));
  const disabledConfig = rotationConfig({
    imageBaseUrl: 'http://mock-rot-off',
    imageApiKey: 'sk-rot-key-dead, sk-rot-key-live',
    imageBackupBaseUrl: '',
    imageBackupApiKey: '',
    imageBackupModel: '',
    imageKeyCooldownMs: 0,
  });
  await imagesMod.generateImage({ prompt: '冷却关闭 1' }, { fetchImpl: disabledFetcher, config: disabledConfig });
  await imagesMod.generateImage({ prompt: '冷却关闭 2' }, { fetchImpl: disabledFetcher, config: disabledConfig });
  check('冷却：0 关闭冷却时死 key 下个请求仍参与轮转（dead → live 两次）',
    disabledFetcher.calls.map(keyTailOf).join(',') === 'dead,live,dead,live',
    `实际 ${disabledFetcher.calls.map(keyTailOf).join(',') || '(无)'}`);

  // 冷却关闭时死 key 不进冷却表：请求级已试集合必须保证同一把 key 只试一次，否则 for(;;) 挂死
  const guardTimeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('生图站点池挂死（超时 3s）')), 3000); }),
  ]);

  const singleKeyFetcher = keyedFetcher(deadKeysResponder(['sk-rot-key-onlydead']));
  const singleKeyConfig = rotationConfig({
    imageBaseUrl: 'http://mock-rot-single',
    imageApiKey: 'sk-rot-key-onlydead',
    imageBackupBaseUrl: '',
    imageBackupApiKey: '',
    imageBackupModel: '',
    imageKeyCooldownMs: 0,
  });
  let singleKeyError;
  try {
    await guardTimeout(imagesMod.generateImage({ prompt: '单站单死 key 不挂死' }, { fetchImpl: singleKeyFetcher, config: singleKeyConfig }));
  } catch (error) {
    singleKeyError = error;
  }
  check('冷却关闭：单站单把死 key 不无限重试（限时抛上游错误、上游只调用一次）',
    Boolean(singleKeyError)
      && imagesMod.toPublicImageError(singleKeyError).code === 'IMAGE_UPSTREAM_UNAVAILABLE'
      && singleKeyFetcher.calls.length === 1,
    `实际调用 ${singleKeyFetcher.calls.length} 次、错误 ${imagesMod.toPublicImageError(singleKeyError).code}`);

  const deadStationFetcher = keyedFetcher(deadKeysResponder(['sk-rot-key-deadonly']));
  const deadStationConfig = rotationConfig({
    imageBaseUrl: 'http://mock-rot-dead-a',
    imageApiKey: 'sk-rot-key-deadonly',
    imageBackupBaseUrl: 'http://mock-rot-dead-b',
    imageBackupApiKey: 'sk-rot-key-live',
    costImageFenPerCall: 3,
    costImageBackupFenPerCall: 5,
    imageKeyCooldownMs: 0,
  });
  let deadStationSwitched = false;
  try {
    await guardTimeout(imagesMod.generateImage({ prompt: '死 key 站冷却关闭时切站' }, { fetchImpl: deadStationFetcher, config: deadStationConfig }));
    deadStationSwitched = deadStationFetcher.calls.map(keyTailOf).join(',') === 'deadonly,live';
  } catch {
    deadStationSwitched = false;
  }
  check('冷却关闭：死 key 站试满即切下一站出图（deadonly → live）',
    deadStationSwitched,
    `实际调用 ${deadStationFetcher.calls.map(keyTailOf).join(',') || '(无)'}`);

  // 站内全部 key 冷却 → 该站本轮跳过，另一站照常兜底
  const blockedFetcher = keyedFetcher(deadKeysResponder(['sk-rot-key-dead1', 'sk-rot-key-dead2']));
  const blockedConfig = rotationConfig({
    imageBaseUrl: 'http://mock-rot-block-a',
    imageApiKey: 'sk-rot-key-dead1, sk-rot-key-dead2',
    imageBackupBaseUrl: 'http://mock-rot-block-b',
    imageBackupApiKey: 'sk-rot-key-live',
    costImageFenPerCall: 3,
    costImageBackupFenPerCall: 5,
  });
  const blockedWarns = [];
  const originalBlockedWarn = console.warn;
  console.warn = (...args) => { blockedWarns.push(args.map((arg) => String(arg)).join(' ')); };
  try {
    await imagesMod.generateImage({ prompt: '整站冷却 1' }, { fetchImpl: blockedFetcher, config: blockedConfig });
    const beforeBlockedSecond = blockedFetcher.calls.length;
    await imagesMod.generateImage({ prompt: '整站冷却 2' }, { fetchImpl: blockedFetcher, config: blockedConfig });
    check('冷却：两把 key 都死后该站被跳过，另一站兜底出图',
      blockedFetcher.calls.map(keyTailOf).join(',') === 'dead1,dead2,live,live',
      `实际 ${blockedFetcher.calls.map(keyTailOf).join(',') || '(无)'}`);
    check('冷却：全站 key 冷却时后续请求不再向上游发请求',
      blockedFetcher.calls.slice(beforeBlockedSecond).map(keyTailOf).join(',') === 'live',
      `实际 ${blockedFetcher.calls.slice(beforeBlockedSecond).map(keyTailOf).join(',') || '(无)'}`);
  } finally {
    console.warn = originalBlockedWarn;
  }
  check('冷却：整站跳过的日志写明「全部 key 冷却中」且不泄露 key',
    blockedWarns.some((line) => line.includes('全部 key 冷却中')) && blockedWarns.every((line) => !line.includes('sk-rot-key-dead')),
    `实际日志 ${blockedWarns.filter((line) => line.includes('冷却')).join(' | ') || '(无)'}`);

  // 整池 key 都不可用 → 抛既有错误码，不生造新错误
  const exhaustedFetcher = keyedFetcher(deadKeysResponder(['sk-rot-key-dead1', 'sk-rot-key-dead2']));
  const exhaustedConfig = rotationConfig({
    imageBaseUrl: 'http://mock-rot-exhausted',
    imageApiKey: 'sk-rot-key-dead1, sk-rot-key-dead2',
    imageBackupBaseUrl: '',
    imageBackupApiKey: '',
    imageBackupModel: '',
  });
  let exhaustedError;
  try {
    await imagesMod.generateImage({ prompt: '整池不可用 1' }, { fetchImpl: exhaustedFetcher, config: exhaustedConfig });
  } catch (error) {
    exhaustedError = error;
  }
  check('冷却：整池 key 都死时抛既有上游错误（IMAGE_UPSTREAM_UNAVAILABLE）',
    imagesMod.toPublicImageError(exhaustedError).code === 'IMAGE_UPSTREAM_UNAVAILABLE',
    `实际 ${imagesMod.toPublicImageError(exhaustedError).code}`);
  const exhaustedCalls = exhaustedFetcher.calls.length;
  let exhaustedAgain;
  try {
    await imagesMod.generateImage({ prompt: '整池不可用 2' }, { fetchImpl: exhaustedFetcher, config: exhaustedConfig });
  } catch (error) {
    exhaustedAgain = error;
  }
  check('冷却：整池仍冷却时直接抛同一错误，不再空撞上游',
    exhaustedFetcher.calls.length === exhaustedCalls
      && imagesMod.toPublicImageError(exhaustedAgain).code === 'IMAGE_UPSTREAM_UNAVAILABLE',
    `实际调用 ${exhaustedFetcher.calls.length - exhaustedCalls} 次、错误 ${imagesMod.toPublicImageError(exhaustedAgain).code}`);
}

// 余额耗尽（#48）：2026-10-31 灾备站欠费返回 HTTP 400 + "Insufficient balance"。
// 旧逻辑把 400 当「请求本身有问题」→ 不切站、不进冷却，每页都撞死站；错误还被映射成「内容太长」。
// 契约：余额类 = 站点级故障（可切站 + 熔断冷却 + 503 额度语义）；真实 400 仍不切站；
// 一次付费运行内切站不重复扣费，全池失败扣 1 退 1，熔断跳过与重复收敛都不产生第二笔退款。
console.log('\n[2c3] 生图池：#48 余额耗尽 = 站点级故障（切站 / 熔断 / 错误映射 / 计费不变量）');
{
  const imagesMod = await import('../src/lib/server/generation/images.ts');
  const chargeKeys = await import('../src/lib/server/generation/charge-keys.ts');

  // 灾备 3 分（便宜先试）→ 主站 5 分：不同价不触发同价轮换，尝试顺序只由单价决定。
  const balanceConfig = (overrides = {}) => ({
    ...imageConfig,
    imageBaseUrl: 'http://mock-bal-healthy',
    imageApiKey: 'sk-bal-healthy',
    imageModel: 'model-bal',
    imageEditModel: 'model-bal',
    imageBackupBaseUrl: 'http://mock-bal-thin',
    imageBackupApiKey: 'sk-bal-thin',
    imageBackupModel: 'model-bal',
    imageBackupEditModel: 'model-bal',
    imageBackup2BaseUrl: '',
    imageBackup2ApiKey: '',
    imageBackup2Model: '',
    imageBackup2EditModel: '',
    costImageFenPerCall: 5,
    costImageBackupFenPerCall: 3,
    costImageBackup2FenPerCall: 0,
    imageKeyCooldownMs: 600_000,
    ...overrides,
  });
  // mock fetch 按 URL 分流；每个场景用独立 host，熔断状态互不串场
  const stationFetcher = (respond) => {
    const calls = [];
    const fetcher = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return respond(String(url));
    };
    fetcher.calls = calls;
    return fetcher;
  };
  const stationOf = (call) => String(call.url).match(/^http:\/\/mock-([^/]+)/)?.[1] ?? String(call.url);
  const callOrder = (fetcher) => fetcher.calls.map(stationOf).join(',');
  const timeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('生图站点池挂死（超时 3s）')), 3000); }),
  ]);
  const okImage = () => jsonResponse({ data: [{ b64_json: PNG_1X1_B64 }] });
  const balance400 = (message) => jsonResponse({ error: { message } }, 400);
  const runGenerate = async (prompt, deps) => {
    try {
      return { image: await timeout(imagesMod.generateImage({ prompt }, deps)), error: null };
    } catch (error) {
      return { image: null, error };
    }
  };
  const countStation = (fetcher, station) => fetcher.calls.filter((call) => stationOf(call) === station).length;

  let failoverImage;
  let failoverError;
  const failoverFetcher = stationFetcher((url) => (
    url.includes('mock-bal-thin') ? balance400('Insufficient balance') : okImage()
  ));
  try {
    failoverImage = await timeout(imagesMod.generateImage({ prompt: '余额不足切站' }, {
      fetchImpl: failoverFetcher, config: balanceConfig(),
    }));
  } catch (error) {
    failoverError = error;
  }
  check('余额切站：灾备站 400 + Insufficient balance → 自动切到健康主站并出图',
    !failoverError && callOrder(failoverFetcher) === 'bal-thin,bal-healthy'
      && Buffer.isBuffer(failoverImage) && failoverImage.equals(Buffer.from(PNG_1X1_B64, 'base64')),
    failoverError ? `抛出 ${failoverError.message}` : `实际调用 ${callOrder(failoverFetcher) || '(无)'}`);
  check('余额切站：健康站只产出 1 张图（上游只回调一次，不重复生成）',
    countStation(failoverFetcher, 'bal-healthy') === 1,
    `实际健康站调用 ${countStation(failoverFetcher, 'bal-healthy')} 次`);

  // 熔断冷却由注入时钟判定：窗口内跳过、到期自动回池，不依赖真实 sleep
  const clock = { now: 1_700_000_000_000 };
  const thinDead = { value: true };
  const cooldownConfig = balanceConfig({
    imageBaseUrl: 'http://mock-bal-cold-healthy',
    imageApiKey: 'sk-bal-cold-healthy',
    imageBackupBaseUrl: 'http://mock-bal-cold-thin',
    imageBackupApiKey: 'sk-bal-cold-thin',
  });
  const cooldownFetcher = stationFetcher((url) => (
    url.includes('mock-bal-cold-thin') && thinDead.value ? balance400('余额不足') : okImage()
  ));
  const cooldownDeps = { fetchImpl: cooldownFetcher, config: cooldownConfig, now: () => clock.now };
  await runGenerate('余额熔断 1', cooldownDeps);
  const thinCallsAfterFirst = countStation(cooldownFetcher, 'bal-cold-thin');
  clock.now += 600_000 - 1;
  const beforeWindowCalls = cooldownFetcher.calls.length;
  await runGenerate('余额熔断 2', cooldownDeps);
  const duringWindow = cooldownFetcher.calls.slice(beforeWindowCalls).map(stationOf).join(',');
  check('余额熔断：冷却窗口内再次生成直接跳过欠费站（fetch 次数不增加，只打健康站）',
    duringWindow === 'bal-cold-healthy'
      && countStation(cooldownFetcher, 'bal-cold-thin') === thinCallsAfterFirst,
    `实际调用 ${duringWindow || '(无)'}，欠费站累计 ${countStation(cooldownFetcher, 'bal-cold-thin')} 次`);
  clock.now += 1;
  thinDead.value = false;
  const beforeExpiryCalls = cooldownFetcher.calls.length;
  await runGenerate('余额熔断 3', cooldownDeps);
  check('余额熔断：窗口到期后欠费站自动回到池中（充值恢复后重新被优先尝试）',
    cooldownFetcher.calls.slice(beforeExpiryCalls).map(stationOf).join(',') === 'bal-cold-thin',
    `实际调用 ${cooldownFetcher.calls.slice(beforeExpiryCalls).map(stationOf).join(',') || '(无)'}`);

  // 全池余额耗尽：两站都要尝试过，公开错误必须是 503 额度/可重试语义
  const exhaustedFetcher = stationFetcher((url) => (
    url.includes('mock-bal-exhausted-primary') ? balance400('insufficient_quota') : balance400('余额不足')
  ));
  const exhaustedRun = await runGenerate('全池余额耗尽', {
    fetchImpl: exhaustedFetcher,
    config: balanceConfig({
      imageBaseUrl: 'http://mock-bal-exhausted-primary',
      imageApiKey: 'sk-bal-exhausted-primary',
      imageBackupBaseUrl: 'http://mock-bal-exhausted-backup',
      imageBackupApiKey: 'sk-bal-exhausted-backup',
    }),
  });
  const exhaustedPublic = exhaustedRun.error ? imagesMod.toPublicImageError(exhaustedRun.error) : null;
  check('余额耗尽：全池都欠费时两站都被尝试过（不是撞死第一站就放弃）',
    callOrder(exhaustedFetcher) === 'bal-exhausted-backup,bal-exhausted-primary',
    `实际调用 ${callOrder(exhaustedFetcher) || '(无)'}`);
  check('余额耗尽：公开错误是 503 额度/可重试语义（不是 400 请求错误）',
    Boolean(exhaustedPublic) && exhaustedPublic.status === 503
      && /IMAGE_(QUOTA_EXHAUSTED|UPSTREAM_UNAVAILABLE)/.test(exhaustedPublic.code),
    `实际 ${exhaustedPublic ? `${exhaustedPublic.status} ${exhaustedPublic.code}` : '(未抛错)'}`);
  check('余额耗尽：文案不含「内容太长」，含额度/稍后/重试语义',
    Boolean(exhaustedPublic)
      && !/内容|过长|简化/.test(exhaustedPublic.message)
      && /额度|余额|充值|稍后|重试/.test(exhaustedPublic.message),
    `实际「${exhaustedPublic?.message ?? '(未抛错)'}」`);

  // 真实 400（非余额文案）仍按请求非法处理：不切站、不冷却
  const real400Config = balanceConfig({
    imageBaseUrl: 'http://mock-bal-400-healthy',
    imageApiKey: 'sk-bal-400-healthy',
    imageBackupBaseUrl: 'http://mock-bal-400-thin',
    imageBackupApiKey: 'sk-bal-400-thin',
  });
  const real400Fetcher = stationFetcher((url) => (
    url.includes('mock-bal-400-thin') ? balance400('invalid image size') : okImage()
  ));
  const real400Run = await runGenerate('真实 400 不切站', { fetchImpl: real400Fetcher, config: real400Config });
  const real400Public = real400Run.error ? imagesMod.toPublicImageError(real400Run.error) : null;
  check('真实 400（非余额文案）：不切站、上游只调用一次',
    Boolean(real400Run.error) && callOrder(real400Fetcher) === 'bal-400-thin',
    `实际调用 ${callOrder(real400Fetcher) || '(无)'}`);
  check('真实 400（非余额文案）：对外仍是「简化内容」语义',
    real400Public?.status === 400 && real400Public?.code === 'IMAGE_REQUEST_INVALID'
      && /简化/.test(real400Public?.message ?? ''),
    `实际 ${real400Public ? `${real400Public.status} ${real400Public.code} ${real400Public.message}` : '(未抛错)'}`);
  const beforeSecond400 = real400Fetcher.calls.length;
  await runGenerate('真实 400 不进冷却', { fetchImpl: real400Fetcher, config: real400Config });
  check('真实 400（非余额文案）：不误进冷却（下个请求仍先尝试该站）',
    real400Fetcher.calls.slice(beforeSecond400).map(stationOf).join(',') === 'bal-400-thin',
    `实际调用 ${real400Fetcher.calls.slice(beforeSecond400).map(stationOf).join(',') || '(无)'}`);

  // 计费不变量：走真实付费运行（单页生成 → beginPaidRun → 扣费 → 出图/退款），只读账本断言
  const billReg = await auth.registerWithPassword(
    { account: 'balbill48', password: 'password123', confirmPassword: 'password123' },
    '127.0.0.1',
  );
  const billUid = billReg.user.id;
  const unitPrice = credits.estimateCredits({ action: 'single_page_generate', pages: 1 }).unitPrice;
  const pageLedger = (pageId) => credits.listLedger(billUid, { pageSize: 50 }).items
    .filter((item) => item.refId === pageId);
  const refundRows = (pageId) => pageLedger(pageId).filter((item) => item.eventType === 'refund');
  const debitRows = (pageId) => pageLedger(pageId).filter((item) => item.eventType === 'debit');

  const billConfig = balanceConfig({
    imageBaseUrl: 'http://mock-bal-bill-healthy',
    imageApiKey: 'sk-bal-bill-healthy',
    imageBackupBaseUrl: 'http://mock-bal-bill-thin',
    imageBackupApiKey: 'sk-bal-bill-thin',
  });
  const billFetcher = stationFetcher((url) => (
    url.includes('mock-bal-bill-thin') ? balance400('Insufficient balance') : okImage()
  ));
  const beforeBill1 = credits.getBalance(billUid);
  const bill1 = await singlePages.generateSinglePage(billUid, {
    pageId: 'bal-bill-1', content: '余额切站计费',
  }, { fetchImpl: billFetcher, config: billConfig });
  check('计费：切站成功只扣 1 次费（账本 1 条扣费、0 条退款、余额净减 1 个单价）',
    bill1.status === 'succeeded'
      && debitRows('bal-bill-1').length === 1 && refundRows('bal-bill-1').length === 0
      && bill1.balance === beforeBill1 - unitPrice,
    `status=${bill1.status} 扣费 ${debitRows('bal-bill-1').length} 条、退款 ${refundRows('bal-bill-1').length} 条、余额 ${beforeBill1}→${bill1.balance}（单价 ${unitPrice}）`);

  const billDeadFetcher = stationFetcher(() => balance400('余额不足'));
  const beforeFail = credits.getBalance(billUid);
  const billFail = await singlePages.generateSinglePage(billUid, {
    pageId: 'bal-bill-fail', content: '全池余额耗尽',
  }, {
    fetchImpl: billDeadFetcher,
    config: balanceConfig({
      imageBaseUrl: 'http://mock-bal-bill-dead-primary',
      imageApiKey: 'sk-bal-bill-dead-primary',
      imageBackupBaseUrl: 'http://mock-bal-bill-dead-backup',
      imageBackupApiKey: 'sk-bal-bill-dead-backup',
    }),
  });
  check('计费：全池失败 = 扣 1 + 退 1，金额相等、净额 0',
    billFail.status === 'failed'
      && debitRows('bal-bill-fail').length === 1 && refundRows('bal-bill-fail').length === 1
      && Math.abs(debitRows('bal-bill-fail')[0].delta) === refundRows('bal-bill-fail')[0].delta
      && credits.getBalance(billUid) === beforeFail,
    `扣费 ${debitRows('bal-bill-fail')[0]?.delta ?? '(无)'}、退款 ${refundRows('bal-bill-fail')[0]?.delta ?? '(无)'}、余额 ${beforeFail}→${credits.getBalance(billUid)}`);
  check('计费：全池失败对外返回 503 额度语义，不含「内容太长」',
    billFail.status === 'failed'
      && /额度|余额|稍后|重试/.test(billFail.error) && !/内容|过长|简化/.test(billFail.error),
    `实际「${billFail.error}」`);

  // 熔断跳过本身不产生退款：同一时钟窗口内连续两页，第二页只打健康站且只扣一次
  const billClock = { now: 1_700_000_000_000 };
  const billCoolFetcher = stationFetcher((url) => (
    url.includes('mock-bal-skip-thin') ? balance400('余额不足') : okImage()
  ));
  const billCoolDeps = {
    fetchImpl: billCoolFetcher,
    config: balanceConfig({
      imageBaseUrl: 'http://mock-bal-skip-healthy',
      imageApiKey: 'sk-bal-skip-healthy',
      imageBackupBaseUrl: 'http://mock-bal-skip-thin',
      imageBackupApiKey: 'sk-bal-skip-thin',
    }),
    now: () => billClock.now,
  };
  const beforeSkip = credits.getBalance(billUid);
  const skip1 = await singlePages.generateSinglePage(billUid, {
    pageId: 'bal-skip-1', content: '熔断前第一次',
  }, billCoolDeps);
  const skipCallsAfterFirst = billCoolFetcher.calls.length;
  const skip2 = await singlePages.generateSinglePage(billUid, {
    pageId: 'bal-skip-2', content: '熔断跳过第二次',
  }, billCoolDeps);
  const skip2Order = billCoolFetcher.calls.slice(skipCallsAfterFirst).map(stationOf).join(',');
  check('计费：熔断跳过欠费站后成功，第二页只扣 1 次费、不产生退款',
    skip1.status === 'succeeded' && skip2.status === 'succeeded'
      && skip2Order === 'bal-skip-healthy'
      && debitRows('bal-skip-2').length === 1 && refundRows('bal-skip-2').length === 0
      && beforeSkip - skip1.balance === unitPrice && skip1.balance - skip2.balance === unitPrice,
    `第二页调用 ${skip2Order || '(无)'}，扣费 ${debitRows('bal-skip-2').length} 条、退款 ${refundRows('bal-skip-2').length} 条，余额 ${beforeSkip}→${skip1.balance}→${skip2.balance}（单价 ${unitPrice}）`);

  // 同一失败重复收敛：幂等退款，不再产生第二笔
  const failChargeKey = chargeKeys.singlePageChargeKey({ pageId: 'bal-bill-fail', jobId: billFail.jobId });
  const refundsBeforeSettle = refundRows('bal-bill-fail').length;
  const balanceBeforeSettle = credits.getBalance(billUid);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    paidRun.failPaidRun({
      userId: billUid,
      chargeKey: failChargeKey,
      refundReason: '单页生成失败退回',
      refType: 'single-page',
      refId: 'bal-bill-fail',
      settle() {},
    });
  }
  check('计费：同一失败重复收敛不产生第二笔退款（退款幂等）',
    refundsBeforeSettle === 1 && refundRows('bal-bill-fail').length === 1
      && credits.getBalance(billUid) === balanceBeforeSettle,
    `重复收敛前 ${refundsBeforeSettle} 条退款，重复后 ${refundRows('bal-bill-fail').length} 条，余额 ${balanceBeforeSettle}→${credits.getBalance(billUid)}`);
}

console.log('\n[19] 免费 LLM 动作频控（30 次/10 分钟/用户，共享桶）+ 限流器单元');
{
  const rlUser = await auth.registerWithPassword(
    { account: 'rluser01', password: 'password123', confirmPassword: 'password123' },
    '127.0.0.1',
  );
  const rlUid = rlUser.user.id;
  const rlDeck = decks.createDeck(rlUid, {
    title: '频控', sourceFileName: '', sourceText: '频控测试文本', durationMinutes: 10,
    targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
  });
  // 首次 outline（无 force）+ 29 次 force 重生成 = 30 次全部放行
  await actions.dispatchDeckIntent(rlUid, rlDeck.id, { kind: 'generateOutline', params: {} }, fullDeps);
  for (let i = 0; i < 29; i += 1) {
    await actions.dispatchDeckIntent(rlUid, rlDeck.id, { kind: 'generateOutline', params: { force: true } }, fullDeps);
  }
  await expectThrows('第 31 次免费 LLM 动作被 429 拒', () =>
    actions.dispatchDeckIntent(rlUid, rlDeck.id, { kind: 'generateOutline', params: { force: true } }, fullDeps), 'LLM_RATE_LIMITED');
  await expectThrows('同桶：structure 也被拒', () =>
    actions.dispatchDeckIntent(rlUid, rlDeck.id, { kind: 'structureSlides', params: { force: true } }, fullDeps), 'LLM_RATE_LIMITED');
  const reusedAfterLimit = await actions.dispatchDeckIntent(rlUid, rlDeck.id, { kind: 'generateOutline', params: {} }, fullDeps);
  check('限流后无 force 的 outline 复用不受影响', reusedAfterLimit.extra.reused === true);

  const rateLimitMod = await import('../src/lib/server/rate-limit.ts');
  const probe = 'unit-probe-key';
  check('限流器：前 2 次放行、第 3 次拒且带 retryAfter',
    rateLimitMod.hitRateLimit(probe, { windowMs: 60000, max: 2 }).allowed
      && rateLimitMod.hitRateLimit(probe, { windowMs: 60000, max: 2 }).allowed
      && !rateLimitMod.hitRateLimit(probe, { windowMs: 60000, max: 2 }).allowed
      && rateLimitMod.hitRateLimit(probe, { windowMs: 60000, max: 2 }).retryAfterSeconds >= 1);
  const consumeKey = 'unit-consume-key';
  const first = rateLimitMod.consumeRateLimit(consumeKey, { windowMs: 60000, max: 5, cost: 3 });
  const second = rateLimitMod.consumeRateLimit(consumeKey, { windowMs: 60000, max: 5, cost: 4 });
  check('限流器：按 cost 部分消耗，超额不透支窗口',
    first.allowed && first.consumed === 3
      && !second.allowed && second.consumed === 2 && second.count === 5);
}

await runPluginRuntimeTests({ check, expectThrows });
await runPptToBaseTests({ check });
await runPptToBaseServerTests({ check, expectThrows, auth, credits, llmConfig, makeMockFetcher, editsOkHandler, PNG_1X1_B64 });

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
releaseTestLock();
if (failed > 0) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
