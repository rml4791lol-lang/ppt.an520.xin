#!/usr/bin/env node
// 风格一版预览弹窗验收：点封面/预览按钮 → 弹窗翻页。需先起 dev（默认 3120）。
//   node scripts/shot-style-preview.mjs
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
await page.getByRole('button', { name: '风格一版', exact: true }).click();
await page.waitForTimeout(500);
const cardCount = await page.locator('text=使用此风格').count();
const previewBtnCount = await page.getByRole('button', { name: '预览', exact: true }).count();
console.log('风格卡数量:', cardCount, '预览按钮数量:', previewBtnCount);

// 点封面图打开预览
await page.getByRole('button', { name: /^预览 / }).first().click();
await page.waitForTimeout(600);
console.log('弹窗出现:', await page.locator('[role="dialog"]').count());
await page.screenshot({ path: path.join(OUT, 'style-preview-p1.png') });

// 翻页到第 2 页
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'style-preview-p2.png') });
console.log('翻页后页码文本:', await page.locator('[role="dialog"] span').last().textContent());

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
console.log('ESC 后弹窗数:', await page.locator('[role="dialog"]').count());

await browser.close();
console.log('截图输出:', OUT);
