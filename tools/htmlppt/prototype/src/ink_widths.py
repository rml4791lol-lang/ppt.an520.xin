#!/usr/bin/env python3
"""Measure the ink (non-background) bounding box of each text row in two 1280x720 PNGs.

Usage: ink_widths.py html.png pptx.png '[{"index":0,"y0":32,"y1":86}, ...]'
Prints JSON: [{"index":0,"htmlInkWidth":123,"inkWidth":120}, ...]
"""
import json
import sys
from PIL import Image

BACKGROUND_TOLERANCE = 40  # max channel distance from the corner pixel to count as "ink"


def band_ink_width(img, y0, y1):
    w, h = img.size
    y0 = max(0, min(h - 1, int(y0)))
    y1 = max(0, min(h, int(y1)))
    if y1 <= y0:
        return None
    crop = img.crop((0, y0, w, y1)).convert("RGB")
    pixels = crop.load()
    bg = crop.getpixel((w - 1, 0))
    min_x, max_x = None, None
    for y in range(crop.size[1]):
        for x in range(crop.size[0]):
            r, g, b = pixels[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > BACKGROUND_TOLERANCE:
                if min_x is None or x < min_x:
                    min_x = x
                if max_x is None or x > max_x:
                    max_x = x
    if min_x is None:
        return 0
    return max_x - min_x + 1


def main():
    html_path, pptx_path, bands_json = sys.argv[1], sys.argv[2], sys.argv[3]
    bands = json.loads(bands_json)
    html = Image.open(html_path)
    pptx = Image.open(pptx_path)
    out = []
    for b in bands:
        out.append(
            {
                "index": b["index"],
                "htmlInkWidth": band_ink_width(html, b["y0"], b["y1"]),
                "inkWidth": band_ink_width(pptx, b["y0"], b["y1"]),
                "htmlSize": list(html.size),
                "pptxSize": list(pptx.size),
            }
        )
    print(json.dumps(out))


if __name__ == "__main__":
    main()
