#!/usr/bin/env node
// 模块 5 验收：真模板（kind=template）路线全流程实测。
// 世校赛主题 → 注册 → 上传 → 大纲 → 大纲编辑（改标题）→ 梳理 → 冻结 → 选 hj 真模板 → 估价 → 生成 → 账对 → 下载成片。
// 真实消耗上游（an520 gpt-image-2，4 页约 ¥0.6）与账户星星（注册赠送 100🌟 内）。
// 用法：BASE_URL=http://127.0.0.1:3120 node scripts/m7-template-route-e2e.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3120';
const PACK_ID = process.env.PACK_ID || 'anppt-hj-keji-weilai-20260822';
const OUT = path.resolve(process.cwd(), 'output/m7-template-test');
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const H = { 'x-anppt-action': '1' };
const account = `m7${Date.now().toString(36)}`;
let cookie = '';

async function api(pathname, { method = 'GET', body, form } = {}) {
  const headers = { ...H, cookie };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
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

console.log('[0] 注册');
{
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...H },
    body: JSON.stringify({ account, password: 'password123', confirmPassword: 'password123' }),
  });
  check('注册 201', res.status === 201, `实际 ${res.status}`);
  cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
}

console.log('[1] 上传世校赛主题文档（4 页）');
const SOURCE = `校园智慧用电安全管理平台

职业院校宿舍与实训室用电安全事故频发，私拉乱接、大功率违规电器、线路老化是三大隐患。传统人工巡检覆盖率不足三成，隐患发现平均滞后四十八小时。

平台由三层构成：末端智能空开与计量插座实时采集电流、电压与温度；边缘网关完成本地研判与断电保护；云端平台统一呈现用电画像与隐患工单。

试点覆盖三栋宿舍楼一千二百个回路。运行六个月，隐患发现时效从四十八小时缩短到三分钟，违规用电事件下降八成二，巡检人力减少一半。

已在两所兄弟院校复制推广，单校区部署周期两周。计划年内覆盖全省二十所职业院校，并接入市级校园安全监管平台。`;
let deckId = '';
{
  const form = new FormData();
  form.append('file', new Blob([SOURCE], { type: 'text/plain' }), 'wvcsc-iot.txt');
  form.append('duration', '5');
  form.append('targetPageCount', '4');
  const { status, json } = await api('/api/deck/parse', { method: 'POST', form });
  check('parse 201', status === 201, `实际 ${status} ${JSON.stringify(json)?.slice(0, 120)}`);
  deckId = json?.data?.deckId || '';
}

console.log('[2] 大纲 → 大纲编辑（改第 2 页标题）');
{
  const r1 = await action(deckId, { action: 'outline' });
  check('outline 200', r1.status === 200, `实际 ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 160)}`);
  const s = await deckState(deckId);
  check('状态 outlined', s.deck.status === 'outlined', `实际 ${s.deck.status}`);
  console.log(`    大纲 ${s.slides.length} 页：${s.slides.map((x) => `${x.pageIndex + 1}[${x.pageType || x.role}]`).join(' ')}`);

  const target = s.slides[1] || s.slides[0];
  const newTitle = '三层架构：端、边、云协同';
  const r2 = await action(deckId, { action: 'update-slide', slideId: target.slideId, title: newTitle });
  check('update-slide 200', r2.status === 200, `实际 ${r2.status} ${JSON.stringify(r2.json)?.slice(0, 160)}`);
  check('标题编辑生效', r2.json?.data?.contentChanged === true, `实际 ${JSON.stringify(r2.json?.data)?.slice(0, 80)}`);
  const s2 = await deckState(deckId);
  check('标题已持久化', s2.slides.some((x) => x.title === newTitle),
    `实际 ${s2.slides.map((x) => x.title).join(' | ')}`);
}

console.log('[3] 梳理 → 冻结 → 选真模板');
{
  const r2 = await action(deckId, { action: 'structure' });
  check('structure 200', r2.status === 200, `实际 ${r2.status}`);
  const s = r2.json?.data ?? (await deckState(deckId));
  check('全部页梳理 ok', s.slides.every((x) => x.structureStatus === 'ok'),
    s.slides.map((x) => `${x.pageIndex}:${x.structureStatus}`).join(','));
  const r3 = await action(deckId, { action: 'confirm-structure' });
  check('confirm 且 contentLocked', r3.status === 200 && r3.json?.data?.contentLocked === true, `实际 ${r3.status}`);
  const r4 = await action(deckId, { action: 'style', stylePackId: PACK_ID });
  check('选中真模板 ' + PACK_ID, r4.status === 200, `实际 ${r4.status} ${JSON.stringify(r4.json)?.slice(0, 160)}`);
}

console.log('[4] 估价 → 生成（真实扣费）');
{
  const s0 = await deckState(deckId);
  const pageCount = s0.slides.length;
  const est = await api('/api/credits/estimate', { method: 'POST', body: { action: 'deck_page_generate', pages: pageCount } });
  check('估价 = 页数×10', est.json?.data?.credits === pageCount * 10, `实际 ${JSON.stringify(est.json?.data)}`);
  const before = (await api('/api/credits/balance')).json.data.balance;

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
  check('全部页真实出图', ok === s.slides.length, `${ok}/${s.slides.length}`);

  const after = (await api('/api/credits/balance')).json.data.balance;
  check('净扣费 = 成功页×10', before - after === ok * 10, `实际 ${before}→${after}`);

  console.log('[5] 下载成片');
  for (const slide of s.slides) {
    const version = slide.versions?.find((v) => v.imageUrl) || slide.versions?.[slide.versions.length - 1];
    if (!version?.imageUrl) continue;
    const res = await fetch(`${BASE}${version.imageUrl}`, { headers: { cookie } });
    if (!res.ok) { check(`下载第 ${slide.pageIndex + 1} 页`, false, `HTTP ${res.status}`); continue; }
    const file = path.join(OUT, `p${slide.pageIndex + 1}.png`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`    p${slide.pageIndex + 1}.png ← ${version.imageUrl}`);
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
