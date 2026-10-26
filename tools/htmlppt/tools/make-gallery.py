#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make-gallery.py —— 生成演示中心（多套 PPT 的索引页 + 缩略图 + 清单）

用法：python3 tools/make-gallery.py
产物：deliverables/演示中心/index.html + thumbs/ + index.json
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables" / "演示中心"
THUMBS = OUT / "thumbs"
MATRIX = ROOT / "deliverables" / "演示矩阵"
AWARD = ROOT.parent / "PPT 复刻" / "out" / "award-replica"
TPL = ROOT / "templates"

# (family, title, meta, pages, thumb_source, pptx, html, note)
DECKS = [
    # A. 国金模板 24 页 × 6 主题
    ("国金模板 · 行业主题", "国金-AI 深蓝", "24 页 · 深色科技", 24,
     MATRIX / "render" / "国金-ai" / "page-01.png", MATRIX / "pptx" / "国金-ai.pptx", None,
     "AI/算法风格：#0A1A3F 深蓝 + #35C4F0 青蓝"),
    ("国金模板 · 行业主题", "国金-工业蓝橙", "24 页 · 深色工业", 24,
     MATRIX / "render" / "国金-industry" / "page-01.png", MATRIX / "pptx" / "国金-industry.pptx", None,
     "工业/汽车：深蓝 + 橙，适合制造与技术方案"),
    ("国金模板 · 行业主题", "国金-农业绿", "24 页 · 深色稳重", 24,
     MATRIX / "render" / "国金-agri" / "page-01.png", MATRIX / "pptx" / "国金-agri.pptx", None,
     "农业/乡村振兴：墨绿 + 金色点缀"),
    ("国金模板 · 行业主题", "国金-学术蓝", "24 页 · 深色学术", 24,
     MATRIX / "render" / "国金-academic" / "page-01.png", MATRIX / "pptx" / "国金-academic.pptx", None,
     "学术/科研：藏青 + 天蓝，适合论文汇报"),
    ("国金模板 · 行业主题", "国金-机器人", "24 页 · 深色工业", 24,
     MATRIX / "render" / "国金-robot" / "page-01.png", MATRIX / "pptx" / "国金-robot.pptx", None,
     "机器人/装备：深蓝灰 + 橙，工业感强"),
    ("国金模板 · 行业主题", "国金-海洋深蓝", "24 页 · 深色海洋", 24,
     MATRIX / "render" / "国金-ocean" / "page-01.png", MATRIX / "pptx" / "国金-ocean.pptx", None,
     "海洋/遥感：深海蓝 + 亮蓝，适合涉海项目"),
    # B. 金奖复刻
    ("金奖复刻 · 真实获奖稿", "蓝海核卫士", "13 页 · 纯形状国赛风", 13,
     AWARD / "蓝海核卫士" / "复刻-p01.png",
     AWARD / "蓝海核卫士" / "金奖复刻-蓝海核卫士.pptx", None,
     "深蓝满版 + 书法大字；结论条/轨条/拓扑全部形状绘制"),
    ("金奖复刻 · 真实获奖稿", "万格智能", "20 页 · 国赛风", 20,
     AWARD / "万格智能" / "复刻-p01.png",
     AWARD / "万格智能" / "金奖复刻-万格智能.pptx", None, "国金底座参照册，结构差基线 38.46"),
    ("金奖复刻 · 真实获奖稿", "一知智能", "22 页 · 国赛风", 22,
     AWARD / "一知智能" / "复刻-p01.png",
     AWARD / "一知智能" / "金奖复刻-一知智能.pptx", None, "技术链路 + LOGO 墙，骨架 IoU 0.608"),
    ("金奖复刻 · 真实获奖稿", "普安克", "22 页 · 国赛风", 22,
     AWARD / "普安克" / "复刻-p01.png",
     AWARD / "普安克" / "金奖复刻-普安克.pptx", None, "项目/团队/市场结构完整"),
    ("金奖复刻 · 真实获奖稿", "粉擎速递", "28 页 · 国赛风", 28,
     AWARD / "粉擎速递" / "复刻-p01.png",
     AWARD / "粉擎速递" / "金奖复刻-粉擎速递.pptx", None, "翻拍稿复刻，走字身判据"),
    # C. 设计模板族（HTML 母版）
    ("设计模板族 · HTML 母版", "T1 学院蓝", "6 页 · 学术答辩", 6,
     TPL / "t1-academic-blue" / "preview.png", None,
     TPL / "t1-academic-blue" / "index.html", "衬线标题 + 细金线 + 校徽；可编辑文本 94 个"),
    ("设计模板族 · HTML 母版", "T2 深色科技", "5 页 · 产品/路演", 5,
     TPL / "t2-dark-tech" / "preview.png", None,
     TPL / "t2-dark-tech" / "index.html", "深色底 + 荧光青 + 数据大字；106 个槽位"),
    ("设计模板族 · HTML 母版", "T3 编辑风", "5 页 · 杂志/叙事", 5,
     TPL / "t3-editorial" / "preview.png", None,
     TPL / "t3-editorial" / "index.html", "大留白 + 衬线 + 编号章节；73 个槽位"),
    # D. 转换与还原
    ("转换与还原 · 真实稿", "参考稿 18 页", "18 页 · PPT→HTML", 18,
     ROOT / "deliverables" / "参考稿18页" / "预览-18页.png",
     None, ROOT / "deliverables" / "参考稿18页" / "deck.html",
     "微软雅黑/方正粗黑宋；911 对象，可编辑文本 652、可换图 135"),
    ("转换与还原 · 真实稿", "科创港 6 页（新作）", "6 页 · HTML→PPTX", 6,
     ROOT / "deliverables" / "新作-科创港6页-预览.png",
     ROOT / "deliverables" / "新作-科创港6页.pptx",
     ROOT / "deliverables" / "新作-科创港6页.html", "国赛路演结构：封面/背景/技术/体系/成果"),
]


