#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""grade-photo.py —— 把照片统一成"藏青→暖金"分割色调（split-tone）

做法：亮度归一化 → 3 段色阶映射（阴影藏青 / 中调石板蓝 / 高光暖金）→ 轻微暗角 + 颗粒。
这样所有照片共享同一套色阶，整册氛围一致，且文字压图时对比可控。

用法：
  python3 tools/grade-photo.py in.jpg out.png [--palette navy-gold] [--gamma 1.0] [--vignette 0.35]
"""
from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image, ImageFilter

# 三段色阶：shadow → mid → highlight（RGB 0-255）
PALETTES = {
    "navy-gold": ((6, 14, 34), (27, 58, 108), (233, 201, 143)),
    "navy-gold-cool": ((5, 12, 30), (23, 52, 100), (214, 226, 240)),
    "navy-gold-warm": ((8, 16, 38), (34, 64, 112), (243, 196, 110)),
}


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def grade(img: Image.Image, palette: str = "navy-gold", gamma: float = 1.0,
          vignette: float = 0.35, grain: float = 0.035, sky_darken: float = 0.55) -> Image.Image:
    shadow, mid, high = PALETTES[palette]
    im = img.convert("RGB")
    arr = np.asarray(im).astype(np.float32) / 255.0
    # 亮度（Rec.709）
    lum = 0.2126 * arr[:, :, 0] + 0.7152 * arr[:, :, 1] + 0.0722 * arr[:, :, 2]
    # 归一化 1%–99%，避免过曝天空吃掉所有细节
    lo, hi = np.percentile(lum, 1), np.percentile(lum, 99)
    lum = np.clip((lum - lo) / max(hi - lo, 1e-4), 0, 1) ** gamma

    # 3 段映射
    t1 = np.clip(lum / 0.55, 0, 1)
    t2 = np.clip((lum - 0.55) / 0.45, 0, 1)
    out = np.zeros_like(arr)
    for c in range(3):
        out[:, :, c] = np.where(
            lum <= 0.55,
            shadow[c] / 255.0 + (mid[c] - shadow[c]) / 255.0 * t1,
            mid[c] / 255.0 + (high[c] - mid[c]) / 255.0 * t2,
        )

    # 上半部压暗（照片天空过曝；压掉后主体成为唯一亮区）
    hh = lum.shape[0]
    grad = np.linspace(1.0 - sky_darken, 1.0, hh).reshape(hh, 1, 1)
    out *= grad

    # 暗角（把注意力推向中心/主体）
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w * 0.5, h * 0.45
    r = np.sqrt(((xx - cx) / (w * 0.62)) ** 2 + ((yy - cy) / (h * 0.62)) ** 2)
    vig = np.clip(1 - vignette * np.clip(r, 0, 1.4) ** 1.6, 0, 1)
    out *= vig[:, :, None]

    # 颗粒
    if grain > 0:
        rng = np.random.default_rng(7)
        n = rng.normal(0, grain, (h, w, 1))
        out = np.clip(out + n, 0, 1)

    return Image.fromarray((out * 255).astype(np.uint8))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--palette", default="navy-gold", choices=sorted(PALETTES))
    ap.add_argument("--gamma", type=float, default=1.0)
    ap.add_argument("--vignette", type=float, default=0.35)
    ap.add_argument("--grain", type=float, default=0.03)
    ap.add_argument("--sky-darken", type=float, default=0.55)
    ap.add_argument("--crop", default="", help="裁剪比例 l,t,r,b（0-1），如 0.35,0,1,1")
    a = ap.parse_args()
    img = Image.open(a.src)
    if a.crop:
        l, t, r, b = [float(x) for x in a.crop.split(",")]
        w, h = img.size
        img = img.crop((int(l * w), int(t * h), int(r * w), int(b * h)))
    out = grade(img, a.palette, a.gamma, a.vignette, a.grain, a.sky_darken)
    out.save(a.dst, "PNG")
    print(f"graded -> {a.dst} ({out.size[0]}x{out.size[1]}, {a.palette})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
