/**
 * convert.mjs — measured model (out/measure.json) → native PPTX objects (out/deck.raw.pptx)
 *
 * Unit rules: 1 px (CSS, 96dpi) = 1/96 inch; 1 px = 0.75 pt.
 * Native objects only: text boxes (a:t), shapes, pictures, tables.
 * Features PptxGenJS cannot express (gradFill, custGeom) are emitted with a unique
 * placeholder colour and recorded in out/directives.json for postprocess.mjs.
 */
import PptxGenJS from 'pptxgenjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');

const PX_IN = 1 / 96; // px -> inch
const PX_PT = 0.75; // px -> pt
const E = 914400; // EMU per inch

const CFG = {
  hardLines: !process.argv.includes('--no-hard-lines'),
  textYOffset: Number(process.env.TEXT_Y_OFFSET || 0),
  textXOffset: Number(process.env.TEXT_X_OFFSET || 0),
  svgMode: process.env.SVG_MODE || 'custgeom', // 'custgeom' | 'png'
  fontFace: process.env.FONT_FACE || 'PingFang SC',
};

const r3 = (v) => Math.round(v * 1000) / 1000;
const inch = (px) => Math.round(px * PX_IN * 1e6) / 1e6;
const pt = (px) => r3(px * PX_PT);

function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function mix(fg, bg, a) {
  return fg.map((v, i) => v * a + bg[i] * (1 - a));
}

/** CSS linear-gradient colour at a point (used to blend semi-transparent text over its backdrop). */
function gradientColorAt(g, rect, x, y) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let t;
  if (g.kind === 'radial') {
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    t = d / (0.5 * Math.max(rect.w, rect.h));
  } else {
    const phi = (g.angle * Math.PI) / 180; // DrawingML angle: 0 = to the right, clockwise
    const dx = Math.cos(phi);
    const dy = Math.sin(phi);
    const len = Math.abs(rect.w * dx) + Math.abs(rect.h * dy) || 1;
    t = 0.5 + ((x - cx) * dx + (y - cy) * dy) / len;
  }
  t = Math.max(0, Math.min(1, t));
  const stops = g.stops;
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].pos <= t) i++;
  const a = stops[i];
  const b = stops[Math.min(i + 1, stops.length - 1)];
  const span = b.pos - a.pos || 1;
  const k = Math.max(0, Math.min(1, (t - a.pos) / span));
  const ca = hexToRgb(a.hex);
  const cb = hexToRgb(b.hex);
  return {
    rgb: ca.map((v, j) => v + (cb[j] - v) * k),
    a: a.a + (b.a - a.a) * k,
  };
}

