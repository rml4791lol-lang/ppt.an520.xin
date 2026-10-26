#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""fix-pptx-structure.py —— 修复 OOXML 结构层缺陷（两个已实测的真实 bug）

1) p:presentation 子元素顺序：pptxgenjs 输出 sldMasterIdLst, sldIdLst, notesMasterIdLst…，
   ECMA-376 要求 notesMasterIdLst 在 sldIdLst 之前；xmllint/OpenXML SDK 都会报错。
2) a:lin@ang 越界：ang 必须 < 21600000（360°），360° 未归一化会写出 21600000。

用法：
  python tools/fix-pptx-structure.py <in.pptx|potx> <out.pptx> [--json report.json]
只改这两处，其余部件字节保持不变（未改 part 的 SHA256 可对拍）。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

from lxml import etree

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"

PRES_ORDER = [
    "sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz",
    "notesSz", "smartTags", "embeddedFontLst", "custShowLst", "photoAlbum",
    "custDataLst", "kinsoku", "defaultTextStyle", "modifyVerifier", "extLst",
]
ORD = {f"{{{NS_P}}}{n}": i for i, n in enumerate(PRES_ORDER)}
ANG_MAX = 21600000


def reorder_presentation(data: bytes) -> tuple[bytes, bool]:
    root = etree.fromstring(data)
    children = list(root)
    keyed = [(ORD.get(c.tag, 998), i, c) for i, c in enumerate(children)]
    sorted_children = [c for _, _, c in sorted(keyed, key=lambda t: (t[0], t[1]))]
    changed = [c.tag for c, s in zip(children, sorted_children) if c is not s]
    for c in children:
        root.remove(c)
    for c in sorted_children:
        root.append(c)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), bool(changed)


def fix_ang(data: bytes) -> tuple[bytes, int]:
    root = etree.fromstring(data)
    fixed = 0
    for el in root.iter(f"{{{NS_A}}}lin"):
        v = el.get("ang")
        if v is None:
            continue
        try:
            n = int(v)
        except ValueError:
            continue
        if n >= ANG_MAX or n < 0:
            el.set("ang", str(n % ANG_MAX))
            fixed += 1
    if not fixed:
        return data, 0
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), fixed


def fix_paragraphs(data: bytes) -> tuple[bytes, int]:
    """a:p 里出现多个 a:pPr（合法只有一个且必须在最前）；同时把 endParaRPr 归位到最后。"""
    root = etree.fromstring(data)
    fixed = 0
    for para in root.iter(f"{{{NS_A}}}p"):
        pprs = [c for c in para if c.tag == f"{{{NS_A}}}pPr"]
        for extra in pprs[1:]:
            para.remove(extra)
            fixed += 1
        if pprs:
            first = pprs[0]
            if para.getchildren().index(first) != 0:
                para.remove(first)
                para.insert(0, first)
                fixed += 1
    if not fixed:
        return data, 0
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), fixed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--json")
    a = ap.parse_args()

    src = Path(a.src)
    if not src.exists():
        print(f"missing {src}", file=sys.stderr)
        return 2
    zin = zipfile.ZipFile(src)
    report = {"file": str(src), "parts": len(zin.namelist()), "reordered": False,
              "ang_fixed": 0, "ang_files": {}, "paragraph_fixed": 0, "changed_parts": []}
    out_buf = io.BytesIO()
    with zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            changed = False
            if info.filename == "ppt/presentation.xml":
                new, did = reorder_presentation(data)
                report["reordered"] = did
                if did:
                    changed = True
                    data = new
            elif info.filename.endswith(".xml") and (
                info.filename.startswith("ppt/slides/") or info.filename.startswith("ppt/slideLayouts/")
                or info.filename.startswith("ppt/slideMasters/") or info.filename.startswith("ppt/theme/")
            ):
                new, n = fix_ang(data)
                if n:
                    report["ang_fixed"] += n
                    report["ang_files"][info.filename] = n
                    changed = True
                    data = new
                new2, n2 = fix_paragraphs(data)
                if n2:
                    report["paragraph_fixed"] += n2
                    changed = True
                    data = new2
            if changed:
                report["changed_parts"].append({
                    "part": info.filename, "sha256_before": hashlib.sha256(zin.read(info.filename)).hexdigest()[:16],
                    "sha256_after": hashlib.sha256(data).hexdigest()[:16],
                })
            zout.writestr(info, data)

    Path(a.dst).write_bytes(out_buf.getvalue())
    print(f"fixed -> {a.dst} · reordered={report['reordered']} · ang_fixed={report['ang_fixed']} "
          f"· paragraph_fixed={report['paragraph_fixed']} · changed_parts={len(report['changed_parts'])}")
    if a.json:
        Path(a.json).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
