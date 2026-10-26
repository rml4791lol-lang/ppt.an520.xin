/**
 * measure.mjs — open samples/deck.html in headless Chrome, screenshot each slide,
 * and dump a structural model (rects + computed styles + visual lines) to out/measure.json
 *
 * Units: everything here stays in CSS px (96 dpi). Conversion happens in convert.mjs.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SAMPLE = process.env.HTMLPPT_DECK ? path.resolve(process.env.HTMLPPT_DECK) : path.join(ROOT, 'samples', 'deck.html');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');
const SCREEN_DIR = path.join(OUT, 'html');

const SLIDE_W = 1280;
const SLIDE_H = 720;

/**
 * svgpaths.mjs is a dependency-free pure module, so we inject its *source* into the page
 * (measurement runs inside Chrome) instead of duplicating the parser. `export` keywords are
 * stripped at runtime; the IIFE keeps the page's globals clean and exposes one namespace.
 */
const SVGPATHS_FILE = path.join(__dirname, 'svgpaths.mjs');
const SVGPATHS_EXPORTS = ['tokenizePath', 'parsePathD', 'arcCenterParams', 'arcToCubics', 'quadToCubic', 'rectPath'];

function svgpathsPageScript() {
  const src = fs.readFileSync(SVGPATHS_FILE, 'utf8').replace(/^export\s+(?=(?:const|let|function|class)\b)/gm, '');
  return `(() => {\n${src}\nwindow.__svgpaths = { ${SVGPATHS_EXPORTS.join(', ')} };\n})();`;
}

async function main() {
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
    viewport: { width: SLIDE_W, height: SLIDE_H },
    deviceScaleFactor: 1,
  });
  await page.goto('file://' + SAMPLE, { waitUntil: 'load' });
  await page.evaluate(svgpathsPageScript());
  const injected = await page.evaluate(() => typeof window.__svgpaths?.parsePathD);
  if (injected !== 'function') throw new Error('svgpaths.mjs injection failed');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) =>
        img.complete && img.naturalWidth > 0
          ? null
          : new Promise((res) => {
              img.onload = res;
              img.onerror = res;
            }),
      ),
    );
  });

  const slideCount = await page.evaluate(() => document.querySelectorAll('section.slide').length);
  const slides = [];
  for (let i = 0; i < slideCount; i++) {
    await page.evaluate((idx) => {
      document.querySelectorAll('section.slide').forEach((s, j) => {
        s.style.display = j === idx ? '' : 'none';
      });
    }, i);
    await page.waitForTimeout(120);

    const png = path.join(SCREEN_DIR, `slide-${i + 1}.png`);
    await page.screenshot({
      path: png,
      clip: { x: 0, y: 0, width: SLIDE_W, height: SLIDE_H },
    });

    const model = await page.evaluate(measureSlideInPage, i);
    slides.push({ ...model, screenshot: path.relative(ROOT, png) });
    console.log(
      `[measure] slide ${i + 1}: ${model.objects.length} objects, ` +
        `${model.objects.filter((o) => o.kind === 'text').length} text, ` +
        `${model.objects.filter((o) => o.kind === 'shape').length} shape, ` +
        `${model.objects.filter((o) => o.kind === 'image').length} image, ` +
        `${model.objects.filter((o) => o.kind === 'svg').length} svg, ` +
        `${model.objects.filter((o) => o.kind === 'table').length} table, ` +
        `${model.objects.filter((o) => o.kind === 'svg').reduce((n, o) => n + ((o.geometry && o.geometry.curves) || 0), 0)} curve cmds, ` +
        `${model.textChars} text chars`,
    );
  }
  await browser.close();

  const out = {
    width: SLIDE_W,
    height: SLIDE_H,
    generatedAt: new Date().toISOString(),
    slides,
  };
  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(out, null, 1));
  console.log(`[measure] wrote out/measure.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KiB)`);
}

/* ------------------------------------------------------------------------------------------------
 * Everything below runs INSIDE the page (Playwright serializes this function's source).
 * ---------------------------------------------------------------------------------------------- */
