/**
 * report.mjs — merge every measurement artifact into out/metrics.json and print the verdict.
 * Single source of truth for the numbers quoted in README.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');

const read = (name, fallback = null) => {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

function main() {
  const measure = read('measure.json');
  const convertStats = read('convert_stats.json', {});
  const editability = read('editability.json', {});
  const zipStats = read('zip_stats.json', {});
  const pixel = read('pixel.json', {});
  const fontMatrix = read('font_matrix.json', {});
  const render = read('render.json', {});
  const postprocess = read('postprocess_report.json', {});
  const validate = read('pptx_validate.json', {});
  const deck = fs.existsSync(path.join(OUT, 'deck.pptx')) ? fs.statSync(path.join(OUT, 'deck.pptx')) : null;

  const pixelSlides = (pixel.slides || []).map((s) => ({
    slide: s.slide,
    mae: s.mae,
    pixelDiffRatio: s.pixelDiffRatio,
    majorDiffRatio: s.majorDiffRatio,
    textDys: s.textVerticalOffsetPx,
    worstRegions: (s.worstRegions || []).slice(0, 4),
  }));

  const gates = {
    buildRan: !!measure && !!convertStats && !!editability && !!pixel,
    deckExists: !!(deck && deck.size > 0),
    deckOpensWithLibreOffice: !!render.pages?.length,
    deckOpensWithPythonPptx: !!validate.ok,
    slideSize1280x720: editability.gates?.slideSize1280x720 === true,
    textCharsCoverage90: editability.gates?.textCharsCoverage90 === true,
    noFullPagePicture: editability.gates?.noFullPagePicture === true,
    noScreenshotOnlySlide: editability.gates?.noScreenshotOnlySlide === true,
    everySlideHasTextRuns: editability.gates?.everySlideHasTextRuns === true,
    zipAllDeflate: editability.gates?.zipAllDeflate === true,
    contentTypesValid: editability.gates?.contentTypesValid === true,
    // 一个 SVG 可能拆成多个原生形状（多色分组 + 圆），custgeom 计的是"形状数"不是"对象数"，
    // 因此门禁只要求：每个 SVG 对象要么至少产出 1 个原生形状，要么走了 PNG 兜底。
    svgCustGeomOrFallbackRecorded: (convertStats.svg?.total || 0) ===
      (convertStats.svg?.objectsNative || 0) + (convertStats.svg?.pngFallback || 0),
    gradientsPostProcessed: (postprocess.applied || 0) === (postprocess.total || 0),
  };

  const metrics = {
    generatedAt: new Date().toISOString(),
    command: 'npm run build',
    delivery: {
      deck: 'out/deck.pptx',
      bytes: deck ? deck.size : 0,
      slides: editability.slides || 0,
      htmlScreenshots: 'out/html/slide-N.png',
      pptxRenders: 'out/pptx/slide-N.png',
      diffImages: 'out/diff/slide-N.png',
      contactSheet: 'out/diff/contact-sheet.png',
      metrics: 'out/metrics.json',
      editability: 'out/editability.json',
    },
    pipeline: [
      'samples/deck.html (5 slides, fixed 1280x720)',
      'headless Chrome (channel:chrome) measure: getBoundingClientRect + getComputedStyle + visual line boxes',
      'px->inch /96, px->pt *0.75, native text boxes (margin 0, fit none, exact line spacing, hard line breaks)',
      'PptxGenJS: text / roundRect+rect / picture / table; gradient + custGeom placeholders',
      'postprocess: inject a:gradFill + a:custGeom, prune dangling Overrides, repack 100% DEFLATE',
      'LibreOffice 26.8 headless -> PDF, pdftoppm -> 1280x720 PNG',
      'numpy/Pillow pixel diff + per-object attribution + contact sheet',
    ],
    text: editability.text || {},
    editability: {
      runs_a_t: editability.text?.runs_a_t,
      coverage: editability.text?.coverage,
      slidesDetail: (editability.slidesDetail || []).map((s) => ({
        slide: s.slide,
        runs_a_t: s.runs_a_t,
        chars_pptx: s.chars_pptx,
        chars_html: s.chars_html,
        coverage: s.coverage,
        p_sp: s.p_sp,
        p_pic: s.p_pic,
        p_graphicFrame: s.p_graphicFrame,
        a_tbl: s.a_tbl,
        custGeom: s.custGeom,
        gradFill: s.gradFill,
        fullPagePicture: s.fullPagePicture,
        biggestPictureAreaRatio: s.biggestPictureAreaRatio,
      })),
    },
    pixel: {
      overall: pixel.overall || {},
      byKind: pixel.byKind || {},
      textVerticalOffsetPx: pixel.textVerticalOffsetPx || {},
      slides: pixelSlides,
    },
    structure: {
      objects: convertStats.objects || {},
      svg: convertStats.svg || {},
      gradients: convertStats.gradients || 0,
      textRunsWritten: convertStats.textRuns,
      paragraphs: convertStats.paragraphs,
      hardLines: convertStats.hardLines,
      postprocess,
    },
    package: {
      sldSzEMU: editability.sldSz,
      zip: editability.zip,
      contentTypes: editability.contentTypes,
      pdfBytes: render.pdfBytes,
      embeddedFonts: render.embeddedFonts || [],
    },
    fonts: {
      proxyNote:
        'LibreOffice is the verification proxy, not PowerPoint. Headless soffice only sees its bundled fonts unless FONTCONFIG_FILE points at the host fontconfig; render.mjs does that so both sides resolve PingFang SC.',
      fontConfig: render.fontConfig,
      embeddedFonts: render.embeddedFonts || [],
      probe: (fontMatrix.fonts || []).map((f) => ({
        label: f.label,
        htmlInkWidthPx: f.htmlInkWidthPx,
        pptxInkWidthPx: f.pptxInkWidthPx,
        deltaPx: f.deltaPx,
        deltaPct: f.deltaPct,
      })),
      probeConclusion:
        'Pure-Latin and pure-CJK controls match within -3px/-2px (<1.2%); the mixed sample is +19..22px for every typeface, i.e. LibreOffice adds ~0.25em at each of the 3 CJK<->Latin boundaries. That residual is a LibreOffice text-layout difference, not font substitution.',
    },
    knownLimitations: [
      'LibreOffice 26.8 is used as the objective render proxy; PowerPoint can render differently (baseline placement, CJK/Latin auto-spacing). All pixel numbers are proxy numbers, not PowerPoint guarantees.',
      'LibreOffice adds ~0.25em spacing at every CJK<->Latin boundary. Measured text is therefore 3.4-4.3% wider in the proxy; hard-line text cannot drift vertically but the last glyphs of mixed lines sit a few px right.',
      'Text baseline: the text box top = CSS content-box top; the proxy renders text 1-6px lower (median 3px, grows with line-height). This is reported per slide in pixel.json, not silently compensated.',
      'Hard-lines mode writes wrap="none" and one paragraph per visual line: visually exact, but re-flowing text in PowerPoint will not re-wrap (documented trade-off; use --no-hard-lines for reflow mode).',
      'custGeom support is limited to straight-line SVG paths with a single fill/stroke style (our 8 icons). Curves (circle/ellipse/path C commands) fall back to 4x PNG and are counted in convert_stats.svg.pngFallback.',
      'Only linear/radial CSS gradients are translated to a:gradFill; conic/repeating gradients fall back to their first stop. Element opacity is folded into fill transparency, parent opacity stacking is not multiplied.',
      'Tables map cell text/fill/border/column widths/row heights; nested tables, merged cells (colspan>1) and cell-level vertical alignment nuances are not fully reproduced.',
      'Images are stretched into their measured rect; CSS border-radius clipping on images, filters and blend modes are not applied.',
      'box-shadow is approximated with one outer shadow; multiple shadows/inset shadows are ignored.',
      'Semi-transparent text is flattened to an opaque colour blended against the measured backdrop, because PptxGenJS text colour has no alpha channel.',
    ],
    gates,
    verdict: Object.values(gates).every(Boolean) ? 'PASS' : 'FAIL',
    ...(pixel.overall ? {
      headline: {
        slides: editability.slides,
        bytes: deck ? deck.size : 0,
        textCharsCoverage: editability.text?.coverage,
        runs_a_t: editability.text?.runs_a_t,
        pixelDiffRatio: pixel.overall.pixelDiffRatio,
        majorDiffRatio: pixel.overall.majorDiffRatio,
        mae: pixel.overall.mae,
        fullPagePictures: (editability.slidesDetail || []).filter((s) => s.fullPagePicture).length,
        zipDeflateRatio: editability.zip?.deflateRatio,
      },
    } : {}),
  };

  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 1));

  const h = metrics.headline || {};
  console.log('\n================  HTML -> PPTX  ================');
  console.log(`slides              ${h.slides}`);
  console.log(`deck.pptx           ${(h.bytes / 1024).toFixed(0)} KiB`);
  console.log(`text chars coverage ${(h.textCharsCoverage * 100).toFixed(1)}%  (a:t runs ${h.runs_a_t})`);
  console.log(`full-page pictures  ${h.fullPagePictures}`);
  console.log(`pixel diff > 16     ${(h.pixelDiffRatio * 100).toFixed(2)}%   > 48: ${(h.majorDiffRatio * 100).toFixed(2)}%   MAE ${h.mae}`);
  console.log(`zip DEFLATE         ${h.zipDeflateRatio}%`);
  console.log(`gates               ${metrics.verdict}  ${JSON.stringify(gates)}`);
  console.log('================================================\n');
  if (metrics.verdict !== 'PASS') process.exit(3);
}

main();