function main() {
  const measure = JSON.parse(fs.readFileSync(path.join(OUT, 'measure.json'), 'utf8'));
  const pptx = new PptxGenJS();
  pptx.author = 'proto-builder';
  pptx.subject = 'HTML slides -> native editable PPTX prototype';
  pptx.title = 'HTML to PPTX prototype';
  const layoutName = 'HTML1280x720';
  pptx.defineLayout({ name: layoutName, width: measure.width * PX_IN, height: measure.height * PX_IN });
  pptx.layout = layoutName;

  // ---- collect every colour used by the design so placeholder markers never collide ----
  const usedColors = new Set();
  const noteColor = (h) => h && usedColors.add(String(h).toUpperCase());
  for (const s of measure.slides) {
    for (const o of s.objects) {
      if (o.fill && o.fill.hex) noteColor(o.fill.hex);
      if (o.fill && o.fill.type === 'gradient') o.fill.value.stops.forEach((st) => noteColor(st.hex));
      if (o.border) noteColor(o.border.hex);
      if (o.color) noteColor(o.color);
      if (o.kind === 'text') o.lines.forEach((l) => l.segments.forEach((sg) => noteColor(sg.style.color)));
      if (o.kind === 'table') o.cells.flat().forEach((c) => { if (c.fill) noteColor(c.fill.hex); noteColor(c.color); if (c.border) noteColor(c.border.hex); });
    }
  }
  let markerSeq = 0;
  function newMarker() {
    for (;;) {
      const i = markerSeq++;
      const hex = 'FE' + i.toString(16).toUpperCase().padStart(2, '0') + 'E0';
      if (!usedColors.has(hex)) {
        usedColors.add(hex);
        return hex;
      }
    }
  }

  const directives = [];
  const stats = {
    slides: 0,
    objects: { text: 0, shape: 0, image: 0, svg: 0, table: 0 },
    svg: { total: 0, custgeom: 0, objectsNative: 0, pngFallback: 0 },
    gradients: 0,
    textObjects: 0,
    textRuns: 0,
    paragraphs: 0,
    textChars: 0,
    hardLines: CFG.hardLines,
    textYOffset: CFG.textYOffset,
  };

  measure.slides.forEach((slideModel, slideIdx) => {
    const slide = pptx.addSlide();
    stats.slides++;

    const backdropAt = (x, y, beforeIndex) => {
      let bg = [255, 255, 255];
      for (let i = 0; i < beforeIndex; i++) {
        const o = slideModel.objects[i];
        if (o.kind !== 'shape' || !o.fill) continue;
        if (!(x >= o.x - 1 && x <= o.x + o.w + 1 && y >= o.y - 1 && y <= o.y + o.h + 1)) continue;
        if (o.fill.type === 'solid') bg = mix(hexToRgb(o.fill.hex), bg, o.fill.a);
        else if (o.fill.type === 'gradient') {
          const c = gradientColorAt(o.fill.value, o, x, y);
          bg = mix(c.rgb, bg, c.a);
        }
      }
      return bg;
    };

    slideModel.objects.forEach((obj, objIdx) => {
      if (obj.kind === 'text') {
        stats.objects.text++;
        stats.textObjects++;
        // hard-lines: one paragraph per visual line (exact reproduction, no reflow).
        // reflow mode (--no-hard-lines): merge wrapped lines back into one paragraph so the
        // text box can re-wrap inside PowerPoint.
        let paraLines;
        if (CFG.hardLines) {
          paraLines = obj.lines.map((ln) => ln.segments);
        } else {
          paraLines = [];
          let cur = [];
          for (let i = 0; i < obj.lines.length; i++) {
            const ln = obj.lines[i];
            if (ln.explicit) {
              if (cur.length) paraLines.push(cur);
              cur = [];
            } else if (cur.length) {
              cur.push({ text: ' ', style: ln.segments[0].style });
            }
            cur = cur.concat(ln.segments);
          }
          if (cur.length) paraLines.push(cur);
        }

        const firstStyle = obj.lines[0].segments[0].style;
        const bgForText = backdropAt(obj.x + Math.min(12, obj.w / 2), obj.y + obj.lineHeight / 2, objIdx);
        const blend = (st) => {
          const fg = hexToRgb(st.color);
          const a = st.colorA ?? 1;
          return a >= 0.999 ? st.color : rgbToHex(mix(fg, bgForText, a));
        };

        const runs = [];
        paraLines.forEach((para, pi) => {
          para.forEach((seg, si) => {
            const st = seg.style || firstStyle;
            const isLastOfPara = si === para.length - 1;
            const opts = {
              fontFace: CFG.fontFace,
              fontSize: pt(st.fontSize),
              color: blend(st),
              bold: !!st.bold,
              italic: !!st.italic,
            };
            if (st.letterSpacing) opts.charSpacing = pt(st.letterSpacing);
            if (isLastOfPara && pi < paraLines.length - 1) opts.breakLine = true;
            runs.push({ text: seg.text, options: opts });
            stats.textRuns++;
          });
          stats.paragraphs++;
        });

        const textOpts = {
          x: inch(obj.x + CFG.textXOffset),
          y: inch(obj.y + CFG.textYOffset),
          w: inch(obj.w),
          h: inch(Math.max(obj.h, obj.lineHeight)),
          margin: 0,
          fit: 'none',
          wrap: CFG.hardLines ? false : true,
          valign: 'top',
          align: obj.align || 'left',
          fontFace: CFG.fontFace,
          fontSize: pt(firstStyle.fontSize),
          color: blend(firstStyle),
          lineSpacing: pt(obj.lineHeight),
          charSpacing: firstStyle.letterSpacing ? pt(firstStyle.letterSpacing) : undefined,
          isTextBox: true,
        };
        slide.addText(runs, textOpts);
        stats.textChars += obj.textChars || 0;
      } else if (obj.kind === 'shape') {
        stats.objects.shape++;
        let shapeType = 'rect';
        let rectRadius = 0;
        if (obj.radius > 0.5) {
          shapeType = 'roundRect';
          rectRadius = inch(Math.min(obj.radius, Math.min(obj.w, obj.h) / 2));
        }
        const opts = { x: inch(obj.x), y: inch(obj.y), w: inch(obj.w), h: inch(obj.h) };
        let needPost = false;
        if (obj.fill && obj.fill.type === 'gradient') {
          const marker = newMarker();
          opts.fill = { color: marker };
          directives.push({ slide: slideIdx + 1, kind: 'gradient', marker, gradient: obj.fill.value });
          stats.gradients++;
          needPost = true;
        } else if (obj.fill && obj.fill.type === 'solid') {
          opts.fill = { color: obj.fill.hex, transparency: Math.round((1 - obj.fill.a) * 100) };
        } else {
          opts.fill = { type: 'none' };
        }
        if (obj.border) {
          opts.line = {
            color: obj.border.hex,
            width: pt(obj.border.width),
            transparency: Math.round((1 - obj.border.a) * 100),
          };
        } else {
          opts.line = { type: 'none' };
        }
        if (obj.shadow) {
          opts.shadow = {
            type: 'outer',
            color: obj.shadow.color,
            opacity: obj.shadow.opacity,
            blur: pt(obj.shadow.blur),
            offset: pt(obj.shadow.distance),
            angle: obj.shadow.angle,
          };
        }
        if (needPost) {
          // marker fill must stay reachable by postprocess; record geometry too
          directives[directives.length - 1].shape = { x: obj.x, y: obj.y, w: obj.w, h: obj.h, shapeType, rectRadius };
        }
        slide.addShape(shapeType, { ...opts, rectRadius });
      } else if (obj.kind === 'image') {
        stats.objects.image++;
        let src = obj.src;
        const imgOpts = { x: inch(obj.x), y: inch(obj.y), w: inch(obj.w), h: inch(obj.h) };
        // object-fit: cover / contain → PptxGenJS 原生 sizing（对应 a:srcRect 裁剪 / 等比内缩）
        if (obj.fit === 'cover' || obj.fit === 'contain') {
          imgOpts.sizing = { type: obj.fit, w: inch(obj.w), h: inch(obj.h) };
          delete imgOpts.w; delete imgOpts.h;
        }
        if (src.startsWith('data:')) imgOpts.data = src;
        else if (src.startsWith('file://')) imgOpts.path = fileURLToPathSafe(src);
        else imgOpts.path = src;
        slide.addImage(imgOpts);
      } else if (obj.kind === 'svg') {
        stats.objects.svg++;
        stats.svg.total++;
        if (CFG.svgMode === 'custgeom' && obj.geometry && obj.geometry.supported) {
          stats.svg.custgeom++;
          stats.svg.objectsNative++;
          // 一个 SVG 可能拆成多组（颜色/线宽不同）→ 每组一个原生形状，叠放顺序 = DOM 顺序
          for (const group of (obj.geometry.groups || [])) {
            const marker = newMarker();
            slide.addShape('rect', {
              x: inch(obj.x), y: inch(obj.y), w: inch(obj.w), h: inch(obj.h),
              fill: { color: marker }, line: { type: 'none' },
            });
            directives.push({
              slide: slideIdx + 1, kind: 'custgeom', marker, group,
              geometry: obj.geometry, rect: { x: obj.x, y: obj.y, w: obj.w, h: obj.h },
            });
          }
          // circle / ellipse → 原生椭圆形状（不参与 custGeom）
          for (const c of (obj.geometry.circles || [])) {
            const shapeOpts = {
              x: inch(obj.x + c.x), y: inch(obj.y + c.y), w: inch(Math.max(c.w, 0.5)), h: inch(Math.max(c.h, 0.5)),
            };
            if (c.fillHex) shapeOpts.fill = { color: c.fillHex, transparency: Math.round((1 - (c.fillA ?? 1)) * 100) };
            else shapeOpts.fill = { type: 'none' };
            if (c.strokeHex) shapeOpts.line = { color: c.strokeHex, width: Math.max(0.25, (c.strokeWidth || 1) * 0.75), transparency: Math.round((1 - (c.strokeA ?? 1)) * 100) };
            else shapeOpts.line = { type: 'none' };
            slide.addShape('ellipse', shapeOpts);
            stats.svg.custgeom++;
          }
        } else {
          stats.svg.pngFallback++;
          slide.addImage({ data: obj.raster4x.dataUri, x: inch(obj.x), y: inch(obj.y), w: inch(obj.w), h: inch(obj.h) });
        }
      } else if (obj.kind === 'table') {
        stats.objects.table++;
        const rows = obj.cells.map((row) =>
          row.map((cell) => ({
            text: cell.text,
            options: {
              fontFace: CFG.fontFace,
              fontSize: pt(cell.fontSize),
              color: cell.color,
              bold: !!cell.bold,
              align: cell.align || 'left',
              valign: 'middle',
              fill: cell.fill ? { color: cell.fill.hex, transparency: Math.round((1 - cell.fill.a) * 100) } : { type: 'none' },
              margin: [inch(cell.padding[0]), inch(cell.padding[1]), inch(cell.padding[2]), inch(cell.padding[3])].map(r3),
              border: cell.border
                ? { type: 'solid', pt: pt(cell.border.width), color: cell.border.hex }
                : { type: 'none' },
            },
          })),
        );
        const totalW = obj.colW.reduce((a, b) => a + b, 0);
        slide.addTable(rows, {
          x: inch(obj.x),
          y: inch(obj.y),
          w: inch(totalW),
          colW: obj.colW.map(inch),
          rowH: obj.rowH.map(inch),
          margin: 0,
          border: { type: 'solid', pt: 0.75, color: 'E2E8F0' },
          fontFace: CFG.fontFace,
          fontSize: pt(obj.cells[0][0].fontSize),
          valign: 'middle',
          autoPage: false,
        });
      }
    });
    stats.objects.text += 0; // keep shape stable
  });

  const rawPath = path.join(OUT, 'deck.raw.pptx');
  // pptxgenjs writes asynchronously
  // DEFLATE-compress every zip entry: PowerPoint/WPS are unreliable with STORE-only decks
  return pptx.writeFile({ fileName: rawPath, compression: true }).then(() => {
    fs.writeFileSync(path.join(OUT, 'directives.json'), JSON.stringify({ directives, config: CFG }, null, 1));
    fs.writeFileSync(path.join(OUT, 'convert_stats.json'), JSON.stringify(stats, null, 1));
    console.log(
      `[convert] slides=${stats.slides} text=${stats.objects.text} shape=${stats.objects.shape} ` +
        `image=${stats.objects.image} svg=${stats.objects.svg}(nativeObj=${stats.svg.objectsNative},shapes=${stats.svg.custgeom},png=${stats.svg.pngFallback}) ` +
        `table=${stats.objects.table} gradient=${stats.gradients} textRuns=${stats.textRuns} paragraphs=${stats.paragraphs} => ${path.relative(ROOT, rawPath)}`,
    );
  });
}

function fileURLToPathSafe(u) {
  try {
    return fileURLToPath(u);
  } catch {
    return u.replace(/^file:\/\//, '');
  }
}

main().catch((err) => {
  console.error('[convert] FAILED', err);
  process.exit(1);
});
