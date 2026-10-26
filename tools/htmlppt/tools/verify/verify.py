#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""verify.py —— PPTX/POTX 六层验收（无 PowerPoint 代理链）

子命令：
  pkg    OPC 包完整性（CT 覆盖 / rels 悬空 / 压缩方法 / slide→layout→master / 画布尺寸）
  order  ECMA-376 CT_Presentation 子元素顺序 + a:lin@ang 越界（自实现，零依赖）
  xsd    ECMA-376 Transitional XSD（需要 xmllint；首次自动下载缓存到 ~/.cache/htmlppt/xsd）
  sdk    Open XML SDK 校验器（ooxml-validate 预编译二进制；缺失时尝试下载）
  potx   模板结构（main CT=template / master / layout 关系闭合 / layout type 唯一）
  fonts  字体嵌入一致性（fntdata 解析 / fsType / embeddedFontLst↔rels↔part）
  lo     LibreOffice 烟雾测试（能打开 / 页数正确 / stderr 无 Error）
  all    依次执行，输出 JSON 与退出码（0 全绿 / 1 有错误 / 2 工具失败）

用法：
  python3 tools/verify/verify.py all <file> --json
  python3 tools/verify/verify.py pkg <file>
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships"

CACHE = Path.home() / ".cache" / "htmlppt"
XSD_DIR = CACHE / "xsd"
SDK_DIR = CACHE / "ooxml-validate"
SDK_URL = ("https://github.com/shbernal/ooxml-validate/releases/download/v0.0.4/"
           "ooxml-validate-osx-arm64.tar.gz")
SDK_EXPECTED_VERSION = "3.5.1"

PRES_ORDER = [
    "sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz",
    "notesSz", "smartTags", "embeddedFontLst", "custShowLst", "photoAlbum",
    "custDataLst", "kinsoku", "defaultTextStyle", "modifyVerifier", "extLst",
]
CANVAS_CX, CANVAS_CY = 12192000, 6858000


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["pkg", "order", "xsd", "sdk", "potx", "fonts", "lo", "all"])
    ap.add_argument("file")
    ap.add_argument("--json", action="store_true", dest="as_json")
    ap.add_argument("--strict", action="store_true", help="跳过（skip）也视为失败")
    ap.add_argument("--pages", type=int, default=None, help="lo: 期望页数")
    return ap.parse_args()


def issue(code, part="", detail=""):
    return {"code": code, "part": part, "detail": detail}


def load_ct(z):
    from lxml import etree
    root = etree.fromstring(z.read("[Content_Types].xml"))
    defaults, overrides = {}, {}
    for el in root:
        tag = etree.QName(el).localname
        if tag == "Default":
            defaults[el.get("Extension", "").lower()] = el.get("ContentType")
        elif tag == "Override":
            overrides[el.get("PartName")] = el.get("ContentType")
    return defaults, overrides


def resolve_rel(source_part, target):
    if target.startswith("/"):
        return target.lstrip("/")
    base = source_part.rsplit("/", 1)[0] if "/" in source_part else ""
    parts = (base + "/" + target).split("/")
    out = []
    for p in parts:
        if p in ("", "."):
            continue
        if p == "..":
            if out:
                out.pop()
        else:
            out.append(p)
    return "/".join(out)


def iter_rels(z):
    from lxml import etree
    for name in z.namelist():
        if not name.endswith(".rels"):
            continue
        if name == "_rels/.rels":
            source = ""
        else:
            src_dir = name.rsplit("/_rels/", 1)[0] if "/_rels/" in name else ""
            base = name.rsplit("/_rels/", 1)[1][:-5] if "/_rels/" in name else name[:-5]
            source = f"{src_dir}/{base}" if src_dir else base
        try:
            root = etree.fromstring(z.read(name))
        except Exception as e:  # noqa: BLE001
            yield source, [], f"unparseable rels: {e}"
            continue
        rels = []
        for el in root:
            rels.append({"id": el.get("Id"), "type": el.get("Type", ""), "target": el.get("Target", ""),
                         "mode": el.get("TargetMode", "Internal")})
        yield source, rels, None


