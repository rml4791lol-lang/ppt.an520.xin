#!/usr/bin/env node
// 线上对抗审查：ppt.an520.xin「选择风格→生成页面」CTA 状态机（真实浏览器 + 真实扣费）。
// 覆盖断言：
//   a. 已选风格未生成：CTA=「生成整套页面 · N×10🌟」，弹窗页数/价格与 CTA 一致
//   b. 202 后生成中：CTA=禁用态「正在生成中…」
//   c. 全部完成后：CTA=「使用此风格重新生成 · N×10🌟」，弹窗为整套重做文案（含"覆盖已有页面图"）
//   d. 全程 toast 不得出现 forceRegenerate / genStatus / ApiError 等技术术语
//   e. 第 5 步画布成品截图 ×2；余额 100 → 100-成功页×10
// Playwright 依赖：/Users/an/Documents/AI PPT/anppt-app/node_modules（channel: chrome, headless）
// 运行：node scripts/e2e-ui-audit.mjs
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/');
const { chromium } = require('playwright');

const BASE = 'https://ppt.an520.xin';
const OUT = path.resolve(process.cwd(), 'output/ui-audit');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '', shot = '') => {
  results.push({ name, ok, detail, shot });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${shot ? ` [${shot}]` : ''}${ok ? '' : ` — ${detail}`}`);
};

const H = { 'x-anppt-action': '1', Origin: BASE };
const account = `uiaudit${Date.now().toString(36)}`;
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

// ---------- [0] 注册 ----------
console.log('[0] 注册测试账号', account);
{
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...H },
    body: JSON.stringify({ account, password: 'uiaudit12345', confirmPassword: 'uiaudit12345' }),
  });
  const json = await res.json().catch(() => null);
  check('注册 201', res.status === 201, `实际 ${res.status} ${JSON.stringify(json)?.slice(0, 160)}`);
  if (res.status !== 201) process.exit(1);
  cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
  const bal = await api('/api/credits/balance');
  check('开局余额 100🌟', bal.json?.data?.balance === 100, `实际 ${bal.json?.data?.balance}`);
}

// ---------- [1] 建 deck 到「已选风格」 ----------
console.log('[1] parse → outline → structure → confirm → style');
const SOURCE = `2026 年第一季度经营复盘

第一季度营收 1200 万元，同比增长 20%，主要来自企业客户续费。
新客户签约 35 家，客单价 8.5 万元。产品侧完成 3 次大版本迭代，NPS 提升到 47。

第二季度计划聚焦两件事：
一是上线渠道分销体系，目标新增 20 家渠道伙伴；
二是将大客户交付周期从 6 周压缩到 4 周。`;
let deckId = '';
let pageCount = 0;
{
  const form = new FormData();
  form.append('file', new Blob([SOURCE], { type: 'text/plain' }), 'q1-review.txt');
  form.append('duration', '5');
  form.append('targetPageCount', '2');
  const r = await api('/api/deck/parse', { method: 'POST', form });
  check('parse 201', r.status === 201, `实际 ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
  deckId = r.json?.data?.deckId || '';
  if (!deckId) process.exit(1);

  const r1 = await api(`/api/deck/${deckId}`, { method: 'POST', body: { action: 'outline' } });
  check('outline 200', r1.status === 200, `实际 ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 160)}`);

  const r2 = await api(`/api/deck/${deckId}`, { method: 'POST', body: { action: 'structure' } });
  check('structure 200', r2.status === 200, `实际 ${r2.status}`);

  const r3 = await api(`/api/deck/${deckId}`, { method: 'POST', body: { action: 'confirm-structure' } });
  check('confirm-structure 200', r3.status === 200, `实际 ${r3.status}`);

  const packs = await api('/api/style-packs');
  const packId = packs.json?.data?.stylePacks?.[0]?.id || '';
  const r4 = await api(`/api/deck/${deckId}`, { method: 'POST', body: { action: 'style', stylePackId: packId } });
  check('style 选中', r4.status === 200, `实际 ${r4.status}`);

  const s = await deckState(deckId);
  pageCount = s.slides.length;
  check('deck 已到 confirmed（已选风格）', s.deck.status === 'confirmed', `实际 ${s.deck.status}`);
  console.log(`    deckId=${deckId} 页数=${pageCount} 风格包=${packId}`);
}
const PRICE = pageCount * 10;

// ---------- [2] 真实浏览器 ----------
console.log('[2] Playwright 真机断言');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// toast 全程录制（role=status 的 toast 5s 自动消失，用 MutationObserver 抓全量）
await ctx.addInitScript(() => {
  window.__auditToasts = [];
  const scan = () => {
    document.querySelectorAll('[role="status"]').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && !window.__auditToasts.includes(t)) window.__auditToasts.push(t);
    });
  };
  const install = () => {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  };
  // init 脚本执行时 documentElement 可能尚未存在，等 DOM 就绪再挂观察者
  if (document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
});

