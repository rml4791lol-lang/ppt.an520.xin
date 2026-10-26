#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""replace.py —— 对 pptx2html 的产物做「槽位替换」

设计：
  * 内容图有 `data-pptx-slot="img-<slide>-<n>"`，对应 slots.json 里的一条记录；
  * 替换 = 覆盖 assets/ 里的图片文件（原图备份到 assets/_originals/），HTML 不用改；
  * 背景图有 `data-pptx-bg-id="slide-<n>-bg"`，用 `replace-bg` 整体换。

用法：
  python replace.py list <dir>
  python replace.py image <dir> --slot img-3-1 --image new.png
  python replace.py image <dir> --slot img-3-1 --image new.png --out <newdir>   # 不破坏原目录
  python replace.py background <dir> --slide 3 --image bg.png
  python replace.py batch <dir> --map replacements.json
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def load(dirpath: Path):
    slots_p = dirpath / "slots.json"
    map_p = dirpath / "map.json"
    if not slots_p.exists():
        sys.exit(f"[replace] 找不到 {slots_p}；请先用 pptx2html.py 生成")
    return (json.loads(slots_p.read_text(encoding="utf-8")),
            json.loads(map_p.read_text(encoding="utf-8")) if map_p.exists() else {})


def save(dirpath: Path, slots: dict, mp: dict):
    (dirpath / "slots.json").write_text(json.dumps(slots, ensure_ascii=False, indent=1), encoding="utf-8")
    if mp:
        # map.json 里的槽位信息同步更新
        mp["slots"] = slots.get("slots", mp.get("slots"))
        (dirpath / "map.json").write_text(json.dumps(mp, ensure_ascii=False, indent=1), encoding="utf-8")


def find_slot(slots: dict, slot_id: str):
    for s in slots.get("slots", []):
        if s.get("slot") == slot_id:
            return s
    return None


def do_list(dirpath: Path):
    slots, _ = load(dirpath)
    print(f"{'slot':<14}{'页':<4}{'角色':<12}{'尺寸':<16}{'文件'}")
    for s in slots.get("slots", []):
        r = s.get("rect") or {}
        size = f"{r.get('w', 0):.0f}x{r.get('h', 0):.0f}"
        print(f"{s['slot']:<14}{s.get('slide', ''):<4}{s.get('role', ''):<12}{size:<16}{s.get('src', '')}")
        if s.get("ocrText"):
            print(f"{'':<14}OCR: {s['ocrText'][:70]}")
    print(f"\n共 {len(slots.get('slots', []))} 个槽位；摘要 {slots.get('summary')}")


def apply_image(dirpath: Path, slot_id: str, image: Path, outdir: Path | None):
    slots, mp = load(dirpath)
    s = find_slot(slots, slot_id)
    if not s:
        sys.exit(f"[replace] 槽位不存在：{slot_id}")
    target_dir = outdir or dirpath
    if outdir:
        # 复制一份完整产物再改，原目录不动
        if outdir.exists():
            shutil.rmtree(outdir)
        shutil.copytree(dirpath, outdir)
    src_rel = Path(s["src"])
    asset_path = target_dir / src_rel
    backup = target_dir / "assets" / "_originals" / src_rel.name
    backup.parent.mkdir(parents=True, exist_ok=True)
    if asset_path.exists() and not backup.exists():
        shutil.copy2(asset_path, backup)
    shutil.copy2(image, asset_path)
    s["replaced"] = {"with": str(image), "original": str(backup)}
    slots["slots"] = slots.get("slots", [])
    save(target_dir, slots, mp)
    rel = asset_path.relative_to(target_dir)
    print(f"[replace] 已替换 {slot_id} → {rel}（原图备份 {backup.relative_to(target_dir)}）")
    print(f"[replace] 下一步：python3 cli/htmlppt.py build {target_dir/'deck.html'} -o {target_dir/'rebuild'}")


def apply_background(dirpath: Path, slide_no: int, image: Path, outdir: Path | None):
    slots, mp = load(dirpath)
    target_dir = outdir or dirpath
    if outdir:
        if outdir.exists():
            shutil.rmtree(outdir)
        shutil.copytree(dirpath, outdir)
    html = (target_dir / "deck.html").read_text(encoding="utf-8")
    marker = f'data-pptx-bg-id="slide-{slide_no}-bg"'
    idx = html.find(marker)
    if idx < 0:
        sys.exit(f"[replace] 找不到第 {slide_no} 页背景")
    import re
    seg = html[idx: idx + 4000]
    m = re.search(r"background-image:url\('([^']+)'\)", seg)
    if not m:
        sys.exit(f"[replace] 第 {slide_no} 页没有 background-image（可能是纯色/渐变背景）")
    old = m.group(1)
    if old.startswith("data:"):
        sys.exit("[replace] 该产物是单文件内嵌版，无法直接换背景；请用默认链接式产物（或重新 extract）")
    asset = target_dir / old
    backup = target_dir / "assets" / "_originals" / asset.name
    backup.parent.mkdir(parents=True, exist_ok=True)
    if asset.exists() and not backup.exists():
        shutil.copy2(asset, backup)
    shutil.copy2(image, asset)
    print(f"[replace] 已替换第 {slide_no} 页背景 → {asset.relative_to(target_dir)}（原图备份）")
    print(f"[replace] 下一步：python3 cli/htmlppt.py build {target_dir/'deck.html'} -o {target_dir/'rebuild'}")


def do_batch(dirpath: Path, mapfile: Path, outdir: Path | None):
    mapping = json.loads(mapfile.read_text(encoding="utf-8"))
    for slot_id, img in mapping.items():
        apply_image(dirpath, slot_id, Path(img), outdir)


def main():
    ap = argparse.ArgumentParser(description="替换 pptx2html 产物里的图片槽位/背景")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("list"); p1.add_argument("dir")
    p2 = sub.add_parser("image"); p2.add_argument("dir"); p2.add_argument("--slot", required=True)
    p2.add_argument("--image", required=True); p2.add_argument("--out")
    p3 = sub.add_parser("background"); p3.add_argument("dir"); p3.add_argument("--slide", type=int, required=True)
    p3.add_argument("--image", required=True); p3.add_argument("--out")
    p4 = sub.add_parser("batch"); p4.add_argument("dir"); p4.add_argument("--map", required=True); p4.add_argument("--out")
    a = ap.parse_args()
    d = Path(a.dir).resolve()
    if a.cmd == "list":
        do_list(d)
    elif a.cmd == "image":
        apply_image(d, a.slot, Path(a.image).resolve(), Path(a.out).resolve() if a.out else None)
    elif a.cmd == "background":
        apply_background(d, a.slide, Path(a.image).resolve(), Path(a.out).resolve() if a.out else None)
    elif a.cmd == "batch":
        do_batch(d, Path(a.map).resolve(), Path(a.out).resolve() if a.out else None)


if __name__ == "__main__":
    main()
