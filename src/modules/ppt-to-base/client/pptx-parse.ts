// PPTX（OOXML zip）→ SceneModel 的浏览器端解析。XML 一律走原生 DOMParser，按 localName 匹配，不绑命名空间前缀。
// 划界见模块 README：文字只收槽位不画字形；graphicFrame（表格/图表/SmartArt）跳过计数。

import type JSZip from "jszip";
import {
  applyColorTransforms,
  geomWithFallback,
  inferSlotRole,
  normalizeSlot,
  resolvePrstColor,
  resolveSchemeColor,
  resolveSysColor,
  resolveZipPath,
  type ColorTransforms,
  type FillSpec,
  type LineSpec,
  type PicNode,
  type SceneModel,
  type SceneNode,
  type ShapeNode,
  type ThemeScheme,
} from "./pptx-model";

export interface ParsedDeck {
  slides: SceneModel[];
}

const MAX_SLIDES = 40;

function kids(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === name);
}

function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  return Array.from(el.children).find((c) => c.localName === name) ?? null;
}

/** 按 localName 取属性（兼容 r:embed 这类带前缀属性）。 */
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) {
    if (a.localName === name) return a.value;
  }
  return null;
}

function numAttr(el: Element | null | undefined, name: string): number | null {
  const raw = attr(el, name);
  if (raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function parseXml(text: string, label: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`${label} 解析失败，文件可能已损坏`);
  }
  return doc;
}

async function readXml(zip: JSZip, path: string, label: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  return parseXml(await file.async("string"), label);
}

// ---------- 颜色 ----------

const COLOR_TAGS = new Set(["srgbClr", "schemeClr", "prstClr", "sysClr"]);

/** 容器直接子级里的颜色元素（含 tint/shade/lumMod/lumOff/satMod/alpha 变换）。 */
function parseColorEl(container: Element, scheme: ThemeScheme): { color: string; alpha: number } | null {
  const colorEl = Array.from(container.children).find((c) => COLOR_TAGS.has(c.localName));
  if (!colorEl) return null;
  let hex: string;
  if (colorEl.localName === "srgbClr") {
    hex = `#${(attr(colorEl, "val") ?? "000000").toLowerCase()}`;
  } else if (colorEl.localName === "schemeClr") {
    hex = resolveSchemeColor(attr(colorEl, "val") ?? "", scheme);
  } else if (colorEl.localName === "prstClr") {
    hex = resolvePrstColor(attr(colorEl, "val") ?? "");
  } else {
    hex = resolveSysColor(attr(colorEl, "val") ?? "", attr(colorEl, "lastClr"));
  }
  const t: ColorTransforms = {};
  for (const c of Array.from(colorEl.children)) {
    const v = numAttr(c, "val");
    if (v === null) continue;
    const f = v / 100000;
    if (c.localName === "tint") t.tint = f;
    else if (c.localName === "shade") t.shade = f;
    else if (c.localName === "lumMod") t.lumMod = f;
    else if (c.localName === "lumOff") t.lumOff = f;
    else if (c.localName === "satMod") t.satMod = f;
    else if (c.localName === "alpha") t.alpha = f;
  }
  return applyColorTransforms(hex, t);
}

// ---------- 填充 / 描边 ----------