def thumb(src: Path, dst: Path, w: int = 640, h: int = 360) -> bool:
    if not src.exists():
        return False
    im = Image.open(src).convert("RGB")
    # 取左上角 16:9 区域（长图/联络表都适用）
    sw, sh = im.size
    if sw / sh > w / h:
        crop = (0, 0, int(sh * w / h), sh)
    else:
        crop = (0, 0, sw, int(sw * h / w))
    im = im.crop(crop).resize((w, h), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, quality=88)
    return True


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    THUMBS.mkdir(parents=True, exist_ok=True)
    files_dir = OUT / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    def rel(p) -> str | None:
        """ROOT 内用相对路径；ROOT 外复制进 files/ 再给相对路径。"""
        if not p:
            return None
        p = Path(p)
        if not p.exists():
            return None
        try:
            return str(p.relative_to(ROOT))
        except ValueError:
            dst = files_dir / p.name
            if not dst.exists() or dst.stat().st_mtime < p.stat().st_mtime:
                shutil.copy2(p, dst)
            return f"files/{p.name}"

    items = []
    for i, (family, title, meta, pages, thumb_src, pptx, html, note) in enumerate(DECKS):
        tname = f"deck-{i:02d}.jpg"
        ok = thumb(Path(thumb_src), THUMBS / tname)
        items.append({
            "family": family, "title": title, "meta": meta, "pages": pages,
            "thumb": f"thumbs/{tname}" if ok else None,
            "pptx": rel(pptx),
            "html": rel(html),
            "note": note,
        })
    (OUT / "index.json").write_text(json.dumps({"decks": items}, ensure_ascii=False, indent=1), encoding="utf-8")

    families = []
    for it in items:
        if it["family"] not in families:
            families.append(it["family"])
    cards = []
    for fam in families:
        cards.append(f'<h2 class="family">{fam}</h2><div class="grid">')
        for it in [x for x in items if x["family"] == fam]:
            def href(relpath: str) -> str:
                return relpath if relpath.startswith("files/") else "../../" + relpath

            links = []
            if it["pptx"]:
                links.append(f'<a href="{href(it["pptx"])}" download>下载 PPTX</a>')
            if it["html"]:
                links.append(f'<a href="{href(it["html"])}" target="_blank">打开 HTML</a>')
            thumb_html = (f'<img src="{it["thumb"]}" alt="{it["title"]}">'
                          if it["thumb"] else '<div class="noimg">无预览</div>')
            cards.append(f'''
      <article class="card">
        {thumb_html}
        <div class="body">
          <h3>{it["title"]}</h3>
          <p class="meta">{it["meta"]}</p>
          <p class="note">{it["note"]}</p>
          <div class="links">{" ".join(links) or "—"}</div>
        </div>
      </article>''')
        cards.append("</div>")

    html = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTMLPPT · 演示中心</title>
