// M5：断点续跑已创建的 deck（structure 重试 → 冻结 → 风格 → 生成 → 导出）。
// 用法：node scripts/m5-resume.mjs <label> <account> <deckId> <stylePackId>
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , label, account, deckId, stylePackId] = process.argv;
if (!label || !account || !deckId || !stylePackId) {
  console.error('用法：node scripts/m5-resume.mjs <label> <account> <deckId> <stylePackId>');
  process.exit(1);
}
const BASE = process.env.BASE_URL || 'http://localhost:3120';
const H = { 'x-anppt-action': '1' };
let cookie = '';

async function api(pathname, { method = 'GET', body } = {}) {
  const headers = { ...H, cookie };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deckState = async () => (await api(`/api/deck/${deckId}`)).json?.data;
const action = (body) => api(`/api/deck/${deckId}`, { method: 'POST', body });

{
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...H },
    body: JSON.stringify({ account, password: 'password123' }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}`);
  cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
  console.log(`[resume] 登录 ${account}，deck=${deckId}`);
}

// structure：只重梳非 ok 页，最多 4 轮
for (let round = 1; round <= 4; round += 1) {
  const r = await action({ intent: { kind: 'structureSlides', params: {} } });
  if (r.status !== 200) throw new Error(`structure 失败 ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
  const s = await deckState();
  const notOk = s.slides.filter((x) => x.structureStatus !== 'ok');
  console.log(`[structure] 第 ${round} 轮：${s.slides.length - notOk.length}/${s.slides.length} ok${notOk.length ? `，缺 ${notOk.map((x) => x.pageIndex).join(',')}` : ''}`);
  if (notOk.length === 0) break;
  if (round === 4) throw new Error(`梳理 4 轮后仍未全 ok: ${notOk.map((x) => x.pageIndex).join(',')}`);
}

{
  const r = await action({ intent: { kind: 'confirmStructure', params: {} } });
  if (r.status !== 200) throw new Error(`confirm 失败 ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
  const r2 = await action({ intent: { kind: 'setStyle', params: { stylePackId } } });
  if (r2.status !== 200) throw new Error(`style 失败 ${r2.status} ${JSON.stringify(r2.json)?.slice(0, 200)}`);
  console.log(`[resume] structure ok + locked + style=${stylePackId}`);
}

const before = (await api('/api/credits/balance')).json.data.balance;
{
  const r = await action({ intent: { kind: 'generateSlides', params: {} } });
  if (r.status !== 202) throw new Error(`generate 失败 ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
  console.log(`[3] 生成中…（开始前余额 ${before}）`);
  const deadline = Date.now() + 15 * 60_000;
  let s;
  for (;;) {
    s = await deckState();
    const pending = s.slides.some((x) => ['queued', 'running'].includes(x.genStatus));
    if (!pending && ['generated', 'partial'].includes(s.deck.status)) break;
    if (Date.now() > deadline) throw new Error(`生成超时，状态 ${s.deck.status}`);
    await sleep(4000);
  }
  const ok = s.slides.filter((x) => x.genStatus === 'succeeded');
  const failedPages = s.slides.filter((x) => x.genStatus === 'failed');
  const after = (await api('/api/credits/balance')).json.data.balance;
  console.log(`[3] 完成：${ok.length} 成功 / ${failedPages.length} 失败；余额 ${before} → ${after}（消耗 ${before - after}）`);
  for (const sl of s.slides) {
    const img = sl.versions?.find((v) => v.imageUrl)?.imageUrl || '';
    console.log(`    p${sl.pageIndex} ${sl.genStatus} ${img}`);
  }

  const r6 = await api(`/api/deck/${deckId}/export-image`, { method: 'POST', body: {} });
  if (r6.status !== 201) throw new Error(`导出失败 ${r6.status} ${JSON.stringify(r6.json)?.slice(0, 160)}`);
  const url = r6.json?.data?.url || '';
  const file = await fetch(`${BASE}${url}`, { headers: { cookie } });
  const buf = Buffer.from(await file.arrayBuffer());
  const pptxPath = path.resolve(process.cwd(), 'output', `m5-${label}.pptx`);
  writeFileSync(pptxPath, buf);
  const slideNames = new Set(buf.toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g) || []);
  console.log(`[4] 导出 pptx ${pptxPath}（内含 ${slideNames.size} 页）`);

  writeFileSync(
    path.resolve(process.cwd(), 'output', `m5-${label}.json`),
    JSON.stringify(
      {
        deckId, account, stylePackId,
        credits: { before, after, spent: before - after },
        slides: s.slides.map((sl) => ({
          pageIndex: sl.pageIndex, role: sl.role, pageType: sl.pageType, title: sl.title,
          genStatus: sl.genStatus, imageUrl: sl.versions?.find((v) => v.imageUrl)?.imageUrl || '',
        })),
      },
      null,
      2,
    ),
  );
  console.log(`[done] output/m5-${label}.json`);
}
