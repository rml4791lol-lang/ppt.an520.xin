/**
 * fontprobe.mjs — is the serif fallback our bug or a LibreOffice-side limitation?
 *
 * For each candidate font we render the same string in Chrome and in a PptxGenJS deck,
 * then compare the rendered ink width (px) and list the fonts LibreOffice actually embeds
 * in the PDF. This turns "looks different" into numbers.
 *
 * Output: out/fontprobe/{html.png, pptx.png, pdf_fonts.txt} + out/font_matrix.json
 */
import { chromium } from 'playwright';
import PptxGenJS from 'pptxgenjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');
const DIR = path.join(OUT, 'fontprobe');
const SOFFICE = process.env.SOFFICE || '/opt/homebrew/bin/soffice';

/** same host-fontconfig trick as render.mjs: without it LO only sees its bundled fonts */
function sofficeEnv() {
  const candidates = ['/opt/homebrew/etc/fonts/fonts.conf', '/usr/local/etc/fonts/fonts.conf', '/etc/fonts/fonts.conf'];
  const fc = candidates.find((p) => fs.existsSync(p));
  const env = { ...process.env };
  if (fc) env.FONTCONFIG_FILE = fc;
  return { env, fc };
}

const FONTS = ['PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Noto Sans SC', 'Arial', 'Helvetica Neue', 'Songti SC'];
const TEXT = 'HTML 幻灯片 AaBb 0123 → 90% 覆盖率';
// controls: same font, pure-Latin and pure-CJK strings. If these match (Δ≈0) but the mixed
// string is wider, the residual width difference is LibreOffice's CJK/Latin auto-spacing,
// not font substitution.
const CONTROLS = [
  { font: 'PingFang SC', text: 'HTML AaBb 0123 90%', label: 'control-latin' },
  { font: 'PingFang SC', text: '幻灯片覆盖率', label: 'control-cjk' },
];
const FONT_PX = 30;
const ROW_GAP = 66;
const TOP = 40;
const X = 40;

