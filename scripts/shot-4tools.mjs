// SlideEditor 4 工具 UI 截图：测试号 → deck → 单页编辑器 → 工具区 + 涂抹模式
import { createRequire } from 'module';
const { chromium } = createRequire('/Users/an/Documents/AI PPT/anppt-app/node_modules/')('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addCookies([{ name: 'anppt_v2_session', value: 'sess_WDsTzq7YmqWIztpyH7S4E3nYZXTayT2awTTZlHp3j_4', domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:3120/deck/deck_00650cbb5e8b17f5644e64c1', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 打开第 2 页单页编辑器
  await page.locator('[title*="打开单页编辑器"]').nth(1).click();
  await page.locator('[aria-label^="单页编辑器"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'output/gold-beta-test/4tools-editor.png' });

  // 进入涂抹模式
  const eraseBtn = page.locator('[aria-label^="单页编辑器"] button:has-text("高精清除")');
  if (await eraseBtn.count()) {
    await eraseBtn.first().click();
    await page.waitForTimeout(800);
    // 在 canvas 上抹两笔
    const canvas = page.locator('[aria-label^="单页编辑器"] canvas');
    if (await canvas.count()) {
      const box = await canvas.first().boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.85);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.85, { steps: 12 });
        await page.mouse.up();
      }
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'output/gold-beta-test/4tools-erase-mode.png' });
  } else {
    console.log('ERASE BUTTON NOT FOUND');
  }
  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
