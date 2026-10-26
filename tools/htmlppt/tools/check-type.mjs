// check-type.mjs —— 检查"18pt（24px）以上大字"的可读性与底图规则
//
// 规则（对应"所有字体 >18pt"）：
//   1) 所有文字 font-size 必须 > 18pt（=24px），即 ≥25px；否则 FAIL
//   2) font-size ≥ 24px：与背后实际像素的对比度 ≥ 3:1（WCAG 大字号门槛）
//   3) 若背后是生成底图（.bg / .bg-gen / img 覆盖）：必须有 scrim（遮挡层）且对比度仍 ≥3:1
//
// 用法：node tools/check-type.mjs <html路径|file://|http://> [--json]
import { chromium } from '/Users/an/Desktop/Atlas/PPT/HTML -ppt/prototype/node_modules/playwright/index.mjs';
import path from 'node:path';

const target = process.argv[2];
if (!target) { console.error('usage: node tools/check-type.mjs <html>'); process.exit(2); }
const url = /^(file|http)/.test(target) ? target : 'file://' + path.resolve(target);
const asJson = process.argv.includes('--json');

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);

const info = await p.evaluate(() => {
  const toRgb = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1].split(',').map(Number);
    return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t) continue;
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const fs = parseFloat(cs.fontSize);
    if (!fs) continue;
    const sec = el.closest('section, .slide');
    const secsAll = [...document.querySelectorAll('section.slide, section')];
    const secIdx = sec ? secsAll.indexOf(sec) : -1;
    const sr = sec ? sec.getBoundingClientRect() : { left: 0, top: 0 };
    // 文字是否真的压在页级大图（img 面积 ≥ 页面 30%）之上：按矩形相交判断
    let hasImageBg = false;
    let hasScrim = !!(sec && sec.querySelector('.scrim, .hero-scrim, .duo, .grad, .veil, [data-scrim]'));
    if (sec) {
      const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      for (const im of sec.querySelectorAll('img')) {
        const ir = im.getBoundingClientRect();
        if (ir.width * ir.height >= 1280 * 720 * 0.3 && overlap(ir, r) > 0.2 * r.width * r.height) {
          hasImageBg = true; break;
        }
      }
    }
    let cur = el;
    while (cur && cur !== document.body) {
      const st = getComputedStyle(cur);
      const clipText = st.backgroundClip === 'text' || st.webkitBackgroundClip === 'text';
      if (!clipText && cur.tagName === 'IMG') hasImageBg = true;
      if (cur.classList && (cur.classList.contains('scrim') || cur.dataset.scrim === '1')) hasScrim = true;
      cur = cur.parentElement;
    }
    out.push({
      text: t.slice(0, 36),
      cls: (el.className || '').toString().slice(0, 40),
      sizePx: +fs.toFixed(1),
      color: toRgb(cs.color),
      x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, secIdx,
      hasImageBg, hasScrim,
      page: sec ? sec.id || sec.getAttribute('data-page') || '' : '',
    });
  }
  return out;
});

// 背景图：把文字变透明后截一张，用于采样"背后真实像素"
await p.addStyleTag({ content: 'body,body *:not(img){color:transparent !important;text-shadow:none !important}' });
await p.waitForTimeout(200);
const secs = await p.locator('section.slide, section').all();
const shots = [];
for (const sec of secs) shots.push((await sec.screenshot()).toString('base64'));
await b.close();

// 在浏览器里解码背景截图并采样（不依赖 sharp）
const b2 = await chromium.launch({ channel: 'chrome', headless: true });
const p2 = await b2.newPage();
await p2.setContent('<!doctype html><html><body></body></html>');
const rects = info.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h, secIdx: t.secIdx }));
const sampled = await p2.evaluate(async ({ shots, rects }) => {
  const imgs = [];
  for (const b64 of shots) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    imgs.push(img);
  }
  const out = [];
  for (const r of rects) {
    const img = imgs[r.secIdx] || imgs[0];
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(img.width - 1, Math.ceil(r.x + r.w)), y1 = Math.min(img.height - 1, Math.ceil(r.y + r.h));
    const data = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
    let R = 0, G = 0, B = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) { R += data[i]; G += data[i + 1]; B += data[i + 2]; n++; }
    out.push(n ? { r: R / n, g: G / n, b: B / n } : { r: 0, g: 0, b: 0 });
  }
  return out;
}, { shots, rects });
await b2.close();

const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const results = info.map((t, i) => {
  const bg = sampled[i];
  const fg = t.color || { r: 255, g: 255, b: 255 };
  return { ...t, bg, contrast: +contrast(fg, bg).toFixed(2) };
});

const MIN_FONT_PX = 25;  // >18pt
const large = results.filter((r) => r.sizePx >= MIN_FONT_PX);
const small = results.filter((r) => r.sizePx < MIN_FONT_PX);
const largeFail = large.filter((r) => r.contrast < 3);
const smallFail = small.filter((r) => r.contrast < 4.5);
const imageLarge = large.filter((r) => r.hasImageBg);
const imageNoScrim = imageLarge.filter((r) => !r.hasScrim);

const payload = {
  file: url,
  checks: {
    minFontPx: MIN_FONT_PX,
    minFontRule: '>18pt (25px)',
    fontsBelowMin: small.length,
    minSizePx: results.length ? Math.min(...results.map((r) => r.sizePx)) : null,
    largeTextThresholdPx: MIN_FONT_PX,
    large: large.length, largeFail: largeFail.length,
    small: small.length, smallFail: smallFail.length,
    largeOverImage: imageLarge.length, largeOverImageMissingScrim: imageNoScrim.length,
    minLargeContrast: large.length ? Math.min(...large.map((r) => r.contrast)) : null,
    minSmallContrast: small.length ? Math.min(...small.map((r) => r.contrast)) : null,
  },
  largeFail: largeFail.map((r) => ({ text: r.text, cls: r.cls, sizePx: r.sizePx, contrast: r.contrast, bg: r.bg })),
  smallFail: smallFail.map((r) => ({ text: r.text, cls: r.cls, sizePx: r.sizePx, contrast: r.contrast })),
  imageNoScrim: imageNoScrim.map((r) => ({ text: r.text, sizePx: r.sizePx, contrast: r.contrast })),
  fontFail: small.map((r) => ({ text: r.text, cls: r.cls, sizePx: r.sizePx })),
  ok: largeFail.length === 0 && smallFail.length === 0 && imageNoScrim.length === 0,
};
if (asJson) console.log(JSON.stringify(payload, null, 1));
else {
  console.log(`${payload.ok ? 'PASS' : 'FAIL'} · 最小字号 ${payload.checks.minSizePx}px（规则 >18pt=25px，违规 ${small.length}）· 大字 ${large.length}（对比度失败 ${largeFail.length}，最低 ${payload.checks.minLargeContrast}）· 压图大字 ${imageLarge.length}（缺 scrim ${imageNoScrim.length}）`);
  for (const f of small) console.log(`  ✘ 字号不足 ${f.sizePx}px「${f.text}」`);
  for (const f of largeFail) console.log(`  ✘ 大字 ${f.sizePx}px「${f.text}」对比度 ${f.contrast} < 3`);
  for (const f of smallFail) console.log(`  ✘ 小字 ${f.sizePx}px「${f.text}」对比度 ${f.contrast} < 4.5`);
  for (const f of imageNoScrim) console.log(`  ✘ 压图无 scrim「${f.text}」`);
}
process.exit(payload.ok ? 0 : 1);
