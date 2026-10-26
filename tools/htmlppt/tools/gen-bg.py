#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""gen-bg.py —— 按需生成页面底图（图片生成模型），并输出可直接用于 HTML 的底图资产

后端：
  arkcli   → `arkcli +gen`（火山方舟，需已登录：arkcli auth login volc-sso）
  coze     → `coze generate image`（需已登录：coze auth login）
  fallback → 本地程序化兜底（无网络、无账号时用于验证版式；产物标注 source=fallback）

用法：
  python3 tools/gen-bg.py --brief "night aerial view of a waterfront science park" \
      --out assets/bg-cover.png [--backend arkcli|coze|fallback] [--palette navy]
  python3 tools/gen-bg.py --brief "..." --out out.png --json
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

W, H = 1280, 720

PALETTES = {
    "navy": {"top": (10, 20, 46), "bottom": (4, 8, 20), "glow": (36, 74, 140), "accent": (232, 180, 74)},
    "ocean": {"top": (6, 27, 51), "bottom": (2, 10, 21), "glow": (30, 120, 190), "accent": (90, 200, 240)},
    "agri": {"top": (14, 43, 34), "bottom": (6, 18, 14), "glow": (40, 110, 80), "accent": (216, 178, 92)},
    "academic": {"top": (14, 14, 18), "bottom": (5, 5, 8), "glow": (90, 80, 50), "accent": (232, 180, 74)},
}

PROMPT_TMPL = (
    "cinematic wide 16:9 background for a Chinese university innovation presentation: {brief}. "
    "Color direction: {palette_desc}. Premium, restrained, corporate-tech aesthetic. "
    "Very large clean dark negative space in the center for a large title, soft atmospheric depth, "
    "subtle light rays and haze, high detail, no text, no logos, no watermark, no people, 8k"
)


def palette_desc(name: str) -> str:
    return {
        "navy": "deep navy blue #0B1533 with warm gold city lights",
        "ocean": "deep ocean blue with bright cyan highlights",
        "agri": "dark forest green with muted gold accents",
        "academic": "near-black charcoal with antique gold accents",
    }.get(name, "deep navy with gold accents")


PHOTO_TMPL = (
    "photorealistic 16:9 editorial photograph for a Chinese university innovation deck: {brief}. "
    "Natural balanced exposure, no blown-out sky, soft late-afternoon light, {palette_desc}, "
    "composed with clear negative space on {space} for a headline, shallow depth of field, "
    "high-end architectural photography, no text, no logos, no watermark, no people looking at camera"
)


def build_prompt(brief: str, palette: str, mode: str = "background", space: str = "the left third") -> str:
    if mode == "photo":
        return PHOTO_TMPL.format(brief=brief.strip(), palette_desc=palette_desc(palette), space=space)
    return PROMPT_TMPL.format(brief=brief.strip(), palette_desc=palette_desc(palette))


def find_image_path(obj, base: Path) -> Path | None:
    """在 arkcli/coze 的 JSON 返回里找落盘路径。"""
    if isinstance(obj, dict):
        for k in ("path", "file_path", "output_path", "local_path", "saved_to"):
            v = obj.get(k)
            if isinstance(v, str) and Path(v).exists():
                return Path(v)
        for k in ("url", "image_url", "download_url"):
            v = obj.get(k)
            if isinstance(v, str) and v.startswith("http"):
                dst = base / "bg-download.png"
                try:
                    urllib.request.urlretrieve(v, dst)
                    return dst
                except Exception:  # noqa: BLE001
                    continue
        for k in ("b64_json", "base64", "image_base64"):
            v = obj.get(k)
            if isinstance(v, str) and len(v) > 200:
                dst = base / "bg-b64.png"
                dst.write_bytes(base64.b64decode(v.split(",")[-1]))
                return dst
        for v in obj.values():
            r = find_image_path(v, base)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_image_path(v, base)
            if r:
                return r
    return None


