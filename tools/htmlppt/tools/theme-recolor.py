#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""theme-recolor.py —— 真正换主题：改写 theme1.xml 的 clrScheme（schemeClr 引用全跟着变）

retint.py 只改 srgbClr；国金模板的 108 处颜色是 schemeClr 引用，所以必须改主题色板。

用法：
  python3 tools/theme-recolor.py in.pptx <palette> -o out.pptx [--theme part]

palette 取自 `PPT 复刻/tools/retint.py` 的 INDUSTRIES（ai/industry/ocean/medical/agri/
academic/robot/domestic/bp/equipment）。
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path

from lxml import etree

NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
RETINT = Path("/Users/an/Desktop/Atlas/PPT/PPT 复刻/tools/retint.py")

# 主题槽位 ← 调色板角色
SCHEME_MAP = {
    "dk1": "BG",
    "lt1": "WHITE",
    "dk2": "DEEP",
    "lt2": "SUB",
    "accent1": "BLUE",
    "accent2": "CYAN",
    "accent3": "GOLD",
    "accent4": "HL",
    "accent5": "PANEL",
    "accent6": "MUTED",
    "hlink": "CYAN",
    "folHlink": "SUB",
}


def load_palettes() -> dict:
    spec = importlib.util.spec_from_file_location("retint", RETINT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # 有 __main__ 保护，不会执行 CLI
    return mod.INDUSTRIES


def recolor_theme(xml: bytes, fills: dict) -> tuple[bytes, int]:
    root = etree.fromstring(xml)
    cs = root.find(f"{{{NS_A}}}themeElements/{{{NS_A}}}clrScheme")
    if cs is None:
        raise ValueError("theme has no clrScheme")
    changed = 0
    for el in cs:
        name = etree.QName(el).localname
        role = SCHEME_MAP.get(name)
        if not role or role not in fills:
            continue
        new_val = fills[role].upper()
        cur = el[0]
        if cur.get("val", "").upper() == new_val:
            continue
        old_tag = etree.QName(cur).localname
        if old_tag == "srgbClr":
            cur.set("val", new_val)
        else:  # sysClr 等：换成 srgbClr
            new = etree.SubElement(el, f"{{{NS_A}}}srgbClr")
            new.set("val", new_val)
            el.remove(cur)
        changed += 1
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), changed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("palette")
    ap.add_argument("-o", "--out")
    ap.add_argument("--json")
    a = ap.parse_args()
    palettes = load_palettes()
    if a.palette not in palettes:
        print(f"未知调色板：{a.palette}；可选 {sorted(palettes)}", file=sys.stderr)
        return 2
    pal = palettes[a.palette]
    fills = pal["fills"]
    # 浅色主题要把 dk1/lt1 语义对调：dk1=浅底、lt1=深字（否则白底白字）
    global SCHEME_MAP
    if pal.get("light"):
        SCHEME_MAP = dict(SCHEME_MAP, lt1="DARKTX")
    src = Path(a.src)
    out = Path(a.out) if a.out else src.with_name(f"{src.stem}-{a.palette}.pptx")
    zin = zipfile.ZipFile(src)
    buf = io.BytesIO()
    report = {"src": str(src), "palette": a.palette, "themes": {}, "changed": 0}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename.startswith("ppt/theme/") and info.filename.endswith(".xml"):
                new, n = recolor_theme(data, fills)
                if n:
                    report["themes"][info.filename] = n
                    report["changed"] += n
                    data = new
            zout.writestr(info, data)
    out.write_bytes(buf.getvalue())
    print(f"theme {a.palette}: {report['changed']} slots -> {out}")
    if a.json:
        Path(a.json).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
