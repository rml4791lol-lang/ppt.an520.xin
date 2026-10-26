/**
 * postprocess.mjs — inject the two DrawingML features PptxGenJS has no API for:
 *   1) a:gradFill   (CSS gradients — placeholder solid colour is swapped for a gradient)
 *   2) a:custGeom   (inline SVG geometry — placeholder rect geometry is swapped for real
 *                    paths; lines become a:lnTo, curves become a:cubicBezTo)
 *
 * custGeom coordinate space: path coordinates are written in EMU and `path/@w = ext/@cx`,
 * `path/@h = ext/@cy`, so the DrawingML scale factor is exactly 1. Q/T/A were already
 * converted to absolute cubics by src/svgpaths.mjs during measurement.
 *
 * Strategy: every shape that needs post-processing is generated with a unique placeholder
 * colour (out/directives.json). We unzip the pptx in memory (JSZip), find the <p:sp> block
 * owning that colour, rewrite geometry/fill/line, and rezip with DEFLATE compression
 * (PowerPoint is known to complain about STORE-only decks: dom-to-pptx PR #40).
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');
const RAW = path.join(OUT, 'deck.raw.pptx');
const FINAL = path.join(OUT, 'deck.pptx');

const emuFromPt = (ptVal) => Math.round(ptVal * 12700);
const EMU_PER_PX = 9525; // 914400 / 96

function gradFillXml(g) {
  const stops = g.stops
    .map((s) => {
      const alpha = s.a < 0.999 ? `<a:alpha val="${Math.round(s.a * 100000)}"/>` : '';
      return `<a:gs pos="${Math.round(s.pos * 100000)}"><a:srgbClr val="${s.hex}">${alpha}</a:srgbClr></a:gs>`;
    })
    .join('');
  const dir =
    g.kind === 'radial'
      ? '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'
      : `<a:lin ang="${Math.round((((g.angle % 360) + 360) % 360) * 60000)}" scaled="1"/>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${dir}</a:gradFill>`;
}

/**
 * svg geometry -> a:custGeom.
 *
 * Coordinate space: the path is written in **EMU**, and `path/@w = ext/@cx`,
 * `path/@h = ext/@cy`, so the DrawingML mapping factor is exactly 1 (1 path unit = 1 EMU).
 * Coordinates come in as viewBox user units, hence kx = ext.cx / viewBox.width.
 * Curves are native `<a:cubicBezTo>` (3 pts); Q/T and A were already folded to C upstream
 * by src/svgpaths.mjs, so no approximation happens here.
 */
