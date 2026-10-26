#!/usr/bin/env node
// 模块 4 验收截图：模板页两 tab + 三维筛选交互。需先起 dev（默认 3120）。
//   node scripts/shot-style-packs.mjs
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3120';
const OUT = path.resolve(process.cwd(), 'output/ui-audit');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

await page.goto(`${BASE}/style-packs`, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(OUT, 'm4-template-tab.png'), fullPage: false });
console.log('默认 tab 模板数量:', await page.locator('text=使用模板').count());

// 三维筛选：选颜色「蓝」
await page.getByRole('button', { name: '蓝', exact: true }).click();
await page.waitForTimeout(300);
console.log('选蓝后模板数量:', await page.locator('text=使用模板').count());
await page.screenshot({ path: path.join(OUT, 'm4-template-filter-blue.png') });
await page.getByRole('button', { name: '蓝', exact: true }).click();

// 赛道二级导航
const trackChip = page.getByRole('button', { name: '装备制造', exact: true });
if (await trackChip.count()) {
  await trackChip.click();
  await page.waitForTimeout(300);
  console.log('选装备制造后数量:', await page.locator('text=使用模板').count());
  await page.screenshot({ path: path.join(OUT, 'm4-template-track.png') });
  await trackChip.click();
}

// 预览弹层翻页
await page.getByRole('button', { name: '预览' }).first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'm4-template-preview.png') });
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');

// 风格一版回归
await page.getByRole('button', { name: '风格一版', exact: true }).click();
await page.waitForTimeout(400);
console.log('风格一版卡片数:', await page.locator('text=使用此风格').count());
await page.screenshot({ path: path.join(OUT, 'm4-style-tab.png') });

await browser.close();
console.log('截图输出:', OUT);
