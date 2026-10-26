#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""pptx2html/verify.py —— 反向管线保真度验收

输入：原始 .pptx + 转换出的 deck.html
输出：verify.json（逐页 MAE/diff>16）+ 拼版对比图 compare.png

用法：
  python verify.py --pptx deck.pptx --html out/ref/deck.html --out out/ref/verify
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
PY = "/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python"
SOFFICE = "/opt/homebrew/bin/soffice"
FONTCONFIG = "/opt/homebrew/etc/fonts/fonts.conf"


def sh(cmd, env=None, timeout=600):
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=e)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def render_pptx(pptx, outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    pdfdir = outdir / "pdf"; pdfdir.mkdir(exist_ok=True)
    rc, log = sh([SOFFICE, "--headless", "--convert-to", "pdf", "--outdir", str(pdfdir), str(pptx)],
                 env={"FONTCONFIG_FILE": FONTCONFIG})
    pdfs = list(pdfdir.glob("*.pdf"))
    if not pdfs:
        return [], log[-400:]
    rc2, log2 = sh(["pdftoppm", "-png", "-r", "96", str(pdfs[0]), str(outdir / "page")])
    def _num(p):
        m = re.findall(r"(\d+)", p.name)
        return int(m[-1]) if m else 0
    return sorted(outdir.glob("page-*.png"), key=_num), (log + log2)[-400:]


def metrics(a_path, b_path):
    from PIL import Image
    import numpy as np
    a = Image.open(a_path).convert("RGB").resize((1280, 720), Image.LANCZOS)
    b = Image.open(b_path).convert("RGB").resize((1280, 720), Image.LANCZOS)
    d = np.abs(np.asarray(a, np.int16) - np.asarray(b, np.int16)).max(axis=2)
    return {"mae": round(float(d.mean()), 2),
            "pct_gt16": round(float((d > 16).mean() * 100), 2),
            "pct_gt48": round(float((d > 48).mean() * 100), 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pptx", required=True)
    ap.add_argument("--html", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)

    pages, log = render_pptx(Path(a.pptx), out / "pptx")
    rc, slog = sh(["node", str(Path(__file__).parent / "shoot.mjs"), a.html, str(out / "html")], timeout=600)
    def _num2(p):
        m = re.findall(r"(\d+)", p.name)
        return int(m[-1]) if m else 0
    shots = sorted((out / "html").glob("slide-*.png"), key=_num2)
    rows = []
    for i, (p, h) in enumerate(zip(pages, shots), 1):
        rows.append({"slide": i, **metrics(h, p)})
    agg = {"slides": len(rows),
           "mae": round(sum(r["mae"] for r in rows) / len(rows), 2) if rows else None,
           "pct_gt16": round(sum(r["pct_gt16"] for r in rows) / len(rows), 2) if rows else None,
           "pct_gt48": round(sum(r["pct_gt48"] for r in rows) / len(rows), 2) if rows else None}
    (out / "verify.json").write_text(json.dumps({"perSlide": rows, "aggregate": agg}, ensure_ascii=False, indent=1), encoding="utf-8")

    # 拼版：前 6 页 HTML | PPTX | diff
    try:
        from PIL import Image, ImageDraw, ImageFont
        import numpy as np
        n = min(6, len(rows))
        W, H = 640, 360
        sheet = Image.new("RGB", (3 * W + 16, n * H + 8), (240, 241, 244))
        f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 18)
        d = ImageDraw.Draw(sheet)
        for i in range(n):
            p = pages[i]; h = shots[i]
            hi = Image.open(h).convert("RGB").resize((W, H), Image.LANCZOS)
            pi = Image.open(p).convert("RGB").resize((W, H), Image.LANCZOS)
            diff = Image.fromarray((np.abs(np.asarray(hi, np.int16) - np.asarray(pi, np.int16)).max(axis=2) * 3).clip(0, 255).astype("uint8")).convert("RGB")
            y = i * H
            sheet.paste(hi, (0, y)); sheet.paste(pi, (W + 8, y)); sheet.paste(diff, (2 * W + 16, y))
            d.text((4, y + H - 20), f"p{i+1} HTML", fill=(200, 30, 30), font=f)
            d.text((W + 12, y + H - 20), f"p{i+1} PPTX MAE={rows[i]['mae']}", fill=(200, 30, 30), font=f)
        sheet.save(out / "compare.png")
    except Exception as e:
        print("contact sheet skipped:", e)
    print(json.dumps(agg, ensure_ascii=False))
    if log:
        print(log, file=sys.stderr)


if __name__ == "__main__":
    main()