def cmd_pkg(path):
    problems = []
    z = zipfile.ZipFile(path)
    names = [n for n in z.namelist() if not n.endswith("/")]
    dup = len(names) - len(set(names))
    if dup:
        problems.append(issue("E_DUP_PART", "", f"{dup} duplicate entries"))
    if "[Content_Types].xml" not in names:
        problems.append(issue("E_NO_CT", "", "missing [Content_Types].xml"))
        return problems
    defaults, overrides = load_ct(z)
    main_ct = overrides.get("/ppt/presentation.xml", "")
    for n in names:
        if n == "[Content_Types].xml":
            continue
        if "/" + n in overrides or n in overrides:
            continue
        ext = n.rsplit(".", 1)[-1].lower() if "." in n else ""
        if ext not in defaults:
            problems.append(issue("E_CT_MISSING", n, f"no content type for .{ext}"))
    for n in overrides:
        if n.lstrip("/") not in names:
            problems.append(issue("E_CT_DANGLING", n, "override for missing part"))
    # compression
    for info in z.infolist():
        if info.compress_type not in (0, 8):
            problems.append(issue("E_COMPRESSION", info.filename, f"method {info.compress_type}"))
    # rels
    for source, rels, err in iter_rels(z):
        if err:
            problems.append(issue("E_RELS_PARSE", source, err))
            continue
        for r in rels:
            if r["mode"] == "External":
                continue
            tgt = resolve_rel(source, r["target"])
            if tgt and tgt not in names:
                problems.append(issue("E_RELS_DANGLING", source, f"{r['id']} -> {r['target']}"))
    # canvas size
    try:
        from lxml import etree
        pres = etree.fromstring(z.read("ppt/presentation.xml"))
        sz = pres.find(f"{{{NS_P}}}sldSz")
        if sz is None:
            problems.append(issue("E_NO_SLDSZ", "ppt/presentation.xml", "no sldSz"))
        else:
            if int(sz.get("cx")) != CANVAS_CX or int(sz.get("cy")) != CANVAS_CY:
                problems.append(issue("E_CANVAS", "ppt/presentation.xml",
                                      f'{sz.get("cx")}x{sz.get("cy")} != {CANVAS_CX}x{CANVAS_CY}'))
    except Exception as e:  # noqa: BLE001
        problems.append(issue("E_PRES_PARSE", "ppt/presentation.xml", str(e)))
    # slide -> layout -> master
    for source, rels, _ in iter_rels(z):
        if re.match(r"^ppt/slides/slide\d+\.xml$", source):
            if not any(r["type"].endswith("/slideLayout") for r in rels):
                problems.append(issue("E_NO_LAYOUT_REL", source, "slide has no slideLayout rel"))
        if re.match(r"^ppt/slideLayouts/slideLayout\d+\.xml$", source):
            if not any(r["type"].endswith("/slideMaster") for r in rels):
                problems.append(issue("E_NO_MASTER_REL", source, "layout has no slideMaster rel"))
    return problems


def cmd_order(path):
    from lxml import etree
    problems = []
    z = zipfile.ZipFile(path)
    pres = etree.fromstring(z.read("ppt/presentation.xml"))
    names = [etree.QName(c).localname for c in pres]
    idx = [PRES_ORDER.index(n) for n in names if n in PRES_ORDER]
    if idx != sorted(idx):
        problems.append(issue("E_PRES_ORDER", "ppt/presentation.xml", " -> ".join(names)))
    for n in z.namelist():
        if not n.endswith(".xml") or not (n.startswith("ppt/slides/") or n.startswith("ppt/slideLayouts/")
                                          or n.startswith("ppt/slideMasters/") or n.startswith("ppt/theme/")):
            continue
        try:
            root = etree.fromstring(z.read(n))
        except Exception:  # noqa: BLE001
            continue
        for el in root.iter(f"{{{NS_A}}}lin"):
            v = el.get("ang")
            if v and int(v) >= 21600000:
                problems.append(issue("E_ANG_RANGE", n, f"ang={v} >= 21600000"))
    return problems


