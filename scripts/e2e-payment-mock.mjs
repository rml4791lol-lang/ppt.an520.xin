#!/usr/bin/env node
// 充值扫码面板 UI 冒烟（mock 支付全链路）：注册 → 下单 → 二维码面板 → mock 回调 → 到账。
// 依赖本机 Playwright（默认借 anppt-app 的 node_modules，可用 PLAYWRIGHT_DEPS 覆盖）：
//   PLAYWRIGHT_DEPS="/Users/an/Documents/AI PPT/anppt-app/node_modules" \
//   BASE_URL=http://127.0.0.1:3000 node scripts/e2e-payment-mock.mjs
// 截图输出到 scripts/output/payment-*.png。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const DEPS = process.env.PLAYWRIGHT_DEPS || '/Users/an/Documents/AI PPT/anppt-app/node_modules';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.resolve(process.cwd(), 'scripts/output');
mkdirSync(OUT, { recursive: true });

const require = createRequire(path.join(DEPS, 'package.json'));
const { chromium } = require('playwright');

const H = { 'Content-Type': 'application/json', 'x-anppt-action': '1' };
const account = `payui${Date.now().toString(36)}`;

async function api(pathname, body, cookie) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: cookie ? { ...H, cookie } : H,
    body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

// 1. API 注册拿 session cookie
const reg = await api('/api/auth/register', {
  account, password: 'password123', confirmPassword: 'password123',
});
check('注册 201', reg.res.status === 201, `实际 ${reg.res.status}`);
const cookie = String(reg.setCookie || '').split(';')[0];
check('拿到 session cookie', cookie.startsWith('anppt_v2_session='));

// 2. 浏览器带 cookie 进充值页下单
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [name, rawValue] = cookie.split('=');
  await ctx.addCookies([{ name, value: decodeURIComponent(rawValue), url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/recharge`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: '立即购买' }).first().click();
  await page.waitForSelector('text=微信扫码支付', { timeout: 8000 });
  check('支付面板出现（微信扫码）', true);
  await page.waitForSelector('img[alt="支付二维码"]', { timeout: 8000 });
  check('二维码图片渲染', true);
  await page.screenshot({ path: path.join(OUT, 'payment-qr.png') });

  // 3. mock 回调 → 面板应变「支付成功」
  const orderNoText = await page.locator('text=订单号').textContent();
  const orderNo = (orderNoText || '').replace('订单号', '').trim();
  check('面板露出订单号', orderNo.length > 8, orderNoText || '');
  const notify = await fetch(`${BASE}/api/recharge/notify/wechat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mock: true, out_trade_no: orderNo, amount: { total: 990, currency: 'CNY' } }),
  });
  check('mock 回调被接受', notify.status === 200, `实际 ${notify.status}`);
  await page.getByRole('heading', { name: '支付成功', exact: true }).waitFor({ timeout: 10000 });
  check('轮询捕获到账（支付成功面板）', true);
  await page.waitForTimeout(1200); // 等 router.refresh() 刷新区头积分
  await page.screenshot({ path: path.join(OUT, 'payment-success.png') });
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
