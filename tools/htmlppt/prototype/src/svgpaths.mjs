/**
 * svgpaths.mjs — SVG `path/@d` parser with curves, and the arc -> cubic-bezier math.
 *
 * Output model: a flat list of **absolute** commands, one per drawing segment:
 *   { t: 'M', x, y }                          moveTo
 *   { t: 'L', x, y }                          lineTo (H/V are folded into L)
 *   { t: 'C', x1, y1, x2, y2, x, y }          cubic bezier (Q/T/S and A are folded into C)
 *   { t: 'Z' }                                close
 * Coordinates are in SVG user units (viewBox space), exactly as written in `d`.
 *
 * Supported grammar: M m L l H h V v C c S s Q q T t A a Z z
 *   - implicit command repetition (`M 0 0 10 0 20 0`, `c ... ...`)
 *   - relative -> absolute folding
 *   - S/s: first control point = reflection of the previous cubic's second control point
 *   - Q/q, T/t: exact quadratic -> cubic elevation (control points at 2/3)
 *   - A/a: SVG spec F.6.5 endpoint -> center parameterisation, then an adaptive
 *          cubic-bezier subdivision whose error is checked in **unit-circle space**
 *          and converted to px with `rmax` (default tolerance 0.1px).
 *
 * This module is dependency free and side-effect free: it is imported by the Node side
 * (tests) *and* injected verbatim into the headless browser page by measure.mjs, where
 * `export` keywords are stripped at runtime. Keep it ES2019-only, no imports, no `window`.
 *
 * Not handled here (measure.mjs detects these and falls back to a 4x PNG for the whole SVG):
 *   - transform="matrix/rotate/scale" on the svg/path/shape/group (no CTM application)
 *   - `<use>`, nested `<svg>`, clipPath/mask/pattern/marker, paint servers (url(#…))
 * Arc flags must be exactly 0/1 (SVG spec). The compact form `a5 5 0 0110 0` is therefore
 * rejected (-> null -> PNG fallback) instead of being silently misread as 110.
 */

/** Default radial tolerance for `A` -> cubic conversion, in viewBox px. */
export const PATH_TOLERANCE = 0.1;

/** Largest recursion cap for the adaptive arc subdivision. */
const MAX_ARC_SEGMENTS = 8192;

const CMD_RE = /([MmZzLlHhVvCcSsQqTtAa])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

/**
 * Split path data into command letters and numbers.
 * @param {string} d
 * @returns {Array<string|number>}
 */
export function tokenizePath(d) {
  const toks = [];
  CMD_RE.lastIndex = 0;
  let m;
  while ((m = CMD_RE.exec(d))) toks.push(m[1] ? m[1] : parseFloat(m[2]));
  return toks;
}

/**
 * Exact quadratic -> cubic elevation: C1 = P0 + 2/3 (Q - P0), C2 = P1 + 2/3 (Q - P1).
 * @param {{x:number,y:number}} p0
 * @param {{x:number,y:number}} q
 * @param {{x:number,y:number}} p1
 * @returns {{c1:{x:number,y:number}, c2:{x:number,y:number}, p:{x:number,y:number}}}
 */
export function quadToCubic(p0, q, p1) {
  const k = 2 / 3;
  return {
    c1: { x: p0.x + k * (q.x - p0.x), y: p0.y + k * (q.y - p0.y) },
    c2: { x: p1.x + k * (q.x - p1.x), y: p1.y + k * (q.y - p1.y) },
    p: { x: p1.x, y: p1.y },
  };
}

/**
 * SVG spec F.6.5 step 1: endpoint parameterisation -> center parameterisation.
 *
 * @param {number} x1 start point x
 * @param {number} y1 start point y
 * @param {number} rx radius x (as written; sign ignored, too-small radii scaled up)
 * @param {number} ry radius y
 * @param {number} phiDeg x-axis rotation in degrees
 * @param {boolean} largeArc large-arc-flag
 * @param {boolean} sweep sweep-flag
 * @param {number} x2 end point x
 * @param {number} y2 end point y
 * @returns {null|{cx:number,cy:number,rx:number,ry:number,phi:number,th1:number,dth:number}}
 *          null means "draw a straight line instead" (F.6.2: coincident endpoints are a
 *          no-op, a zero radius is a line) — F.6.6 "out-of-range radii" is fixed here by
 *          scaling rx/ry up, per the spec.
 */
