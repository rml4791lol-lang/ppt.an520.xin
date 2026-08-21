#!/usr/bin/env node
// 对抗审查第二层：真实上游全链路（注册→解析→大纲→梳理→冻结→风格→生成→导出→账对）。
// 需要 dev/prod server 已带真实上游 env 启动（LLM/生图走 127.0.0.1:6800 隧道）：
//   ssh -L 6800:127.0.0.1:6800 hk-hermes   # 先打隧道
//   BASE_URL=http://localhost:3000 node scripts/e2e-fullchain.mjs
// 会真实消耗上游生图（页数控制在 2 页以内）与账户星星。截图输出 scripts/output/。
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.resolve(process.cwd(), 'scripts/output');
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const H = { 'x-anppt-action': '1' };
const account = `e2e${Date.now().toString(36)}`;
let cookie = '';

async function api(pathname, { method = 'GET', body, form } = {}) {
  const headers = { ...H, cookie };
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deckState(deckId) {
  const { status, json } = await api(`/api/deck/${deckId}`);
  if (status !== 200 || !json?.ok) throw new Error(`deck state ${status}`);
  return json.data;
}

async function action(deckId, body) {
  const { status, json } = await api(`/api/deck/${deckId}`, { method: 'POST', body });
  return { status, json };
}

console.log('[0] 注册（送 100🌟）');
{
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...H },
    body: JSON.stringify({ account, password: 'password123', confirmPassword: 'password123' }),
  });
  check('注册 201', res.status === 201, `实际 ${res.status}`);
  cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
  const bal = await api('/api/credits/balance');
  check('开局 100🌟', bal.json?.data?.balance === 100, `实际 ${bal.json?.data?.balance}`);
}

console.log('[1] 上传小文档（2 页体量）');
const SOURCE = `2026 年第一季度经营复盘

第一季度营收 1200 万元，同比增长 20%，主要来自企业客户续费。
新客户签约 35 家，客单价 8.5 万元。产品侧完成 3 次大版本迭代，NPS 提升到 47。

第二季度计划聚焦两件事：
一是上线渠道分销体系，目标新增 20 家渠道伙伴；
二是将大客户交付周期从 6 周压缩到 4 周。`;
let deckId = '';
{
  const form = new FormData();
  form.append('file', new Blob([SOURCE], { type: 'text/plain' }), 'q1-review.txt');
  form.append('duration', '5');
  form.append('targetPageCount', '2');
  const { status, json } = await api('/api/deck/parse', { method: 'POST', form });
  check('parse 201', status === 201, `实际 ${status} ${JSON.stringify(json)?.slice(0, 120)}`);
  deckId = json?.data?.deckId || '';
}

console.log('[2] 大纲 → 梳理 → 冻结 → 风格');
{
  const r1 = await action(deckId, { action: 'outline' });
  check('outline 200', r1.status === 200, `实际 ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 160)}`);
  let s = await deckState(deckId);
  check('状态 outlined 且 ≤3 页', s.deck.status === 'outlined' && s.slides.length >= 1 && s.slides.length <= 3,
    `实际 ${s.deck.status}/${s.slides.length} 页`);

  const r2 = await action(deckId, { action: 'structure' });
  check('structure 200', r2.status === 200, `实际 ${r2.status}`);
  s = r2.json?.data ?? (await deckState(deckId));
  check('全部页梳理 ok', s.slides.every((x) => x.structureStatus === 'ok'),
    s.slides.map((x) => `${x.pageIndex}:${x.structureStatus}`).join(','));

  const r3 = await action(deckId, { action: 'confirm-structure' });
  check('confirm 200 且 contentLocked', r3.status === 200 && r3.json?.data?.contentLocked === true,
    `实际 ${r3.status}`);

  const packs = await api('/api/style-packs');
  const packId = packs.json?.data?.stylePacks?.[0]?.id || '';
  check('风格包列表可取', Boolean(packId));
  const r4 = await action(deckId, { action: 'style', stylePackId: packId });
  check('style 选中', r4.status === 200, `实际 ${r4.status}`);
}

console.log('[3] 估价 → 生成（真实扣费）');
let before = 0;
let pageCount = 0;
{
  const s0 = await deckState(deckId);
  pageCount = s0.slides.length;
  const est = await api('/api/credits/estimate', { method: 'POST', body: { action: 'deck_page_generate', pages: pageCount } });
  check('估价 = 页数×10', est.json?.data?.credits === pageCount * 10,
    `实际 ${JSON.stringify(est.json?.data)}`);
  before = (await api('/api/credits/balance')).json.data.balance;

  const r5 = await action(deckId, { action: 'generate' });
  check('generate 202', r5.status === 202, `实际 ${r5.status} ${JSON.stringify(r5.json)?.slice(0, 160)}`);

  const deadline = Date.now() + 10 * 60_000;
  let s;
  for (;;) {
    s = await deckState(deckId);
    const pending = s.slides.some((x) => ['queued', 'running'].includes(x.genStatus));
    if (!pending && ['generated', 'partial'].includes(s.deck.status)) break;
    if (Date.now() > deadline) { check('生成 10min 内完成', false, s.deck.status); break; }
    await sleep(3000);
  }
  const ok = s.slides.filter((x) => x.genStatus === 'succeeded').length;
  const failedPages = s.slides.filter((x) => x.genStatus === 'failed').length;
  console.log(`    页面结果：${ok} 成功 / ${failedPages} 失败（共 ${s.slides.length} 页）`);
  check('至少 1 页真实出图', ok >= 1);
  const withImage = s.slides.filter((x) => x.versions?.some((v) => v.imageUrl));
  check('成功页带 imageUrl', withImage.length === ok);

  const after = (await api('/api/credits/balance')).json.data.balance;
  check('净扣费 = 成功页×10（失败页已退）', before - after === ok * 10,
    `before=${before} after=${after} ok=${ok}`);

  const ledger = await api('/api/credits/ledger?pageSize=50');
  const rows = ledger.json?.data?.items ?? ledger.json?.data?.rows ?? [];
  check('流水含 debit 记录', rows.some((r) => Number(r.delta ?? r.amount) < 0));
  if (failedPages > 0) check('流水含 refund 记录', rows.some((r) => String(r.eventType ?? r.event_type ?? '').includes('refund')));
}

console.log('[4] 导出图片版 PPTX');
{
  const r = await api(`/api/deck/${deckId}/export-image`, { method: 'POST', body: {} });
  check('导出 201', r.status === 201, `实际 ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
  const url = r.json?.data?.url || '';
  if (url) {
    const file = await fetch(`${BASE}${url}`, { headers: { cookie } });
    check('pptx 可下载', file.status === 200, `实际 ${file.status}`);
    const buf = Buffer.from(await file.arrayBuffer());
    const slideNames = new Set(buf.toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g) || []);
    const okCount = pageCount; // 导出按成功页
    check(`pptx 内含 ${okCount} 页 slide`, slideNames.size === okCount, `实际 ${slideNames.size}`);
  }
}

console.log(failed ? `\n${failed} 项失败` : '\n全链路通过');
process.exit(failed ? 1 : 0);
