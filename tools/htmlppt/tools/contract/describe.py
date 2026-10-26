#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""describe.py —— 从 potx/pptx 生成机器可读契约（describe.json / layout.md / deck 清单）

只依赖 zipfile + lxml（python-pptx 打不开 .potx，content-type 限制）。

用法：
  python3 tools/contract/describe.py <potx|pptx> [--json out.json] [--layout-md dir]
                                    [--deck-out deck.json] [--contract 槽位契约.md]

输出 schema：htmlppt/describe@1
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import zipfile
from pathlib import Path

from lxml import etree

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"

EMU_PX = 9525.0
CANVAS = (1280, 720)
DEFAULT_THEMES = ["ai", "industry", "ocean", "medical", "agri", "academic", "robot", "domestic", "bp", "equipment"]
ROOT = Path(__file__).resolve().parents[2]


def q(tag: str, ns: str = NS_P) -> str:
    return f"{{{ns}}}{tag}"


def emu_to_px(v: str | None) -> float | None:
    if v is None:
        return None
    return round(float(v) / EMU_PX, 1)


def capacity(w: float, h: float, sz_pt: float | None, ins_l: float = 0.0, ins_r: float = 0.0) -> dict | None:
    """CJK 口径：1.0em/字，行距 1.2，留 10% 余量（与 capacity.py 同源）。"""
    if not sz_pt:
        return None
    em = sz_pt * 4.0 / 3.0  # pt -> px
    per_line = max(1, int((w - ins_l - ins_r) / (em * 1.0)))
    lines = max(1, int((h + 2) / (em * 1.2)))
    return {"per_line": per_line, "lines": lines,
            "text": f"{per_line} 字（单行）" if lines <= 1 else f"{per_line} 字/行 × {lines} 行"}


def parse_contract_md(path: Path | None) -> dict[tuple[str, str], dict]:
    """解析《槽位契约.md》的表格，取其 prose 字段（示例 / 必填）作为补充；结构字段以 XML 为准。"""
    if path is None or not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    out: dict[tuple[str, str], dict] = {}
    sections = re.split(r"^## (S\d+) · (.+?)$", text, flags=re.M)
    for i in range(1, len(sections) - 2, 3):
        raw_sid, name, body = sections[i], sections[i + 1].strip(), sections[i + 2]
        sid = f"S{int(raw_sid[1:]):02d}"
        for row in re.findall(r"^\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]*)\|([^|]*)\|\s*$", body, re.M):
            slot = row[0].strip()
            if not slot or slot == "槽位名":
                continue
            out[(sid, slot)] = {
                "type_md": row[1].strip().strip("`"),
                "pos_md": row[2].strip(),
                "sz_md": row[3].strip(),
                "cap_md": row[4].strip(),
                "sample": row[5].strip(),
                "required": "必填" in row[6],
            }
    return out


def load_rels(z: zipfile.ZipFile, part: str) -> dict[str, dict]:
    d = part.rsplit("/", 1)[0] if "/" in part else ""
    rel_name = f"{d}/_rels/{part.rsplit('/', 1)[-1]}.rels" if d else f"_rels/{part}.rels"
    if rel_name not in z.namelist():
        return {}
    root = etree.fromstring(z.read(rel_name))
    return {el.get("Id"): {"type": el.get("Type", ""), "target": el.get("Target", "")} for el in root}


