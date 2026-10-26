// PPTX → 底座场景模型的纯函数层：不依赖 DOM/canvas，node 可直接测。
// 坐标约定：解析层一律用 EMU（914400/英寸），出口处 letterbox 到 1536×864。

export const BASE_W = 1536;
export const BASE_H = 864;
export const EMU_PER_INCH = 914400;

export type FillSpec =
  | { kind: "none" }
  | { kind: "solid"; color: string; alpha: number }
  | { kind: "gradient"; angle: number; stops: { pos: number; color: string; alpha: number }[] }
  | { kind: "image"; relId: string };

export interface LineSpec {
  color: string;
  alpha: number;
  widthEmu: number;
}

export interface ShapeNode {
  kind: "shape";
  geom: string;
  geomAdj: number | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  fill: FillSpec;
  line: LineSpec | null;
}

export interface PicNode {
  kind: "pic";
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  relId: string;
  srcRect: { l: number; t: number; r: number; b: number } | null;
}

export type SceneNode = ShapeNode | PicNode;

export interface SlotSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  role: "title" | "subtitle" | "body";
  phType: string | null;
}

export interface SceneModel {
  widthEmu: number;
  heightEmu: number;
  background: FillSpec | null;
  nodes: SceneNode[];
  slots: SlotSpec[];
  skippedFrames: number;
  /** relId → zip 内路径（ppt/media/...） */
  media: Record<string, string>;
}

/** 主题色板：accent1..6 / dk1 / lt1 / dk2 / lt2 / hlink / folHlink → #rrggbb */
export type ThemeScheme = Record<string, string>;

/** slide EMU 画幅 → 1536×864 白底 letterbox 的缩放与偏移（与壳图 letterbox 同算法）。 */
export function baseTransform(widthEmu: number, heightEmu: number): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(BASE_W / widthEmu, BASE_H / heightEmu);
  return {
    scale,
    offsetX: (BASE_W - widthEmu * scale) / 2,
    offsetY: (BASE_H - heightEmu * scale) / 2,
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function hslFromRgb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function rgbFromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const conv = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [conv(h + 1 / 3), conv(h), conv(h - 1 / 3)];
}

function hexFromRgb(r: number, g: number, b: number): string {
  const to = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export interface ColorTransforms {
  tint?: number;
  shade?: number;
  lumMod?: number;
  lumOff?: number;
  satMod?: number;
  alpha?: number;
}

/** srgbClr #rrggbb 应用 OOXML 色彩变换。tint/shade 按规范折算为 lumMod/lumOff，作用于 HSL 明度。 */
export function applyColorTransforms(hex: string, t: ColorTransforms): { color: string; alpha: number } {
  let r = parseInt(hex.slice(1, 3), 16) / 255;
  let g = parseInt(hex.slice(3, 5), 16) / 255;
  let b = parseInt(hex.slice(5, 7), 16) / 255;
  const [h, s0, l0] = hslFromRgb(r, g, b);
  let s = s0;
  let l = l0;
  if (t.tint !== undefined) {
    l = l * t.tint + (1 - t.tint);
  }
  if (t.shade !== undefined) {
    l = l * t.shade;
  }
  if (t.lumMod !== undefined) l = l * t.lumMod;
  if (t.lumOff !== undefined) l = l + t.lumOff;
  if (t.satMod !== undefined) s = s * t.satMod;
  [r, g, b] = rgbFromHsl(((h % 1) + 1) % 1, clamp01(s), clamp01(l));
  return { color: hexFromRgb(r, g, b), alpha: t.alpha !== undefined ? clamp01(t.alpha) : 1 };
}

const PRST_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  navy: "#000080",
  teal: "#008080",
  lime: "#00ff00",
  gold: "#ffd700",
  silver: "#c0c0c0",
};

/** schemeClr 名称 → 主题色板键。 */
export function resolveSchemeColor(name: string, scheme: ThemeScheme): string {
  const key = name === "bg1" ? "lt1" : name === "bg2" ? "lt2" : name === "tx1" ? "dk1" : name === "tx2" ? "dk2" : name;
  return scheme[key] ?? scheme.accent1 ?? "#4472c4";
}

export function resolvePrstColor(name: string): string {
  return PRST_COLORS[name.toLowerCase()] ?? "#808080";
}

export function resolveSysColor(name: string, lastClr: string | null): string {
  if (lastClr && /^[0-9a-fA-F]{6}$/.test(lastClr)) return `#${lastClr.toLowerCase()}`;
  if (name === "window" || name === "windowFrame") return "#ffffff";
  return "#000000";
}

/** 支持的几何集合；未识别预设一律回退 rect（底座图近似优先于报错）。 */
const SUPPORTED_GEOMS = new Set([
  "rect",
  "roundRect",
  "round1Rect",
  "round2SameRect",
  "ellipse",
  "oval",
  "triangle",
  "rtTriangle",
  "diamond",
  "parallelogram",
  "trapezoid",
  "chevron",
  "homePlate",
  "pentagon",
  "hexagon",
  "line",
]);

export function geomWithFallback(name: string | null | undefined): string {
  if (!name) return "rect";
  return SUPPORTED_GEOMS.has(name) ? name : "rect";
}

const TITLE_PH = new Set(["title", "ctrTitle"]);
const SUBTITLE_PH = new Set(["subTitle"]);
const TITLE_MIN_PT = 24;

/** 槽位角色推断：占位符类型优先，否则按最大字号分位。 */
export function inferSlotRole(phType: string | null, maxFontPt: number | null): SlotSpec["role"] {
  if (phType && TITLE_PH.has(phType)) return "title";
  if (phType && SUBTITLE_PH.has(phType)) return "subtitle";
  if (maxFontPt !== null && maxFontPt >= TITLE_MIN_PT) return "title";
  return "body";
}

/** 形状 EMU 矩形 → 归一化槽位（0..1，越界裁剪）。 */
export function normalizeSlot(
  x: number,
  y: number,
  w: number,
  h: number,
  slideW: number,
  slideH: number,
): Pick<SlotSpec, "x" | "y" | "w" | "h"> {
  const nx = clamp01(x / slideW);
  const ny = clamp01(y / slideH);
  return {
    x: nx,
    y: ny,
    w: clamp01((x + w) / slideW) - nx,
    h: clamp01((y + h) / slideH) - ny,
  };
}

/** 槽位导出 JSON 文档（base.json）。 */
export function buildBaseJson(scene: SceneModel, sourceName: string): Record<string, unknown> {
  return {
    version: 1,
    source: sourceName,
    canvas: { width: BASE_W, height: BASE_H },
    slide: { widthEmu: scene.widthEmu, heightEmu: scene.heightEmu },
    slots: scene.slots,
  };
}

/** OOXML 路径规范化：rels target（如 ../media/image1.png）相对 sourceDir 解析。 */
export function resolveZipPath(sourceDir: string, target: string): string {
  const parts = `${sourceDir}/${target}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