def gen_arkcli(prompt: str, out: Path, base: Path) -> tuple[bool, str]:
    cmd = ["arkcli", "+gen", prompt, "--modality", "image", "--image-count", "1",
           "--output-format", "png", "--no-open", "--format", "json"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        return False, (r.stderr or r.stdout)[-800:]
    try:
        data = json.loads(r.stdout[r.stdout.index("{"):])
    except Exception:  # noqa: BLE001
        return False, "arkcli 返回无法解析为 JSON"
    src = find_image_path(data, base)
    if not src:
        return False, "arkcli 返回里没找到图片路径/URL"
    return True, str(src)


def gen_coze(prompt: str, out: Path, base: Path) -> tuple[bool, str]:
    cmd = ["coze", "generate", "image", prompt, "--output-path", str(base),
           "--size", f"{W}x{H}", "--no-watermark", "--format", "json"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        return False, (r.stderr or r.stdout)[-800:]
    try:
        data = json.loads(r.stdout[r.stdout.index("{"):])
    except Exception:  # noqa: BLE001
        return False, "coze 返回无法解析为 JSON"
    src = find_image_path(data, base)
    if not src:
        return False, "coze 返回里没找到图片路径/URL"
    return True, str(src)


def gen_fallback(prompt: str, out: Path, base: Path, palette: str) -> tuple[bool, str]:
    """程序化兜底底图：用于无账号时验证版式与文字压图（不是 AI 生成，产物会标注）。"""
    from PIL import Image, ImageDraw, ImageFilter

    random.seed(hash(prompt) & 0xFFFF)
    pal = PALETTES.get(palette, PALETTES["navy"])
    img = Image.new("RGB", (W, H), pal["bottom"])
    px = img.load()
    top, bottom = pal["top"], pal["bottom"]
    for y in range(H):
        t = y / (H - 1)
        for x in range(W):
            dx = (x - W / 2) / (W / 2)
            dy = (y - H * 0.42) / (H / 2)
            glow = max(0.0, 1.0 - math.sqrt(dx * dx + dy * dy) / 1.15)
            r = int(bottom[0] + (top[0] - bottom[0]) * (1 - t) + pal["glow"][0] * glow * 0.35)
            g = int(bottom[1] + (top[1] - bottom[1]) * (1 - t) + pal["glow"][1] * glow * 0.35)
            b = int(bottom[2] + (top[2] - bottom[2]) * (1 - t) + pal["glow"][2] * glow * 0.35)
            px[x, y] = (min(r, 255), min(g, 255), min(b, 255))

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # 地平线城市灯光
    horizon = int(H * 0.66)
    for _ in range(160):
        x = random.uniform(0, W)
        y = horizon + random.gauss(0, 26)
        if 0 <= y < H:
            c = pal["accent"] if random.random() < 0.5 else (150, 190, 230)
            a = random.randint(20, 90)
            d.ellipse([x - 1.2, y - 1.2, x + 1.2, y + 1.2], fill=(*c, a))
    layer = layer.filter(ImageFilter.GaussianBlur(1.2))
    img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")

    # 轻雾与暗角
    fog = Image.new("L", (W, H), 0)
    fd = ImageDraw.Draw(fog)
    fd.ellipse([-W * 0.2, H * 0.35, W * 1.2, H * 1.4], fill=40)
    fog = fog.filter(ImageFilter.GaussianBlur(120))
    img = Image.composite(Image.new("RGB", (W, H), (16, 30, 60)), img, fog.point(lambda v: int(v * 0.35)))

    vign = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vign)
    vd.ellipse([-W * 0.15, -H * 0.25, W * 1.15, H * 1.25], fill=255)
    vign = vign.filter(ImageFilter.GaussianBlur(160))
    img = Image.composite(img, Image.new("RGB", (W, H), (2, 4, 10)), vign)
    img = img.resize((W, H), Image.LANCZOS)
    img.save(out, "PNG")
    return True, str(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--brief", required=True, help="画面描述（中文/英文均可）")
    ap.add_argument("--out", required=True, help="输出 PNG 路径")
    ap.add_argument("--palette", default="navy", choices=sorted(PALETTES))
    ap.add_argument("--mode", default="background", choices=["background", "photo"],
                    help="background=抽象氛围底；photo=写真底图（用作整页底图）")
    ap.add_argument("--space", default="the left third", help="photo 模式：给标题留白的位置")
    ap.add_argument("--backend", default="auto", choices=["auto", "arkcli", "coze", "fallback"])
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    out = Path(a.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(a.brief, a.palette, a.mode, a.space)
    base = Path(tempfile.mkdtemp(prefix="bg-gen-"))

    order = [a.backend] if a.backend != "auto" else ["arkcli", "coze", "fallback"]
    errors: list[str] = []
    source = None
    for backend in order:
        if backend == "arkcli":
            if not shutil.which("arkcli"):
                errors.append("arkcli: 未安装")
                continue
            ok, info = gen_arkcli(prompt, out, base)
        elif backend == "coze":
            if not shutil.which("coze"):
                errors.append("coze: 未安装")
                continue
            ok, info = gen_coze(prompt, out, base)
        else:
            ok, info = gen_fallback(prompt, out, base, a.palette)
        if ok:
            source = backend
            src = Path(info)
            if src.resolve() != out.resolve():
                from PIL import Image
                im = Image.open(src).convert("RGB").resize((W, H), Image.LANCZOS)
                im.save(out, "PNG")
            break
        errors.append(f"{backend}: {info}")

    if source is None:
        payload = {"ok": False, "errors": errors}
        print(json.dumps(payload, ensure_ascii=False, indent=1) if a.json else errors[0], file=sys.stderr)
        return 1

    payload = {"ok": True, "out": str(out), "source": source, "backend": source,
               "palette": a.palette, "mode": a.mode, "size": [W, H], "prompt": prompt,
               "ai_generated": source in ("arkcli", "coze"), "errors": errors}
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=1))
    else:
        print(f"bg -> {out} · source={source} · {'AI 生成' if payload['ai_generated'] else '本地兜底（非 AI）'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