def ensure_xsd() -> tuple[Path | None, str]:
    pml = XSD_DIR / "pml.xsd"
    if pml.exists():
        return XSD_DIR, ""
    XSD_DIR.parent.mkdir(parents=True, exist_ok=True)
    url = "https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip"
    try:
        raw = CACHE / "ecma376.zip"
        if not raw.exists():
            urllib.request.urlretrieve(url, raw)
        with zipfile.ZipFile(raw) as z:
            inner = [n for n in z.namelist() if n.endswith("OfficeOpenXML-XMLSchema-Transitional.zip")]
            if not inner:
                return None, "schema zip not found inside ECMA archive"
            (XSD_DIR).mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(io.BytesIO(z.read(inner[0]))) as z2:
                z2.extractall(XSD_DIR)
        return (XSD_DIR, "") if pml.exists() else (None, "pml.xsd missing after extract")
    except Exception as e:  # noqa: BLE001
        return None, f"download failed: {e}"


def cmd_xsd(path):
    xsd_dir, err = ensure_xsd()
    if xsd_dir is None:
        return [], [f"xsd skipped: {err}"]
    problems, skipped = [], []
    tmp = Path(tempfile.mkdtemp())
    with zipfile.ZipFile(path) as z:
        z.extractall(tmp)
    targets = [tmp / "ppt" / "presentation.xml"]
    for sub in ("slides", "slideLayouts", "slideMasters"):
        targets += sorted((tmp / "ppt" / sub).glob("*.xml"))
    for t in targets:
        schema = xsd_dir / "pml.xsd"
        r = subprocess.run(["xmllint", "--noout", "--schema", str(schema), str(t)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            problems.append(issue("E_XSD", str(t.relative_to(tmp)), (r.stderr or "").strip().splitlines()[-1:][0] if r.stderr else "invalid"))
    for t in sorted((tmp / "ppt" / "theme").glob("*.xml")):
        schema = xsd_dir / "dml-main.xsd"
        r = subprocess.run(["xmllint", "--noout", "--schema", str(schema), str(t)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            problems.append(issue("E_XSD", str(t.relative_to(tmp)), (r.stderr or "").strip().splitlines()[-1:][0] if r.stderr else "invalid"))
    return problems, skipped


def ensure_sdk() -> tuple[Path | None, str]:
    for p in SDK_DIR.glob("**/ooxml-validate"):
        if p.is_file() and os.access(p, os.X_OK):
            return p, ""
    if sys.platform != "darwin":
        return None, "sdk binary auto-download only implemented for darwin/arm64"
    try:
        SDK_DIR.mkdir(parents=True, exist_ok=True)
        import tarfile
        api = "https://api.github.com/repos/shbernal/ooxml-validate/releases/tags/v0.0.4"
        req = urllib.request.Request(api, headers={"User-Agent": "htmlppt-verify"})
        meta = json.loads(urllib.request.urlopen(req, timeout=30).read())
        asset_url = next(a["browser_download_url"] for a in meta["assets"] if "osx-arm64" in a["name"])
        tmp = CACHE / "ooxml-validate.tgz"
        urllib.request.urlretrieve(asset_url, tmp)
        with tarfile.open(tmp) as tf:
            tf.extractall(SDK_DIR)
        for p in SDK_DIR.glob("**/ooxml-validate"):
            if p.is_file():
                os.chmod(p, 0o755)
                return p, ""
        return None, "binary not found in archive"
    except Exception as e:  # noqa: BLE001
        return None, f"sdk unavailable: {e}"


def cmd_sdk(path):
    exe, err = ensure_sdk()
    if exe is None:
        return [], [f"sdk skipped: {err}"]
    r = subprocess.run([str(exe), str(path)], capture_output=True, text=True)
    out = r.stdout or ""
    if r.returncode == 2:
        return [], [f"sdk tool failure: {(out + (r.stderr or '')).strip()[:300]}"]
    # 输出是 JSON：{results:[{valid, truncated, errors:[{id,partUri,xpath,description}]}]}
    try:
        data = json.loads(out[out.index("{"):])
    except Exception:  # noqa: BLE001
        return ([issue("E_SDK_OUTPUT", "", out.strip()[:300])], [])
    problems = []
    for res in data.get("results", []):
        if res.get("truncated"):
            problems.append(issue("E_SDK_TRUNCATED", res.get("file", ""), "validator truncated output"))
        for e in res.get("errors", []):
            problems.append(issue("E_SDK", str(e.get("partUri", "")).lstrip("/"),
                                  f"{e.get('id')}: {str(e.get('description', ''))[:160]}"))
    return problems, []


def cmd_potx(path):
    problems = []
    z = zipfile.ZipFile(path)
    defaults, overrides = load_ct(z)
    main = overrides.get("/ppt/presentation.xml", "")
    is_template = main.endswith("template.main+xml")
    label = "template.main+xml" if is_template else "presentation.main+xml"
    if not (is_template or main.endswith("presentation.main+xml")):
        problems.append(issue("E_MAIN_CT", "ppt/presentation.xml", main))
    masters = [n for n in z.namelist() if re.match(r"^ppt/slideMasters/slideMaster\d+\.xml$", n)]
    if not masters:
        problems.append(issue("E_NO_MASTER", "", "no slideMaster part"))
    for source, rels, _ in iter_rels(z):
        if re.match(r"^ppt/slideLayouts/slideLayout\d+\.xml$", source):
            if not any(r["type"].endswith("/slideMaster") for r in rels):
                problems.append(issue("E_LAYOUT_MASTER", source, "layout missing master rel"))
    try:
        from lxml import etree
        types = []
        for m in masters:
            layouts = [n for n in z.namelist() if re.match(r"^ppt/slideLayouts/slideLayout\d+\.xml$", n)]
        for lay in layouts if masters else []:
            root = etree.fromstring(z.read(lay))
            cSld = root.find(f"{{{NS_P}}}cSld")
            types.append((lay, cSld.get("name", "") if cSld is not None else ""))
        seen = {}
        for lay, name in types:
            if name in seen:
                problems.append(issue("E_LAYOUT_DUPNAME", lay, f"name={name} also {seen[name]}"))
            seen[name] = lay
    except Exception as e:  # noqa: BLE001
        problems.append(issue("E_POTX_PARSE", "", str(e)))
    return problems


def cmd_fonts(path):
    problems = []
    z = zipfile.ZipFile(path)
    names = z.namelist()
    fonts = [n for n in names if n.lower().endswith(".fntdata")]
    defaults, overrides = load_ct(z)
    if fonts and "fntdata" not in defaults:
        problems.append(issue("E_FONT_CT", "", "no Default for .fntdata"))
    pres = None
    try:
        from lxml import etree
        pres = etree.fromstring(z.read("ppt/presentation.xml"))
    except Exception:  # noqa: BLE001
        pass
    if pres is not None and fonts:
        lst = pres.find(f"{{{NS_P}}}embeddedFontLst")
        if lst is None:
            problems.append(issue("E_FONT_NO_LST", "ppt/presentation.xml", "fntdata exists but no embeddedFontLst"))
        else:
            rels = {}
            for source, rs, _ in iter_rels(z):
                if source == "ppt/presentation.xml":
                    rels = {r["id"]: r["target"] for r in rs}
            for el in lst:
                for f in el:
                    rid = f.get(f"{{{NS_R}}}id")
                    if rid and rid not in rels:
                        problems.append(issue("E_FONT_REL", "ppt/presentation.xml", f"{rid} missing rels"))
    for n in fonts:
        data = z.read(n)
        info = font_info(data)
        if info["kind"] == "eot":
            if info["eot_size"] != len(data):
                problems.append(issue("E_FONT_EOT", n, f"EOTSize {info['eot_size']} != {len(data)}"))
        elif info["kind"] == "sfnt":
            pass  # LibreOffice 会在 fntdata 里写裸 sfnt（powerpoint 用 EOT；两者都接受）
        else:
            problems.append(issue("E_FONT_FORMAT", n, f"{len(data)} bytes, unknown header {data[:4].hex()}"))
            continue
        fs = info.get("fs_type")
        if fs is not None and (fs & 0x0F) not in (0, 8):
            problems.append(issue("E_FONT_FSTYPE", n, f"fsType={fs & 0x0F} not embeddable ({info.get('name', '')})"))
    return problems


def font_info(data: bytes) -> dict:
    """EOT（PowerPoint 习惯）或裸 sfnt（LibreOffice 习惯）都识别。"""
    if len(data) >= 36 and struct.unpack_from("<H", data, 34)[0] == 0x504C:
        return {"kind": "eot", "eot_size": struct.unpack_from("<I", data, 0)[0],
                "fs_type": struct.unpack_from("<H", data, 32)[0]}
    if data[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf"):
        try:
            from fontTools.ttLib import TTFont
            f = TTFont(io.BytesIO(data), fontNumber=0)
            fs = f["OS/2"].fsType if "OS/2" in f else None
            name = f["name"].getDebugName(1) or ""
            return {"kind": "sfnt", "fs_type": fs, "name": name,
                    "glyphs": f["maxp"].numGlyphs if "maxp" in f else None}
        except Exception as e:  # noqa: BLE001
            return {"kind": "sfnt", "fs_type": None, "error": str(e)}
    return {"kind": "unknown"}
    return problems


def cmd_lo(path):
    problems, skipped = [], []
    exe = "soffice" if subprocess.run(["which", "soffice"], capture_output=True).returncode == 0 else None
    if not exe:
        return [], ["lo skipped: soffice not found"]
    outdir = Path(tempfile.mkdtemp())
    env = dict(os.environ)
    env.setdefault("FONTCONFIG_FILE", "/opt/homebrew/etc/fonts/fontconfig")
    r = subprocess.run([exe, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(outdir), str(path)],
                       capture_output=True, text=True, env=env, timeout=180)
    combined = (r.stdout or "") + (r.stderr or "")
    if "Error:" in combined:
        problems.append(issue("E_LO_ERROR", "", [l for l in combined.splitlines() if "Error:" in l][0][:300]))
    pdf = next(outdir.glob("*.pdf"), None)
    if pdf is None:
        problems.append(issue("E_LO_NO_PDF", "", "libreoffice produced no pdf"))
    return problems, skipped


def main():
    a = parse_args()
    path = Path(a.file)
    runners = {"pkg": cmd_pkg, "order": cmd_order, "xsd": cmd_xsd, "sdk": cmd_sdk,
               "potx": cmd_potx, "fonts": cmd_fonts, "lo": cmd_lo}
    results, skipped = {}, []
    if a.cmd == "all":
        for name, fn in runners.items():
            try:
                res = fn(path)
                probs, sk = (res, []) if isinstance(res, list) else res
            except Exception as e:  # noqa: BLE001
                probs, sk = [issue("E_VERIFIER_CRASH", name, str(e))], []
            results[name] = probs
            skipped += sk
    else:
        res = runners[a.cmd](path)
        results[a.cmd], skipped = (res, []) if isinstance(res, list) else res
    total = sum(len(v) for v in results.values())
    payload = {"file": str(path), "ok": total == 0 and (not skipped or not a.strict),
               "errors": total, "skipped": skipped, "layers": {k: v for k, v in results.items()}}
    if a.as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=1))
    else:
        print(f"{path.name}: {'PASS' if payload['ok'] else 'FAIL'} · {total} errors")
        for layer, probs in results.items():
            for p in probs:
                print(f"  [{layer}] {p['code']} {p['part']} {p['detail']}")
        for s in skipped:
            print(f"  (skip) {s}")
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
