#!/usr/bin/env node
// 金奖测试包 beta 实测截图：匿名模板库（无金卡）/ 测试号模板库（有金卡+预览）/ 测试号生成结果页。
//   node scripts/shot-gold-beta.mjs
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3120';
const OUT = path.resolve(process.cwd(), 'output/gold-beta-test');
const DECK_ID = 'deck_00650cbb5e8b17f5644e64c1';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// 1) 匿名模板库：不应出现金奖测试包
const anon = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await anon.goto(`${BASE}/style-packs`, { waitUntil: 'networkidle' });
await anon.waitForTimeout(1200);
const anonGold = await anon.locator('text=金奖版式').count();
console.log('匿名模板库出现金奖卡:', anonGold);
await anon.screenshot({ path: path.join(OUT, 'ui-anon-templates.png') });
await anon.close();

// 2) 测试号（注入 curl 登录的会话 cookie）→ 模板库应出现金奖卡 → 打开预览弹窗
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await ctx.addCookies([{
  name: 'anppt_v2_session',
  value: 'sess_rqeSPg3fYwe2Px8OMj_uPEY4aLWo63_JIaDF0qgA9xM',
  domain: 'localhost',
  path: '/',
}]);
const page = await ctx.newPage();

await page.goto(`${BASE}/style-packs`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const testerGold = await page.locator('text=金奖版式').count();
console.log('测试号模板库出现金奖卡:', testerGold);
const goldCard = page.locator('div', { hasText: '金奖版式·天巡测试包' }).last();
await goldCard.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'ui-tester-templates.png') });

// 打开金奖卡预览（点封面图）
await page.getByRole('button', { name: '预览 金奖版式·天巡测试包' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, 'ui-tester-gold-preview.png') });
await page.keyboard.press('Escape');

// 3) 生成结果页
await page.goto(`${BASE}/deck/${DECK_ID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(OUT, 'ui-tester-deck-result.png'), fullPage: false });

await browser.close();
console.log('截图输出:', OUT);
