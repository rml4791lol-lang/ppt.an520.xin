#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
audit_pptx.py — PPTX「可编辑度」审计工具

用途：拿任何供应商（ComPDF / image2ppt / WPS / PPTBot / 自研）输出的 pptx，
客观量化它到底是 L0 塞图、L1 文字层，还是 L2 元素还原。避免靠肉眼和感觉。

用法：
    python3 audit_pptx.py output.pptx
    python3 audit_pptx.py output.pptx --json report.json
    python3 audit_pptx.py output.pptx --verbose        # 打印每页元素清单

输出：终端可读报告 + 可选 JSON（便于批量跑 10 图 × 5 工具做横向对比）

分层判定（与调研报告一致）：
    L0 塞图      ：整页被一张图片覆盖（图片面积占比 ≥ 85%）且几乎无独立文本
    L1 文字层    ：有文本，但几乎没有独立形状/表格（图形都在背景图里）
    L2 元素还原  ：文本 + 独立形状/表格/连接线并存，且背景图占比低
    L2+/L3       ：独立非图片对象占比高（> 60% 面积）

依赖：python-pptx >= 0.6.21（1.0.x 亦可）
"""
import sys, json, argparse
from collections import Counter, defaultdict

from pptx import Presentation
from pptx.util import Emu
from pptx.enum.shapes import MSO_SHAPE_TYPE


# ---------- 中文字体风险表 ----------
SAFE_FONTS = {
    "noto sans cjk sc", "noto serif cjk sc", "source han sans sc", "source han serif sc",
    "思源黑体", "思源宋体", "noto sans", "noto serif", "inter", "roboto", "arial",
    "helvetica", "times new roman", "dejavu sans", "liberation sans",
}
RISKY_FONTS = {
    "微软雅黑", "microsoft yahei", "宋体", "simsun", "黑体", "simhei", "楷体", "kaiti",
    "仿宋", "fangsong", "方正", "founder", "汉仪", "hanyi", "pingfang", "苹方",
    "songti sc", "hiragino sans gb", "冬青黑体",
}

EMU_PER_INCH = 914400


def _area(shape):
    try:
        w = shape.width or 0
        h = shape.height or 0
        return int(w) * int(h)
    except Exception:
        return 0


def _slide_area(slide, prs):
    try:
        return int(slide.part.package.presentation_part.presentation.slide_width) * \
               int(slide.part.package.presentation_part.presentation.slide_height)
    except Exception:
        return int(prs.slide_width) * int(prs.slide_height)


def _iter_shapes(shapes, depth=0):
    """递归展开 group shape，返回 (shape, depth)。"""
    for sh in shapes:
        yield sh, depth
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _iter_shapes(sh.shapes, depth + 1)


def _text_of(shape):
    try:
        if shape.has_text_frame:
            return shape.text_frame.text or ""
    except Exception:
        pass
    return ""


def _fonts_of(shape):
    """收集 shape 内所有 run 的字体名（含 latin/ea/cs）。"""
    out = []
    try:
        if not shape.has_text_frame:
            return out
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                f = run.font
                if f.name:
                    out.append(f.name)
                # 直接读 XML 里的 a:ea / a:cs（python-pptx 的 font.name 只映射 a:latin）
                try:
                    rPr = run._r.find(
                        '{http://schemas.openxmlformats.org/drawingml/2006/main}rPr')
                    if rPr is not None:
                        for tag in ('ea', 'cs', 'latin'):
                            el = rPr.find(
                                '{http://schemas.openxmlformats.org/drawingml/2006/main}' + tag)
                            if el is not None and el.get('typeface'):
                                out.append(el.get('typeface'))
                except Exception:
                    pass
    except Exception:
        pass
    return out


def _shape_kind(shape):
    try:
        st = shape.shape_type
    except Exception:
        return "unknown"
    if st is None:
        # 没有 shape_type 时按是否有 text_frame 判断
        try:
            if shape.has_text_frame:
                return "textbox"
        except Exception:
            pass
        return "unknown"
    if st == MSO_SHAPE_TYPE.PICTURE:
        return "picture"
    if st == MSO_SHAPE_TYPE.LINKED_PICTURE:
        return "picture"
    if st == MSO_SHAPE_TYPE.TEXT_BOX:
        return "textbox"
    if st == MSO_SHAPE_TYPE.PLACEHOLDER:
        return "placeholder"
    if st == MSO_SHAPE_TYPE.CANVAS:
        return "canvas"
    if st == MSO_SHAPE_TYPE.TABLE:
        return "table"
    if st == MSO_SHAPE_TYPE.GROUP:
        return "group"
    if st == MSO_SHAPE_TYPE.LINE:
        return "line"
    if st == MSO_SHAPE_TYPE.CHART:
        return "chart"
    if st == MSO_SHAPE_TYPE.FREEFORM:
        return "freeform"
    if st == MSO_SHAPE_TYPE.AUTO_SHAPE:
        # 区分有文字的自动形状 / 纯几何
        return "autoshape_text" if _text_of(shape).strip() else "autoshape"
    return "other"


def audit(path, verbose=False):
    prs = Presentation(path)
    slide_w, slide_h = int(prs.slide_width), int(prs.slide_height)
    slide_area = slide_w * slide_h

    deck = {
        "file": path,
        "slide_size_inch": [round(slide_w / EMU_PER_INCH, 2), round(slide_h / EMU_PER_INCH, 2)],
        "aspect": round(slide_w / slide_h, 3) if slide_h else None,
        "slide_count": len(prs.slides),
        "slides": [],
    }
    deck_fonts = Counter()
    deck_kinds = Counter()
    total_editable = 0
    total_chars = 0
    missing_ea_count = 0  # 中文 run 缺少 a:ea 的段数
    slide_summaries = []

    for idx, slide in enumerate(prs.slides, start=1):
        kinds = Counter()
        pic_area = 0
        max_pic_area = 0
        editable_area = 0
        text_shapes = 0
        chars = 0
        runs_with_cjk = 0
        runs_cjk_no_ea = 0
        fonts = Counter()
        shapes_detail = []

        for sh, depth in _iter_shapes(slide.shapes):
            if depth > 0:
                continue  # 只统计顶层，group 内部的子形状用于面积但不单独计
            kind = _shape_kind(sh)
            kinds[kind] += 1
            area = _area(sh)
            txt = _text_of(sh)
            if kind in ("textbox", "autoshape_text", "placeholder") and txt.strip():
                text_shapes += 1
                chars += len(txt)
            if kind == "picture":
                pic_area += area
                max_pic_area = max(max_pic_area, area)
            else:
                editable_area += area

            for fname in _fonts_of(sh):
                fonts[fname] += 1
                deck_fonts[fname] += 1

            # 中文字体 ea 检查
            try:
                if sh.has_text_frame:
                    for para in sh.text_frame.paragraphs:
                        for run in para.runs:
                            t = run.text or ""
                            if any('\u4e00' <= c <= '\u9fff' for c in t):
                                runs_with_cjk += 1
                                rPr = run._r.find(
                                    '{http://schemas.openxmlformats.org/drawingml/2006/main}rPr')
                                ea = None
                                if rPr is not None:
                                    ea = rPr.find(
                                        '{http://schemas.openxmlformats.org/drawingml/2006/main}ea')
                                if ea is None or not ea.get('typeface'):
                                    runs_cjk_no_ea += 1
            except Exception:
                pass

            shapes_detail.append({
                "name": sh.name,
                "kind": kind,
                "text": txt[:80].replace("\n", " ⏎ "),
                "area_pct": round(area / slide_area * 100, 1) if slide_area else 0,
            })

        pic_pct = round(pic_area / slide_area * 100, 1) if slide_area else 0
        max_pic_pct = round(max_pic_area / slide_area * 100, 1) if slide_area else 0
        editable_pct = round(editable_area / slide_area * 100, 1) if slide_area else 0
        non_pic_objs = sum(v for k, v in kinds.items() if k != "picture")
        # 几何对象：除“纯文本框”和“图片”之外的独立对象（形状/表格/线/自由曲线/图表）
        geometry_objs = sum(v for k, v in kinds.items()
                            if k in ("autoshape", "autoshape_text", "table", "line",
                                     "freeform", "chart", "canvas"))
        # 全幅底图：存在一张覆盖 ≥80% 页面的图片（L2 图层的典型形态）
        has_bg_image = max_pic_pct >= 80

        # ---- 分层判定（以“独立对象丰富度”为主，图片覆盖率只作辅助）----
        if non_pic_objs == 0 and text_shapes == 0:
            level = "L0 塞图"
            why = f"整页只有图片（最大单图 {max_pic_pct}%），无任何独立对象"
        elif non_pic_objs <= 2 and text_shapes >= 1:
            level = "L0+ 塞图+隐藏文字层"
            why = f"有 {text_shapes} 个文本框但仅 {non_pic_objs} 个非图片对象，图形仍随背景图（典型“隐形 OCR 层”）"
        elif geometry_objs == 0:
            level = "L1 只认字"
            why = f"{text_shapes} 个文本框、0 个独立形状/表格——只有文字可编辑，版式靠贴图"
        elif geometry_objs <= 2:
            level = "L2- 文字+少量图形"
            why = f"{text_shapes} 个文本框 + {geometry_objs} 个几何对象，版式主体仍是图"
        else:
            level = "L2 元素还原"
            why = f"{text_shapes} 个文本框 + {geometry_objs} 个几何对象 + {non_pic_objs} 个非图片对象，可分层编辑"
        if has_bg_image and level.startswith("L2"):
            why += f"；⚠️ 含全幅底图（最大单图 {max_pic_pct}%），视觉保真靠底图、可编辑靠上层"

        total_editable += non_pic_objs
        total_chars += chars
        missing_ea_count += runs_cjk_no_ea
        deck_kinds.update(kinds)

        s = {
            "slide": idx,
            "level": level,
            "why": why,
            "objects_non_picture": non_pic_objs,
            "kind_counts": dict(kinds),
            "text_shapes": text_shapes,
            "chars": chars,
            "picture_area_pct": pic_pct,
            "max_picture_area_pct": max_pic_pct,
            "has_background_image": has_bg_image,
            "geometry_objects": geometry_objs,
            "editable_area_pct": editable_pct,
            "cjk_runs": runs_with_cjk,
            "cjk_runs_missing_ea_font": runs_cjk_no_ea,
            "fonts": dict(fonts),
        }
        if verbose:
            s["shapes"] = shapes_detail
        slide_summaries.append(s)

    # ---- deck 汇总 ----
    level_counter = Counter(s["level"] for s in slide_summaries)
    avg_pic = round(
        sum(s["max_picture_area_pct"] for s in slide_summaries) / max(1, len(slide_summaries)), 1)
    bg_image_ratio = round(
        sum(1 for s in slide_summaries if s["has_background_image"]) / max(1, len(slide_summaries)) * 100, 1)
    l2_ratio = round(
        sum(1 for s in slide_summaries if s["level"].startswith("L2")) / max(1, len(slide_summaries)) * 100, 1)

    risky = {f: c for f, c in deck_fonts.items() if f.strip().lower() in RISKY_FONTS}
    safe = {f: c for f, c in deck_fonts.items() if f.strip().lower() in SAFE_FONTS}
    unknown_fonts = {f: c for f, c in deck_fonts.items()
                     if f.strip().lower() not in RISKY_FONTS and f.strip().lower() not in SAFE_FONTS}

    deck.update({
        "summary": {
            "level_distribution": dict(level_counter),
            "L2_slide_ratio_pct": l2_ratio,
            "avg_max_picture_area_pct": avg_pic,
            "slides_with_background_image_pct": bg_image_ratio,
            "total_non_picture_objects": total_editable,
            "total_geometry_objects": sum(s["geometry_objects"] for s in slide_summaries),
            "total_chars": total_chars,
            "avg_chars_per_slide": round(total_chars / max(1, len(slide_summaries))),
            "object_kind_total": dict(deck_kinds),
            "cjk_runs_missing_ea_font": missing_ea_count,
            "fonts_all": dict(deck_fonts.most_common()),
            "fonts_risky_no_embed": risky,
            "fonts_safe": safe,
            "fonts_unknown": unknown_fonts,
        },
        "slides": slide_summaries,
    })
    return deck


def print_report(d):
    s = d["summary"]
    print("=" * 74)
    print(f"PPTX 可编辑度审计  |  {d['file']}")
    print(f"页数 {d['slide_count']}   尺寸 {d['slide_size_inch'][0]}×{d['slide_size_inch'][1]} in   "
          f"比例 {d['aspect']}")
    print("=" * 74)
    print("\n【总体判定】")
    for lv, n in sorted(s["level_distribution"].items()):
        print(f"  {lv:<22} {n} 页")
    print(f"  L2 页占比              {s['L2_slide_ratio_pct']}%")
    print(f"  单图最大覆盖（页均）      {s['avg_max_picture_area_pct']}%")
    print(f"  含全幅底图(z0)的页占比     {s['slides_with_background_image_pct']}%")
    print(f"  非图片对象总数           {s['total_non_picture_objects']}"
          f"   （其中几何对象 {s['total_geometry_objects']}）")
    print(f"  文本总字数 / 页均        {s['total_chars']} / {s['avg_chars_per_slide']}")
    print(f"  中文字符缺 a:ea 字体设置  {s['cjk_runs_missing_ea_font']} 处"
          f"{'  ⚠️ 中文会 fallback 宋体' if s['cjk_runs_missing_ea_font'] else '  ✓'}")

    print("\n【对象构成】")
    for k, v in sorted(s["object_kind_total"].items(), key=lambda x: -x[1]):
        print(f"  {k:<18} {v}")

    print("\n【字体风险】")
    if s["fonts_risky_no_embed"]:
        print("  ⚠️ 高风险（不可内置/需用户本机已安装）：")
        for f, c in s["fonts_risky_no_embed"].items():
            print(f"      {f}  ×{c}")
    if s["fonts_safe"]:
        print("  ✓ 可安全内置：")
        for f, c in s["fonts_safe"].items():
            print(f"      {f}  ×{c}")
    if s["fonts_unknown"]:
        print("  ? 未分类（需人工确认授权）：")
        for f, c in s["fonts_unknown"].items():
            print(f"      {f}  ×{c}")

    print("\n【逐页明细】")
    print(f"  {'页':>3} {'判定':<22} {'非图对象':>6} {'文本框':>5} {'几何':>4} {'字数':>6} {'底图%':>6}")
    for sl in d["slides"]:
        print(f"  {sl['slide']:>3} {sl['level']:<22} {sl['objects_non_picture']:>6} "
              f"{sl['text_shapes']:>5} {sl['geometry_objects']:>4} {sl['chars']:>6} "
              f"{sl['max_picture_area_pct']:>6}")

    print("\n【怎么用这份结果】")
    print("  · L0/L1 占比高 → 供应商在「塞图」或「只认字」，用户一定会退款")
    print("  · L2 页占比 = 可直接交付的比例；建议按此分档定价")
    print("  · 含全幅底图(z0) 不代表不合格：这是主流形态（底图保真 + 上层可编辑）")
    print("  · 非图片对象数 = Ctrl+A 能选中的独立元素数，是「可编辑」最硬的指标")
    print("  · 中文字符缺 a:ea → 打开后中文全部变宋体，是最常见的隐性质量事故")
    print("=" * 74)


def main():
    ap = argparse.ArgumentParser(description="PPTX 可编辑度审计")
    ap.add_argument("pptx", nargs="+", help="一个或多个 pptx 文件")
    ap.add_argument("--json", help="单文件时把完整结果写成 JSON")
    ap.add_argument("--csv", help="多文件时输出横向对比 CSV（盲测用）")
    ap.add_argument("--verbose", action="store_true", help="逐页打印元素清单")
    ap.add_argument("--quiet", action="store_true", help="不打印逐份报告")
    a = ap.parse_args()

    results = []
    for f in a.pptx:
        try:
            d = audit(f, verbose=a.verbose)
            results.append(d)
            if not a.quiet:
                print_report(d)
        except Exception as e:
            print(f"[跳过] {f}: {e}", file=sys.stderr)

    if a.json and len(results) == 1:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(results[0], fh, ensure_ascii=False, indent=2)
        print(f"\nJSON 已写入 {a.json}")

    if a.csv and results:
        import csv
        cols = ["file", "slide_count", "L2_slide_ratio_pct", "avg_max_picture_area_pct",
                "slides_with_background_image_pct", "total_non_picture_objects",
                "total_geometry_objects", "avg_chars_per_slide",
                "cjk_runs_missing_ea_font", "level_L0", "level_L1", "level_L2", "fonts_risky"]
        with open(a.csv, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            for d in results:
                s = d["summary"]
                ld = s["level_distribution"]
                w.writerow({
                    "file": d["file"],
                    "slide_count": d["slide_count"],
                    "L2_slide_ratio_pct": s["L2_slide_ratio_pct"],
                    "avg_max_picture_area_pct": s["avg_max_picture_area_pct"],
                    "slides_with_background_image_pct": s["slides_with_background_image_pct"],
                    "total_non_picture_objects": s["total_non_picture_objects"],
                    "total_geometry_objects": s["total_geometry_objects"],
                    "avg_chars_per_slide": s["avg_chars_per_slide"],
                    "cjk_runs_missing_ea_font": s["cjk_runs_missing_ea_font"],
                    "level_L0": sum(v for k, v in ld.items() if k.startswith("L0")),
                    "level_L1": sum(v for k, v in ld.items() if k.startswith("L1")),
                    "level_L2": sum(v for k, v in ld.items() if k.startswith("L2")),
                    "fonts_risky": ";".join(s["fonts_risky_no_embed"].keys()),
                })
        print(f"\n横向对比 CSV 已写入 {a.csv}")


if __name__ == "__main__":
    main()
