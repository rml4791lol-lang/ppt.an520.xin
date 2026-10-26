#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""契约测试（外部行为）：describe / layout.md / schemas / deck 清单。

跑法：python3 tools/contract/test_contract.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DESCRIBE = ROOT / "tools" / "contract" / "describe.py"
CONTRACTS = ROOT / "contracts"
POTX = ROOT / ".." / "PPT 复刻" / "out" / "gold-template" / "国金模板.potx"
CONTRACT_MD = ROOT / ".." / "PPT 复刻" / "out" / "gold-template" / "槽位契约.md"
PY = sys.executable


def describe(out: Path | None = None) -> dict:
    cmd = [PY, str(DESCRIBE), str(POTX), "--json", str(out)] if out else [PY, str(DESCRIBE), str(POTX)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    return json.loads(r.stdout)


@unittest.skipUnless(POTX.exists(), "国金模板.potx 不存在")
class DescribeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = Path(tempfile.mkdtemp()) / "describe.json"
        cls.d = describe(cls.out)

    def test_schema_and_canvas(self):
        self.assertEqual("htmlppt/describe@1", self.d["schema"])
        self.assertEqual(1280, self.d["canvas"]["w"])
        self.assertEqual(720, self.d["canvas"]["h"])
        self.assertEqual(24, len(self.d["layouts"]))

    def test_slot_type_counts_match_reality(self):
        from collections import Counter
        c = Counter(s["type"] for lay in self.d["layouts"] for s in lay["slots"])
        self.assertEqual(24, c["title"], c)
        self.assertEqual(605, c["body"], c)
        self.assertEqual(74, c["pic"], c)
        self.assertEqual(1, c["obj"], c)
        self.assertEqual(24, c["sldNum"], c)
        self.assertEqual(728, sum(c.values()))

    def test_slots_inside_canvas(self):
        for lay in self.d["layouts"]:
            for s in lay["slots"]:
                self.assertGreaterEqual(s["x"], 0, (lay["id"], s["name"]))
                self.assertGreaterEqual(s["y"], 0, (lay["id"], s["name"]))
                self.assertLessEqual(s["x"] + s["w"], 1281, (lay["id"], s["name"]))
                self.assertLessEqual(s["y"] + s["h"], 721, (lay["id"], s["name"]))

    def test_capacity_present_for_text_slots(self):
        for lay in self.d["layouts"]:
            for s in lay["slots"]:
                if s["type"] in ("title", "body") and s.get("sz_pt"):
                    self.assertGreaterEqual(s["capacity"]["per_line"], 1, (lay["id"], s["name"]))
                    self.assertGreaterEqual(s["capacity"]["lines"], 1, (lay["id"], s["name"]))

    def test_layout_names_match_contract_md(self):
        md = CONTRACT_MD.read_text(encoding="utf-8")
        # 契约 md 每节形如 "## S1 · 封面（居中书法型）" + "占位符 8 个"
        sections = re.findall(r"^## (S\d+) · (.+?)\n\n.*?占位符 (\d+) 个", md, re.M | re.S)
        self.assertGreaterEqual(len(sections), 24, f"parse md sections: {len(sections)}")
        by_num = {f"S{int(n[1:]):02d}": (name.strip(), int(cnt)) for n, name, cnt in sections}
        for lay in self.d["layouts"]:
            self.assertIn(lay["id"], by_num, lay["id"])
            md_name, md_cnt = by_num[lay["id"]]
            self.assertEqual(md_cnt, len(lay["slots"]), f'{lay["id"]} 槽位数与契约 md 不符')
            self.assertIn(md_name, lay["name"], f'{lay["id"]} 版式名不符：{lay["name"]} vs {md_name}')


@unittest.skipUnless(POTX.exists(), "国金模板.potx 不存在")
class ArtifactTests(unittest.TestCase):
    def test_layout_md_written(self):
        outdir = Path(tempfile.mkdtemp()) / "layouts"
        r = subprocess.run([PY, str(DESCRIBE), str(POTX), "--layout-md", str(outdir)],
                           capture_output=True, text=True)
        self.assertEqual(0, r.returncode, r.stderr[-1500:])
        files = sorted(outdir.glob("S*.md"))
        self.assertEqual(24, len(files), [f.name for f in files])
        body = (outdir / "S01.md").read_text(encoding="utf-8")
        self.assertIn("封面", body)
        self.assertIn("赛事全称", body)
        self.assertIn("建议字数", body)

    def test_deck_example_validates_against_schema(self):
        import jsonschema
        deck = json.loads((CONTRACTS / "deck.example.json").read_text(encoding="utf-8"))
        schema = json.loads((CONTRACTS / "deck.schema.json").read_text(encoding="utf-8"))
        jsonschema.validate(deck, schema)
        self.assertEqual(24, len(deck["pages"]))
        for p in deck["pages"]:
            self.assertRegex(p["source"], r"^spec:S\d{2}$")
            self.assertRegex(p["layout"], r"^S\d{2}$")

    def test_describe_output_validates_against_schema(self):
        import jsonschema
        out = Path(tempfile.mkdtemp()) / "d.json"
        d = describe(out)
        schema = json.loads((CONTRACTS / "describe.schema.json").read_text(encoding="utf-8"))
        jsonschema.validate(d, schema)

    def test_cli_describe(self):
        r = subprocess.run([PY, str(ROOT / "cli" / "htmlppt.py"), "describe", "--json"],
                           capture_output=True, text=True)
        self.assertEqual(0, r.returncode, r.stderr[-1500:])
        payload = json.loads(r.stdout)
        self.assertEqual(24, len(payload["layouts"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