async function measureSlideInPage(slideIndex) {
  const slide = document.querySelectorAll('section.slide')[slideIndex];
  const slideRect = slide.getBoundingClientRect();
  const ox = slideRect.left;
  const oy = slideRect.top;

  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const round2 = (v) => Math.round(v * 100) / 100;
  const hx = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();

  function splitTop(str) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function colorOf(css) {
    if (!css) return null;
    const c = String(css).trim().toLowerCase();
    if (!c || c === 'none' || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const a = parts.length > 3 ? parts[3] : 1;
    if (!(a > 0.004)) return null;
    return { hex: hx(parts[0]) + hx(parts[1]) + hx(parts[2]), a: round2(a) };
  }

  const DIRS = {
    top: 0, 'top right': 45, right: 90, 'bottom right': 135,
    bottom: 180, 'bottom left': 225, left: 270, 'top left': 315,
  };
  function parseGradient(bgImage) {
    if (!bgImage || bgImage === 'none') return null;
    const m = bgImage.match(/^(linear|radial|repeating-linear|repeating-radial)-gradient\((.*)\)$/s);
    if (!m) return null;
    const kind = m[1].startsWith('radial') ? 'radial' : 'linear';
    const parts = splitTop(m[2]).map((s) => s.trim()).filter(Boolean);
    let angle = kind === 'linear' ? 180 : null;
    const stops = [];
    for (const part of parts) {
      let t = part;
      const deg = t.match(/^(-?[\d.]+)deg$/);
      if (deg) {
        angle = parseFloat(deg[1]);
        continue;
      }
      if (t.startsWith('to ')) {
        angle = DIRS[t.slice(3).trim()] ?? 180;
        continue;
      }
      if (/^(circle|ellipse|closest|farthest|at\s)/.test(t)) continue;
      const posM = t.match(/^(.*?)\s+([\d.]+)%$/);
      let colorStr = t;
      let pos = null;
      if (posM) {
        colorStr = posM[1];
        pos = parseFloat(posM[2]) / 100;
      }
      const col = colorOf(colorStr.trim().startsWith('#') ? hexToRgbStr(colorStr.trim()) : colorStr.trim());
      if (!col) continue;
      stops.push({ pos, hex: col.hex, a: col.a });
    }
    if (stops.length < 2) return null;
    // fill missing stop positions evenly
    if (stops.some((s) => s.pos === null)) {
      stops.forEach((s, i) => {
        if (s.pos === null) s.pos = stops.length === 1 ? 0 : i / (stops.length - 1);
      });
    }
    stops.sort((a, b) => a.pos - b.pos);
    if (stops[0].pos > 0) stops.unshift({ ...stops[0], pos: 0 });
    if (stops[stops.length - 1].pos < 1) stops.push({ ...stops[stops.length - 1], pos: 1 });
    // CSS angle (0 = to top, clockwise) -> DrawingML angle (0 = to right, clockwise)
    const rad = ((angle ?? 180) * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    let pptxAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (pptxAngle < 0) pptxAngle += 360;
    return { kind, angle: Math.round(pptxAngle * 10) / 10, stops };
  }

  function hexToRgbStr(h) {
    let s = h.replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    const n = parseInt(s.slice(0, 6), 16);
    if (!Number.isFinite(n)) return 'rgb(0,0,0)';
    return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
  }

  function isVisible(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0.4 || r.height <= 0.4) return false;
    return true;
  }

  function boxDecor(el, cs) {
    const bg = colorOf(cs.backgroundColor);
    const grad = parseGradient(cs.backgroundImage);
    let border = null;
    let borderW = 0;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = px(cs['border' + side + 'Width']);
      const style = cs['border' + side + 'Style'];
      if (w > 0 && style !== 'none') {
        borderW = Math.max(borderW, w);
        if (!border) border = colorOf(cs['border' + side + 'Color']);
      }
    }
    const radius = px(cs.borderTopLeftRadius);
    const shadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : null;
    const hasFill = !!bg || !!grad;
    const hasLine = borderW > 0 && !!border;
    if (!hasFill && !hasLine && radius === 0 && !shadow) return null;
    return {
      fill: grad ? { type: 'gradient', value: grad } : bg ? { type: 'solid', hex: bg.hex, a: bg.a } : null,
      border: hasLine ? { width: borderW, hex: border.hex, a: border.a } : null,
      radius,
      shadow,
    };
  }

  function parseShadow(css) {
    if (!css || css === 'none') return null;
    if (/inset/.test(css)) return null; // inset shadows are not mapped
    const colorMatch = css.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/);
    const col = colorMatch
      ? colorOf(colorMatch[0].startsWith('#') ? hexToRgbStr(colorMatch[0]) : colorMatch[0])
      : { hex: '000000', a: 0.25 };
    const nums = [...css.matchAll(/(-?[\d.]+)px/g)].map((m) => parseFloat(m[1]));
    const blur = nums[2] ?? 0;
    const dx = nums[0] ?? 0;
    const dy = nums[1] ?? 0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let angle = 90;
    if (dist > 0.01) {
      angle = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = right, 90 = down
      if (angle < 0) angle += 360;
    }
    return {
      opacity: col ? col.a : 0.25,
      color: col ? col.hex : '000000',
      blur,
      distance: dist,
      angle: Math.round(angle) % 360,
    };
  }

  function styleOfElement(el, cs) {
    const lhRaw = cs.lineHeight;
    const fontSize = px(cs.fontSize);
    const lineHeight = lhRaw === 'normal' ? fontSize * 1.2 : px(lhRaw);
    const col = colorOf(cs.color) || { hex: '000000', a: 1 };
    const ls = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing);
    return {
      fontFamily: (cs.fontFamily || 'PingFang SC').split(',')[0].replace(/["']/g, '').trim(),
      fontSize,
      lineHeight,
      bold: parseInt(cs.fontWeight, 10) >= 600,
      italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
      color: col.hex,
      colorA: col.a,
      letterSpacing: ls,
      align: normalizeAlign(cs.textAlign, cs.direction),
      textTransform: cs.textTransform,
    };
  }

  function normalizeAlign(a, dir) {
    if (!a || a === 'start' || a === 'left') return 'left';
    if (a === 'end' || a === 'right') return 'right';
    if (a === 'center') return 'center';
    if (a === 'justify') return 'justify';
    return 'left';
  }

  // ---------- text extraction -------------------------------------------------
  function atomicChild(el, cs) {
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'IMG' || tag === 'SVG' || tag === 'TABLE' || tag === 'BR') return true;
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (px(cs.opacity) <= 0.01) return true;
    const bg = colorOf(cs.backgroundColor);
    const grad = parseGradient(cs.backgroundImage);
    const borderW = px(cs.borderTopWidth);
    const borderStyle = cs.borderTopStyle;
    return !!(bg || grad || (borderW > 0 && borderStyle !== 'none') || px(cs.borderTopLeftRadius) > 0);
  }

  function collectRuns(el) {
    const runs = []; // {text, styleKey}
    const styles = [];
    const styleIndex = new Map();
    function styleKey(st) {
      const k = JSON.stringify(st);
      if (!styleIndex.has(k)) {
        styleIndex.set(k, styles.length);
        styles.push(st);
      }
      return styleIndex.get(k);
    }
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent || '';
        if (!raw) return;
        const parent = node.parentElement;
        if (!parent) return;
        const cs = getComputedStyle(parent);
        let text = raw.replace(/\s+/g, ' ');
        if (text.trim() === '' && runs.length === 0) text = ' ';
        if (text === '') return;
        runs.push({ text, styleKey: styleKey(styleOfElement(parent, cs)), node });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();
      if (tag === 'BR') {
        runs.push({ br: true });
        return;
      }
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (atomicChild(node, cs)) return; // rendered separately (or not text)
      // Only inline formatting flows into the same text box; block children become their own objects.
      if (!cs.display.startsWith('inline')) return;
      for (const child of node.childNodes) walk(child);
    }
    for (const child of el.childNodes) walk(child);
    return { runs, styles };
  }

  function charRectsForTextNode(textNode) {
    const rects = [];
    const range = document.createRange();
    const len = textNode.textContent.length;
    for (let i = 0; i < len; i++) {
      range.setStart(textNode, i);
      range.setEnd(textNode, i + 1);
      const r = range.getClientRects()[0] || range.getBoundingClientRect();
      rects.push({ top: r.top, left: r.left, width: r.width, height: r.height });
    }
    return rects;
  }

  /** turn runs into visual lines: [{segments:[{text,styleKey}], text, top, explicit}] */
  function buildLines(runs, rootLineHeight) {
    const lines = [];
    let cur = null;
    let pendingBreak = false;
    let segLine = null;
    let segment = '';
    const tolerance = Math.max(2, rootLineHeight * 0.35);

    function newLine(top, explicit) {
      cur = {
        segments: [],
        top: top ?? 0,
        left: Infinity,
        right: -Infinity,
        minTop: Infinity,
        maxBottom: -Infinity,
        explicit: !!explicit,
      };
      lines.push(cur);
      segLine = cur;
      return cur;
    }
    function flushSeg(styleKey) {
      if (segment !== '') {
        const target = segLine || cur;
        if (target) {
          if (!target.segments.length) target.top = target.top || 0;
          target.segments.push({ text: segment, styleKey });
        }
        segment = '';
      }
    }

    for (const run of runs) {
      if (run.br) {
        flushSeg(run.styleKey ?? -1);
        pendingBreak = true;
        continue;
      }
      const rects = charRectsForTextNode(run.node);
      for (let i = 0; i < rects.length; i++) {
        const rc = rects[i];
        const ch = run.text[i];
        if (ch === undefined) continue;
        const valid = rc.width > 0 && rc.height > 0;
        if (!valid) {
          // collapsed whitespace (line-end / line-start) -> belongs to current line
          if (!cur) newLine(0, pendingBreak);
          segment += ch;
          continue;
        }
        if (pendingBreak) {
          flushSeg(run.styleKey);
          newLine(rc.top, true);
          pendingBreak = false;
        } else if (!cur) {
          newLine(rc.top, false);
        } else if (Math.abs(rc.top - cur.top) > tolerance) {
          flushSeg(run.styleKey);
          newLine(rc.top, false);
        }
        if (rc.left < cur.left) cur.left = rc.left;
        if (rc.left + rc.width > cur.right) cur.right = rc.left + rc.width;
        if (rc.top < cur.minTop) cur.minTop = rc.top;
        if (rc.top + rc.height > cur.maxBottom) cur.maxBottom = rc.top + rc.height;
        segment += ch;
      }
      flushSeg(run.styleKey);
    }

    const cleaned = [];
    for (const line of lines) {
      const segs = line.segments.filter((s) => s.text);
      if (!segs.length) continue;
      segs[0] = { ...segs[0], text: segs[0].text.replace(/^\s+/, '') };
      const lastI = segs.length - 1;
      segs[lastI] = { ...segs[lastI], text: segs[lastI].text.replace(/\s+$/, '') };
      const merged = [];
      for (const sg of segs) {
        if (!sg.text) continue;
        const prev = merged[merged.length - 1];
        if (prev && prev.styleKey === sg.styleKey) prev.text += sg.text;
        else merged.push({ ...sg });
      }
      const text = merged.map((sg) => sg.text).join('');
      if (!text.trim()) continue;
      cleaned.push({
        segments: merged,
        text,
        top: line.top,
        explicit: line.explicit,
        box: {
          x: Number.isFinite(line.left) ? line.left : 0,
          y: Number.isFinite(line.minTop) ? line.minTop : line.top,
          w: Number.isFinite(line.right) ? line.right - line.left : 0,
          h: Number.isFinite(line.maxBottom) ? line.maxBottom - line.minTop : 0,
        },
      });
    }
    return cleaned;
  }

  // ---------- object walk ----------------------------------------------------
  const objects = [];
  const warnings = [];
  const consumed = new WeakSet();
  let counter = 0;

  function makeBase(el, kind, cs) {
    const r = el.getBoundingClientRect();
    return {
      id: `s${slideIndex + 1}-o${++counter}`,
      kind,
      tag: el.tagName.toLowerCase(),
      cls: el.className && typeof el.className === 'string' ? el.className : '',
      x: r3(r.left - ox),
      y: r3(r.top - oy),
      w: r3(r.width),
      h: r3(r.height),
    };
  }

  function label(el) {
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).join('.') : '';
    return el.tagName.toLowerCase() + cls;
  }

  async function rasterizeSvg(svgEl, rect, scale) {
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const clone = svgEl.cloneNode(true);
    const orig = [svgEl, ...svgEl.querySelectorAll('*')];
    const dup = [clone, ...clone.querySelectorAll('*')];
    for (let i = 0; i < orig.length; i++) {
      const cs = getComputedStyle(orig[i]);
      if (!dup[i]) continue;
      dup[i].setAttribute('fill', cs.fill && cs.fill !== 'none' ? cs.fill : 'none');
      dup[i].setAttribute('stroke', cs.stroke && cs.stroke !== 'none' ? cs.stroke : 'none');
      dup[i].setAttribute('stroke-width', cs.strokeWidth || '1');
      dup[i].setAttribute('stroke-linecap', cs.strokeLinecap || 'butt');
      dup[i].setAttribute('stroke-linejoin', cs.strokeLinejoin || 'miter');
      dup[i].removeAttribute('style');
    }
    clone.removeAttribute('style');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const svgStr = new XMLSerializer().serializeToString(clone);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUri: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
  }

  // --- svg geometry (for custGeom): absolute M/L/C/Z, curves included ---
  // The parser + arc->cubic math lives in src/svgpaths.mjs and is injected above.
  const SP = window.__svgpaths;
  if (!SP) throw new Error('window.__svgpaths missing: svgpaths.mjs was not injected');
  const PATH_TOL = 0.1; // px radial tolerance for A -> cubic

  function parsePathD(d) {
    return SP.parsePathD(d, { tolerance: PATH_TOL });
  }

  function polyPoints(node, tag) {
    if (tag === 'line') {
      return [
        { t: 'M', x: px(node.getAttribute('x1')), y: px(node.getAttribute('y1')) },
        { t: 'L', x: px(node.getAttribute('x2')), y: px(node.getAttribute('y2')) },
      ];
    }
    if (tag === 'rect') {
      const x = px(node.getAttribute('x'));
      const y = px(node.getAttribute('y'));
      const w = px(node.getAttribute('width'));
      const h = px(node.getAttribute('height'));
      // rx/ry become the same adaptive cubics as an elliptical arc (SVG 1.1 §9.2 rules)
      return SP.rectPath(x, y, w, h, px(node.getAttribute('rx')), px(node.getAttribute('ry')), PATH_TOL);
    }
    const raw = (node.getAttribute('points') || '').trim();
    if (!raw) return null;
    const nums = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    if (nums.length < 4) return null;
    const cmds = [{ t: 'M', x: nums[0], y: nums[1] }];
    for (let i = 2; i + 1 < nums.length; i += 2) cmds.push({ t: 'L', x: nums[i], y: nums[i + 1] });
    if (tag === 'polygon') cmds.push({ t: 'Z' });
    return cmds;
  }

  function extractSvgGeometry(svgEl) {
    const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const rect = svgEl.getBoundingClientRect();
    const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : Math.round(rect.width);
    const vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : Math.round(rect.height);
    // SVG 内若有 <text>，custGeom 会丢字 → 整块走 PNG 兜底（宁可保真，不丢内容）
    const hasText = !!svgEl.querySelector('text, tspan, foreignObject');
    const groupsMap = new Map();
    const circles = [];
    let supported = true;
    const reasons = [];
    let curves = 0; // number of cubic segments recovered as real vector geometry
    let nodesTotal = 0;
    /** mark the whole SVG as not losslessly convertible (it will fall back to PNG) */
    const flag = (reason) => {
      supported = false;
      if (reasons.indexOf(reason) < 0) reasons.push(reason);
    };
    // Features whose paint/geometry we cannot reproduce inside one a:custGeom shape.
    const exotic = svgEl.querySelector('use, clipPath, mask, pattern, marker, symbol, image, svg');
    if (exotic) flag('<' + exotic.tagName + '>');
    const xfAttr = svgEl.getAttribute('transform');
    if (xfAttr && xfAttr.trim() && xfAttr.trim() !== 'none') flag('svg-transform');
    /** a transform on the node or an ancestor <g> means our user-unit coords are wrong */
    function hasTransform(node) {
      let n = node;
      while (n && n !== svgEl) {
        if (n.nodeType !== 1) break;
        const t = n.getAttribute && n.getAttribute('transform');
        if (t && t.trim() && t.trim() !== 'none') return true;
        n = n.parentElement;
      }
      return false;
    }
    const nodes = svgEl.querySelectorAll('path, polyline, polygon, line, rect, circle, ellipse');
    nodes.forEach((node) => {
      const tag = node.tagName.toLowerCase();
      const cs = getComputedStyle(node);
      nodesTotal++;
      if (hasTransform(node)) { flag('element-transform'); return; }
      // paint servers (gradients/patterns) cannot be expressed by our per-group solid fill
      if (String(cs.fill || '').indexOf('url(') >= 0 || String(cs.stroke || '').indexOf('url(') >= 0) {
        flag('paint-server');
        return;
      }
      const fillCol = cs.fill && cs.fill !== 'none' ? colorOf(cs.fill) : null;
      const strokeCol = cs.stroke && cs.stroke !== 'none' ? colorOf(cs.stroke) : null;
      if (tag === 'circle' || tag === 'ellipse') {
        const cr = node.getBoundingClientRect();
        circles.push({
          x: cr.left - rect.left, y: cr.top - rect.top, w: cr.width, h: cr.height,
          fillHex: fillCol ? fillCol.hex : null, fillA: fillCol ? fillCol.a : null,
          strokeHex: strokeCol ? strokeCol.hex : null, strokeA: strokeCol ? strokeCol.a : null,
          strokeWidth: px(cs.strokeWidth),
        });
        return;
      }
      const parsed = tag === 'path' ? parsePathD(node.getAttribute('d')) : polyPoints(node, tag);
      const commandList = Array.isArray(parsed) ? parsed : parsed && parsed.cmds;
      if (!commandList) { flag(tag === 'path' ? 'unparsable-path' : 'bad-geometry'); return; }
      if (!commandList.length) return;
      for (const c of commandList) if (c.t === 'C') curves++;
      const key = [fillCol ? fillCol.hex : '-', fillCol ? fillCol.a : '-',
                   strokeCol ? strokeCol.hex : '-', strokeCol ? strokeCol.a : '-',
                   Math.round(px(cs.strokeWidth) * 100), cs.strokeLinecap, cs.strokeLinejoin].join('|');
      let g = groupsMap.get(key);
      if (!g) {
        g = {
          subpaths: [],
          fillHex: fillCol ? fillCol.hex : null, fillA: fillCol ? fillCol.a : null,
          strokeHex: strokeCol ? strokeCol.hex : null, strokeA: strokeCol ? strokeCol.a : null,
          strokeWidth: px(cs.strokeWidth), cap: cs.strokeLinecap, join: cs.strokeLinejoin,
        };
        groupsMap.set(key, g);
      }
      g.subpaths.push({ cmds: commandList });
    });
    const groups = [...groupsMap.values()].filter(
      (g) => g.subpaths.length && (g.fillHex || g.strokeHex));
    if (!groups.length && !circles.length && !reasons.length) flag('empty-geometry');
    if (hasText) flag('svg-text');
    return {
      viewBox: [vbW, vbH], groups, circles, hasText, supported, curves, nodesTotal,
      unsupportedReasons: reasons,
      // 兼容旧字段（单色单组场景）
      subpaths: groups[0] ? groups[0].subpaths : [],
      fillHex: groups[0] ? groups[0].fillHex : null, fillA: groups[0] ? groups[0].fillA : null,
      strokeHex: groups[0] ? groups[0].strokeHex : null, strokeA: groups[0] ? groups[0].strokeA : null,
      strokeWidth: groups[0] ? groups[0].strokeWidth : 0,
      cap: groups[0] ? groups[0].cap : 'butt', join: groups[0] ? groups[0].join : 'miter',
    };
  }

  const styleMap = []; // global run styles

  async function visit(el) {
    if (consumed.has(el)) return;
    consumed.add(el);
    const tag = el.tagName.toUpperCase();
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) return;
    const rect = el.getBoundingClientRect();

    if (tag === 'IMG') {
      const src = el.getAttribute('src') || '';
      const obj = makeBase(el, 'image', cs);
      obj.src = src.startsWith('data:') ? src : new URL(src, document.baseURI).href;
      obj.naturalW = el.naturalWidth || rect.width;
      obj.naturalH = el.naturalHeight || rect.height;
      obj.fit = cs.objectFit || 'fill';
      obj.alt = el.getAttribute('alt') || '';
      objects.push(obj);
      return;
    }

    if (tag === 'SVG') {
      const obj = makeBase(el, 'svg', cs);
      const geom = extractSvgGeometry(el);
      if (!geom.supported) {
        warnings.push({
          id: obj.id,
          tag: 'svg',
          reasons: geom.unsupportedReasons && geom.unsupportedReasons.length
            ? geom.unsupportedReasons
            : ['unknown'],
          nodes: geom.nodesTotal,
          fallback: 'png@4x',
        });
      }
      obj.geometry = geom;
      obj.raster4x = await rasterizeSvg(el, rect, 4);
      obj.z = getComputedStyle(el).zIndex;
      objects.push(obj);
      return;
    }

    if (tag === 'TABLE') {
      const obj = makeBase(el, 'table', cs);
      const rows = [...el.rows];
      const colW = rows.length ? [...rows[0].cells].map((c) => c.getBoundingClientRect().width) : [];
      const rowH = rows.map((r) => r.getBoundingClientRect().height);
      obj.colW = colW.map(r3);
      obj.rowH = rowH.map(r3);
      obj.cells = rows.map((r) =>
        [...r.cells].map((c) => {
          const ccs = getComputedStyle(c);
          const cr = c.getBoundingClientRect();
          const bg = colorOf(ccs.backgroundColor);
          const fg = colorOf(ccs.color) || { hex: '000000', a: 1 };
          const borderW = px(ccs.borderTopWidth);
          const borderCol = colorOf(ccs.borderTopColor);
          const lh = ccs.lineHeight === 'normal' ? px(ccs.fontSize) * 1.2 : px(ccs.lineHeight);
          return {
            text: (c.innerText || '').replace(/\s+/g, ' ').trim(),
            x: r3(cr.left - ox),
            y: r3(cr.top - oy),
            w: r3(cr.width),
            h: r3(cr.height),
            fill: bg ? { hex: bg.hex, a: bg.a } : null,
            color: fg.hex,
            colorA: fg.a,
            bold: parseInt(ccs.fontWeight, 10) >= 600,
            fontSize: px(ccs.fontSize),
            lineHeight: lh,
            align: normalizeAlign(ccs.textAlign, ccs.direction),
            border: borderW > 0 && borderCol ? { width: borderW, hex: borderCol.hex } : null,
            padding: [px(ccs.paddingTop), px(ccs.paddingRight), px(ccs.paddingBottom), px(ccs.paddingLeft)],
            colspan: c.colSpan || 1,
            rowspan: c.rowSpan || 1,
          };
        }),
      );
      objects.push(obj);
      return;
    }

    // text of this element (inline descendants only)
    const { runs, styles } = collectRuns(el);
    const hasText = runs.some((r) => !r.br);
    let textObj = null;
    if (hasText) {
      const baseStyle = styleOfElement(el, cs);
      const lineHeight = baseStyle.lineHeight;
      const lines = buildLines(runs, lineHeight);
      if (lines.length) {
        const padding = {
          t: px(cs.paddingTop) + px(cs.borderTopWidth),
          r: px(cs.paddingRight) + px(cs.borderRightWidth),
          b: px(cs.paddingBottom) + px(cs.borderBottomWidth),
          l: px(cs.paddingLeft) + px(cs.borderLeftWidth),
        };
        const contentX = rect.left - ox + padding.l;
        const contentW = Math.max(1, rect.width - padding.l - padding.r);
        textObj = makeBase(el, 'text', cs);
        textObj.label = label(el);
        textObj.x = r3(contentX);
        textObj.w = r3(contentW);
        textObj.y = r3(rect.top - oy + padding.t);
        textObj.h = r3(lines.length * lineHeight);
        textObj.lineHeight = r3(lineHeight);
        textObj.lineCount = lines.length;
        textObj.align = baseStyle.align;
        textObj.fontFamily = baseStyle.fontFamily;
        textObj.fontSize = r3(baseStyle.fontSize);
        textObj.color = baseStyle.color;
        textObj.colorA = baseStyle.colorA;
        textObj.letterSpacing = r3(baseStyle.letterSpacing);
        textObj.valign = 'top';
        textObj.lines = lines.map((ln) => ({
          text: ln.text,
          explicit: !!ln.explicit,
          x: r3(ln.box.x - ox),
          y: r3(ln.box.y - oy),
          w: r3(ln.box.w),
          h: r3(ln.box.h),
          segments: ln.segments.map((s) => {
            const st = styles[s.styleKey];
            styleMap.push({ ...st, fontFamily: baseStyle.fontFamily });
            return { text: s.text, style: { ...st, fontFamily: baseStyle.fontFamily } };
          }),
        }));
        textObj.textChars = lines.reduce((n, ln) => n + ln.text.replace(/\s+/g, '').length, 0);
        objects.push(textObj);
      }
    }

    // shape for this element's own box decoration
    const decor = boxDecor(el, cs);
    if (decor) {
      const obj = makeBase(el, 'shape', cs);
      obj.label = label(el);
      obj.fill = decor.fill;
      obj.border = decor.border;
      obj.radius = r3(decor.radius);
      obj.shadow = parseShadow(decor.shadow);
      if (cs.transform && cs.transform !== 'none') obj.transform = cs.transform;
      objects.push(obj);
    }

    // descend into element children
    for (const child of el.children) {
      const ccs = getComputedStyle(child);
      if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
      if (consumed.has(child)) continue;
      if (atomicChild(child, ccs)) {
        await visit(child);
        continue;
      }
      // non-atomic inline children were folded into this text object
      if (ccs.display.startsWith('inline')) continue;
      await visit(child);
    }
  }

  await visit(slide);

  // --- source text (for coverage cross-check) ---
  const nonWs = (s) => (s || '').replace(/\s+/g, '').length;
  const measureChars = objects.filter((o) => o.kind === 'text').reduce((n, o) => n + (o.textChars || 0), 0);
  const tableChars = objects
    .filter((o) => o.kind === 'table')
    .reduce((n, o) => n + o.cells.flat().reduce((m, c) => m + nonWs(c.text), 0), 0);
  const sourceChars = nonWs(slide.innerText || '');
  const result = {
    index: slideIndex,
    objects,
    width: Math.round(slideRect.width),
    height: Math.round(slideRect.height),
    textChars: measureChars,
    tableChars,
    sourceChars,
    warnings,
  };
  return result;
}

main().catch((err) => {
  console.error('[measure] FAILED', err);
  process.exit(1);
});
