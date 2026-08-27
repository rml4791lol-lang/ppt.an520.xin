#!/usr/bin/env node
// 单页编辑器验收截图：登录 → 打开 deck 生成画布 → 点开单页编辑器（大图+微调+重生成+版本+下载）。
// 只截图与输入指令文本，不提交任何扣费动作。需 dev 在 3120 跑着：
//   node scripts/shot-slide-editor.mjs
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3120';
const DECK_ID = process.env.DECK_ID || 'deck_e7f3ef22ddb8c35f64faa05a';
const ACCOUNT = process.env.DECK_ACCOUNT || 'm5deckbmt4a433p';
const OUT = path.resolve(process.cwd(), 'output/ui-audit');
mkdirSync(OUT, { recursive: true });

// 登录拿 cookie（与 m5-resume 同口径）
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-anppt-action': '1' },
  body: JSON.stringify({ account: ACCOUNT, password: 'password123' }),
});
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookieValue = String(login.headers.get('set-cookie') || '').split(';')[0];
const [cookieName, cookieVal] = cookieValue.split('=');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await ctx.addCookies([{ name: cookieName, value: cookieVal, url: BASE }]);
const page = await ctx.newPage();

await page.goto(`${BASE}/deck/${DECK_ID}`, { waitUntil: 'networkidle' });
// 若不在生成页步，点步骤导航
const canvasHeading = page.getByRole('heading', { name: /生成画布/ });
if ((await canvasHeading.count()) === 0) {
  await page.getByRole('button', { name: '生成页面' }).click();
  await page.waitForTimeout(800);
}
await page.locator('article button[title="点击放大查看"]').first().waitFor({ timeout: 15000 });
await page.screenshot({ path: path.join(OUT, 'm6-canvas-grid.png') });

// 1) 点缩略图打开编辑器
await page.locator('article button[title="点击放大查看"]').first().click();
const editor = page.getByRole('dialog', { name: /单页编辑器/ });
await editor.waitFor({ timeout: 5000 });
await page.waitForTimeout(600);
console.log('编辑器打开: OK | 微调按钮:', await editor.getByRole('button', { name: /微调本页/ }).count(),
  '| 重生成按钮:', await editor.getByRole('button', { name: /重新生成/ }).count(),
  '| 下载原图:', await editor.getByRole('link', { name: /下载原图/ }).count(),
  '| 版本数:', await editor.locator('text=本页版本').count());
await page.screenshot({ path: path.join(OUT, 'm6-slide-editor.png') });

// 2) 输入微调指令（不提交），按钮应从禁用变可用
await editor.locator('textarea').fill('把标题再放大一些，整体色调更亮');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, 'm6-slide-editor-instruction.png') });
const refineBtn = editor.getByRole('button', { name: /微调本页/ });
console.log('输入指令后微调按钮可用:', await refineBtn.isEnabled());

// 3) ESC 退出，再从「优化本页」按钮进入（同一编辑器）
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.getByRole('button', { name: /优化本页/ }).first().click();
await editor.waitFor({ timeout: 5000 });
console.log('优化本页入口复开: OK');
await page.keyboard.press('Escape');

await browser.close();
console.log('截图输出:', OUT);