<style>
:root {{ color-scheme: dark; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:#0c1220; color:#e8eef8; font:15px/1.6 -apple-system,"PingFang SC","Noto Sans SC",sans-serif; }}
header {{ padding:56px 48px 24px; border-bottom:1px solid #1e2b45; }}
h1 {{ margin:0 0 8px; font-size:32px; letter-spacing:.5px; }}
.sub {{ color:#8fa3c4; max-width:900px; }}
.stats {{ display:flex; gap:32px; margin-top:22px; }}
.stats b {{ font-size:26px; display:block; color:#63d0ff; }}
.stats span {{ color:#8fa3c4; font-size:13px; }}
main {{ padding:28px 48px 80px; }}
.family {{ font-size:16px; color:#8fa3c4; font-weight:600; letter-spacing:1px; margin:36px 0 14px; text-transform:uppercase; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:18px; }}
.card {{ background:#111a2e; border:1px solid #1e2b45; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; }}
.card img {{ width:100%; aspect-ratio:16/9; object-fit:cover; display:block; border-bottom:1px solid #1e2b45; }}
.noimg {{ aspect-ratio:16/9; display:grid; place-items:center; color:#5d6f8f; background:#0f1728; }}
.body {{ padding:14px 16px 16px; display:flex; flex-direction:column; gap:6px; }}
h3 {{ margin:0; font-size:17px; }}
.meta {{ margin:0; color:#63d0ff; font-size:13px; }}
.note {{ margin:0; color:#9fb0cc; font-size:13px; }}
.links {{ margin-top:auto; padding-top:10px; display:flex; gap:14px; }}
a {{ color:#7bd88f; text-decoration:none; font-size:13px; }}
a:hover {{ text-decoration:underline; }}
footer {{ padding:0 48px 48px; color:#5d6f8f; font-size:12px; }}
</style></head>
<body>
<header>
  <h1>HTMLPPT · 演示中心</h1>
  <p class="sub">同一套管线产出的多风格 PPT：国金模板（6 套行业主题）· 金奖复刻（5 本真实获奖稿）· 设计模板族（3 种设计语言）· 转换与还原（PPT↔HTML）。全部通过六层结构验收。</p>
  <div class="stats">
    <div><b>{len(items)}</b><span>套 PPT</span></div>
    <div><b>{sum(i["pages"] for i in items)}</b><span>页合计</span></div>
    <div><b>4</b><span>风格族</span></div>
    <div><b>6</b><span>验收层（pkg/order/xsd/sdk/potx/fonts/lo）</span></div>
  </div>
</header>
<main>
{"".join(cards)}
</main>
<footer>本地预览：本页由 tools/make-gallery.py 生成；PPTX 链接可直接下载用 PowerPoint 打开。</footer>
</body></html>'''
    (OUT / "index.html").write_text(html, encoding="utf-8")
    print(f"gallery -> {OUT / 'index.html'} · {len(items)} decks")
    missing = [i["title"] for i in items if not i["thumb"]]
    if missing:
        print("missing thumbs:", missing)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
