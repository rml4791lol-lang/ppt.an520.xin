#!/usr/bin/env python3
"""Generate deterministic sample images for the deck (no network, no randomness)."""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "samples" / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_photo(path: Path):
    """A 1280x800 abstract 'photo' (sky + sun + hills)."""
    w, h = 1280, 800
    img = Image.new("RGB", (w, h))
    px = img.load()
    top = (18, 40, 72)
    mid = (44, 110, 150)
    low = (14, 32, 54)
    for y in range(h):
        t = y / (h - 1)
        if t < 0.55:
            c = lerp(top, mid, t / 0.55)
        else:
            c = lerp(mid, low, (t - 0.55) / 0.45)
        for x in range(w):
            # slight horizontal light falloff
            k = 1.0 - 0.22 * abs((x / (w - 1)) - 0.5)
            px[x, y] = tuple(min(255, int(v * k)) for v in c)
    d = ImageDraw.Draw(img, "RGBA")
    # sun glow
    for r, a in [(150, 70), (110, 90), (70, 120), (38, 180)]:
        d.ellipse([900 - r, 230 - r, 900 + r, 230 + r], fill=(255, 196, 120, a))
    # hills
    for base, color in ((610, (10, 26, 46, 255)), (680, (8, 20, 36, 255)), (740, (5, 13, 24, 255))):
        pts = [(-20, 800)]
        for x in range(0, w + 40, 40):
            y = base + 48 * math.sin(x / 150.0) + 22 * math.sin(x / 47.0 + 1.3)
            pts.append((x, y))
        pts.append((w + 20, 800))
        d.polygon(pts, fill=color)
    # subtle grain (deterministic)
    px = img.load()
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            n = ((x * 73856093) ^ (y * 19349663)) % 9 - 4
            r, g, b = px[x, y]
            px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    img.save(path)


def make_logo(path: Path):
    """Transparent logo mark 256x256, rounded square + glyph."""
    s = 256
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, s - 8, s - 8], radius=56, fill=(37, 99, 235, 255))
    # white 'H' + arrow-ish glyph
    d.rounded_rectangle([62, 66, 92, 190], radius=8, fill=(255, 255, 255, 255))
    d.rounded_rectangle([164, 66, 194, 190], radius=8, fill=(255, 255, 255, 255))
    d.rounded_rectangle([92, 116, 164, 140], radius=6, fill=(255, 255, 255, 255))
    img.save(path)


def make_pixel_probe(path: Path):
    """Small 96x64 pixel-art style image used to check image scaling."""
    img = Image.new("RGBA", (96, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, c in enumerate([(239, 68, 68, 255), (245, 158, 11, 255), (16, 185, 129, 255),
                           (37, 99, 235, 255), (139, 92, 246, 255)]):
        d.rectangle([i * 19, 0, i * 19 + 18, 63], fill=c)
    img.save(path)


if __name__ == "__main__":
    make_photo(ASSETS / "photo-sky.png")
    make_logo(ASSETS / "logo-mark.png")
    make_pixel_probe(ASSETS / "pixel-probe.png")
    for p in sorted(ASSETS.glob("*.png")):
        print(p.name, p.stat().st_size, "bytes")
