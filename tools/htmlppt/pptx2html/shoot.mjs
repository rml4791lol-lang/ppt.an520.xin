// pptx2html/shoot.mjs —— 把 deck.html 的每一页截成 1280×720 PNG
// 用法: node shoot.mjs <deck.html> <outDir> [width] [height]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../prototype/node_modules/playwright/index.mjs';

const [htmlPath, outDir, wArg, hArg] = process.argv.slice(2);
const width = parseInt(wArg || '1280', 10);
const height = parseInt(hArg || '720', 10);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
await page.goto('file://' + path.resolve(htmlPath));
await page.waitForTimeout(400);
const n = await page.evaluate(() => document.querySelectorAll('section.slide').length);
for (let i = 0; i < n; i++) {
  await page.evaluate((idx) => {
    document.querySelectorAll('section.slide').forEach((s, j) => {
      s.style.display = j === idx ? 'block' : 'none';
      s.style.left = '0px'; s.style.top = '0px';
    });
  }, i);
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(outDir, `slide-${i + 1}.png`) });
}
await browser.close();
console.log(JSON.stringify({ slides: n, out: outDir }));