function parseGradient(el: Element, scheme: ThemeScheme): FillSpec {
  const gsLst = kid(el, "gsLst");
  const stops = gsLst
    ? kids(gsLst, "gs")
        .map((gs) => {
          const col = parseColorEl(gs, scheme);
          const pos = numAttr(gs, "pos") ?? 0;
          return col ? { pos: Math.min(1, Math.max(0, pos / 100000)), color: col.color, alpha: col.alpha } : null;
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .sort((a, b) => a.pos - b.pos)
    : [];
  if (stops.length < 2) return { kind: "none" };
  const lin = kid(el, "lin");
  const angle = (numAttr(lin, "ang") ?? 5400000) / 60000;
  return { kind: "gradient", angle, stops };
}

function blipRelId(container: Element): string | null {
  const blips = container.getElementsByTagNameNS("*", "blip");
  for (const blip of Array.from(blips)) {
    const rel = attr(blip, "embed") ?? attr(blip, "link");
    if (rel) return rel;
  }
  return null;
}

/** 形状/背景填充；spPr 无显式填充时回退 a:style 的 fillRef 引用色。 */
function parseFill(spPr: Element | null, styleEl: Element | null, scheme: ThemeScheme): FillSpec {
  if (spPr) {
    for (const c of Array.from(spPr.children)) {
      if (c.localName === "noFill") return { kind: "none" };
      if (c.localName === "solidFill") {
        const col = parseColorEl(c, scheme);
        return col ? { kind: "solid", color: col.color, alpha: col.alpha } : { kind: "none" };
      }
      if (c.localName === "gradFill") return parseGradient(c, scheme);
      if (c.localName === "blipFill") {
        const relId = blipRelId(c);
        return relId ? { kind: "image", relId } : { kind: "none" };
      }
      if (c.localName === "pattFill") {
        const fg = kid(c, "fgClr");
        const col = fg ? parseColorEl(fg, scheme) : null;
        return col ? { kind: "solid", color: col.color, alpha: col.alpha } : { kind: "none" };
      }
    }
  }
  const fillRef = kid(styleEl, "fillRef");
  if (fillRef && (numAttr(fillRef, "idx") ?? 0) > 0) {
    const col = parseColorEl(fillRef, scheme);
    if (col) return { kind: "solid", color: col.color, alpha: col.alpha };
  }
  return { kind: "none" };
}

function parseLine(spPr: Element | null, scheme: ThemeScheme): LineSpec | null {
  const ln = kid(spPr, "ln");
  if (!ln || kid(ln, "noFill")) return null;
  const solid = kid(ln, "solidFill");
  const col = solid ? parseColorEl(solid, scheme) : null;
  if (!col) return null;
  return { color: col.color, alpha: col.alpha, widthEmu: numAttr(ln, "w") ?? 9525 };
}

// ---------- 几何变换 ----------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

function parseXfrm(spPr: Element | null): Rect | null {
  const xfrm = kid(spPr, "xfrm");
  if (!xfrm) return null;
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  const x = numAttr(off, "x");
  const y = numAttr(off, "y");
  const w = numAttr(ext, "cx");
  const h = numAttr(ext, "cy");
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h, rot: (numAttr(xfrm, "rot") ?? 0) / 60000 };
}

/** 组内坐标 → 外层坐标的 2D 缩放+平移矩阵（组旋转 v1 不支持）。 */
interface Matrix {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

const IDENTITY: Matrix = { sx: 1, sy: 1, tx: 0, ty: 0 };

function groupMatrix(parent: Matrix, grpSpPr: Element | null): Matrix {
  const xfrm = kid(grpSpPr, "xfrm");
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  const chOff = kid(xfrm, "chOff");
  const chExt = kid(xfrm, "chExt");
  const cx = numAttr(chExt, "cx");
  const cy = numAttr(chExt, "cy");
  if (!cx || !cy) return parent;
  const sx = (numAttr(ext, "cx") ?? cx) / cx;
  const sy = (numAttr(ext, "cy") ?? cy) / cy;
  const ox = numAttr(off, "x") ?? 0;
  const oy = numAttr(off, "y") ?? 0;
  const chx = numAttr(chOff, "x") ?? 0;
  const chy = numAttr(chOff, "y") ?? 0;
  return {
    sx: parent.sx * sx,
    sy: parent.sy * sy,
    tx: parent.sx * (ox - chx * sx) + parent.tx,
    ty: parent.sy * (oy - chy * sy) + parent.ty,
  };
}

function applyMatrix(m: Matrix, r: Rect): Rect {
  return {
    x: m.sx * r.x + m.tx,
    y: m.sy * r.y + m.ty,
    w: m.sx * r.w,
    h: m.sy * r.h,
    rot: r.rot,
  };
}

// ---------- 文本槽位 ----------

function textInfo(sp: Element): { hasText: boolean; maxPt: number | null } {
  const txBody = kid(sp, "txBody");
  if (!txBody) return { hasText: false, maxPt: null };
  let hasText = false;
  for (const t of Array.from(txBody.getElementsByTagNameNS("*", "t"))) {
    if ((t.textContent ?? "").trim()) {
      hasText = true;
      break;
    }
  }
  let maxPt: number | null = null;
  for (const tag of ["rPr", "defRPr", "endParaRPr"]) {
    for (const el of Array.from(txBody.getElementsByTagNameNS("*", tag))) {
      const sz = numAttr(el, "sz");
      if (sz !== null) maxPt = Math.max(maxPt ?? 0, sz / 100);
    }
  }
  return { hasText, maxPt };
}

function phOf(sp: Element, nvTag: string): { type: string | null; idx: string | null } {
  const ph = kid(kid(kid(sp, nvTag), "nvPr"), "ph");
  return ph ? { type: attr(ph, "type"), idx: attr(ph, "idx") } : { type: null, idx: null };
}

// ---------- rels ----------

/** 解析某 part 的 .rels：rId → zip 内路径（外链跳过）。 */
async function parseRels(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const dir = partPath.slice(0, partPath.lastIndexOf("/"));
  const name = partPath.slice(partPath.lastIndexOf("/") + 1);
  const doc = await readXml(zip, `${dir}/_rels/${name}.rels`, "关系表");
  const map = new Map<string, string>();
  if (!doc) return map;
  for (const rel of Array.from(doc.getElementsByTagNameNS("*", "Relationship"))) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target || attr(rel, "TargetMode") === "External") continue;
    map.set(id, resolveZipPath(dir, target));
  }
  return map;
}