function custGeomXml(d, ext) {
  const g = d.group || d.geometry;
  const vbW = Math.max(1e-6, d.geometry.viewBox[0] || 0);
  const vbH = Math.max(1e-6, d.geometry.viewBox[1] || 0);
  // prefer the real shape extent from <a:ext>; fall back to the measured px rect
  const W = Math.max(1, Math.round(ext ? ext.cx : d.rect.w * EMU_PER_PX));
  const H = Math.max(1, Math.round(ext ? ext.cy : d.rect.h * EMU_PER_PX));
  const kx = W / vbW;
  const ky = H / vbH;
  const pt = (x, y) => `<a:pt x="${Math.round(x * kx)}" y="${Math.round(y * ky)}"/>`;
  const paths = g.subpaths
    .map((sp) => {
      const body = sp.cmds
        .map((c) => {
          if (c.t === 'M') return `<a:moveTo>${pt(c.x, c.y)}</a:moveTo>`;
          if (c.t === 'L') return `<a:lnTo>${pt(c.x, c.y)}</a:lnTo>`;
          if (c.t === 'C') {
            return `<a:cubicBezTo>${pt(c.x1, c.y1)}${pt(c.x2, c.y2)}${pt(c.x, c.y)}</a:cubicBezTo>`;
          }
          if (c.t === 'Z') return '<a:close/>';
          return '';
        })
        .join('');
      return body ? `<a:path w="${W}" h="${H}">${body}</a:path>` : '';
    })
    .join('');
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom>`;
}

function lineXmlFor(d) {
  const g = d.group || d.geometry;
  const capMap = { round: 'rnd', square: 'sq', butt: 'flat' };
  const cap = capMap[g.cap] || 'flat';
  if (!g.strokeHex) return '<a:ln><a:noFill/></a:ln>';
  const pxW = (g.strokeWidth || 1) * (d.rect.w / d.geometry.viewBox[0]);
  const wEmu = Math.max(1, emuFromPt(pxW * 0.75));
  const alpha = g.strokeA < 0.999 ? `<a:alpha val="${Math.round(g.strokeA * 100000)}"/>` : '';
  return (
    `<a:ln w="${wEmu}" cap="${cap}"><a:solidFill><a:srgbClr val="${g.strokeHex}">${alpha}</a:srgbClr></a:solidFill>` +
    `${g.join === 'round' ? '<a:round/>' : '<a:miter lim="800000"/>'}</a:ln>`
  );
}

function fillXmlFor(d) {
  const g = d.group || d.geometry;
  if (!g.fillHex) return '<a:noFill/>';
  const alpha = g.fillA < 0.999 ? `<a:alpha val="${Math.round(g.fillA * 100000)}"/>` : '';
  return `<a:solidFill><a:srgbClr val="${g.fillHex}">${alpha}</a:srgbClr></a:solidFill>`;
}

function rewriteBlock(block, directive) {
  let out = block;
  const markerRe = new RegExp(
    `<a:solidFill><a:srgbClr val="${directive.marker}"(?:\\/>|>[\\s\\S]*?<\\/a:srgbClr>)<\\/a:solidFill>`,
  );
  if (directive.kind === 'gradient') {
    return out.replace(markerRe, gradFillXml(directive.gradient));
  }
  if (directive.kind === 'custgeom') {
    // the placeholder rect carries the real target extent -> use it as the path space
    const extMatch = block.match(/<a:ext cx="(-?\d+)" cy="(-?\d+)"\s*\/>/);
    const ext = extMatch ? { cx: Number(extMatch[1]), cy: Number(extMatch[2]) } : null;
    out = out.replace(/<a:prstGeom prst="[^"]*">[\s\S]*?<\/a:prstGeom>/, custGeomXml(directive, ext));
    out = out.replace(markerRe, fillXmlFor(directive));
    const lineXml = lineXmlFor(directive);
    if (/<a:ln\b[\s\S]*?<\/a:ln>/.test(out)) {
      out = out.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, lineXml);
    } else {
      out = out.replace('</p:spPr>', `${lineXml}</p:spPr>`);
    }
    return out;
  }
  return out;
}

function applyDirective(xml, directive) {
  const markerIdx = xml.indexOf(`val="${directive.marker}"`);
  if (markerIdx < 0) return { xml, ok: false, reason: 'marker not found' };
  const spStart = xml.lastIndexOf('<p:sp>', markerIdx);
  const spEndRel = xml.indexOf('</p:sp>', markerIdx);
  if (spStart < 0 || spEndRel < 0) return { xml, ok: false, reason: 'p:sp block not found' };
  const spEnd = spEndRel + '</p:sp>'.length;
  const block = xml.slice(spStart, spEnd);
  const rewritten = rewriteBlock(block, directive);
  const ok = rewritten !== block;
  return { xml: xml.slice(0, spStart) + rewritten + xml.slice(spEnd), ok, reason: ok ? '' : 'no change' };
}


// ECMA-376 CT_Presentation 的子元素顺序；pptxgenjs 的子元素顺序不合法（notesMasterIdLst 在 sldIdLst 后），
// 严格校验器（xmllint / Open XML SDK）都会报错，PowerPoint 也可能提示"需要修复"。
const PRES_ORDER = [
  'sldMasterIdLst', 'notesMasterIdLst', 'handoutMasterIdLst', 'sldIdLst', 'sldSz', 'notesSz',
  'smartTags', 'embeddedFontLst', 'custShowLst', 'photoAlbum', 'custDataLst', 'kinsoku',
  'defaultTextStyle', 'modifyVerifier', 'extLst',
];

function reorderPresentationXml(xml) {
  const m = xml.match(/<p:presentation\b[^>]*>([\s\S]*)<\/p:presentation>/);
  if (!m) return xml;
  const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
  const body = m[1];
  const re = /<p:([A-Za-z0-9]+)\b[^>]*?(\/>|>[\s\S]*?<\/p:\1>)/g;
  const children = [];
  let last = 0, mm;
  while ((mm = re.exec(body))) {
    if (mm.index > last) children.push(body.slice(last, mm.index));
    children.push(mm[0]);
    last = mm.index + mm[0].length;
  }
  if (last < body.length) children.push(body.slice(last));
  const idx = (c) => {
    const nm = c.match(/^<p:([A-Za-z0-9]+)/);
    const i = nm ? PRES_ORDER.indexOf(nm[1]) : -1;
    return i < 0 ? 998 : i;
  };
  const sorted = children
    .map((c, i) => ({ c, i }))
    .sort((a, b) => idx(a.c) - idx(b.c) || a.i - b.i)
    .map((x) => x.c);
  return xml.slice(0, m.index) + openTag + sorted.join('') + '</p:presentation>' + xml.slice(m.index + m[0].length);
}

async function main() {
  if (!fs.existsSync(RAW)) throw new Error(`missing ${RAW}; run convert.mjs first`);
  const directives = (JSON.parse(fs.readFileSync(path.join(OUT, 'directives.json'), 'utf8')).directives) || [];
  const source = await JSZip.loadAsync(fs.readFileSync(RAW));

  // Rebuild the archive from decompressed bytes. JSZip keeps the *original* compression of
  // loaded entries, so a plain generateAsync() would preserve pptxgenjs's STORE entries.
  const names = Object.keys(source.files).filter((n) => !source.files[n].dir);
  const payload = new Map();
  for (const name of names) payload.set(name, await source.file(name).async('nodebuffer'));
  const zip = new JSZip();
  for (const [name, bytes] of payload) zip.file(name, bytes);
  // Keep the conventional part order (directory order is otherwise irrelevant,
  // but [Content_Types].xml first is the least surprising for validators).
  const ordered = ['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', ...names.filter(
    (n) => !['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml'].includes(n),
  )];
  const zipOrdered = new JSZip();
  for (const name of ordered) if (payload.has(name)) zipOrdered.file(name, payload.get(name));

  const bySlide = new Map();
  for (const d of directives) {
    if (!bySlide.has(d.slide)) bySlide.set(d.slide, []);
    bySlide.get(d.slide).push(d);
  }

  // 修正 presentation.xml 的子元素顺序（严格校验器的硬要求）
  {
    const presEntry = zipOrdered.file('ppt/presentation.xml');
    if (presEntry) {
      const presXml = await presEntry.async('string');
      const fixedPres = reorderPresentationXml(presXml);
      if (fixedPres !== presXml) {
        zipOrdered.file('ppt/presentation.xml', fixedPres);
        console.log('[postprocess] reordered p:presentation children (ECMA-376)');
      }
    }
  }

  const report = { total: directives.length, applied: 0, failed: 0, details: [] };
  const curves = { total: 0, bySlide: {}, custGeomShapes: 0 };
  // seed every slide so bySlide has no holes (slides without custGeom still report 0)
  for (const n of names) {
    const m = n.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) curves.bySlide[Number(m[1])] = 0;
  }
  for (const [slideNo, list] of [...bySlide.entries()].sort((a, b) => a[0] - b[0])) {
    const name = `ppt/slides/slide${slideNo}.xml`;
    const entry = zipOrdered.file(name);
    if (!entry) throw new Error(`missing ${name} inside raw pptx`);
    let xml = await entry.async('string');
    for (const d of list) {
      const res = applyDirective(xml, d);
      xml = res.xml;
      report.details.push({ slide: slideNo, kind: d.kind, marker: d.marker, ok: res.ok, reason: res.reason });
      if (res.ok) report.applied++;
      else report.failed++;
    }
    // count what actually landed in the package (a:cubicBezTo = native DrawingML curves)
    const bez = (xml.match(/<a:cubicBezTo>/g) || []).length;
    curves.total += bez;
    curves.bySlide[slideNo] = bez;
    curves.custGeomShapes += (xml.match(/<a:custGeom>/g) || []).length;
    zipOrdered.file(name, xml);
  }
  report.cubicBezTo = curves;

  // PptxGenJS declares `slideMaster2..N` content-type overrides it never writes (it reuses
  // slideMaster1 for every slide). Strict validators flag those as dangling Overrides, so prune them.
  const ctEntry = zipOrdered.file('[Content_Types].xml');
  const ctXml = await ctEntry.async('string');
  const existingParts = new Set(payload.keys()); // NB: payload is a Map; Object.keys(Map) is []
  const prunedOverrides = [];
  const prunedCt = ctXml.replace(/<Override\b[^>]*?\/>/g, (tag) => {
    const m = tag.match(/PartName="([^"]+)"/);
    if (!m) return tag;
    const part = m[1].replace(/^\//, '');
    if (existingParts.has(part)) return tag;
    prunedOverrides.push(m[1]);
    return '';
  });
  if (prunedOverrides.length) zipOrdered.file('[Content_Types].xml', prunedCt);
  report.prunedOverrides = prunedOverrides;

  const buf = await zipOrdered.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'darwin',
  });
  fs.writeFileSync(FINAL, buf);

  report.zipBytes = buf.length;
  report.compression = 'DEFLATE (level 6)';
  fs.writeFileSync(path.join(OUT, 'postprocess_report.json'), JSON.stringify(report, null, 1));
  console.log(
    `[postprocess] directives=${report.total} applied=${report.applied} failed=${report.failed} ` +
      `custGeom=${curves.custGeomShapes} cubicBezTo=${curves.total} ` +
      `DEFLATE -> out/deck.pptx (${(buf.length / 1024).toFixed(0)} KiB)`,
  );
  if (report.failed > 0) {
    console.error('[postprocess] FAILED directives:', report.details.filter((d) => !d.ok));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[postprocess] FAILED', err);
  process.exit(1);
});