function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const rows = [
    ...FONTS.map((font, i) => ({ font, text: TEXT, label: font, index: i, x: X, y: TOP + i * ROW_GAP, fontSizePx: FONT_PX })),
    ...CONTROLS.map((c, j) => ({
      ...c,
      index: FONTS.length + j,
      x: X,
      y: TOP + (FONTS.length + j) * ROW_GAP,
      fontSizePx: FONT_PX,
    })),
  ];

  // ---------- 1) Chrome: measure + screenshot ----------
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:1280px;height:720px;background:#FFFFFF;overflow:hidden}
    body{font-family:"PingFang SC";-webkit-font-smoothing:antialiased}
    .row{position:absolute;left:${X}px;height:40px;font-size:${FONT_PX}px;line-height:40px;white-space:nowrap;color:#111111}
  </style></head><body>
  ${rows
    .map(
      (r) =>
        `<div class="row" data-row="${r.index}" style="top:${r.y}px;font-family:'${r.font}';">${r.text}</div>`,
    )
    .join('\n')}
  </body></html>`;
  const htmlPath = path.join(DIR, 'probe.html');
  fs.writeFileSync(htmlPath, html);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const chrome = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.row').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({
        index: Number(el.dataset.row),
        width: r.width,
        fontFamily: cs.fontFamily,
      });
    });
    return out;
  });
  await page.screenshot({ path: path.join(DIR, 'html.png'), clip: { x: 0, y: 0, width: 1280, height: 720 } });
  await browser.close();

  // ---------- 2) PptxGenJS deck with the same rows ----------
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'P', width: 1280 / 96, height: 720 / 96 });
  pptx.layout = 'P';
  const slide = pptx.addSlide();
  for (const r of rows) {
    slide.addText(r.text, {
      x: X / 96,
      y: r.y / 96,
      w: 1200 / 96,
      h: 40 / 96,
      margin: 0,
      fit: 'none',
      wrap: false,
      valign: 'top',
      fontFace: r.font,
      fontSize: (FONT_PX * 0.75).toFixed(2) * 1,
      color: '111111',
      isTextBox: true,
    });
  }
  const pptxPath = path.join(DIR, 'probe.pptx');
  await pptx.writeFile({ fileName: pptxPath });

  // ---------- 3) LibreOffice render ----------
  const { env: loEnv, fc: fontConfig } = sofficeEnv();
  const profile = path.join(os.tmpdir(), 'dsh_lo_profile_fontprobe');
  fs.rmSync(profile, { recursive: true, force: true });
  execFileSync(
    SOFFICE,
    ['--headless', '--norestore', '-env:UserInstallation=file://' + profile, '--convert-to', 'pdf', '--outdir', DIR, pptxPath],
    { timeout: 180000, stdio: 'pipe', env: loEnv },
  );
  execFileSync(
    'pdftoppm',
    ['-png', '-scale-to-x', '1280', '-scale-to-y', '720', path.join(DIR, 'probe.pdf'), path.join(DIR, 'pptx')],
    { timeout: 120000 },
  );
  const rendered = path.join(DIR, 'pptx-1.png');
  if (!fs.existsSync(rendered)) throw new Error('fontprobe render missing');

  let pdfFonts = '';
  try {
    pdfFonts = execFileSync('pdffonts', [path.join(DIR, 'probe.pdf')], { encoding: 'utf8' });
  } catch {
    pdfFonts = '(pdffonts unavailable)';
  }
  fs.writeFileSync(path.join(DIR, 'pdf_fonts.txt'), pdfFonts);

  // ---------- 4) ink width comparison (Pillow) ----------
  const analysisPy = path.join(__dirname, 'ink_widths.py');
  const bands = JSON.stringify(rows.map((r) => ({ index: r.index, y0: r.y - 8, y1: r.y + 46 })));
  const outJson = execFileSync(
    process.env.PYTHON || '/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python',
    [analysisPy, path.join(DIR, 'html.png'), rendered, bands],
    { encoding: 'utf8' },
  );
  const ink = JSON.parse(outJson);

  const matrix = rows.map((r) => {
    const c = chrome.find((x) => x.index === r.index) || {};
    const p = ink.find((x) => x.index === r.index) || {};
    const delta = p.inkWidth && c.width ? p.inkWidth - c.width : null;
    return {
      label: r.label,
      text: r.text,
      font: r.font,
      chromeRequestedFamily: (c.fontFamily || '').split(',')[0],
      chromeWidthPx: c.width ? Math.round(c.width) : null,
      pptxInkWidthPx: p.inkWidth ?? null,
      deltaPx: delta === null ? null : Math.round(delta),
      deltaPct: delta === null ? null : Math.round((delta / c.width) * 1000) / 10,
      htmlInkWidthPx: p.htmlInkWidth ?? null,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    text: TEXT,
    fontSizePx: FONT_PX,
    fontConfig: fontConfig || '(LibreOffice bundled default)',
    note: 'chromeWidthPx = layout width of the <div> (nowrap text). pptxInkWidthPx = ink run width measured from the LibreOffice render; htmlInkWidthPx from the Chrome screenshot.',
    fonts: matrix,
    spacingHypothesis: {
      boundariesInMixedText: 3,
      note: 'mixed sample has 3 CJK<->Latin boundaries; LO adds ~0.25em per boundary = 7.5px @30px = 22.5px total',
      expectedInflationPx: 22.5,
    },
    pdfFonts,
    artifacts: {
      html: path.relative(ROOT, path.join(DIR, 'html.png')),
      pptx: path.relative(ROOT, path.join(DIR, 'pptx-1.png')),
    },
  };
  fs.writeFileSync(path.join(OUT, 'font_matrix.json'), JSON.stringify(report, null, 1));
  console.log(
    '[fontprobe] ' +
      matrix
        .map((m) => `${m.label}: html=${m.htmlInkWidthPx}px pptx=${m.pptxInkWidthPx}px Δ=${m.deltaPx}px`)
        .join(' | '),
  );
  console.log('[fontprobe] embedded pdf fonts: ' + pdfFonts.split('\n').slice(2, 8).map((l) => l.split(' ')[0]).join(', '));
}

main().catch((err) => {
  console.error('[fontprobe] FAILED', err);
  process.exit(1);
});
