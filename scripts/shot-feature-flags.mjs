// 截图：管理后台功能开关板 + 用户列表测试用户徽标（需 dev :3120 已跑新代码）
import { createRequire } from 'node:module';
const require = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/');
const { chromium } = require('playwright');

const SESSION = process.argv[2];
if (!SESSION) { console.error('usage: node shot-feature-flags.mjs <session-token>'); process.exit(1); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'anppt_v2_session', value: SESSION, url: 'http://localhost:3120' }]);
const page = await ctx.newPage();
await page.goto('http://localhost:3120/admin', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const flagSection = page.locator('section', { hasText: '功能开关板' }).first();
await flagSection.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await flagSection.screenshot({ path: 'output/playwright/feature-flags-board.png' });

const testerRow = page.locator('div.px-5.py-4', { hasText: '@flagtester01' }).first();
await testerRow.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await testerRow.screenshot({ path: 'output/playwright/feature-flags-tester-row.png' });

await browser.close();
console.log('saved output/playwright/feature-flags-board.png + feature-flags-tester-row.png');
