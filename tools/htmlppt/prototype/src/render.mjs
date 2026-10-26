/**
 * render.mjs — LibreOffice headless: deck.pptx -> deck.pdf -> one 1280x720 PNG per page.
 * Uses poppler pdftoppm at 96 dpi so the raster size matches the HTML canvas exactly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');
const DECK = path.join(OUT, 'deck.pptx');
const RENDER_DIR = path.join(OUT, 'render');
const PNG_DIR = path.join(OUT, 'pptx');
const SOFFICE = process.env.SOFFICE || '/opt/homebrew/bin/soffice';
const PDFTOPPM = process.env.PDFTOPPM || 'pdftoppm';
const DPI = 96;

/**
 * LibreOffice ships its own fontconfig configuration, which on macOS only covers the fonts
 * bundled inside the app. Pointing FONTCONFIG_FILE at the host fontconfig lets headless
 * soffice resolve the same system fonts Chrome uses (PingFang SC, Arial, ...).
 * Without this, every glyph falls back to Liberation/Linux Libertine + Noto Sans CJK HK
 * and the pixel diff is dominated by font substitution rather than layout.
 */
function sofficeEnv() {
  const candidates = [
    '/opt/homebrew/etc/fonts/fonts.conf',
    '/usr/local/etc/fonts/fonts.conf',
    '/etc/fonts/fonts.conf',
  ];
  const fc = candidates.find((p) => fs.existsSync(p));
  const env = { ...process.env };
  if (fc) env.FONTCONFIG_FILE = fc;
  return { env, fc };
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function main() {
  if (!fs.existsSync(DECK)) throw new Error(`missing ${DECK}; run convert + postprocess first`);
  fs.rmSync(RENDER_DIR, { recursive: true, force: true });
  fs.mkdirSync(RENDER_DIR, { recursive: true });
  fs.rmSync(PNG_DIR, { recursive: true, force: true });
  fs.mkdirSync(PNG_DIR, { recursive: true });

  const t0 = Date.now();
  const { env: loEnv, fc: fontConfig } = sofficeEnv();
  // NB: LibreOffice chokes on profile URLs with spaces, so keep the profile in /tmp
  const profile = path.join(os.tmpdir(), 'dsh_lo_profile_proto');
  fs.rmSync(profile, { recursive: true, force: true });
  execFileSync(
    SOFFICE,
    [
      '--headless',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=file://${profile}`,
      '--convert-to',
      'pdf',
      '--outdir',
      RENDER_DIR,
      DECK,
    ],
    { timeout: 240000, stdio: 'pipe', env: loEnv },
  );
  const pdf = path.join(RENDER_DIR, 'deck.pdf');
  if (!fs.existsSync(pdf)) throw new Error('soffice produced no PDF');
  const pdfInfo = fs.statSync(pdf);

  // LibreOffice writes pages a hair wider than 960pt (960.009), which makes plain -r 96
  // produce 1281x720. -scale-to-x/y pins the raster to the HTML canvas exactly.
  execFileSync(
    PDFTOPPM,
    ['-png', '-scale-to-x', '1280', '-scale-to-y', '720', pdf, path.join(PNG_DIR, 'slide')],
    { timeout: 120000 },
  );

  // normalise planted names (pdftoppm may zero-pad: slide-1.png / slide-01.png)
  const files = fs.readdirSync(PNG_DIR).filter((f) => /^slide-\d+\.png$/.test(f));
  files.sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const pages = [];
  files.forEach((f, i) => {
    const src = path.join(PNG_DIR, f);
    const dst = path.join(PNG_DIR, `slide-${i + 1}.png`);
    if (src !== dst) {
      fs.renameSync(src, dst);
      const stale = files[i];
      void stale;
    }
    const { w, h } = pngSize(dst);
    pages.push({ index: i + 1, file: path.relative(ROOT, dst), width: w, height: h });
  });

  let pdfFonts = '';
  try {
    pdfFonts = execFileSync('pdffonts', [pdf], { encoding: 'utf8' });
  } catch {
    pdfFonts = '(pdffonts unavailable)';
  }
  fs.writeFileSync(path.join(OUT, 'render_fonts.txt'), pdfFonts);

  const report = {
    engine: 'LibreOffice + pdftoppm',
    fontConfig: fontConfig || '(LibreOffice bundled default)',
    embeddedFonts: pdfFonts
      .split('\n')
      .slice(2)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean),
    soffice: execFileSync(SOFFICE, ['--version'], { encoding: 'utf8' }).trim(),
    dpi: DPI,
    pdfBytes: pdfInfo.size,
    pages,
    elapsedMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(OUT, 'render.json'), JSON.stringify(report, null, 1));
  console.log(
    `[render] ${pages.length} page(s) @${DPI}dpi ` +
      pages.map((p) => `${p.width}x${p.height}`).join(',') +
      ` pdf=${(pdfInfo.size / 1024).toFixed(0)}KiB in ${Date.now() - t0}ms`,
  );
}

try {
  main();
} catch (err) {
  console.error('[render] FAILED', err);
  process.exit(1);
}