// ---------- 主题 / 版式 ----------

async function parseThemeScheme(zip: JSZip): Promise<ThemeScheme> {
  const themePath =
    zip.file("ppt/theme/theme1.xml") !== null
      ? "ppt/theme/theme1.xml"
      : Object.keys(zip.files).find((p) => /^ppt\/theme\/theme\d+\.xml$/.test(p)) ?? null;
  if (!themePath) return {};
  const doc = await readXml(zip, themePath, "主题");
  const scheme: ThemeScheme = {};
  const clrScheme = doc?.getElementsByTagNameNS("*", "clrScheme")[0];
  if (!clrScheme) return scheme;
  for (const slot of Array.from(clrScheme.children)) {
    const col = parseColorEl(slot, scheme);
    if (col) scheme[slot.localName] = col.color;
  }
  return scheme;
}

type LayoutPhMap = Map<string, Rect>;

/** 版式占位符几何表（type:idx → 矩形），供幻灯片里缺 xfrm 的占位符继承位置。 */
async function layoutPlaceholders(zip: JSZip, layoutPath: string): Promise<LayoutPhMap> {
  const map: LayoutPhMap = new Map();
  const doc = await readXml(zip, layoutPath, "版式");
  if (!doc) return map;
  for (const sp of Array.from(doc.getElementsByTagNameNS("*", "sp"))) {
    const ph = phOf(sp, "nvSpPr");
    const rect = parseXfrm(kid(sp, "spPr"));
    if (!rect) continue;
    if (!ph.type && ph.idx === null) continue;
    map.set(`${ph.type ?? "body"}:${ph.idx ?? ""}`, rect);
  }
  return map;
}

function inheritPhRect(ph: { type: string | null; idx: string | null }, layoutPh: LayoutPhMap): Rect | null {
  if (!ph.type && ph.idx === null) return null;
  return (
    layoutPh.get(`${ph.type ?? "body"}:${ph.idx ?? ""}`) ??
    layoutPh.get(`${ph.type ?? "body"}:`) ??
    layoutPh.get(`body:${ph.idx ?? ""}`) ??
    null
  );
}