def describe(path: Path, contract_md: Path | None) -> dict:
    z = zipfile.ZipFile(path)
    names = z.namelist()
    pres = etree.fromstring(z.read("ppt/presentation.xml"))
    sldSz = pres.find(q("sldSz"))
    canvas = {"w": int(round(int(sldSz.get("cx")) / EMU_PX)), "h": int(round(int(sldSz.get("cy")) / EMU_PX)),
              "cx": int(sldSz.get("cx")), "cy": int(sldSz.get("cy"))}
    rels = load_rels(z, "ppt/presentation.xml")
    masters = []
    for rid, rel in rels.items():
        if rel["type"].endswith("/slideMaster"):
            part = "ppt/" + rel["target"] if not rel["target"].startswith("/") else rel["target"].lstrip("/")
            masters.append({"id": f"master{len(masters) + 1}", "part": part})
    layout_parts = sorted([n for n in names if re.match(r"ppt/slideLayouts/slideLayout\d+\.xml$", n)],
                          key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
    # layout -> master 关系
    layout_master = {}
    for lp in layout_parts:
        for rid, rel in load_rels(z, lp).items():
            if rel["type"].endswith("/slideMaster"):
                layout_master[lp] = "ppt/" + rel["target"]
    md = parse_contract_md(contract_md)
    layouts = []
    for idx, lp in enumerate(layout_parts, 1):
        root = etree.fromstring(z.read(lp))
        cSld = root.find(q("cSld"))
        name = cSld.get("name", f"layout{idx}") if cSld is not None else f"layout{idx}"
        tx = root.find(q("txStyles"))
        slots = []
        for sp in root.iter(q("sp")):
            ph = sp.find(f"{q('nvSpPr')}/{q('nvPr')}/{q('ph')}")
            if ph is None:
                continue
            nv = sp.find(f"{q('nvSpPr')}/{q('cNvPr')}")
            slot_name = (nv.get("name") if nv is not None else "") or f"slot{len(slots) + 1}"
            ph_type = ph.get("type", "body") or "body"
            xfrm = sp.find(f"{q('spPr')}/{q('xfrm', NS_A)}")
            x = y = w = h = None
            if xfrm is not None:
                off = xfrm.find(q("off", NS_A))
                ext = xfrm.find(q("ext", NS_A))
                if off is not None:
                    x, y = emu_to_px(off.get("x")), emu_to_px(off.get("y"))
                if ext is not None:
                    w, h = emu_to_px(ext.get("cx")), emu_to_px(ext.get("cy"))
            sz = None
            lst = sp.find(f"{q('txBody')}/{q('lstStyle', NS_A)}/{q('lvl1pPr', NS_A)}/{q('defRPr', NS_A)}")
            if lst is not None and lst.get("sz"):
                sz = int(lst.get("sz")) / 100.0
            if sz is None and tx is not None:
                style = tx.find(q("titleStyle" if ph_type == "title" else "bodyStyle"))
                if style is not None:
                    d = style.find(f"{q('lvl1pPr', NS_A)}/{q('defRPr', NS_A)}")
                    if d is not None and d.get("sz"):
                        sz = int(d.get("sz")) / 100.0
            sid = f"S{idx:02d}"
            extra = md.get((sid, slot_name), {})
            slot = {
                "name": slot_name,
                "type": ph_type,
                "idx": ph.get("idx"),
                "x": x if x is not None else 0.0,
                "y": y if y is not None else 0.0,
                "w": w if w is not None else 0.0,
                "h": h if h is not None else 0.0,
                "sz_pt": sz,
                "capacity": capacity(w or 0.0, h or 0.0, sz),
                "sample": extra.get("sample", ""),
                "required": extra.get("required"),
            }
            slots.append(slot)
        layouts.append({
            "id": f"S{idx:02d}",
            "part": lp,
            "name": name,
            "master": layout_master.get(lp),
            "slot_count": len(slots),
            "slots": slots,
        })
    themes = detect_themes()
    components = load_components()
    return {
        "schema": "htmlppt/describe@1",
        "source": str(path),
        "canvas": canvas,
        "masters": masters,
        "layouts": layouts,
        "themes": themes,
        "components": components,
        "totals": {
            "layouts": len(layouts),
            "slots": sum(l["slot_count"] for l in layouts),
            "by_type": count_types(layouts),
        },
    }


def count_types(layouts: list[dict]) -> dict:
    out: dict[str, int] = {}
    for lay in layouts:
        for s in lay["slots"]:
            out[s["type"]] = out.get(s["type"], 0) + 1
    return out


def detect_themes() -> list[str]:
    retint = ROOT / ".." / "PPT 复刻" / "tools" / "retint.py"
    if retint.exists():
        try:
            r = subprocess.run([sys.executable, str(retint), "--list"], capture_output=True, text=True, timeout=30)
            keys = re.findall(r"^\s*([a-z]+)\s+[#A-Fa-f0-9]", r.stdout or "", re.M)
            if len(keys) >= 5:
                return keys
        except Exception:  # noqa: BLE001
            pass
    return DEFAULT_THEMES


def load_components() -> list[dict]:
    p = ROOT / "contracts" / "components.json"
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data.get("components", [])
    except Exception:  # noqa: BLE001
        return []


def write_layout_md(d: dict, outdir: Path) -> int:
    outdir.mkdir(parents=True, exist_ok=True)
    n = 0
    for lay in d["layouts"]:
        lines = [f"# {lay['id']} · {lay['name']}", "",
                 f"> 版式部件：`{lay['part']}` ｜ 槽位 {lay['slot_count']} 个 ｜ master: `{lay['master']}`", "",
                 "## 槽位表", "",
                 "| 槽位名 | 类型 | 位置 (x,y,w,h) | 字号 | 建议字数 | 必填 | 示例 |",
                 "|---|---|---|---|---|---|---|"]
        for s in lay["slots"]:
            sz = f"{s['sz_pt']:g}pt" if s.get("sz_pt") else "—"
            cap = s["capacity"]["text"] if s.get("capacity") else "—"
            req = "必填" if s.get("required") else ("选填" if s.get("required") is False else "—")
            pos = f"{s['x']:g}, {s['y']:g}, {s['w']:g}, {s['h']:g}"
            lines.append(f"| {s['name']} | `{s['type']}` | {pos} | {sz} | {cap} | {req} | {s.get('sample') or ''} |")
        lines += ["", "## 填写规则", "",
                  "- 只能改槽位内容；位置/字号/颜色由版式保证，不要在 HTML 里改几何。",
                  "- 超出「建议字数」不会被拦截，但会折行或裁切——这是安全线。",
                  "- 复用槽位（如赛事全称）跨页出现时，修改必须显式声明作用域（本页 / 全册）。", ""]
        (outdir / f"{lay['id']}.md").write_text("\n".join(lines), encoding="utf-8")
        n += 1
    return n


def make_deck(d: dict) -> dict:
    pages = []
    for lay in d["layouts"]:
        pages.append({
            "id": lay["id"],
            "layout": lay["id"],
            "source": f"spec:{lay['id']}",
            "title": lay["name"].split("·", 1)[-1].strip(),
            "theme_slots": [],
            "content_ref": f"content/{lay['id']}.json",
        })
    return {
        "schema": "htmlppt/deck@1",
        "deck_id": "gold-template-demo",
        "canvas": {"w": d["canvas"]["w"], "h": d["canvas"]["h"]},
        "theme": "ai",
        "masters": [m["id"] for m in d["masters"]],
        "pages": pages,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--layout-md")
    ap.add_argument("--deck-out")
    ap.add_argument("--contract")
    a = ap.parse_args()
    path = Path(a.file)
    if not path.exists():
        print(f"missing {path}", file=sys.stderr)
        return 2
    contract = Path(a.contract) if a.contract else path.parent / "槽位契约.md"
    d = describe(path, contract)
    out = json.dumps(d, ensure_ascii=False, indent=1)
    if a.json_out:
        Path(a.json_out).write_text(out, encoding="utf-8")
    print(out)
    if a.layout_md:
        n = write_layout_md(d, Path(a.layout_md))
        print(f"# layout.md: {n} files -> {a.layout_md}", file=sys.stderr)
    if a.deck_out:
        deck = make_deck(d)
        Path(a.deck_out).write_text(json.dumps(deck, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"# deck manifest -> {a.deck_out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
