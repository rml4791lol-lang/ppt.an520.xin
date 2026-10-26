#!/usr/bin/env python3
"""diffstat.py — objective HTML-vs-PPTX comparison for out/metrics.json.

For every slide compares out/html/slide-N.png against out/pptx/slide-N.png (LibreOffice
re-render), then:
  * per-pixel diff ratio at two thresholds + mean absolute error
  * writes an amplified diff image to out/diff/slide-N.png
  * attributes diff to measured objects/kinds (shapes, text, images, table)
  * a vertical baseline diagnostic for text boxes (row-edge cross correlation)
  * a 3-column contact sheet (HTML | PPTX | diff) to out/diff/contact-sheet.png
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ["HTMLPPT_OUT"]).resolve() if os.environ.get("HTMLPPT_OUT") else ROOT / "out"
DIFF_DIR = OUT / "diff"
THRESH_SOFT = 16
THRESH_HARD = 48
SCALE = 0.5



def _rel(p):
    try:
        return str(p.relative_to(ROOT))
    except ValueError:
        return str(p)

def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB")).astype(np.int16)


def region_stats(a, b, rect):
    h, w = a.shape[:2]
    x0 = max(0, min(w - 1, int(rect["x"])))
    y0 = max(0, min(h - 1, int(rect["y"])))
    x1 = max(x0 + 1, min(w, int(np.ceil(rect["x"] + rect["w"]))))
    y1 = max(y0 + 1, min(h, int(np.ceil(rect["y"] + rect["h"]))))
    if (x1 - x0) < 3 or (y1 - y0) < 3:
        return None
    da = a[y0:y1, x0:x1]
    db = b[y0:y1, x0:x1]
    d = np.abs(da - db).max(axis=2)
    area = d.size
    changed = int((d > THRESH_SOFT).sum())
    return {
        "area": area,
        "changed": changed,
        "ratio": round(changed / area, 4),
        "mae": round(float(np.abs(da - db).mean()), 2),
        "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0,
    }


def vertical_offset(a_gray, b_gray, rect, max_shift=8):
    """Best vertical alignment of a text region via row edge-profile correlation."""
    h, w = a_gray.shape
    x0 = max(0, min(w - 1, int(rect["x"]) - 2))
    y0 = max(0, min(h - 1, int(rect["y"]) - 2))
    x1 = max(x0 + 2, min(w, int(np.ceil(rect["x"] + rect["w"])) + 2))
    y1 = max(y0 + 2, min(h, int(np.ceil(rect["y"] + rect["h"])) + 2))
    if (x1 - x0) < 4 or (y1 - y0) < 6:
        return None

    def profile(img):
        reg = img[y0:y1, x0:x1]
        # edge magnitude per row: insensitive to background colour
        return np.abs(np.diff(reg, axis=0)).sum(axis=1).astype(np.float64)

    pa, pb = profile(a_gray), profile(b_gray)
    if pa.sum() < 1 or pb.sum() < 1:
        return None
    best = (1e18, 0)
    n = len(pa)
    for dy in range(-max_shift, max_shift + 1):
        if dy >= 0:
            x, y = pa[: n - dy], pb[dy:]
        else:
            x, y = pa[-dy:], pb[: n + dy]
        m = min(len(x), len(y))
        if m < 4:
            continue
        xx, yy = x[:m], y[:m]
        denom = (np.linalg.norm(xx) * np.linalg.norm(yy)) or 1.0
        score = 1.0 - float(np.dot(xx, yy) / denom)  # lower = better
        if score < best[0]:
            best = (score, dy)
    return best[1]


def make_diff_image(a, b, path: Path):
    d = np.abs(a - b).max(axis=2)
    amp = np.clip(d * 3, 0, 255).astype(np.uint8)
    Image.fromarray(amp).save(path)


def label(img, text, font):
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, img.width - 1, 20], fill=(17, 24, 39))
    draw.text((6, 3), text, fill=(255, 255, 255), font=font)
    return img


def main():
    DIFF_DIR.mkdir(parents=True, exist_ok=True)
    measure = json.load(open(OUT / "measure.json"))
    render = json.load(open(OUT / "render.json")) if (OUT / "render.json").exists() else {"pages": []}
    html_dir = OUT / "html"
    pptx_dir = OUT / "pptx"

    try:
        font = ImageFont.load_default(size=15)
    except TypeError:  # Pillow < 10
        font = ImageFont.load_default()

    slides = []
    total_px = 0
    total_changed = 0
    total_major = 0
    mae_sum = 0.0
    sheet_rows = []
    fresh = True
    kind_agg = {}
    text_offsets = []

    for s in measure["slides"]:
        idx = s["index"] + 1
        html_path = html_dir / f"slide-{idx}.png"
        pptx_path = pptx_dir / f"slide-{idx}.png"
        if not html_path.exists() or not pptx_path.exists():
            raise SystemExit(f"missing render for slide {idx}: {html_path} / {pptx_path}")
        a = load_rgb(html_path)
        b = load_rgb(pptx_path)
        if a.shape != b.shape:
            reshaped = np.asarray(
                Image.open(pptx_path).convert("RGB").resize((a.shape[1], a.shape[0]), Image.LANCZOS)
            ).astype(np.int16)
            size_mismatch = [list(b.shape[1::-1]), list(a.shape[1::-1])]
            b = reshaped
        else:
            size_mismatch = None

        d = np.abs(a - b).max(axis=2)
        changed = int((d > THRESH_SOFT).sum())
        major = int((d > THRESH_HARD).sum())
        mae = float(np.abs(a - b).mean())
        area = d.size
        total_px += area
        total_changed += changed
        total_major += major
        mae_sum += mae

        diff_path = DIFF_DIR / f"slide-{idx}.png"
        make_diff_image(a, b, diff_path)

        # attribute diff to measured objects
        regions = []
        for o in s["objects"]:
            st = region_stats(a, b, o)
            if st is None:
                continue
            st.update({"kind": o["kind"], "id": o["id"], "tag": o.get("tag", ""), "label": o.get("label", "")})
            regions.append(st)
            k = kind_agg.setdefault(o["kind"], {"area": 0, "changed": 0})
            k["area"] += st["area"]
            k["changed"] += st["changed"]

        worst = sorted(regions, key=lambda r: r["ratio"], reverse=True)[:8]

        # vertical baseline diagnostic for text boxes
        ag = np.asarray(Image.open(html_path).convert("L")).astype(np.float32)
        bg = np.asarray(Image.open(pptx_path).convert("L")).astype(np.float32)
        if bg.shape != ag.shape:
            bg = np.asarray(
                Image.open(pptx_path).convert("L").resize((ag.shape[1], ag.shape[0]), Image.LANCZOS)
            ).astype(np.float32)
        slide_offsets = []
        for o in s["objects"]:
            if o["kind"] != "text":
                continue
            dy = vertical_offset(ag, bg, o)
            if dy is not None:
                slide_offsets.append(dy)
        if slide_offsets:
            text_offsets.extend(slide_offsets)

        slides.append(
            {
                "slide": idx,
                "size": [int(a.shape[1]), int(a.shape[0])],
                "sizeMismatchResampled": size_mismatch,
                "mae": round(mae, 2),
                "pixelDiffRatio": round(changed / area, 4),
                "majorDiffRatio": round(major / area, 4),
                "changedPixels": changed,
                "html": _rel(html_path),
                "pptx": _rel(pptx_path),
                "diff": _rel(diff_path),
                "objectsModeled": len(s["objects"]),
                "regionsAnalyzed": len(regions),
                "worstRegions": [
                    {kk: r[kk] for kk in ("id", "kind", "tag", "label", "x", "y", "w", "h", "ratio", "mae")}
                    for r in worst
                ],
                "textVerticalOffsetPx": {
                    "samples": len(slide_offsets),
                    "median": float(np.median(slide_offsets)) if slide_offsets else None,
                    "min": int(min(slide_offsets)) if slide_offsets else None,
                    "max": int(max(slide_offsets)) if slide_offsets else None,
                },
            }
        )

        # contact sheet source images
        html_img = Image.open(html_path).convert("RGB").resize(
            (int(a.shape[1] * SCALE), int(a.shape[0] * SCALE)), Image.LANCZOS
        )
        pptx_img = Image.open(pptx_path).convert("RGB").resize(
            (int(a.shape[1] * SCALE), int(a.shape[0] * SCALE)), Image.LANCZOS
        )
        diff_img = Image.open(diff_path).convert("RGB").resize(
            (int(a.shape[1] * SCALE), int(a.shape[0] * SCALE)), Image.LANCZOS
        )
        sheet_rows.append((idx, html_img, pptx_img, diff_img, changed / area, mae, fresh))
        fresh = False

    kind_breakdown = {
        k: {
            "area": v["area"],
            "changedPixels": v["changed"],
            "ratio": round(v["changed"] / v["area"], 4) if v["area"] else None,
        }
        for k, v in sorted(kind_agg.items())
    }

    pixel = {
        "thresholds": {"soft": THRESH_SOFT, "hard": THRESH_HARD},
        "overall": {
            "slides": len(slides),
            "pixels": total_px,
            "pixelDiffRatio": round(total_changed / total_px, 4),
            "majorDiffRatio": round(total_major / total_px, 4),
            "mae": round(mae_sum / len(slides), 2),
        },
        "byKind": kind_breakdown,
        "textVerticalOffsetPx": {
            "samples": len(text_offsets),
            "median": float(np.median(text_offsets)) if text_offsets else None,
            "mean": round(float(np.mean(text_offsets)), 2) if text_offsets else None,
            "histogram": {str(k): int(text_offsets.count(k)) for k in sorted(set(text_offsets))},
            "note": "row-edge cross correlation, positive = PPTX text sits lower than HTML",
        },
        "slides": slides,
    }
    (OUT / "pixel.json").write_text(json.dumps(pixel, indent=1, ensure_ascii=False))

    # ---------- contact sheet: HTML | PPTX | diff ----------
    if sheet_rows:
        cell_w, cell_h = sheet_rows[0][1].width, sheet_rows[0][1].height
        pad = 8
        header = 24
        width = 3 * cell_w + 4 * pad
        height = len(sheet_rows) * (cell_h + header + pad) + pad + 40
        sheet = Image.new("RGB", (width, height), (241, 245, 249))
        draw = ImageDraw.Draw(sheet)
        draw.text((pad, 10), "HTML (Chrome)  |  PPTX (LibreOffice re-render)  |  amplified diff", fill=(15, 23, 42), font=font)
        y = 34
        for idx, hi, pi, di, ratio, mae, _ in sheet_rows:
            for col, (img, name) in enumerate([(hi, "HTML"), (pi, "PPTX"), (di, "diff")]):
                x = pad + col * (cell_w + pad)
                labelled = label(img.copy(), f"slide {idx} · {name}", font)
                sheet.paste(labelled, (x, y))
            draw.text(
                (pad, y + cell_h + header + 2),
                f"slide {idx}: diff>16 = {ratio * 100:.2f}%   MAE = {mae:.2f}",
                fill=(51, 65, 85),
                font=font,
            )
            y += cell_h + header + pad + 14
        sheet.save(DIFF_DIR / "contact-sheet.png")
        pixel["contactSheet"] = _rel(DIFF_DIR / "contact-sheet.png")

    (OUT / "pixel.json").write_text(json.dumps(pixel, indent=1, ensure_ascii=False))
    o = pixel["overall"]
    print(
        f"[diff] {o['slides']} slides · MAE {o['mae']} · diff>{THRESH_SOFT} {o['pixelDiffRatio'] * 100:.2f}% · "
        f"diff>{THRESH_HARD} {o['majorDiffRatio'] * 100:.2f}% · text dy median {pixel['textVerticalOffsetPx']['median']}px"
    )
    print("[diff] wrote out/pixel.json, out/diff/*.png, out/diff/contact-sheet.png")


if __name__ == "__main__":
    main()
