#!/usr/bin/env node
// 探针 3：检查 disabled 按钮的 React fiber props 与原生事件链路。用完即弃。
import { createRequire } from 'node:module';
const require = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/');
const { chromium } = require('playwright');

const BASE = 'https://ppt.an520.xin';
const H = { 'x-anppt-action': '1', Origin: BASE, 'Content-Type': 'application/json' };
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ account: 'uiauditmt07sxug', password: 'uiaudit12345' }),
});
const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
const [name, value] = cookie.split('=');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name, value, url: BASE }]);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => console.log('PAGE LOG:', m.text()));

await page.goto(`${BASE}/deck/deck_432eb028c3e07712b8144d33`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav[aria-label="生成流程"]', { timeout: 30_000 });
await page.waitForTimeout(2000);

const r = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('nav[aria-label="生成流程"] button')];
  const b0 = btns.find((x) => x.textContent.includes('上传内容'));
  const b3 = btns.find((x) => x.textContent.includes('选择风格'));
  const propsOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    const p = key ? el[key] : null;
    return p ? { hasOnClick: typeof p.onClick === 'function', disabledProp: p.disabled } : null;
  };
  // 原生链路：直接 addEventListener 验证 click 事件本身能否到达
  window.__clicks = { b0: 0, b3: 0 };
  b0.addEventListener('click', () => { window.__clicks.b0 += 1; });
  b3.addEventListener('click', () => { window.__clicks.b3 += 1; });
  const r0 = b0.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const r3 = b3.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return {
    b0Props: propsOf(b0),
    b3Props: propsOf(b3),
    dispatchReturn: { r0, r3 },
    nativeClicks: window.__clicks,
  };
});
console.log(JSON.stringify(r, null, 2));
await page.waitForTimeout(500);
const main = await page.evaluate(() => (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').slice(0, 40));
console.log('dispatch 双按钮后 main:', main); // b3 的 dispatch 若生效应切到选择风格

// 再验证：disabled 按钮上去掉 disabled 后，React 的 onClick 是否随之可用
const r2 = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('nav[aria-label="生成流程"] button')];
  const b0 = btns.find((x) => x.textContent.includes('上传内容'));
  b0.disabled = false;
  b0.click(); // el.click on now-enabled
  return { clicks: window.__clicks };
});
await page.waitForTimeout(500);
const main2 = await page.evaluate(() => (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').slice(0, 40));
console.log('b0 去 disabled + el.click 后:', JSON.stringify(r2), 'main:', main2);

await browser.close();
