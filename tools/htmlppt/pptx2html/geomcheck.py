#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""geomcheck.py —— 原稿 vs 导出回件：逐对象几何一致性（位置/尺寸）

用法：
  python geomcheck.py 原稿.pptx 回件.pptx [--tol 2.0] [--json out.json]

输出：
  * 每页对象数、能配上的对象数
  * 位置偏差 dx/dy、尺寸偏差 dw/dh 的均值/中位/95分位
  * 在 tol 像素内完全一致的对象占比
  * 未能配对的（原稿独有 / 回件独有）
"""
from __future__ import annotations

import argparse
import json
import statistics as st
from collections import Counter

from pptx import Presentation
from pptx.util import Emu

EMU_PX = 9525.0


def flatten(shapes, tx=(0.0, 0.0, 1.0, 1.0), out=None):
    """把（可能嵌套的）组展平成绝对框列表：[(kind, x, y, w, h)]，单位 px"""
    if out is None:
        out = []
    ox, oy, sx, sy = tx
    for sh in shapes:
        if sh.shape_type == 6:  # GROUP
            try:
                xfrm = sh._element.find(
                    "{http://schemas.openxmlformats.org/presentationml/2006/main}grpSpPr"
                ).find("{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm")
                off = xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}off")
                ext = xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}ext")
                chOff = xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}chOff")
                chExt = xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}chExt")
                gsx = float(ext.get("cx")) / float(chExt.get("cx"))
                gsy = float(ext.get("cy")) / float(chExt.get("cy"))
                nox = ox + float(off.get("x")) * sx - float(chOff.get("x")) * gsx * sx
                noy = oy + float(off.get("y")) * sy - float(chOff.get("y")) * gsy * sy
                flatten(sh.shapes, (nox, noy, sx * gsx, sy * gsy), out)
            except Exception:
                pass
            continue
        try:
            x = (ox + float(sh.left) * sx) / EMU_PX
            y = (oy + float(sh.top) * sy) / EMU_PX
            w = float(sh.width) * sx / EMU_PX
            h = float(sh.height) * sy / EMU_PX
        except Exception:
            continue
        kind = "group" if False else str(sh.shape_type).split(" ")[0]
        out.append((kind, round(x, 2), round(y, 2), round(w, 2), round(h, 2)))
    return out


def slide_boxes(prs):
    return [[b for b in flatten(s.shapes) if b[3] > 0.5 and b[4] > 0.5] for s in prs.slides]


def match(orig, rebuilt, tol=2.0):
    """贪心最近邻匹配：按中心距离，要求宽高差也不离谱。"""
    used = set()
    pairs = []
    for i, a in enumerate(orig):
        ax, ay, aw, ah = a[1], a[2], a[3], a[4]
        acx, acy = ax + aw / 2, ay + ah / 2
        best = None
        for j, b in enumerate(rebuilt):
            if j in used:
                continue
            bx, by, bw, bh = b[1], b[2], b[3], b[4]
            bcx, bcy = bx + bw / 2, by + bh / 2
            d = ((acx - bcx) ** 2 + (acy - bcy) ** 2) ** 0.5
            size_pen = abs(aw - bw) + abs(ah - bh)
            score = d + 0.5 * size_pen
            if score < 12 and (best is None or score < best[0]):
                best = (score, j, b)
        if best:
            used.add(best[1])
            bx, by, bw, bh = best[2][1], best[2][2], best[2][3], best[2][4]
            pairs.append({
                "orig": a, "rebuilt": best[2],
                "dx": round(bx - ax, 2), "dy": round(by - ay, 2),
                "dw": round(bw - aw, 2), "dh": round(bh - ah, 2),
                "dist": round(((ax + aw / 2 - bx - bw / 2) ** 2 + (ay + ah / 2 - by - bh / 2) ** 2) ** 0.5, 2),
            })
    unmatched_orig = [a for i, a in enumerate(orig) if all(p["orig"] is not a for p in pairs)]
    unmatched_new = [b for j, b in enumerate(rebuilt) if j not in used]
    return pairs, unmatched_orig, unmatched_new


def pctl(vals, p):
    if not vals:
        return None
    vals = sorted(vals)
    k = max(0, min(len(vals) - 1, int(round((p / 100.0) * (len(vals) - 1)))))
    return round(vals[k], 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("orig")
    ap.add_argument("rebuilt")
    ap.add_argument("--tol", type=float, default=2.0)
    ap.add_argument("--json")
    a = ap.parse_args()

    prs_o = Presentation(a.orig)
    prs_r = Presentation(a.rebuilt)
    ob = slide_boxes(prs_o)
    rb = slide_boxes(prs_r)

    report = {"pages": [], "summary": {}}
    all_dx, all_dy, all_dw, all_dh, all_dist = [], [], [], [], []
    exact = 0
    total_matched = 0
    total_orig = 0

    for i, (o, r) in enumerate(zip(ob, rb), 1):
        pairs, uo, un = match(o, r, a.tol)
        within = sum(1 for p in pairs
                     if max(abs(p["dx"]), abs(p["dy"]), abs(p["dw"]), abs(p["dh"])) <= a.tol)
        total_matched += len(pairs)
        total_orig += len(o)
        exact += within
        all_dx += [p["dx"] for p in pairs]
        all_dy += [p["dy"] for p in pairs]
        all_dw += [p["dw"] for p in pairs]
        all_dh += [p["dh"] for p in pairs]
        all_dist += [p["dist"] for p in pairs]
        report["pages"].append({
            "slide": i, "orig_objects": len(o), "rebuilt_objects": len(r),
            "matched": len(pairs), "within_tol": within,
            "within_tol_ratio": round(within / max(len(o), 1), 3),
            "unmatched_orig": len(uo), "unmatched_rebuilt": len(un),
            "median_dist_px": round(st.median([p["dist"] for p in pairs]), 2) if pairs else None,
            "max_dist_px": round(max([p["dist"] for p in pairs]), 2) if pairs else None,
        })

    n = len(all_dx)
    report["summary"] = {
        "orig_objects": total_orig,
        "rebuilt_objects": sum(len(x) for x in rb),
        "matched": n,
        "match_rate": round(n / max(total_orig, 1), 3),
        f"within_{a.tol}px": exact,
        f"within_{a.tol}px_ratio": round(exact / max(n, 1), 3),
        "dx_median": round(st.median(all_dx), 2) if n else None,
        "dy_median": round(st.median(all_dy), 2) if n else None,
        "dw_median": round(st.median(all_dw), 2) if n else None,
        "dh_median": round(st.median(all_dh), 2) if n else None,
        "dist_median": round(st.median(all_dist), 2) if n else None,
        "dist_p95": pctl(all_dist, 95),
        "dist_max": round(max(all_dist), 2) if n else None,
        "abs_dx_p95": pctl([abs(v) for v in all_dx], 95),
        "abs_dy_p95": pctl([abs(v) for v in all_dy], 95),
    }

    print(f"原稿对象 {report['summary']['orig_objects']} · 回件对象 {report['summary']['rebuilt_objects']} "
          f"· 配上 {n}（{report['summary']['match_rate']*100:.1f}%）")
    print(f"位置/尺寸在 {a.tol}px 内一致：{exact}/{n} = {report['summary'][f'within_{a.tol}px_ratio']*100:.1f}%")
    print(f"中心距离：中位 {report['summary']['dist_median']}px · 95分位 {report['summary']['dist_p95']}px "
          f"· 最大 {report['summary']['dist_max']}px")
    print(f"dx 中位 {report['summary']['dx_median']} · dy 中位 {report['summary']['dy_median']} "
          f"· dw 中位 {report['summary']['dw_median']} · dh 中位 {report['summary']['dh_median']}")
    print("\n逐页：")
    for p in report["pages"]:
        print(f"  P{p['slide']:>2}: 原 {p['orig_objects']:>3} / 回 {p['rebuilt_objects']:>3} / "
              f"配上 {p['matched']:>3} / {a.tol}px 内 {p['within_tol']:>3} "
              f"({p['within_tol_ratio']*100:.0f}%) · 中位 {p['median_dist_px']}px")

    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        print(f"\n写入 {a.json}")


if __name__ == "__main__":
    main()
