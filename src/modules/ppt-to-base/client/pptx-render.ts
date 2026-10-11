// SceneModel → 1536×864 canvas 渲染：白底 letterbox，绘制填充/描边/图片/装饰形状，不画任何文字。
// 槽位叠加层（可选）仅供预览定位，不进导出的底座 PNG——导出时别传 showSlots。

import type JSZip from "jszip";
import { baseTransform, BASE_H, BASE_W, type FillSpec, type SceneModel, type ShapeNode } from "./pptx-model";

export type ImageLoader = (zipPath: string) => Promise<HTMLImageElement>;

/** 从 zip 读媒体字节建 Image（blob URL 用完即销）。 */
export function makeZipImageLoader(zip: JSZip): ImageLoader {
  const cache = new Map<string, Promise<HTMLImageElement>>();
  return (zipPath) => {
    let p = cache.get(zipPath);
    if (!p) {
      p = (async () => {
        const file = zip.file(zipPath);
        if (!file) throw new Error(`缺少媒体文件 ${zipPath}`);
        const blob = await file.async("blob");
        const url = URL.createObjectURL(blob);
        try {
          return await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`媒体文件无法解码 ${zipPath}`));
            img.src = url;
          });
        } finally {
          URL.revokeObjectURL(url);
        }
      })();
      cache.set(zipPath, p);
    }
    return p;
  };
}

function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