/** 背景填充：bgPr 走完整填充解析，bgRef 退化为引用色的纯色。 */
function parseBackground(root: Document, scheme: ThemeScheme): FillSpec | null {
  const bg = root.getElementsByTagNameNS("*", "bg")[0];
  if (!bg) return null;
  const bgPr = kid(bg, "bgPr");
  if (bgPr) {
    const fill = parseFill(bgPr, null, scheme);
    if (fill.kind !== "none") return fill;
  }
  const bgRef = kid(bg, "bgRef");
  const col = bgRef ? parseColorEl(bgRef, scheme) : null;
  return col ? { kind: "solid", color: col.color, alpha: col.alpha } : null;
}

// ---------- 形状树 ----------

interface WalkCtx {
  scheme: ThemeScheme;
  layoutPh: LayoutPhMap;
  slideW: number;
  slideH: number;
  slots: SceneModel["slots"];
  skipped: { count: number };
}

function walkShape(sp: Element, nvTag: string, matrix: Matrix, ctx: WalkCtx, nodes: SceneNode[]): void {
  const spPr = kid(sp, "spPr");
  const ph = phOf(sp, nvTag);
  const local = parseXfrm(spPr);
  const rect = local ?? inheritPhRect(ph, ctx.layoutPh);
  if (!rect || rect.w <= 0 || rect.h <= 0) return;
  const placed = local ? applyMatrix(matrix, rect) : rect;
  const styleEl = kid(sp, "style");
  const prstGeom = kid(spPr, "prstGeom");
  const geomName = geomWithFallback(attr(prstGeom, "prst"));
  const gd = kid(kid(prstGeom, "avLst"), "gd");
  const fmla = attr(gd, "fmla") ?? "";
  const adjMatch = /val\s+(\d+)/.exec(fmla);
  const geomAdj = adjMatch ? Number(adjMatch[1]) : null;
  const fill = parseFill(spPr, styleEl, ctx.scheme);
  const line = parseLine(spPr, ctx.scheme);
  const { hasText, maxPt } = textInfo(sp);
  if (hasText) {
    const norm = normalizeSlot(placed.x, placed.y, placed.w, placed.h, ctx.slideW, ctx.slideH);
    if (norm.w > 0 && norm.h > 0) {
      ctx.slots.push({ ...norm, role: inferSlotRole(ph.type, maxPt), phType: ph.type });
    }
  }
  const isLine = geomName === "line";
  if (fill.kind === "none" && !line && hasText && !isLine) return; // 纯文本框：底座上不留痕迹
  const node: ShapeNode = {
    kind: "shape",
    geom: geomName,
    geomAdj,
    x: placed.x,
    y: placed.y,
    w: placed.w,
    h: placed.h,
    rot: placed.rot,
    fill,
    line,
  };
  nodes.push(node);
}

function walkPic(pic: Element, matrix: Matrix, nodes: SceneNode[]): void {
  const spPr = kid(pic, "spPr");
  const rect = parseXfrm(spPr);
  if (!rect || rect.w <= 0 || rect.h <= 0) return;
  const placed = applyMatrix(matrix, rect);
  const blipFill = kid(pic, "blipFill");
  const relId = blipFill ? blipRelId(blipFill) : null;
  if (!relId) return;
  const src = kid(blipFill, "srcRect");
  const frac = (name: string) => (numAttr(src, name) ?? 0) / 100000;
  const node: PicNode = {
    kind: "pic",
    x: placed.x,
    y: placed.y,
    w: placed.w,
    h: placed.h,
    rot: placed.rot,
    relId,
    srcRect: src ? { l: frac("l"), t: frac("t"), r: frac("r"), b: frac("b") } : null,
  };
  nodes.push(node);
}

