#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""pptx2html —— 原生 PPTX → 可编辑 HTML（HTMLPPT 反向管线）

设计目标：
  * 输出是"我们的 HTML 契约"兼容的页面（1280×720 固定画布、绝对定位、语义文本、无脚本），
    因此可以再喂给正向管线 HTML → 可编辑 PPTX，形成闭环。
  * 每个 PPT 对象对应一个带 `data-pptx-id` 的 DOM 节点，便于"替换背景 / 换图 / 换文案"。
  * 无法原生表达的效果（图表、SmartArt、艺术字、复杂预设形状）不静默丢弃，写进 map.json 的 lossy 清单。

用法：
  python pptx2html.py deck.pptx -o out_dir [--width 1280] [--height 720]
产物：
  out_dir/deck.html          多页 deck（每页 section.slide）
  out_dir/assets/*.png       抽取/裁剪后的图片
  out_dir/map.json           逐对象映射 + lossy 清单 + 主题色
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import ocr as OCR  # macOS Vision，可选
    OCR_AVAILABLE = OCR.available()
except Exception:
    OCR = None
    OCR_AVAILABLE = False

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Emu

EMU_PER_PX = 9525.0  # 96 dpi


def px(emu):
    return round(float(emu) / EMU_PER_PX, 3)


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def esc_attr(s):
    return esc(s).replace('"', "&quot;")


# ---------------------------------------------------------------- theme / colors
class Theme:
    def __init__(self, pptx_path):
        self.map = {}
        try:
            with zipfile.ZipFile(pptx_path) as z:
                names = [n for n in z.namelist() if re.match(r"ppt/theme/theme\d+\.xml$", n)]
                xml = z.read(sorted(names)[0]).decode("utf-8", "ignore")
            clr = re.search(r"<a:clrScheme[\s\S]*?</a:clrScheme>", xml)
            if clr:
                for name, val in re.findall(r'<a:(\w+)>\s*<(?:a:srgbClr|a:sysClr)[^>]*'
                                            r'(?:val|lastClr)="([0-9A-Fa-f]{6})"', clr.group(0)):
                    self.map[name] = "#" + val.upper()
        except Exception:
            pass
        self.map.setdefault("tx1", "#000000")
        self.map.setdefault("bg1", "#FFFFFF")
        self.map.setdefault("dk1", "#000000")
        self.map.setdefault("lt1", "#FFFFFF")

    def get(self, name, default="#000000"):
        if not name:
            return default
        return self.map.get(name, default)


THEME_ALIAS = {
    "DARK_1": "tx1", "LIGHT_1": "bg1", "DARK_2": "dk2", "LIGHT_2": "lt2",
    "ACCENT_1": "accent1", "ACCENT_2": "accent2", "ACCENT_3": "accent3",
    "ACCENT_4": "accent4", "ACCENT_5": "accent5", "ACCENT_6": "accent6",
    "HYPERLINK": "hlink", "FOLLOWED_HYPERLINK": "folHlink",
    "TEXT_1": "tx1", "BACKGROUND_1": "bg1", "TEXT_2": "tx2", "BACKGROUND_2": "bg2",
}


def color_of(cf, theme):
    """python-pptx ColorFormat -> '#RRGGBB' 或 None"""
    if cf is None:
        return None
    try:
        if cf.type is None:
            return None
    except Exception:
        pass
    try:
        rgb = cf.rgb
        if rgb is not None:
            return "#" + str(rgb)
    except Exception:
        pass
    try:
        tc = cf.theme_color
        if tc is not None:
            return theme.get(THEME_ALIAS.get(str(tc).split(" ")[0].strip(), ""), None)
    except Exception:
        pass
    return None


def _clamp01(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def apply_color_mods(hexcol, mods):
    """按 OOXML 的 shade/tint/lumMod/lumOff 修饰颜色（PPT 主题色几乎都靠这个）。"""
    import colorsys
    h = hexcol.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        r, g, b = int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0
    except Exception:
        return hexcol
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    if "shade" in mods:
        ll *= mods["shade"]
    if "tint" in mods:
        ll = 1.0 - (1.0 - ll) * mods["tint"]
    if "lumMod" in mods:
        ll *= mods["lumMod"]
    if "lumOff" in mods:
        ll += mods["lumOff"]
    if "satMod" in mods:
        ss *= mods["satMod"]
    ll = _clamp01(ll)
    ss = _clamp01(ss)
    r, g, b = colorsys.hls_to_rgb(hh, ll, ss)
    return "#%02X%02X%02X" % (round(r * 255), round(g * 255), round(b * 255))


def resolve_color_el(el, theme):
    """解析 <a:srgbClr>/<a:schemeClr>/<a:sysClr> 元素，含 lumMod/lumOff/shade/tint。"""
    if el is None:
        return None
    mods = {}
    for child in el:
        tag = child.tag.split("}")[-1]
        if tag in ("lumMod", "lumOff", "shade", "tint", "satMod"):
            try:
                mods[tag] = int(child.get("val")) / 100000.0
            except Exception:
                pass
    tag = el.tag.split("}")[-1]
    if tag == "srgbClr":
        base = "#" + (el.get("val") or "")
    elif tag == "schemeClr":
        name = el.get("val") or ""
        base = theme.get(THEME_ALIAS.get(name, name))
    elif tag == "sysClr":
        base = "#" + (el.get("lastClr") or "000000")
    else:
        return None
    if not base or base == "#":
        return None
    return apply_color_mods(base, mods) if mods else base


def _color_child(el):
    """取 el 下第一个颜色元素（srgbClr/schemeClr/sysClr）。"""
    for child in el:
        if child.tag.split("}")[-1] in ("srgbClr", "schemeClr", "sysClr"):
            return child
    return None


def rgba(hexcol, alpha):
    if not hexcol:
        return None
    h = hexcol.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    if alpha is None or alpha >= 0.999:
        return f"#{h.upper()}"
    return f"rgba({r},{g},{b},{round(alpha, 3)})"


def alpha_from_xml(el):
    """在 a:solidFill/a:srgbClr 下读 alpha。"""
    if el is None:
        return 1.0
    m = el.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}alpha")
    if m is not None:
        try:
            return int(m.get("val")) / 100000.0
        except Exception:
            return 1.0
    return 1.0


# ---------------------------------------------------------------- fills / lines
NS_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
NS_P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
NS_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def fill_css(sp, theme):
    """读 spPr 的填充 → (css_value, kind, extra)"""
    el = sp._element
    spPr = el.find(f"{NS_A}spPr") if el.find(f"{NS_A}spPr") is not None else el
    # python-pptx 里 spPr 在 p:sp 下
    p_ns = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
    spPr = el.find(f"{p_ns}spPr")
    if spPr is None:
        return None, "none", {}
    grad = spPr.find(f"{NS_A}gradFill")
    if grad is not None:
        stops = []
        for gs in grad.findall(f".//{NS_A}gs"):
            pos = int(gs.get("pos", "0")) / 1000.0
            a = alpha_from_xml(gs)
            col = resolve_color_el(_color_child(gs), theme)
            if not col:
                continue
            stops.append(f"{rgba(col, a)} {pos:g}%")
        lin = grad.find(f"{NS_A}lin")
        ang = 90.0
        if lin is not None:
            ang = int(lin.get("ang", "0")) / 60000.0 + 90.0
        if stops:
            return f"linear-gradient({ang:g}deg, {', '.join(stops)})", "gradient", {"angle": ang, "stops": stops}
        return None, "none", {}
    solid = spPr.find(f"{NS_A}solidFill")
    if solid is not None:
        a = alpha_from_xml(solid)
        col = resolve_color_el(_color_child(solid), theme)
        if col:
            return rgba(col, a), "solid", {"alpha": a}
    if spPr.find(f"{NS_A}noFill") is not None:
        return None, "none", {}
    return None, "inherit", {}


def line_css(sp, theme):
    el = sp._element
    p_ns = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
    spPr = el.find(f"{p_ns}spPr")
    if spPr is None:
        return None
    ln = spPr.find(f"{NS_A}ln")
    if ln is None:
        return None
    if ln.find(f"{NS_A}noFill") is not None:
        return None
    w = int(ln.get("w", "12700")) / 12700.0  # pt
    solid = ln.find(f"{NS_A}solidFill")
    col = None
    if solid is not None:
        base = resolve_color_el(_color_child(solid), theme)
        if base:
            col = rgba(base, alpha_from_xml(solid))
    dash = ln.find(f"{NS_A}prstDash")
    style = "solid"
    if dash is not None and dash.get("val") in ("dash", "sysDash", "lgDash", "dot"):
        style = "dashed"
    if not col:
        return None
    return {"width": round(w * 4 / 3, 2), "color": col, "style": style}  # pt -> px


# ---------------------------------------------------------------- text
def run_style(run, para, theme, default_font_size_px=18):
    f = run.font
    size_px = None
    try:
        if f.size is not None:
            size_px = round(f.size.pt / 0.75, 2)
    except Exception:
        size_px = None
    color = None
    _rPr0 = run._r.find(f"{NS_A}rPr")
    if _rPr0 is not None:
        _sf = _rPr0.find(f"{NS_A}solidFill")
        if _sf is not None:
            color = resolve_color_el(_color_child(_sf), theme)
    if color is None:
        color = color_of(f.color, theme)
    bold = bool(f.bold)
    italic = bool(f.italic)
    underline = bool(f.underline)
    name = None
    try:
        name = f.name
    except Exception:
        pass
    # a:ea（中文字体）常与 latin 不同，直接从 XML 读
    rPr = run._r.find(f"{NS_A}rPr")
    if rPr is not None:
        ea = rPr.find(f"{NS_A}ea")
        if ea is not None and ea.get("typeface"):
            name = name or ea.get("typeface")
        spc = rPr.get("spc")
        if spc:
            pass
    ls = None
    try:
        if para.line_spacing is not None:
            v = para.line_spacing
            ls = round(float(v) / EMU_PER_PX, 2) if hasattr(v, "pt") else None
    except Exception:
        ls = None
    return dict(size=size_px or default_font_size_px, color=color or "#000000",
                bold=bold, italic=italic, underline=underline, font=name, line=ls)


def para_html(para, theme, base_size):
    style = run_style(para.runs[0], para, theme, base_size) if para.runs else dict(size=base_size, color="#000000", bold=False, italic=False, underline=False, font=None, line=None)
    align = {"LEFT": "left", "CENTER": "center", "RIGHT": "right", "JUSTIFY": "justify"}.get(str(para.alignment), "left") if para.alignment else "left"
    lh = style["line"] or round(style["size"] * 1.35, 2)
    before = px(para.space_before) if para.space_before is not None else 0
    after = px(para.space_after) if para.space_after is not None else 0
    p_style = f"margin:{before}px 0 {after}px 0;line-height:{lh}px;text-align:{align};font-size:{style['size']}px;"
    inner = "".join(
        f'<span style="{span_css(run_style(r, para, theme, style["size"]), theme)}">{esc(r.text)}</span>'
        for r in para.runs
    )
    if not para.runs and para.text:
        inner = esc(para.text)
    # bullet
    bullet = ""
    pPr = para._p.find(f"{NS_A}pPr")
    if pPr is not None:
        bu = pPr.find(f"{NS_A}buChar")
        if bu is not None:
            bullet = bu.get("char", "•") + " "
        elif pPr.find(f"{NS_A}buAutoNum") is not None:
            bullet = "• "
    if bullet:
        inner = f'<span style="white-space:pre">{esc(bullet)}</span>' + inner
    return f'<p style="{p_style}">{inner}</p>'


def span_css(st, theme):
    fam = st.get("font")
    parts = [
        f"color:{st['color']}",
        f"font-size:{st['size']}px",
    ]
    if st.get("bold"):
        parts.append("font-weight:700")
    if st.get("italic"):
        parts.append("font-style:italic")
    if st.get("underline"):
        parts.append("text-decoration:underline")
    if fam:
        parts.append(f'font-family:"{fam}","PingFang SC","Noto Sans SC",sans-serif')
    return ";".join(parts)


def norm_autofit_scale(tf):
    """读 a:bodyPr/a:normAutofit/@fontScale，返回字号缩放系数（默认 1）。"""
    try:
        bodyPr = tf._txBody.find(f"{NS_A}bodyPr")
        if bodyPr is None:
            return 1.0
        na = bodyPr.find(f"{NS_A}normAutofit")
        if na is None:
            return 1.0
        fs = na.get("fontScale")
        if not fs:
            return 1.0
        if fs.endswith("%"):
            return float(fs[:-1]) / 100.0
        return int(fs) / 100000.0
    except Exception:
        return 1.0


def text_frame_html(sh, theme, scale=1.0):
    tf = sh.text_frame
    ins = [px(tf.margin_left or 0), px(tf.margin_top or 0), px(tf.margin_right or 0), px(tf.margin_bottom or 0)]
    anchor = {"TOP": "flex-start", "MIDDLE": "center", "BOTTOM": "flex-end"}.get(str(tf.vertical_anchor), "flex-start") if tf.vertical_anchor else "flex-start"
    base = 18
    for para in tf.paragraphs:
        for r in para.runs:
            try:
                if r.font.size:
                    base = round(r.font.size.pt / 0.75, 2)
                    break
            except Exception:
                pass
        else:
            continue
        break
    fs = norm_autofit_scale(tf)
    paras = "".join(para_html(p, theme, round(base * fs, 2)) for p in tf.paragraphs)
    scale = scale * fs
    return (f"display:flex;flex-direction:column;justify-content:{anchor};"
            f"padding:{ins[1]}px {ins[2]}px {ins[3]}px {ins[0]}px;", paras)


# ---------------------------------------------------------------- pictures
def _image_transparency(sh):
    """返回图片透明像素占比（无 alpha 通道返回 0）。"""
    try:
        from PIL import Image
        import io as _io
        im = Image.open(_io.BytesIO(sh.image.blob))
        if im.mode not in ("RGBA", "LA", "P"):
            return 0.0
        im = im.convert("RGBA")
        small = im.copy(); small.thumbnail((96, 96))
        px = list(small.getdata())
        if not px:
            return 0.0
        return sum(1 for _r, _g, _b, a in px if a < 200) / len(px)
    except Exception:
        return 0.0


def _picture_role(sh, area, top_ratio, width_px, height_px):
    """内容图 / 装饰图的启发式判定（返回 content 或 decoration）。"""
    if area < 0.03:
        return "decoration"
    # 页眉/页脚带 + 小面积 → logo / 装饰
    if area < 0.10 and (top_ratio < 0.12 or top_ratio > 0.86):
        return "decoration"
    # 透明背景占比高 → 图标/logo（照片基本不透明）
    if _image_transparency(sh) > 0.30:
        return "decoration"
    # 极宽条带（比例 >=4:1 且很矮）→ 页眉 logo / 文字条，不当内容图
    try:
        if float(sh.height) > 0 and float(sh.width) / float(sh.height) >= 4.0 and float(sh.height) / 9525 < 140:
            return "decoration"
    except Exception:
        pass
    return "content"


def _opaque_shape(sh):
    """形状是否不透明（solid fill alpha>=0.95，或本身是图片）。"""
    if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
        return True
    try:
        spPr = sh._element.find(f"{NS_P}spPr")
        if spPr is None:
            return False
        sf = spPr.find(f"{NS_A}solidFill")
        if sf is None:
            return False
        return alpha_from_xml(sf) >= 0.95
    except Exception:
        return False


def _box(sh):
    return (float(sh.left), float(sh.top), float(sh.left) + float(sh.width), float(sh.top) + float(sh.height))


def _covered_by_later(shapes, idx, sh):
    """图片是否被 z 序更靠后的不透明形状完全盖住（>1px 容差）。"""
    l, t, r, b = _box(sh)
    for other in shapes[idx + 1:]:
        try:
            if not _opaque_shape(other):
                continue
            ol, ot, orr, ob = _box(other)
            if ol <= l + 9525 and ot <= t + 9525 and orr >= r - 9525 and ob >= b - 9525:
                return True
        except Exception:
            continue
    return False


def classify_slide(shapes, sw, sh_, theme, ocr_budget):
    """把每张图分成四类：background / content / decoration / covered（+ text-image）。

    规则（可在 README §图片分类 调整）：
      * 满页（>=90%）且贴边 → background（进背景组件，不作为内容槽）
      * 被后续不透明形状完全盖住 → covered（不转，省体积）
      * 面积 <3% → decoration（logo/图标/装饰，保留但不作为内容槽）
      * 其余 → content（可替换槽位）；面积>=4% 且 OCR 有 >=8 字 → text-image（建议重建为文本）
    """
    areas = {}
    for sh in shapes:
        try:
            areas[sh.shape_id] = (float(sh.width) * float(sh.height)) / (float(sw) * float(sh_))
        except Exception:
            areas[sh.shape_id] = 0.0
    roles = {}
    first_content = None
    for idx, sh in enumerate(shapes):
        info = {"role": "shape", "area": round(areas[sh.shape_id], 4)}
        if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
            area = areas[sh.shape_id]
            if area >= 0.9 and float(sh.left) <= 1 and float(sh.top) <= 1:
                info.update(role="background", reason="full-page")
            elif _covered_by_later(shapes, idx, sh):
                info.update(role="covered", reason="fully-covered")
            elif _picture_role(sh, area, float(sh.top) / float(sh_), None, None) == "decoration":
                info.update(role="decoration", reason="heuristic")
            else:
                info["role"] = "content"
                if first_content is None:
                    first_content = idx
                # 文字截图判定要保守：大块、不透明、浅底占比高、OCR 多行多字
                if ocr_budget > 0 and area >= 0.06 and OCR_AVAILABLE:
                    try:
                        from PIL import Image
                        import io as _io
                        b = sh.image.blob
                        im0 = Image.open(_io.BytesIO(b))
                        opaque = im0.mode not in ("RGBA", "LA", "P")
                        im_gray = im0.convert("RGB")
                        small = im_gray.copy(); small.thumbnail((160, 160))
                        px = list(small.getdata())
                        light = sum(1 for r, g, b2 in px if min(r, g, b2) > 235) / max(len(px), 1)
                        buf = _io.BytesIO(); im_gray.save(buf, format="PNG")
                        txt = OCR.ocr_png_bytes(buf.getvalue()) if (opaque and light >= 0.45) else None
                        if txt:
                            lines = [l for l in txt.split("  ") if l.strip()]
                            nchars = len("".join(txt.split()))
                            if len(lines) >= 3 and nchars >= 20:
                                info.update(role="text-image", ocr=txt[:300])
                                ocr_budget -= 1
                    except Exception:
                        pass
        else:
            # 背景装饰：仅限「最底层」的大面积无字形状。
            # 组合不参与（组里常含图文，误判会把整组压到背景层）。
            has_text = sh.has_text_frame and sh.text_frame.text.strip()
            is_group = sh.shape_type == MSO_SHAPE_TYPE.GROUP
            if (not is_group) and first_content is None and idx <= 1 \
                    and areas[sh.shape_id] >= 0.6 and not has_text:
                info["role"] = "background-decoration"
        roles[sh.shape_id] = info
    bg = {"image": None}
    for sh in shapes:
        if roles[sh.shape_id]["role"] == "background":
            bg["image"] = sh
            break
    return roles, bg, ocr_budget


_MEDIA_CACHE = {}


def blip_part(sh):
    """返回图片的原始媒体部件（含 rId 指向的 /ppt/media/*），用于原字节抽取。"""
    try:
        blipFill = sh._element.find(f"{NS_P}blipFill")
        if blipFill is None:
            return None
        blip = blipFill.find(f"{NS_A}blip")
        if blip is None:
            return None
        rid = blip.get(NS_R + "embed")
        if not rid:
            return None
        return sh.part.related_part(rid)
    except Exception:
        return None


def svg_blip_part(sh):
    """如果图片是「SVG + PNG 回退」（Office 2016+ 常见），返回 SVG 的关系部件。"""
    try:
        blipFill = sh._element.find(f"{NS_P}blipFill")
        if blipFill is None:
            return None
        for blip in blipFill.iter(f"{NS_A}blip"):
            for ext in blip.iter(f"{NS_A}ext"):
                for child in ext:
                    if child.tag.endswith("}svgBlip"):
                        rid = child.get(NS_R + "embed")
                        if rid:
                            return sh.part.related_part(rid)
    except Exception:
        return None
    return None


def save_picture(sh, assets, idx, crop_with_pillow=True):
    """把 PPT 包里的媒体原样拆出来（不重编码），仅在需要裁剪时生成裁剪副本。"""
    from PIL import Image
    import io
    Image.MAX_IMAGE_PIXELS = None  # 本地可信文件

    # 1) Office 2016+ 的「SVG 图 + PNG 回退」：优先拆 SVG
    svg = svg_blip_part(sh)
    if svg is not None:
        pname = str(svg.partname).rsplit("/", 1)[-1]
        media_dir = assets / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        target = media_dir / pname
        if not target.exists():
            target.write_bytes(svg.blob)
        return f"assets/media/{pname}", (0, 0, 0, 0)

    # 2) 栅格图：直接复制包内原始字节，按 partname 去重
    crop = (sh.crop_left or 0, sh.crop_top or 0, sh.crop_right or 0, sh.crop_bottom or 0)
    crop_key = tuple(round(float(c), 5) for c in crop)
    part = blip_part(sh)
    if part is None:
        img = sh.image
        name = f"img{idx:03d}.png"
        (assets / name).write_bytes(img.blob)
        return f"assets/{name}", crop

    pname = str(part.partname).rsplit("/", 1)[-1]
    media_dir = assets / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    key = (pname, crop_key)
    if key in _MEDIA_CACHE:
        return _MEDIA_CACHE[key], crop

    try:
        if any(crop_key) and crop_with_pillow:
            im = Image.open(io.BytesIO(part.blob))
            im.load()
            w, h = im.size
            l = int(w * crop[0]); t = int(h * crop[1])
            r = int(w * crop[2]); b = int(h * crop[3])
            im = im.crop((l, t, w - r, h - b))
            stem = Path(pname).stem
            out = media_dir / f"{stem}_crop{idx}.png"
            im.save(out, optimize=True)
            src = f"assets/media/{out.name}"
        else:
            target = media_dir / pname
            if not target.exists():
                target.write_bytes(part.blob)
            src = f"assets/media/{pname}"
    except Exception:
        target = media_dir / pname
        if not target.exists():
            target.write_bytes(part.blob)
        src = f"assets/media/{pname}"

    _MEDIA_CACHE[key] = src
    return src, crop


# ---------------------------------------------------------------- freeform
def freeform_path(sh):
    el = sh._element
    p_ns = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
    spPr = el.find(f"{p_ns}spPr")
    if spPr is None:
        return None
    cg = spPr.find(f"{NS_A}custGeom")
    if cg is None:
        return None
    pathLst = cg.find(f"{NS_A}pathLst")
    if pathLst is None:
        return None
    d = []
    pw, ph = 0, 0
    for path in pathLst.findall(f"{NS_A}path"):
        try:
            pw = max(pw, int(path.get("w") or 0))
            ph = max(ph, int(path.get("h") or 0))
        except Exception:
            pass
        for cmd in path:
            tag = cmd.tag.replace(NS_A, "")
            pts = cmd.findall(f"{NS_A}pt")
            if tag == "moveTo" and pts:
                d.append(f"M{int(pts[0].get('x'))/1000:.1f},{int(pts[0].get('y'))/1000:.1f}")
            elif tag == "lnTo" and pts:
                d.append(f"L{int(pts[0].get('x'))/1000:.1f},{int(pts[0].get('y'))/1000:.1f}")
            elif tag in ("cubicBezTo", "quadBezTo") and len(pts) >= 3:
                c = [f"{int(p.get('x'))/1000:.1f},{int(p.get('y'))/1000:.1f}" for p in pts]
                if tag == "cubicBezTo":
                    d.append(f"C{c[0]} {c[1]} {c[2]}")
                else:
                    d.append(f"Q{c[0]} {c[1]}")
            elif tag == "close":
                d.append("Z")
    return ({"d": " ".join(d), "w": pw, "h": ph} if d else None)


# ---------------------------------------------------------------- shape dispatch
def shape_common_style(sh, tx=(0.0, 0.0, 1.0, 1.0)):
    ox, oy, sx, sy = tx
    rot = float(getattr(sh, "rotation", 0) or 0)
    s = (f"position:absolute;left:{px(ox + sh.left * sx)}px;top:{px(oy + sh.top * sy)}px;"
         f"width:{px(sh.width * sx)}px;height:{px(sh.height * sy)}px;")
    if rot:
        s += f"transform:rotate({rot:g}deg);"
    return s


def render_shape(sh, ctx, tx=(0.0, 0.0, 1.0, 1.0)):
    """返回 (html, map_entry) 或 None"""
    theme = ctx["theme"]
    # 组：递归展平，子元素坐标换算到画布
    if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
        return render_group(sh, ctx, tx)

    sid = sh.shape_id
    name = sh.name
    ox, oy, sx, sy = tx
    rect = dict(l=px(ox + sh.left * sx), t=px(oy + sh.top * sy), w=px(sh.width * sx), h=px(sh.height * sy))
    base = shape_common_style(sh, tx)
    entry = dict(id=sid, name=name, type=str(sh.shape_type), rect=rect, refs=[], lossy=[])

    if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
        info = (ctx.get("roles") or {}).get(sid) or {}
        role = info.get("role")
        if role is None:
            # 组合内的图片没有预分类 → 现场用启发式判定
            cw, ch = ctx.get("canvas", (1280, 720))
            area = max(rect["w"], 0) * max(rect["h"], 0) / (cw * ch)
            role = _picture_role(sh, area, rect["t"] / ch, rect["w"], rect["h"])
            info = {"role": role}
        if role == "covered":
            ctx["map"].setdefault("skipped", []).append(
                {"slide": ctx.get("slide_index"), "id": sid, "reason": info.get("reason", "covered")})
            return "", None
        src, crop = save_picture(sh, ctx["assets"], ctx["n"], ctx["crop"])
        ctx["n"] += 1
        op = ""
        try:
            blip = sh._element.find(f"{NS_P}blipFill")
            amf = blip.find(f"{NS_A}alphaModFix") if blip is not None else None
            if amf is not None and amf.get("amt"):
                op = f"opacity:{int(amf.get('amt'))/100000:.3f};"
        except Exception:
            pass
        # 槽位：内容图 = 可替换；装饰图 = 保留但不算内容槽；文字截图 = 建议重建为文本
        slot_attr = ""
        slot_id = None
        if role in ("content", "text-image"):
            slot_id = f"img-{ctx.get('slide_index', 0)}-{len(ctx.get('slots', [])) + 1}"
            ctx.setdefault("slots", []).append({
                "slot": slot_id, "slide": ctx.get("slide_index"), "pptxId": sid,
                "role": role, "src": src, "rect": rect,
                "ocrText": info.get("ocr") if role == "text-image" else None,
            })
            slot_attr = f' data-pptx-role="{role}" data-pptx-slot="{slot_id}"'
            if role == "text-image":
                slot_attr += ' data-pptx-suggestion="建议重建为可编辑文本（OCR 已识别）"'
        else:
            slot_attr = ' data-pptx-role="decoration"'
        html = (f'<img class="o" data-pptx-id="{sid}" data-pptx-type="picture" alt="{esc_attr(name)}"'
                f'{slot_attr} src="{src}" style="{base}object-fit:fill;{op}">')
        entry["type"] = "picture"; entry["src"] = src; entry["role"] = role; entry["slot"] = slot_id
        return html, entry

    if sh.has_table:
        html = render_table(sh, ctx, base, sid)
        entry["type"] = "table"
        return html, entry

    if sh.has_chart:
        entry["lossy"].append("chart: 图表未映射（v1 跳过）")
        return "", entry

    if sh.shape_type == MSO_SHAPE_TYPE.LINE:
        # 连接线/直线：用 SVG 线画（不能把包围盒高度当 border 宽度，会变成大色块）
        ln = line_css(sh, theme) or {}
        w = max(rect["w"], 0.5)
        h = max(rect["h"], 0.5)
        sw = max(float(ln.get("width") or 1.0), 0.5)
        col = ln.get("color") or "#000000"
        dash = ' stroke-dasharray="4 3"' if ln.get("style") == "dashed" else ""
        xfrm = sh._element.find(f"{NS_P}spPr/{NS_A}xfrm")
        flipH = xfrm is not None and xfrm.get("flipH") == "1"
        flipV = xfrm is not None and xfrm.get("flipV") == "1"
        x1, y1, x2, y2 = 0.0, 0.0, w, h
        if flipH:
            x1, x2 = w, 0.0
        if flipV:
            y1, y2 = h, 0.0
        html = (f'<svg class="o" data-pptx-id="{sid}" data-pptx-type="line" width="{w:g}" height="{h:g}" '
                f'viewBox="0 0 {w:g} {h:g}" style="{base}overflow:visible;">'
                f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{col}" '
                f'stroke-width="{sw:g}"{dash} vector-effect="non-scaling-stroke"/></svg>')
        entry["type"] = "line"
        return html, entry

    # 自由曲线
    if sh.shape_type == MSO_SHAPE_TYPE.FREEFORM:
        ff = freeform_path(sh)
        fill, fkind, fmeta = fill_css(sh, theme)
        ln = line_css(sh, theme)
        if ff:
            d = ff["d"]
            pvw = (ff["w"] or max(rect["w"], 1)) / 1000.0
            pvh = (ff["h"] or max(rect["h"], 1)) / 1000.0
            fa, defs = "none", ""
            gid = f"g{sid}"
            if fkind == "gradient" and fmeta.get("stops"):
                # SVG 的 fill 不能吃 CSS 渐变字符串 → 转成 <linearGradient>
                stops_svg = []
                for st in fmeta["stops"]:
                    col, pct = st.rsplit(" ", 1)
                    stops_svg.append(f'<stop offset="{pct}" stop-color="{col}" />')
                ang = fmeta.get("angle", 90)
                import math as _m
                rad = _m.radians(ang)
                x1 = 50 - 50 * _m.sin(rad); y1 = 50 + 50 * _m.cos(rad)
                x2 = 50 + 50 * _m.sin(rad); y2 = 50 - 50 * _m.cos(rad)
                defs = (f'<defs><linearGradient id="{gid}" x1="{x1:.1f}%" y1="{y1:.1f}%" '
                        f'x2="{x2:.1f}%" y2="{y2:.1f}%">{"".join(stops_svg)}</linearGradient></defs>')
                fa = f"url(#{gid})"
            elif fkind == "solid" and fill:
                fa = fill
            la = ln["color"] if ln else "none"
            lw = ln["width"] if ln else 0
            html = (f'<svg class="o" data-pptx-id="{sid}" data-pptx-type="freeform" width="{rect["w"]}" height="{rect["h"]}" '
                    f'viewBox="0 0 {pvw:.2f} {pvh:.2f}" preserveAspectRatio="none" style="{base}overflow:visible;">'
                    f'{defs}<path d="{d}" fill="{fa}" stroke="{la}" stroke-width="{lw/((rect["w"] or 1)/pvw):.3f}"/></svg>')
            entry["type"] = "freeform"
            return html, entry
        entry["lossy"].append("freeform: 无法解析路径")

    # 自动形状 / 文本框
    fill, fkind, fmeta = fill_css(sh, theme)
    ln = line_css(sh, theme)
    style = base
    radius = 0
    shape_name = ""
    try:
        shape_name = str(sh.auto_shape_type) if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE else ""
    except Exception:
        shape_name = ""
    if "OVAL" in shape_name:
        style += "border-radius:50%;"
    elif "ROUNDED_RECTANGLE" in shape_name:
        try:
            adj = sh.adjustments[0]
        except Exception:
            adj = 0.16667
        radius = round(min(rect["w"], rect["h"]) * float(adj), 2)
        style += f"border-radius:{radius}px;"
    elif shape_name and "RECTANGLE" not in shape_name:
        entry["lossy"].append(f"preset-shape:{shape_name} 以矩形近似")
        style += "border-radius:2px;"
    if fill:
        style += f"background:{fill};"
    if ln:
        style += f"border:{ln['width']}px {ln['style']} {ln['color']};"
    if sh.has_text_frame and sh.text_frame.text.strip():
        tstyle, paras = text_frame_html(sh, theme, 1.0)
        style_txt = style + tstyle
        html = (f'<div class="o t" data-pptx-id="{sid}" data-pptx-type="textshape" style="{style_txt}">'
                f'{paras}</div>')
        entry["type"] = "textshape"
    else:
        html = f'<div class="o" data-pptx-id="{sid}" data-pptx-type="shape" style="{style}"></div>'
        entry["type"] = "shape"
    return html, entry


def render_group(sh, ctx, tx):
    p_ns = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
    xfrm = sh._element.find(f"{p_ns}grpSpPr/{NS_A}xfrm")
    ox, oy, sx, sy = tx
    if xfrm is not None:
        off = xfrm.find(f"{NS_A}off"); ext = xfrm.find(f"{NS_A}ext")
        chOff = xfrm.find(f"{NS_A}chOff"); chExt = xfrm.find(f"{NS_A}chExt")
        if None not in (off, ext, chOff, chExt) and float(chExt.get("cx")) and float(chExt.get("cy")):
            gsx = float(ext.get("cx")) / float(chExt.get("cx"))
            gsy = float(ext.get("cy")) / float(chExt.get("cy"))
            # 父空间：P = off + (C - chOff) * gs；累积：abs = ox + P * s
            nox = ox + float(off.get("x")) * sx - float(chOff.get("x")) * gsx * sx
            noy = oy + float(off.get("y")) * sy - float(chOff.get("y")) * gsy * sy
            tx = (nox, noy, sx * gsx, sy * gsy)
    htmls = []
    for child in sh.shapes:
        r = render_shape(child, ctx, tx)
        if not r:
            continue
        h, e = r
        if h:
            htmls.append(h)
        if e:
            ctx["map"]["objects"].append(e)
    return "\n".join(htmls), None


# ---------------------------------------------------------------- table
def cell_border(tc, theme):
    p_ns = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
    tcPr = tc.find(f"{p_ns}tcPr")
    if tcPr is None:
        return None
    out = {}
    for tag in ("lnL", "lnR", "lnT", "lnB"):
        ln = tcPr.find(f"{NS_A}{tag}")
        if ln is None:
            continue
        w = int(ln.get("w", "12700")) / 12700.0
        solid = ln.find(f"{NS_A}solidFill")
        if solid is None:
            continue
        clr = solid.find(f"{NS_A}srgbClr")
        if clr is None:
            continue
        out[tag] = (round(w * 4 / 3, 2), "#" + clr.get("val"))
    return out or None


def render_table(sh, ctx, base, sid):
    theme = ctx["theme"]
    tbl = sh.table
    colw = [px(c.width) for c in tbl.columns]
    rows = []
    for tr in tbl.rows:
        cells = []
        for cell in tr.cells:
            tc = cell._tc
            fill, kind, meta = None, None, None
            try:
                if cell.fill.type == 1:
                    fill = color_of(cell.fill.fore_color, theme)
            except Exception:
                pass
            bd = cell_border(tc, theme)
            tf = cell.text_frame
            st, paras = text_frame_html(type("S", (), {"text_frame": tf})(), theme) if tf.text.strip() else ("", "")
            attrs = ""
            if fill:
                attrs += f"background:{fill};"
            if bd:
                for k, v in bd.items():
                    side = {"lnL": "left", "lnR": "right", "lnT": "top", "lnB": "bottom"}[k]
                    attrs += f"border-{side}:{v[0]}px solid {v[1]};"
            cells.append(f'<td style="{attrs}">{paras}</td>')
        rows.append("<tr>" + "".join(cells) + "</tr>")
    cols = "".join(f'<col style="width:{w}px">' for w in colw)
    html = (f'<table class="o" data-pptx-id="{sid}" data-pptx-type="table" '
            f'style="{base}border-collapse:collapse;table-layout:fixed;">'
            f'<colgroup>{cols}</colgroup>{"".join(rows)}</table>')
    return html


# ---------------------------------------------------------------- slide / bg
def slide_bg(slide, theme, assets, idx):
    try:
        f = slide.background.fill
    except Exception:
        return None, None
    try:
        if f.type == 1:
            col = color_of(f.fore_color, theme)
            return col, None
        if f.type == 3:
            stops = []
            for st in f.gradient_stops:
                col = color_of(st.color, theme)
                stops.append(f"{col} {round(st.position * 100, 1)}%")
            ang = 90
            try:
                ang = float(f.gradient_angle or 90)
            except Exception:
                pass
            return f"linear-gradient({ang}deg, {', '.join(stops)})", None
        if f.type == 6:
            img = slide.background.fill
    except Exception:
        pass
    return None, None


# ---------------------------------------------------------------- main
def data_uri_of(path):
    """把图片转成 data URI；有 alpha 用 PNG，无 alpha 用 JPEG(q85) 控制体积。"""
    import base64, io
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    try:
        im = Image.open(path)
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        buf = io.BytesIO()
        if has_alpha:
            im.save(buf, format="PNG", optimize=True)
            mime = "image/png"
        else:
            im.convert("RGB").save(buf, format="JPEG", quality=85, optimize=True)
            mime = "image/jpeg"
        return f"data:{mime};base64,{base64.b64encode(buf.getvalue()).decode()}"
    except Exception:
        raw = path.read_bytes()
        ext = path.suffix.lower().lstrip(".")
        mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
                "svg": "image/svg+xml", "webp": "image/webp"}.get(ext, "image/png")
        import base64 as b64
        return f"data:{mime};base64,{b64.b64encode(raw).decode()}"


def embed_assets(html, outdir):
    import re as _re
    cache = {}
    def repl(m):
        src = m.group(1)
        if src.startswith("data:") or src.startswith("http"):
            return m.group(0)
        if src not in cache:
            fp = (outdir / src).resolve()
            cache[src] = data_uri_of(fp) if fp.exists() else src
        return f'src="{cache[src]}"'
    html = _re.sub(r'src="([^"]+)"', repl, html)
    html = _re.sub(r"url\('([^']+)'\)", lambda m: f"url('{cache.get(m.group(1)) or data_uri_of((outdir / m.group(1)).resolve())}')", html)
    return html


def convert(pptx_path, outdir, width=1280, height=720, embed=False, use_ocr=True):
    """PPTX → HTML。产物：deck.html / assets / map.json / slots.json"""
    outdir = Path(outdir)
    assets = outdir / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    theme = Theme(pptx_path)
    prs = Presentation(pptx_path)
    sw, sh_ = prs.slide_width, prs.slide_height
    ctx = dict(theme=theme, assets=assets, n=1,
               map={"themes": theme.map, "objects": [], "lossy": []},
               crop=not os.environ.get("PPTX2HTML_NO_CROP"), roles={})
    slides_html = []
    all_slots = []
    summary = {"background": 0, "content": 0, "decoration": 0, "covered": 0, "text-image": 0}
    ocr_budget = 40 if use_ocr else 0

    for i, slide in enumerate(prs.slides, 1):
        shapes = list(slide.shapes)
        roles, bg_info, ocr_budget = classify_slide(shapes, sw, sh_, theme, ocr_budget)
        ctx["roles"] = roles
        ctx["slide_index"] = i
        ctx["slots"] = []
        ctx["map"]["objects"] = []
        ctx["n"] = i * 1000
        for info in roles.values():
            if info["role"] in summary:
                summary[info["role"]] += 1

        parts = []
        # ---------- 背景组件 ----------
        bg_color = None
        try:
            bg_color, _ = slide_bg(slide, theme, assets, i)
        except Exception:
            bg_color = None
        bg_children = []
        if bg_info.get("image") is not None:
            bg_src, _ = save_picture(bg_info["image"], assets, i * 1000 + 900, ctx["crop"])
            bg_children.append(
                f'<div class="bg-image" data-pptx-role="background-image" '
                f'style="position:absolute;inset:0;background-image:url(\'{bg_src}\');'
                f'background-size:100% 100%;background-repeat:no-repeat;"></div>')
        # 背景装饰形状（大面积、无文字、在内容之前）
        for sh in shapes:
            if roles.get(sh.shape_id, {}).get("role") != "background-decoration":
                continue
            r = render_shape(sh, ctx)
            if not r:
                continue
            h, e = r
            if h:
                bg_children.append(h.replace('class="o t"', 'class="o t bg-el"')
                                    .replace('class="o"', 'class="o bg-el"'))
            if e:
                ctx["map"]["objects"].append(e)
        if bg_children or bg_color:
            bg_style = f"position:absolute;left:0;top:0;width:100%;height:100%;"
            if bg_color:
                bg_style += f"background:{bg_color};"
            parts.append(
                f'<div class="pptx-bg" data-pptx-role="background" '
                f'data-pptx-bg-id="slide-{i}-bg" style="{bg_style}">' + "".join(bg_children) + "</div>")

        # ---------- 内容层 ----------
        skipped_here = []
        for sh in shapes:
            info = roles.get(sh.shape_id, {})
            if info.get("role") in ("background", "background-decoration", "covered"):
                if info.get("role") == "covered":
                    skipped_here.append({"id": sh.shape_id, "reason": info.get("reason")})
                continue
            r = render_shape(sh, ctx)
            if not r:
                continue
            h, e = r
            if h:
                parts.append(h)
            if e:
                ctx["map"]["objects"].append(e)

        bg_attr = esc_attr(bg_color or "")
        slides_html.append(
            f'<section class="slide" data-slide="{i}" data-layout="pptx-{i}" '
            f'data-pptx-bg="{bg_attr}" data-pptx-bg-id="slide-{i}-bg">\n'
            + "\n".join(parts) + "\n</section>")
        ctx["map"].setdefault("slides", []).append({
            "slide": i,
            "backgroundId": f"slide-{i}-bg",
            "background": {
                "color": bg_color,
                "image": (bg_info["image"].name if bg_info.get("image") is not None else None),
                "decorations": [sid for sid, v in roles.items() if v["role"] == "background-decoration"],
            },
            "images": [dict(id=sid, **v) for sid, v in roles.items()
                       if v["role"] in ("background", "content", "decoration", "covered", "text-image")],
            "slots": [sl["slot"] for sl in ctx["slots"]],
            "skipped": skipped_here,
            "objects": ctx["map"]["objects"],
            "lossy": [l for o in ctx["map"]["objects"] for l in o.get("lossy", [])],
        })
        ctx["map"]["lossy"].extend(ctx["map"]["slides"][-1]["lossy"])
        all_slots.extend(ctx["slots"])

    font_family = '"微软雅黑","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif'
    html = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>{esc(Path(pptx_path).stem)} · from PPTX</title>
<style>
  *,*::before,*::after{{margin:0;padding:0;box-sizing:border-box}}
  html,body{{width:{width}px;height:{height}px;overflow:hidden;background:#FFFFFF}}
  #stage{{position:relative;width:{width}px;height:{height}px}}
  section.slide{{position:absolute;left:0;top:0;width:{width}px;height:{height}px;overflow:hidden;
    font-family:{font_family};background:#FFFFFF}}
  .o{{position:absolute}}
  .pptx-bg{{z-index:0;pointer-events:none}}
  .pptx-bg .bg-el{{z-index:0}}
  section.slide > .o{{z-index:1}}
  p{{margin:0}}
  table{{border-collapse:collapse}}
  td{{vertical-align:middle}}
</style></head>
<body><div id="stage">
{chr(10).join(slides_html)}
</div></body></html>'''
    if embed:
        html = embed_assets(html, outdir)
    (outdir / "deck.html").write_text(html, encoding="utf-8")
    ctx["map"]["pptx"] = str(pptx_path)
    ctx["map"]["slidesCount"] = len(prs.slides)
    ctx["map"]["slots"] = all_slots
    ctx["map"]["summary"] = summary
    (outdir / "map.json").write_text(json.dumps(ctx["map"], ensure_ascii=False, indent=1), encoding="utf-8")
    (outdir / "slots.json").write_text(json.dumps({
        "pptx": str(pptx_path),
        "slots": all_slots,
        "summary": summary,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"slides": len(prs.slides),
            "objects": sum(len(sl["objects"]) for sl in ctx["map"]["slides"]),
            "slots": len(all_slots), "roles": summary,
            "lossy": len(ctx["map"]["lossy"]), "out": str(outdir / "deck.html")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--single-file", action="store_true", help="把图片内联成单文件 HTML（默认输出链接式，便于替换图片）")
    ap.add_argument("--no-ocr", action="store_true", help="跳过 OCR（不检测文字截图）")
    a = ap.parse_args()
    r = convert(a.pptx, a.out, a.width, a.height, embed=a.single_file, use_ocr=not a.no_ocr)
    print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main()
