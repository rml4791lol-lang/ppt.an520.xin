#!/usr/bin/env node
// 补测项 b4（最终方案）：生成中「选择风格」CTA=禁用态「正在生成中…」。
//
// 已探明的事实（见探针 scripts/probe-disabled-nav.mjs 三轮实测）：
//   生成中步骤条按钮的 disabled 是 React fiber prop 层禁用，dispatchEvent / 去属性+el.click() /
//   去属性+Playwright 可信点击 全部无法触发 goStep —— 单标签页内「生成中回到第 4 步」架构上不可达。
// 但存在真实可达路径：先在第 4 步停留（viewStep=3），生成由另一会话/标签页触发，
//   本页 2.5s 轮询拿到 generating 态后 CTA 应变为禁用「正在生成中…」。
// 本脚本复现该路径：浏览器停留在「选择风格」步，API 侧触发 generate-slide（单页重生成，
//   deck 同样进入 generating，见 generate.ts:234），观察 CTA 变化。真实扣费 10🌟。
// 运行：node scripts/e2e-ui-audit-b4.mjs
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/');
const { chromium } = require('playwright');

const BASE = 'https://ppt.an520.xin';
const OUT = path.resolve(process.cwd(), 'output/ui-audit');
mkdirSync(OUT, { recursive: true });

const ACCOUNT = 'uiauditmt07sxug';
const PASSWORD = 'uiaudit12345';
const DECK_ID = 'deck_432eb028c3e07712b8144d33';

const results = [];
const check = (name, ok, detail = '', shot = '') => {
  results.push({ name, ok, detail, shot });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${shot ? ` [${shot}]` : ''}${ok ? '' : ` — ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

const H = { 'x-anppt-action': '1', Origin: BASE };
let cookie = '';
async function api(pathname, { method = 'GET', body } = {}) {
  const headers = { ...H, cookie };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

console.log('[0] 登录复用账号', ACCOUNT);
{
  const r = await api('/api/auth/login', { method: 'POST', body: { account: ACCOUNT, password: PASSWORD } });
  check('登录 200', r.status === 200, `实际 ${r.status}`);
  if (r.status !== 200) process.exit(1);
  cookie = String(r.headers.get('set-cookie') || '').split(';')[0];
  const bal = await api('/api/credits/balance');
  console.log(`    当前余额 ${bal.json?.data?.balance}🌟`);
}

const s0 = (await api(`/api/deck/${DECK_ID}`)).json?.data;
check('deck=generated', s0.deck.status === 'generated', `实际 ${s0.deck.status}`);
const slideId = s0.slides.find((x) => x.genStatus === 'succeeded')?.slideId;

console.log('[1] 浏览器停留第 4 步，API 侧触发单页生成');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  window.__auditToasts = [];
  const scan = () => {
    document.querySelectorAll('[role="status"]').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && !window.__auditToasts.includes(t)) window.__auditToasts.push(t);
    });
  };
  const install = () =>
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
});
const [name, value] = cookie.split('=');
await ctx.addCookies([{ name, value, url: BASE }]);
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const cta = () => page.getByRole('button', { name: /生成整套页面|正在生成中|使用此风格重新生成|生成剩余 \d+ 页/ });

try {
  await page.goto(`${BASE}/deck/${DECK_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav[aria-label="生成流程"]', { timeout: 60_000 });
  // 真实点击进入「选择风格」步并停留（viewStep=3）
  await page.locator('nav[aria-label="生成流程"] button', { hasText: '选择风格' }).click();
  await cta().first().waitFor({ state: 'visible', timeout: 15_000 });
  const before = norm(await cta().first().textContent());
  console.log(`    停留时 CTA=「${before}」`);

  // 另一会话触发单页生成 → deck 进入 generating（真实扣 10🌟）
  const r = await api(`/api/deck/${DECK_ID}`, { method: 'POST', body: { action: 'generate-slide', slideId } });
  check('generate-slide 接口 202', r.status === 202, `实际 ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);

  // 本页轮询（2.5s/次）拿到 generating 后，CTA 应变为禁用「正在生成中…」
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('正在生成中')),
      null, { timeout: 20_000 },
    );
    const ctaText = norm(await cta().first().textContent());
    const ctaDisabled = await cta().first().isDisabled();
    check('b4 生成中 CTA=禁用态「正在生成中…」', ctaText === '正在生成中…' && ctaDisabled,
      `实际「${ctaText}」disabled=${ctaDisabled}`, 'b4-generating-cta-disabled.png');
  } catch {
    const all = await page.evaluate(
      () => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 30),
    );
    check('b4 生成中 CTA=禁用态「正在生成中…」', false, `20s 内未出现，当前按钮：${JSON.stringify(all)}`);
  }
  await page.screenshot({ path: path.join(OUT, 'b4-generating-cta-disabled.png') });

  console.log('  ⏳ 等单页生成完成…');
  const deadline = Date.now() + 5 * 60_000;
  let fin;
  for (;;) {
    fin = (await api(`/api/deck/${DECK_ID}`)).json?.data;
    const pending = fin.slides.some((x) => ['queued', 'running'].includes(x.genStatus));
    if (!pending && ['generated', 'partial'].includes(fin.deck.status)) break;
    if (Date.now() > deadline) break;
    await sleep(3000);
  }
  const ok = fin.slides.filter((x) => x.genStatus === 'succeeded').length;
  check('单页重生成完成，deck 回到 generated', fin.deck.status === 'generated' && ok === fin.slides.length,
    `deck=${fin.deck.status} ok=${ok}/${fin.slides.length}`);
} finally {
  const toasts = await page.evaluate(() => window.__auditToasts || []).catch(() => []);
  const BAD = /forceRegenerate|genStatus|ApiError|ApiClientError|GENERATION_|structureStatus|undefined|NaN|\[object/i;
  const bad = toasts.filter((t) => BAD.test(t));
  console.log(`    采集到 toast ${toasts.length} 条：${JSON.stringify(toasts)}`);
  check('dr 无技术术语 toast', bad.length === 0, bad.join(' | '));
  check('dr 无页面 JS 异常', consoleErrors.length === 0, consoleErrors[0] || '');
  await browser.close();
}

{
  const bal = await api('/api/credits/balance');
  console.log(`    最终余额 ${bal.json?.data?.balance}🌟`);
}

const failed = results.filter((r) => !r.ok);
console.log('\n===== b4 补测汇总 =====');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.shot ? ` [${r.shot}]` : ''}${r.ok ? '' : ` — ${r.detail}`}`);
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过');
process.exit(failed.length ? 1 : 0);