function walkTree(root: Element, matrix: Matrix, ctx: WalkCtx, nodes: SceneNode[]): void {
  for (const el of Array.from(root.children)) {
    if (el.localName === "sp" || el.localName === "cxnSp") {
      walkShape(el, el.localName === "sp" ? "nvSpPr" : "nvCxnSpPr", matrix, ctx, nodes);
    } else if (el.localName === "pic") {
      walkPic(el, matrix, nodes);
    } else if (el.localName === "grpSp") {
      walkTree(el, groupMatrix(matrix, kid(el, "grpSpPr")), ctx, nodes);
    } else if (el.localName === "graphicFrame") {
      ctx.skipped.count += 1;
    }
  }
}

// ---------- 幻灯片 ----------

async function parseSlide(
  zip: JSZip,
  slidePath: string,
  scheme: ThemeScheme,
  slideW: number,
  slideH: number,
): Promise<SceneModel> {
  const doc = await readXml(zip, slidePath, "幻灯片");
  if (!doc) throw new Error(`读取 ${slidePath} 失败`);
  const rels = await parseRels(zip, slidePath);

  // 版式链：占位符几何继承 + 背景回退（版式→母版）
  const layoutPath = [...rels.values()].find((p) => p.includes("slideLayout")) ?? null;
  const layoutDoc = layoutPath ? await readXml(zip, layoutPath, "版式") : null;
  const layoutPh = layoutPath ? await layoutPlaceholders(zip, layoutPath) : new Map();
  let masterDoc: Document | null = null;
  if (layoutPath) {
    const layoutRels = await parseRels(zip, layoutPath);
    const masterPath = [...layoutRels.values()].find((p) => p.includes("slideMaster")) ?? null;
    if (masterPath) masterDoc = await readXml(zip, masterPath, "母版");
  }

  const background =
    parseBackground(doc, scheme) ??
    (layoutDoc ? parseBackground(layoutDoc, scheme) : null) ??
    (masterDoc ? parseBackground(masterDoc, scheme) : null);

  const media: Record<string, string> = {};
  for (const [id, path] of rels) {
    if (path.includes("/media/")) media[id] = path;
  }

  const ctx: WalkCtx = { scheme, layoutPh, slideW, slideH, slots: [], skipped: { count: 0 } };
  const nodes: SceneNode[] = [];
  const spTree = doc.getElementsByTagNameNS("*", "spTree")[0];
  if (spTree) walkTree(spTree, IDENTITY, ctx, nodes);

  return {
    widthEmu: slideW,
    heightEmu: slideH,
    background,
    nodes,
    slots: ctx.slots,
    skippedFrames: ctx.skipped.count,
    media,
  };
}

/** 入口：zip → 全部幻灯片的场景模型（按 sldIdLst 顺序，最多 MAX_SLIDES 页）。 */
export async function parsePptx(zip: JSZip): Promise<ParsedDeck> {
  const presDoc = await readXml(zip, "ppt/presentation.xml", "演示文稿");
  if (!presDoc) throw new Error("不是有效的 PPTX 文件（缺少 ppt/presentation.xml）");
  const sldSz = presDoc.getElementsByTagNameNS("*", "sldSz")[0];
  const slideW = numAttr(sldSz, "cx") ?? 12192000;
  const slideH = numAttr(sldSz, "cy") ?? 6858000;
  const presRels = await parseRels(zip, "ppt/presentation.xml");
  const slidePaths: string[] = [];
  for (const sldId of Array.from(presDoc.getElementsByTagNameNS("*", "sldId"))) {
    // sldId 同时带数字 id 与 r:id（关系 id），后者才是 rels 键；按命名空间精确取
    const relId =
      sldId.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ??
      sldId.getAttribute("r:id");
    const path = relId ? presRels.get(relId) : undefined;
    if (path && path.includes("slides/")) slidePaths.push(path);
  }
  if (slidePaths.length === 0) throw new Error("这份 PPTX 里没有幻灯片");
  if (slidePaths.length > MAX_SLIDES) throw new Error(`一次最多 ${MAX_SLIDES} 页，请拆分后再传`);
  const scheme = await parseThemeScheme(zip);
  const slides: SceneModel[] = [];
  for (const path of slidePaths) {
    slides.push(await parseSlide(zip, path, scheme, slideW, slideH));
  }
  return { slides };
}