const [name, value] = cookie.split('=');
await ctx.addCookies([{ name, value, url: BASE }]);

const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text().slice(0, 200)}`); });

const shot = async (file) => { await page.screenshot({ path: path.join(OUT, file) }); };
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const cta = () => page.getByRole('button', { name: /生成整套页面|正在生成中|使用此风格重新生成|生成剩余 \d+ 页/ });
const navStep = (label) => page.locator('nav[aria-label="生成流程"] button', { hasText: label });

try {
  // ===== a. 已选风格：CTA + 弹窗一致性 =====
  console.log('  a. 已选风格态');
  await page.goto(`${BASE}/deck/${deckId}`, { waitUntil: 'domcontentloaded' });
  await cta().first().waitFor({ state: 'visible', timeout: 60_000 });
  const ctaTextA = norm(await cta().first().textContent());
  const ctaEnabledA = await cta().first().isEnabled();
  check(`a1 CTA=「生成整套页面 · ${PRICE}🌟」`, ctaTextA === `生成整套页面 · ${PRICE}🌟` && ctaEnabledA,
    `实际「${ctaTextA}」enabled=${ctaEnabledA}`, 'a1-style-step-cta.png');
  await shot('a1-style-step-cta.png');

  await cta().first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => /生成页面\s*\d+\s*页/.test(document.querySelector('[role="dialog"]')?.textContent || ''),
    null, { timeout: 15_000 },
  );
  const dlgTextA = norm(await dialog.textContent());
  const mA = dlgTextA.match(/生成页面\s*(\d+)\s*页\s*×\s*(\d+)🌟\s*=\s*(\d+)/);
  const modalOkA = mA && Number(mA[1]) === pageCount && Number(mA[3]) === PRICE;
  check(`a2 弹窗估价 ${pageCount}页×10🌟=${PRICE}🌟 与 CTA 一致`, Boolean(modalOkA),
    `实际「${dlgTextA.slice(0, 120)}」`, 'a2-generate-confirm-modal.png');
  await shot('a2-generate-confirm-modal.png');

  // ===== b. 确认生成 → 202 → 生成中 CTA 禁用 =====
  console.log('  b. 点击确认 → 生成中态');
  const [genResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/api/deck/${deckId}`) && r.request().method() === 'POST',
      { timeout: 30_000 },
    ),
    dialog.getByRole('button', { name: '确认并生成页面' }).click(),
  ]);
  check('b1 generate 接口 202', genResp.status() === 202, `实际 ${genResp.status()}`);

  await sleep(1200); // 等 applyState 落地（202 响应即最新全量状态）
  const st = await deckState(deckId);
  check('b2 deck 进入 generating', ['generating', 'generated', 'partial'].includes(st.deck.status),
    `实际 ${st.deck.status}`);

  // 不刷新直接观察（生成中步骤条禁点，按审查要求强制进入第 4 步看 CTA）
  const stepDisabled = await navStep('选择风格').isDisabled();
  check('b3 生成中「选择风格」步骤不可点击（防跳步）', stepDisabled, `disabled=${stepDisabled}`);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('nav[aria-label="生成流程"] button')]
      .find((x) => x.textContent.includes('选择风格'));
    b.disabled = false;
    b.click();
  });
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('正在生成中')),
      null, { timeout: 10_000 },
    );
    const ctaTextB = norm(await cta().first().textContent());
    const ctaDisabledB = await cta().first().isDisabled();
    check('b4 生成中 CTA=禁用态「正在生成中…」', ctaTextB === '正在生成中…' && ctaDisabledB,
      `实际「${ctaTextB}」disabled=${ctaDisabledB}`, 'b4-generating-cta-disabled.png');
  } catch {
    const all = await page.evaluate(
      () => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 30),
    );
    check('b4 生成中 CTA=禁用态「正在生成中…」', false, `10s 内未出现，当前按钮：${JSON.stringify(all)}`);
  }
  await shot('b4-generating-cta-disabled.png');

  // ===== 等全部页生成完成 =====
  console.log('  ⏳ 轮询等待生成完成（最长 10 分钟）…');
  let final;
  {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      final = await deckState(deckId);
      const pending = final.slides.some((x) => ['queued', 'running'].includes(x.genStatus));
      if (!pending && ['generated', 'partial'].includes(final.deck.status)) break;
      if (Date.now() > deadline) break;
      await sleep(3000);
    }
  }
  const okPages = final.slides.filter((x) => x.genStatus === 'succeeded').length;
  const failPages = final.slides.filter((x) => x.genStatus === 'failed').length;
  console.log(`    生成结果：${okPages} 成功 / ${failPages} 失败，deck=${final.deck.status}`);
  check('生成完成且全部页成功', final.deck.status === 'generated' && okPages === pageCount,
    `deck=${final.deck.status} ok=${okPages} fail=${failPages}`);

  // ===== c. 全部完成：重新生成 CTA + 整套重做弹窗 =====
  console.log('  c. 全部完成态');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav[aria-label="生成流程"]', { timeout: 60_000 });
  await sleep(2500);
  await navStep('选择风格').click();
  await cta().first().waitFor({ state: 'visible', timeout: 15_000 });
  const ctaTextC = norm(await cta().first().textContent());
  const ctaEnabledC = await cta().first().isEnabled();
  check(`c1 CTA=「使用此风格重新生成 · ${PRICE}🌟」`, ctaTextC === `使用此风格重新生成 · ${PRICE}🌟` && ctaEnabledC,
    `实际「${ctaTextC}」enabled=${ctaEnabledC}`, 'c1-alldone-regen-cta.png');
  await shot('c1-alldone-regen-cta.png');

  await cta().first().click();
  const dialogC = page.getByRole('dialog');
  await dialogC.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => /生成页面\s*\d+\s*页/.test(document.querySelector('[role="dialog"]')?.textContent || ''),
    null, { timeout: 15_000 },
  );
  const dlgTextC = norm(await dialogC.textContent());
  const mC = dlgTextC.match(/生成页面\s*(\d+)\s*页\s*×\s*(\d+)🌟\s*=\s*(\d+)/);
  check('c2 弹窗=整套重做文案（含"覆盖已有页面图"）',
    dlgTextC.includes('重新生成整套') && dlgTextC.includes('覆盖已有页面图'),
    `实际「${dlgTextC.slice(0, 140)}」`, 'c2-regen-modal.png');
  check(`c3 弹窗估价=整套 ${pageCount}页=${PRICE}🌟`,
    Boolean(mC && Number(mC[1]) === pageCount && Number(mC[3]) === PRICE),
    `实际「${dlgTextC.slice(0, 140)}」`);
  await shot('c2-regen-modal.png');
  await dialogC.getByRole('button', { name: '取消' }).click(); // 不二次扣费

  // ===== e. 第 5 步画布成品截图 =====
  console.log('  e. 画布成品');
  await navStep('生成页面').click();
  await page.waitForSelector('img[alt^="第 "]', { timeout: 30_000 });
  await sleep(1000);
  await shot('e1-canvas-grid.png');
  const firstImgBtn = page.locator('button:has(img[alt^="第 "])').first();
  if (await firstImgBtn.count()) {
    await firstImgBtn.click();
    await page.getByRole('dialog', { name: '单页放大预览' }).waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await sleep(800);
  }
  await shot('e2-canvas-preview.png');
  check('e1 画布成品截图 ×2', true, '', 'e1-canvas-grid.png / e2-canvas-preview.png');
} finally {
  // ===== d. toast 技术术语审计 =====
  const toasts = await page.evaluate(() => window.__auditToasts || []);
  const BAD = /forceRegenerate|genStatus|ApiError|ApiClientError|GENERATION_|structureStatus|undefined|NaN|\[object/i;
  const badToasts = toasts.filter((t) => BAD.test(t));
  console.log(`    采集到 toast ${toasts.length} 条：${JSON.stringify(toasts)}`);
  check('d1 无技术术语 toast（forceRegenerate/genStatus/ApiError…）', badToasts.length === 0,
    badToasts.join(' | '));
  if (consoleErrors.length) console.log(`    控制台错误 ${consoleErrors.length} 条：${JSON.stringify(consoleErrors.slice(0, 5))}`);
  check('d2 无页面 JS 异常', consoleErrors.length === 0, consoleErrors[0] || '');

  await browser.close();
}

// ---------- [3] 余额核对 ----------
console.log('[3] 余额核对');
{
  const bal = await api('/api/credits/balance');
  const after = bal.json?.data?.balance;
  // 失败页自动退还，应扣 = 成功页×10
  const expect = 100 - pageCount * 10; // 全成功场景；有失败页时按实际成功数放宽
  const st = await deckState(deckId);
  const okPages = st.slides.filter((x) => x.genStatus === 'succeeded').length;
  check(`余额=100-成功页×10=${100 - okPages * 10}🌟`, after === 100 - okPages * 10,
    `实际 ${after}（全成功预期 ${expect}）`);
  console.log(`    最终余额 ${after}🌟`);
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log('\n===== 审查结果汇总 =====');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.shot ? ` [${r.shot}]` : ''}${r.ok ? '' : ` — ${r.detail}`}`);
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部断言通过');
process.exit(failed.length ? 1 : 0);
