#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验收套件的契约测试（外部行为，不测内部实现）。

跑法：
  python3 tools/verify/test_verify.py
覆盖：
  * 结构校验能抓到已知的两个真实缺陷（presentation 顺序、a:lin 角度越界）
  * 修复器把缺陷修好后校验通过
  * 正常产物的 OPC / potx 层零错误
  * verify all --json 输出稳定字段
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFY = ROOT / "tools" / "verify" / "verify.py"
FIXER = ROOT / "tools" / "fix-pptx-structure.py"
PROTO = ROOT / "prototype" / "out" / "deck.pptx"
BAD_ANG = ROOT / "deliverables" / "新作-科创港6页.pptx"
POTX = ROOT / ".." / "PPT 复刻" / "out" / "gold-template" / "国金模板.potx"
PY = sys.executable


def run_verify(cmd: str, path: Path) -> dict:
    r = subprocess.run([PY, str(VERIFY), cmd, str(path), "--json"], capture_output=True, text=True)
    return json.loads(r.stdout)


def codes(layer: list) -> set[str]:
    return {i["code"] for i in layer}


def rewrite_zip(src: Path, dst: Path, mutate) -> None:
    zin = zipfile.ZipFile(src)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            data = mutate(info.filename, data)
            zout.writestr(info, data)


@unittest.skipUnless(PROTO.exists(), "prototype/out/deck.pptx 不存在，先跑一次 build")
class OrderDefectTests(unittest.TestCase):
    def test_detects_presentation_order_violation(self):
        tmp = Path(tempfile.mkdtemp()) / "bad.pptx"

        def mutate(name, data):
            if name != "ppt/presentation.xml":
                return data
            txt = data.decode("utf-8")
            m = re.search(r"<p:notesMasterIdLst>.*?</p:notesMasterIdLst>", txt, re.S)
            if m:  # 把 notesMasterIdLst 挪到 sldIdLst 之后，制造已知违规
                block = m.group(0)
                txt = txt.replace(block, "", 1)
                txt = re.sub(r"(</p:sldIdLst>)", r"\1" + block, txt, count=1)
            return txt.encode("utf-8")

        rewrite_zip(PROTO, tmp, mutate)
        payload = run_verify("order", tmp)
        self.assertIn("E_PRES_ORDER", codes(payload["layers"]["order"]))

    def test_fixer_repairs_and_verifier_passes(self):
        bad = Path(tempfile.mkdtemp()) / "bad.pptx"
        fixed = Path(tempfile.mkdtemp()) / "fixed.pptx"

        def mutate(name, data):
            if name != "ppt/presentation.xml":
                return data
            txt = data.decode("utf-8")
            m = re.search(r"<p:notesMasterIdLst>.*?</p:notesMasterIdLst>", txt, re.S)
            if m:
                block = m.group(0)
                txt = txt.replace(block, "", 1)
                txt = re.sub(r"(</p:sldIdLst>)", r"\1" + block, txt, count=1)
            return txt.encode("utf-8")

        rewrite_zip(PROTO, bad, mutate)
        subprocess.run([PY, str(FIXER), str(bad), str(fixed)], check=True, capture_output=True)
        payload = run_verify("order", fixed)
        self.assertEqual([], payload["layers"]["order"])


@unittest.skipUnless(PROTO.exists(), "prototype/out/deck.pptx 不存在")
class PackageTests(unittest.TestCase):
    def test_opc_package_is_clean(self):
        payload = run_verify("pkg", PROTO)
        self.assertEqual([], payload["layers"]["pkg"])

    def test_verify_all_json_contract(self):
        r = subprocess.run([PY, str(VERIFY), "all", str(PROTO), "--json"], capture_output=True, text=True)
        payload = json.loads(r.stdout)
        for key in ("file", "ok", "errors", "skipped", "layers"):
            self.assertIn(key, payload)
        self.assertIn("pkg", payload["layers"])
        self.assertIn("order", payload["layers"])


@unittest.skipUnless(PROTO.exists(), "prototype/out/deck.pptx 不存在")
class ParagraphDefectTests(unittest.TestCase):
    def test_fixer_removes_duplicate_ppr(self):
        from lxml import etree
        bad = Path(tempfile.mkdtemp()) / "dup.pptx"
        fixed = Path(tempfile.mkdtemp()) / "fixed.pptx"
        NS_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

        def mutate(name, data):
            if name != "ppt/slides/slide1.xml":
                return data
            txt = data.decode("utf-8")
            m = re.search(r"<a:pPr\b[^>]*>.*?</a:pPr>", txt, re.S)
            if m:  # 复制一份 pPr，制造"一个段落两个 pPr"的违规
                txt = txt[:m.end()] + m.group(0) + txt[m.end():]
            return txt.encode("utf-8")

        rewrite_zip(PROTO, bad, mutate)
        subprocess.run([PY, str(FIXER), str(bad), str(fixed)], check=True, capture_output=True)
        with zipfile.ZipFile(fixed) as z:
            root = etree.fromstring(z.read("ppt/slides/slide1.xml"))
        for para in root.iter(NS_A + "p"):
            pprs = [c for c in para if c.tag == NS_A + "pPr"]
            self.assertLessEqual(len(pprs), 1, "段落里仍有多个 a:pPr")


@unittest.skipUnless(PROTO.exists(), "prototype/out/deck.pptx 不存在")
class AngleTests(unittest.TestCase):
    def test_detects_and_fixes_angle_overflow(self):
        bad = Path(tempfile.mkdtemp()) / "badang.pptx"
        fixed = Path(tempfile.mkdtemp()) / "fixedang.pptx"

        def mutate(name, data):
            if not re.match(r"ppt/slides/slide1\.xml$", name):
                return data
            txt = data.decode("utf-8")
            m = re.search(r'<a:lin ang="\d+"', txt)
            if m:  # 把渐变角度改成非法的 21600000（=360°）
                txt = txt[:m.start()] + '<a:lin ang="21600000"' + txt[m.end():]
            return txt.encode("utf-8")

        rewrite_zip(PROTO, bad, mutate)
        payload = run_verify("order", bad)
        self.assertIn("E_ANG_RANGE", codes(payload["layers"]["order"]))
        subprocess.run([PY, str(FIXER), str(bad), str(fixed)], check=True, capture_output=True)
        payload = run_verify("order", fixed)
        self.assertEqual([], payload["layers"]["order"])


@unittest.skipUnless(POTX.exists(), "国金模板.potx 不存在")
class TemplateTests(unittest.TestCase):
    def test_potx_structure_is_clean(self):
        payload = run_verify("potx", POTX)
        self.assertEqual([], payload["layers"]["potx"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