/** 形状几何路径（EMU 坐标系，原点已在形状左上角）。 */
function traceGeom(ctx: CanvasRenderingContext2D, shape: ShapeNode): void {
  const { w, h } = shape;
  const adj = shape.geomAdj;
  const ss = Math.min(w, h);
  ctx.beginPath();
  switch (shape.geom) {
    case "roundRect": {
      const r = ss * ((adj ?? 16667) / 100000);
      ctx.roundRect(0, 0, w, h, r);
      break;
    }
    case "round1Rect":
    case "round2SameRect": {
      const r = ss * ((adj ?? 16667) / 100000);
      ctx.moveTo(0, h);
      ctx.lineTo(0, r);
      ctx.arcTo(0, 0, r, 0, r);
      ctx.lineTo(w - r, 0);
      ctx.arcTo(w, 0, w, r, r);
      ctx.lineTo(w, h);
      ctx.closePath();
      break;
    }
    case "ellipse":
    case "oval":
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "triangle":
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      break;
    case "rtTriangle":
      ctx.moveTo(0, 0);
      ctx.lineTo(w, 0);
      ctx.lineTo(0, h);
      ctx.closePath();
      break;
    case "diamond":
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w / 2, h);
      ctx.lineTo(0, h / 2);
      ctx.closePath();
      break;
    case "parallelogram": {
      const slant = w * ((adj ?? 25000) / 100000);
      ctx.moveTo(slant, 0);
      ctx.lineTo(w, 0);
      ctx.lineTo(w - slant, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      break;
    }
    case "trapezoid": {
      const inset = w * ((adj ?? 20000) / 100000);
      ctx.moveTo(inset, 0);
      ctx.lineTo(w - inset, 0);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      break;
    }
    case "chevron": {
      const a = w * ((adj ?? 50000) / 100000);
      ctx.moveTo(0, 0);
      ctx.lineTo(w - a, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w - a, h);
      ctx.lineTo(0, h);
      ctx.lineTo(a, h / 2);
      ctx.closePath();
      break;
    }
    case "homePlate": {
      const a = w * ((adj ?? 50000) / 100000);
      ctx.moveTo(0, 0);
      ctx.lineTo(w - a, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w - a, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      break;
    }
    case "pentagon": {
      for (let i = 0; i < 5; i += 1) {
        const ang = (-90 + i * 72) * (Math.PI / 180);
        const px = w / 2 + (w / 2) * Math.cos(ang);
        const py = h / 2 + (h / 2) * Math.sin(ang);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case "hexagon": {
      const a = w * ((adj ?? 25000) / 100000);
      ctx.moveTo(a, 0);
      ctx.lineTo(w - a, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w - a, h);
      ctx.lineTo(a, h);
      ctx.lineTo(0, h / 2);
      ctx.closePath();
      break;
    }
    case "line":
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      break;
    default:
      ctx.rect(0, 0, w, h);
  }
}

function fillStyle(ctx: CanvasRenderingContext2D, fill: FillSpec, w: number, h: number): string | CanvasGradient | null {
  if (fill.kind === "solid") return rgba(fill.color, fill.alpha);
  if (fill.kind === "gradient") {
    const a = fill.angle * (Math.PI / 180); // OOXML 角度：0=左→右，顺时针为正；canvas y 轴向下，方向一致
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const grad = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
    for (const stop of fill.stops) grad.addColorStop(stop.pos, rgba(stop.color, stop.alpha));
    return grad;
  }
  return null;
}

async function drawFill(
  ctx: CanvasRenderingContext2D,
  fill: FillSpec,
  w: number,
  h: number,
  scene: SceneModel,
  loadImage: ImageLoader,
): Promise<void> {
  if (fill.kind === "image") {
    const zipPath = scene.media[fill.relId];
    if (!zipPath) return;
    try {
      const img = await loadImage(zipPath);
      ctx.save();
      ctx.clip();
      ctx.drawImage(img, 0, 0, w, h);
      ctx.restore();
    } catch {
      // 图片缺失按无填充处理，不拖垮整页渲染
    }
    return;
  }
  const style = fillStyle(ctx, fill, w, h);
  if (style) {
    ctx.fillStyle = style;
    ctx.fill();
  }
}

export interface RenderOptions {
  /** 预览用：叠加槽位虚线框与角色标签。导出底座图时必须为 false。 */
  showSlots?: boolean;
}

export async function renderSceneToCanvas(
  scene: SceneModel,
  loadImage: ImageLoader,
  opts: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = BASE_W;
  canvas.height = BASE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, BASE_W, BASE_H);

  const { scale, offsetX, offsetY } = baseTransform(scene.widthEmu, scene.heightEmu);
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  if (scene.background) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, scene.widthEmu, scene.heightEmu);
    await drawFill(ctx, scene.background, scene.widthEmu, scene.heightEmu, scene, loadImage);
    ctx.restore();
  }

  for (const node of scene.nodes) {
    ctx.save();
    ctx.translate(node.x + node.w / 2, node.y + node.h / 2);
    if (node.rot) ctx.rotate((node.rot * Math.PI) / 180);
    ctx.translate(-node.w / 2, -node.h / 2);
    if (node.kind === "pic") {
      const zipPath = scene.media[node.relId];
      if (zipPath) {
        try {
          const img = await loadImage(zipPath);
          const crop = node.srcRect;
          if (crop) {
            const sw = img.naturalWidth * (1 - crop.l - crop.r);
            const sh = img.naturalHeight * (1 - crop.t - crop.b);
            ctx.drawImage(img, img.naturalWidth * crop.l, img.naturalHeight * crop.t, sw, sh, 0, 0, node.w, node.h);
          } else {
            ctx.drawImage(img, 0, 0, node.w, node.h);
          }
        } catch {
          // 同上：单图缺失不拖垮整页
        }
      }
    } else {
      traceGeom(ctx, node);
      if (node.fill.kind !== "none") {
        await drawFill(ctx, node.fill, node.w, node.h, scene, loadImage);
      }
      if (node.line) {
        ctx.strokeStyle = rgba(node.line.color, node.line.alpha);
        ctx.lineWidth = node.line.widthEmu;
        ctx.stroke();
      } else if (node.geom === "line") {
        ctx.strokeStyle = "#999999";
        ctx.lineWidth = 9525;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();

  if (opts.showSlots && scene.slots.length > 0) {
    const px = (v: number, size: number) => offsetX + v * size * scale;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.font = "600 16px sans-serif";
    scene.slots.forEach((slot, i) => {
      const x = px(slot.x, scene.widthEmu);
      const y = offsetY + slot.y * scene.heightEmu * scale;
      const w = slot.w * scene.widthEmu * scale;
      const h = slot.h * scene.heightEmu * scale;
      ctx.strokeStyle = "#e11d48";
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "#e11d48";
      ctx.fillText(`${i + 1} ${slot.role}`, x + 6, y + 20);
    });
    ctx.restore();
  }

  return canvas;
}