export function arcCenterParams(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return null;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return null;

  const phi = (phiDeg % 360) * (Math.PI / 180);
  const cosp = Math.cos(phi);
  const sinp = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosp * dx2 + sinp * dy2;
  const y1p = -sinp * dx2 + cosp * dy2;

  // F.6.6: scale the radii up when they are too small to span the endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  if (den === 0) return null;
  let co = Math.sqrt(Math.max(0, num / den));
  if (!!largeArc === !!sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2;
  const cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (n === 0) return 0;
    const a = Math.acos(Math.max(-1, Math.min(1, dot / n)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const th1 = angle(1, 0, ux, uy);
  let dth = angle(ux, uy, vx, vy);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;

  return { cx, cy, rx, ry, phi, th1, dth };
}

/** Cubic bezier evaluation. */
function bezPoint(p0, c1, c2, p1, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
}

/**
 * Convert one SVG elliptical arc into cubic beziers (SVG spec F.6.5 + adaptive split).
 *
 * The circle is parameterised in **unit-circle space** (cos t, sin t); the approximation
 * error is measured there as |dist(bezier(t)) - 1| and multiplied by `rmax` to become a
 * px error — this is the affine-invariant way to bound the error of the transformed
 * ellipse. Each segment is then mapped to ellipse space (scale + rotate + translate).
 * Segments start at <= 90 degrees and double until the sampled error <= tol.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} rx
 * @param {number} ry
 * @param {number} phiDeg
 * @param {boolean} largeArc
 * @param {boolean} sweep
 * @param {number} x2
 * @param {number} y2
 * @param {number} [tol] radial tolerance in px
 * @returns {null|Array<{c1:{x:number,y:number}, c2:{x:number,y:number}, p:{x:number,y:number}}>}
 *          null = degenerate arc, caller should emit a straight line;
 *          []   = zero-length arc, caller should emit nothing.
 */
export function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2, tol) {
  const limit = tol === undefined ? PATH_TOLERANCE : tol;
  const cp = arcCenterParams(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2);
  if (!cp) return null;
  const { cx, cy, phi, th1, dth } = cp;
  const erx = cp.rx;
  const ery = cp.ry;
  if (Math.abs(dth) < 1e-12) return [];

  const cosp = Math.cos(phi);
  const sinp = Math.sin(phi);
  const rmax = Math.max(erx, ery);
  // unit circle -> ellipse space (scale, rotate, translate)
  const E = (p) => [
    cx + cosp * erx * p[0] - sinp * ery * p[1],
    cy + sinp * erx * p[0] + cosp * ery * p[1],
  ];

  let n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  let unitSegs = [];
  for (let iter = 0; iter < 10; iter++) {
    const seg = dth / n;
    const tanHalf = Math.tan(seg / 2);
    const alpha = (Math.sin(seg) * (Math.sqrt(4 + 3 * tanHalf * tanHalf) - 1)) / 3;
    unitSegs = [];
    for (let k = 0; k < n; k++) {
      const t1 = th1 + seg * k;
      const t2 = t1 + seg;
      const s1 = Math.sin(t1);
      const c1 = Math.cos(t1);
      const s2 = Math.sin(t2);
      const c2 = Math.cos(t2);
      unitSegs.push([
        [c1, s1],
        [c1 - alpha * s1, s1 + alpha * c1],
        [c2 + alpha * s2, s2 - alpha * c2],
        [c2, s2],
      ]);
    }
    // Error check in unit-circle space; rmax turns it into px.
    let worst = 0;
    for (const [p0, c1, c2, p2] of unitSegs) {
      for (const t of [0.25, 0.5, 0.75]) {
        const b = bezPoint(p0, c1, c2, p2, t);
        const err = Math.abs(Math.hypot(b[0], b[1]) - 1);
        if (err > worst) worst = err;
      }
    }
    if (worst * rmax <= limit || n >= MAX_ARC_SEGMENTS) break;
    n *= 2;
  }

  return unitSegs.map((seg) => {
    const c1 = E(seg[1]);
    const c2 = E(seg[2]);
    const p = E(seg[3]);
    return { c1: { x: c1[0], y: c1[1] }, c2: { x: c2[0], y: c2[1] }, p: { x: p[0], y: p[1] } };
  });
}

/**
 * Parse path data into absolute M/L/C/Z commands.
 *
 * @param {string} d path data
 * @param {{tolerance?: number}} [opts]
 * @returns {null|{cmds: Array<object>, closed: boolean, subpaths: number}}
 *          null = unparsable (unknown token, missing numbers, NaN); the caller must fall
 *          back to a raster image rather than silently drawing a truncated path.
 */
export function parsePathD(d, opts) {
  if (typeof d !== 'string') return null;
  const tol = opts && typeof opts.tolerance === 'number' ? opts.tolerance : PATH_TOLERANCE;
  const toks = tokenizePath(d);
  if (!toks.length) return null;

  const cmds = [];
  let i = 0;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let prevC2 = null; // previous cubic's 2nd control point (for S/s)
  let prevQ = null; // previous quadratic's control point (for T/t)
  let lastCmd = null;
  let closed = false;
  let subpaths = 0;

  const fail = () => {
    throw new Error('bad path data');
  };
  const num = () => {
    const v = toks[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) fail();
    i++;
    return v;
  };

  try {
    while (i < toks.length) {
      let cmd;
      if (typeof toks[i] === 'string') {
        cmd = toks[i];
        i++;
      } else {
        // Implicit repetition of the previous command (M -> L, m -> l).
        if (!lastCmd || lastCmd === 'Z' || lastCmd === 'z') return null;
        cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
      }
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();

      if (C === 'Z') {
        cmds.push({ t: 'Z' });
        closed = true;
        x = sx;
        y = sy;
        prevC2 = null;
        prevQ = null;
      } else if (C === 'M') {
        const nx = num();
        const ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        sx = x;
        sy = y;
        subpaths++;
        cmds.push({ t: 'M', x, y });
        prevC2 = null;
        prevQ = null;
      } else if (C === 'L') {
        const nx = num();
        const ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        cmds.push({ t: 'L', x, y });
        prevC2 = null;
        prevQ = null;
      } else if (C === 'H') {
        const nx = num();
        x = rel ? x + nx : nx;
        cmds.push({ t: 'L', x, y });
        prevC2 = null;
        prevQ = null;
      } else if (C === 'V') {
        const ny = num();
        y = rel ? y + ny : ny;
        cmds.push({ t: 'L', x, y });
        prevC2 = null;
        prevQ = null;
      } else if (C === 'C') {
        const ax = num();
        const ay = num();
        const bx = num();
        const by = num();
        const nx = num();
        const ny = num();
        const x1 = rel ? x + ax : ax;
        const y1 = rel ? y + ay : ay;
        const x2 = rel ? x + bx : bx;
        const y2 = rel ? y + by : by;
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        cmds.push({ t: 'C', x1, y1, x2, y2, x, y });
        prevC2 = { x: x2, y: y2 };
        prevQ = null;
      } else if (C === 'S') {
        const bx = num();
        const by = num();
        const nx = num();
        const ny = num();
        const x1 = prevC2 ? 2 * x - prevC2.x : x;
        const y1 = prevC2 ? 2 * y - prevC2.y : y;
        const x2 = rel ? x + bx : bx;
        const y2 = rel ? y + by : by;
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        cmds.push({ t: 'C', x1, y1, x2, y2, x, y });
        prevC2 = { x: x2, y: y2 };
        prevQ = null;
      } else if (C === 'Q') {
        const qx = num();
        const qy = num();
        const nx = num();
        const ny = num();
        const q = { x: rel ? x + qx : qx, y: rel ? y + qy : qy };
        const p = { x: rel ? x + nx : nx, y: rel ? y + ny : ny };
        const c = quadToCubic({ x, y }, q, p);
        cmds.push({ t: 'C', x1: c.c1.x, y1: c.c1.y, x2: c.c2.x, y2: c.c2.y, x: p.x, y: p.y });
        x = p.x;
        y = p.y;
        prevQ = q;
        prevC2 = null;
      } else if (C === 'T') {
        const nx = num();
        const ny = num();
        const q = prevQ ? { x: 2 * x - prevQ.x, y: 2 * y - prevQ.y } : { x, y };
        const p = { x: rel ? x + nx : nx, y: rel ? y + ny : ny };
        const c = quadToCubic({ x, y }, q, p);
        cmds.push({ t: 'C', x1: c.c1.x, y1: c.c1.y, x2: c.c2.x, y2: c.c2.y, x: p.x, y: p.y });
        x = p.x;
        y = p.y;
        prevQ = q;
        prevC2 = null;
      } else if (C === 'A') {
        const rx = num();
        const ry = num();
        const rot = num();
        const laf = num();
        const swf = num();
        // SVG spec: the two flags are exactly 0 or 1. Anything else means the tokenizer
        // lost a separator (e.g. `a5 5 0 0110 0`) -> refuse instead of drawing nonsense.
        if ((laf !== 0 && laf !== 1) || (swf !== 0 && swf !== 1)) fail();
        const nx = num();
        const ny = num();
        const ex = rel ? x + nx : nx;
        const ey = rel ? y + ny : ny;
        const segs = arcToCubics(x, y, rx, ry, rot, laf !== 0, swf !== 0, ex, ey, tol);
        if (segs === null) {
          // F.6.2: zero radius -> straight line (coincident endpoints draw nothing).
          if (ex !== x || ey !== y) cmds.push({ t: 'L', x: ex, y: ey });
        } else {
          for (const s of segs) {
            cmds.push({ t: 'C', x1: s.c1.x, y1: s.c1.y, x2: s.c2.x, y2: s.c2.y, x: s.p.x, y: s.p.y });
          }
        }
        x = ex;
        y = ey;
        prevC2 = null;
        prevQ = null;
      } else {
        return null;
      }
      lastCmd = cmd;
    }
  } catch {
    return null;
  }

  if (!cmds.length) return null;
  // A path must start with a moveto; browsers drop leading garbage the same way.
  if (cmds[0].t !== 'M') return null;
  return { cmds, closed, subpaths };
}

/**
 * Rectangle -> commands, honouring `rx`/`ry` (SVG 1.1 §9.2 auto-rules).
 * Corners become the same adaptive cubics as an `A` command.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} [rx]
 * @param {number} [ry]
 * @param {number} [tol]
 * @returns {Array<object>}
 */
export function rectPath(x, y, w, h, rx, ry, tol) {
  if (!(w > 0) || !(h > 0)) return [];
  let rx0 = Number(rx) || 0;
  let ry0 = Number(ry) || 0;
  if (rx0 > 0 && !(ry0 > 0)) ry0 = rx0;
  if (ry0 > 0 && !(rx0 > 0)) rx0 = ry0;
  rx0 = Math.min(Math.abs(rx0), w / 2);
  ry0 = Math.min(Math.abs(ry0), h / 2);
  if (!(rx0 > 0) || !(ry0 > 0)) {
    return [
      { t: 'M', x, y },
      { t: 'L', x: x + w, y },
      { t: 'L', x: x + w, y: y + h },
      { t: 'L', x, y: y + h },
      { t: 'Z' },
    ];
  }
  const cmds = [
    { t: 'M', x: x + rx0, y },
    { t: 'L', x: x + w - rx0, y },
  ];
  const arcTo = (fromX, fromY, toX, toY) => {
    const segs = arcToCubics(fromX, fromY, rx0, ry0, 0, false, true, toX, toY, tol);
    if (segs) for (const s of segs) cmds.push({ t: 'C', x1: s.c1.x, y1: s.c1.y, x2: s.c2.x, y2: s.c2.y, x: s.p.x, y: s.p.y });
    else cmds.push({ t: 'L', x: toX, y: toY });
  };
  // top-right
  arcTo(x + w - rx0, y, x + w, y + ry0);
  cmds.push({ t: 'L', x: x + w, y: y + h - ry0 });
  arcTo(x + w, y + h - ry0, x + w - rx0, y + h);
  cmds.push({ t: 'L', x: x + rx0, y: y + h });
  arcTo(x + rx0, y + h, x, y + h - ry0);
  cmds.push({ t: 'L', x, y: y + ry0 });
  arcTo(x, y + ry0, x + rx0, y);
  cmds.push({ t: 'Z' });
  return cmds;
}
