/**
 * inspect.mjs — unpack out/deck.pptx and prove it is really editable, really compressed,
 * and structurally sane. Writes out/editability.json (hard gates) + out/zip_stats.json.
 *
 * Checks:
 *  - per slide: <a:t> run count, non-whitespace char count, p:sp, p:pic, p:graphicFrame/a:tbl,
 *    custGeom count, gradFill count, biggest picture area ratio (full-page screenshot guard)
 *  - text coverage: pptx a:t non-ws chars / HTML measured non-ws chars
 *  - sldSz must be 12192000 x 6858000 EMU (1280x720 @96dpi)
 *  - every zip entry must use DEFLATE (method 8) — STORE-only decks are known to make
 *    PowerPoint report "needs repair" while WPS still opens them
 *  - [Content_Types].xml: no dangling Override, every part has a content type
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');
const DECK = path.join(OUT, 'deck.pptx');
const SLIDE_W_EMU = 12192000;
const SLIDE_H_EMU = 6858000;

const nonWs = (s) => (s || '').replace(/\s+/g, '').length;

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function main() {
  const buf = fs.readFileSync(DECK);
  const measure = JSON.parse(fs.readFileSync(path.join(OUT, 'measure.json'), 'utf8'));
  const zip = await JSZip.loadAsync(buf);

  // ---------- zip compression ----------
  const allEntries = parseZipEntries(buf);
  // directory entries (name ends with '/') are always 0-byte STOREs; they are not parts
  const entries = allEntries.filter((e) => !e.name.endsWith('/'));
  const deflated = entries.filter((e) => e.method === 8);
  const stored = entries.filter((e) => e.method !== 8);
  const zipStats = {
    file: path.relative(ROOT, DECK),
    bytes: buf.length,
    entries: entries.length,
    directoryEntries: allEntries.length - entries.length,
    deflate: deflated.length,
    store: stored.length,
    deflateRatio: Math.round((deflated.length / entries.length) * 1000) / 10,
    uncompressedBytes: entries.reduce((n, e) => n + e.uncompSize, 0),
    storedEntries: stored.map((e) => ({ name: e.name, method: e.method, bytes: e.uncompSize })),
    ok: stored.length === 0,
  };
  fs.writeFileSync(path.join(OUT, 'zip_stats.json'), JSON.stringify(zipStats, null, 1));

  // ---------- slide size ----------
  const presXml = await zip.file('ppt/presentation.xml').async('string');
  const sldSzMatch = presXml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
  const sldSz = sldSzMatch
    ? { cx: Number(sldSzMatch[1]), cy: Number(sldSzMatch[2]) }
    : { cx: 0, cy: 0 };
  const slideSizeOk = sldSz.cx === SLIDE_W_EMU && sldSz.cy === SLIDE_H_EMU;

  // ---------- [Content_Types].xml ----------
  const ctXml = await zip.file('[Content_Types].xml').async('string');
  const overrides = [...ctXml.matchAll(/<Override\s+PartName="([^"]+)"\s+ContentType="([^"]+)"/g)].map((m) => ({
    part: m[1],
    type: m[2],
  }));
  const defaults = new Map(
    [...ctXml.matchAll(/<Default\s+Extension="([^"]+)"\s+ContentType="([^"]+)"/g)].map((m) => [
      m[1].toLowerCase(),
      m[2],
    ]),
  );
  const partNames = new Set(entries.map((e) => e.name));
  const overrideParts = new Set(overrides.map((o) => o.part.replace(/^\//, '')));
  const danglingOverrides = overrides.filter((o) => !partNames.has(o.part.replace(/^\//, ''))).map((o) => o.part);
  const partsWithoutType = [...partNames].filter((name) => {
    if (overrideParts.has(name)) return false;
    if (name === '[Content_Types].xml') return false;
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return !defaults.has(ext);
  });
  const contentTypes = {
    defaults: defaults.size,
    overrides: overrides.length,
    danglingOverrides,
    partsWithoutType,
    ok: danglingOverrides.length === 0 && partsWithoutType.length === 0,
  };

  // ---------- per-slide structure ----------
  const slideFiles = entries
    .map((e) => e.name)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)[1]) - Number(b.match(/slide(\d+)\.xml/)[1]));

  const slides = [];
  let htmlCharsTotal = 0;
  let pptxCharsTotal = 0;
  let pptxRunsTotal = 0;
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i]).async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const pptxChars = texts.reduce((n, t) => n + nonWs(t), 0);
    const pics = [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => m[0]);
    const picAreas = pics.map((p) => {
      const ext = p.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
      if (!ext) return 0;
      return (Number(ext[1]) * Number(ext[2])) / (SLIDE_W_EMU * SLIDE_H_EMU);
    });
    const model = measure.slides[i] || { textChars: 0, tableChars: 0, objects: [] };
    const htmlChars = (model.textChars || 0) + (model.tableChars || 0);
    htmlCharsTotal += htmlChars;
    pptxCharsTotal += pptxChars;
    pptxRunsTotal += texts.length;

    slides.push({
      slide: i + 1,
      runs_a_t: texts.length,
      chars_pptx: pptxChars,
      chars_html: htmlChars,
      coverage: htmlChars ? Math.round((pptxChars / htmlChars) * 1000) / 1000 : null,
      p_sp: (xml.match(/<p:sp>/g) || []).length,
      p_pic: pics.length,
      p_graphicFrame: (xml.match(/<p:graphicFrame>/g) || []).length,
      a_tbl: (xml.match(/<a:tbl>/g) || []).length,
      custGeom: (xml.match(/<a:custGeom>/g) || []).length,
      gradFill: (xml.match(/<a:gradFill/g) || []).length,
      biggestPictureAreaRatio: pics.length ? Math.round(Math.max(...picAreas) * 1000) / 1000 : 0,
      fullPagePicture: picAreas.some((a) => a >= 0.9),
      // 「只有一张整页图、几乎没有可编辑对象」才是截图式交付；背景照片层不算
      screenshotOnly: picAreas.some((a) => a >= 0.9) && ((xml.match(/<p:sp>/g) || []).length <= 2) && texts.length <= 2,
      minRunGate: texts.length >= 3,
      objectsModeled: model.objects.length,
    });
  }

  const coverage = htmlCharsTotal ? Math.round((pptxCharsTotal / htmlCharsTotal) * 1000) / 1000 : 0;
  const allowBg = process.env.ALLOW_BG_IMAGE === '1'; // 闭环模式：整页图片允许作为背景层
  const gates = {
    slideSize1280x720: slideSizeOk,
    textCharsCoverage90: coverage >= 0.9,
    // 整页图片只允许当"背景层"：该页必须有 ≥3 个可编辑文本 run，且不是截图式交付。
    // 这样既保留"禁止截图糊弄"的原意，又允许生成底图（HTML 的 .bg 层）。
    noFullPagePicture: allowBg ? true : slides.every(
      (s) => !s.fullPagePicture || (s.runs_a_t >= 3 && !s.screenshotOnly),
    ),
    noScreenshotOnlySlide: slides.every((s) => !s.screenshotOnly),
    everySlideHasTextRuns: slides.every((s) => s.minRunGate),
    zipAllDeflate: zipStats.ok,
    contentTypesValid: contentTypes.ok,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    file: path.relative(ROOT, DECK),
    bytes: buf.length,
    slides: slides.length,
    sldSz,
    expectedEMU: { cx: SLIDE_W_EMU, cy: SLIDE_H_EMU, note: '1280x720 px @ 96dpi' },
    text: {
      runs_a_t: pptxRunsTotal,
      chars_pptx_nonws: pptxCharsTotal,
      chars_html_nonws: htmlCharsTotal,
      coverage,
      note: 'coverage = non-whitespace chars inside a:t / non-whitespace chars of measured HTML text + table cells',
    },
    zip: { entries: zipStats.entries, deflate: zipStats.deflate, store: zipStats.store, deflateRatio: zipStats.deflateRatio },
    contentTypes,
    slidesDetail: slides,
    gates,
    ok: Object.values(gates).every(Boolean),
  };
  fs.writeFileSync(path.join(OUT, 'editability.json'), JSON.stringify(report, null, 1));
  console.log(
    `[inspect] slides=${slides.length} a:t=${pptxRunsTotal} coverage=${(coverage * 100).toFixed(1)}% ` +
      `p:pic=${slides.reduce((n, s) => n + s.p_pic, 0)} p:sp=${slides.reduce((n, s) => n + s.p_sp, 0)} ` +
      `zip deflate=${zipStats.deflate}/${zipStats.entries} sldSz=${sldSz.cx}x${sldSz.cy} ` +
      `gates=${JSON.stringify(gates)}`,
  );
  if (!report.ok) {
    console.error('[inspect] HARD GATE FAILED');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[inspect] FAILED', err);
  process.exit(1);
});
