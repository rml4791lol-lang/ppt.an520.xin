#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""htmlppt —— HTMLPPT 仓库的统一命令行入口（仅标准库 + subprocess）。

六个子命令：
  doctor                     检查本机依赖与关键字体
  extract <pptx> -o <dir>    PPTX → 可编辑 HTML（默认图片内嵌）
  build   <html> -o <dir>    HTML → 可编辑 PPTX + 12 项 gates
  verify  --pptx --html -o   HTML vs PPTX 回渲，逐页 MAE
  bench   [--quick]          打印引擎基准矩阵（读取 bench/runs/*/score.json）
  stack   <pptx> [-o <dir>]  一条龙 extract → build → verify

所有命令支持 --json；退出码 0=成功 1=失败 2=用法错误。
仓库根由本文件位置推导，可从任意 cwd 调用。
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = Path(__file__).resolve().parent

# 仓库里脚本默认使用的 Python 环境（含 python-pptx / Pillow / numpy）
VENV_PY = Path("/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python")
FONT_KEYS = [
    ("PingFang SC", "macOS 中文界面主字体"),
    ("Noto Sans SC", "跨平台中文无衬线"),
    ("Songti SC", "中文宋体（正文/引文）"),
    ("Arial", "西文回退"),
    ("Helvetica Neue", "macOS 西文"),
    ("Inter", "设计稿常用西文字体"),
]
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

_TOOL_PY: str | None = None


class ToolError(RuntimeError):
    """外部工具执行失败（统一映射为退出码 1）。"""


# ------------------------------------------------------------------ small utils
def display_width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in str(s))


def pad(s: str, width: int) -> str:
    s = str(s)
    return s + " " * max(0, width - display_width(s))


def table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [display_width(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], display_width(cell))
    line = "  ".join(pad(h, widths[i]) for i, h in enumerate(headers))
    sep = "  ".join("-" * widths[i] for i in range(len(headers)))
    body = ["  ".join(pad(c, widths[i]) for i, c in enumerate(row)) for row in rows]
    return "\n".join([line, sep] + body)


def show_path(p: Path) -> str:
    """喜欢相对 cwd 的短路径，失败则绝对路径。"""
    try:
        r = os.path.relpath(p, Path.cwd())
        return r if not r.startswith(".." + os.sep) or len(r) < len(str(p)) else str(p)
    except Exception:
        return str(p)


def fmt_sec(s: float) -> str:
    return f"{s:.1f}s"


def run(cmd: list[str], *, cwd: Path = ROOT, env: dict | None = None,
        timeout: int = 900, what: str = "命令") -> subprocess.CompletedProcess:
    e = dict(os.environ)
    e.setdefault("PYTHONIOENCODING", "utf-8")
    if env:
        e.update({k: str(v) for k, v in env.items()})
    try:
        p = subprocess.run(cmd, cwd=str(cwd), env=e, capture_output=True,
                           text=True, timeout=timeout)
    except FileNotFoundError as ex:
        raise ToolError(f"{what}找不到可执行文件：{cmd[0]}（{ex}）") from ex
    except subprocess.TimeoutExpired as ex:
        raise ToolError(f"{what}超时（>{timeout}s）：{Path(cmd[0]).name}") from ex
    if p.returncode != 0:
        tail = ((p.stdout or "") + (p.stderr or "")).strip()[-2000:]
        raise ToolError(f"{what}失败（退出码 {p.returncode}）\n{tail}")
    return p


def require_file(p: Path, label: str) -> Path:
    p = p.expanduser().resolve()
    if not p.is_file():
        raise ToolError(f"{label}不存在：{p}")
    return p


def tool_python() -> str:
    """选一个装有 python-pptx / Pillow / numpy 的解释器。"""
    global _TOOL_PY
    if _TOOL_PY:
        return _TOOL_PY
    cands = [os.environ.get("HTMLPPT_PYTHON"), str(VENV_PY), sys.executable,
             shutil.which("python3"), "/opt/homebrew/bin/python3"]
    seen: set[str] = set()
    for cand in cands:
        if not cand or cand in seen:
            continue
        seen.add(cand)
        try:
            p = subprocess.run([cand, "-c", "import pptx, PIL, numpy"],
                               capture_output=True, text=True, timeout=30)
        except Exception:
            continue
        if p.returncode == 0:
            _TOOL_PY = cand
            return cand
    raise ToolError("找不到装有 python-pptx / Pillow / numpy 的 Python。"
                    "请设置 HTMLPPT_PYTHON=/path/to/python3.12")


def node_bin() -> str:
    return os.environ.get("HTMLPPT_NODE") or shutil.which("node") or "node"


def chrome_bin() -> str | None:
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chrome")


def first_line(text: str, fallback: str = "") -> str:
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line
    return fallback


def emit_json(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=1))


def fail(args, message: str) -> int:
    if getattr(args, "json_mode", False):
        emit_json({"command": getattr(args, "command", None), "ok": False, "error": message})
    print(f"✘ {message}", file=sys.stderr)
    return 1


# ------------------------------------------------------------------ doctor
def check_version(name: str, cmd: list[str], required: bool, path: str | None,
                  note: str = "") -> dict:
    if not path:
        return {"name": name, "ok": False, "required": required, "version": None,
                "path": None, "note": note or "未找到"}
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        raw = first_line((p.stdout or "") + "\n" + (p.stderr or ""))
    except Exception as ex:
        raw = f"无法执行：{ex}"
    return {"name": name, "ok": True, "required": required, "version": raw,
            "path": path, "note": note}


def cmd_doctor(args) -> int:
    t0 = time.time()
    py = None
    try:
        py = tool_python()
    except ToolError:
        py = None
    node = shutil.which(node_bin())
    soffice = shutil.which("soffice") or ("/opt/homebrew/bin/soffice"
                                          if Path("/opt/homebrew/bin/soffice").exists() else None)
    pdftoppm = shutil.which("pdftoppm")
    fcmatch = shutil.which("fc-match")
    chrome = chrome_bin()

    checks: list[dict] = []
    checks.append(check_version("python", [py or sys.executable, "--version"], True, py,
                                "需含 python-pptx / Pillow / numpy" if py else "未找到可用解释器"))
    checks.append(check_version("node", [node or "node", "-v"], True, node, "prototype 构建"))
    checks.append(check_version("soffice", [soffice or "soffice", "--version"], True, soffice,
                                "PPTX 回渲 PDF"))
    checks.append(check_version("chrome", [chrome or "chrome", "--version"], True, chrome,
                                "headless 测量/截图"))
    checks.append(check_version("pdftoppm", [pdftoppm or "pdftoppm", "-v"], True, pdftoppm,
                                "PDF → PNG"))
    checks.append(check_version("fc-match", [fcmatch or "fc-match", "--version"], False, fcmatch,
                                "字体检查（可选）"))

    fonts: list[dict] = []
    for family, why in FONT_KEYS:
        if fcmatch:
            try:
                p = subprocess.run([fcmatch, "-f", "%{family}|%{file}", family],
                                   capture_output=True, text=True, timeout=15)
                got, _, path = (p.stdout or "").partition("|")
                hit = family.lower() in got.lower()
                fonts.append({"family": family, "ok": hit, "resolved": got.strip(),
                              "path": path.strip() or None, "note": why})
            except Exception as ex:
                fonts.append({"family": family, "ok": False, "resolved": str(ex),
                              "path": None, "note": why})
        else:
            fonts.append({"family": family, "ok": False, "resolved": None,
                          "path": None, "note": why + "（无 fc-match，无法检查）"})

    missing_required = [c["name"] for c in checks if c["required"] and not c["ok"]]
    missing_fonts = [f["family"] for f in fonts if not f["ok"]]
    ok = not missing_required
    result = {
        "command": "doctor", "ok": ok,
        "platform": f"{platform.system()} {platform.release()}",
        "python": sys.version.split()[0],
        "checks": checks, "fonts": fonts,
        "missingRequired": missing_required, "missingFonts": missing_fonts,
        "elapsedSec": round(time.time() - t0, 2),
    }
    if args.json_mode:
        emit_json(result)
        return 0 if ok else 1

    print(f"htmlppt doctor · {result['platform']} · CLI Python {result['python']}")
    print()
    print(table(["检查项", "必需", "状态", "版本 / 说明"],
                [[c["name"], "是" if c["required"] else "否",
                  "✓" if c["ok"] else "✘",
                  c["version"] or c["note"]] for c in checks]))
    print()
    print(table(["关键字体", "状态", "实际匹配"],
                [[f["family"], "✓" if f["ok"] else "✘", f["resolved"] or "—"] for f in fonts]))
    if missing_required:
        print(f"\n✘ 缺少必需工具：{', '.join(missing_required)}")
    else:
        print("\n✓ 必需工具齐全")
    if missing_fonts:
        print(f"⚠ 字体缺失（可能影响回渲保真）：{', '.join(missing_fonts)}")
    print(f"  耗时 {fmt_sec(time.time() - t0)}")
    return 0 if ok else 1


# ------------------------------------------------------------------ extract
def do_extract(pptx: Path, out: Path, embed: bool) -> dict:
    t0 = time.time()
    py = tool_python()
    out.mkdir(parents=True, exist_ok=True)
    cmd = [py, str(ROOT / "pptx2html" / "pptx2html.py"), str(pptx), "-o", str(out)]
    if embed:
        cmd.append("--single-file")
    p = run(cmd, timeout=900, what="pptx2html 提取")
    info: dict = {}
    line = (p.stdout or "").strip().splitlines()
    if line:
        try:
            info = json.loads(line[-1])
        except Exception:
            info = {}
    if not info and (out / "map.json").exists():
        m = json.loads((out / "map.json").read_text(encoding="utf-8"))
        info = {"slides": m.get("slidesCount"), "objects": None,
                "lossy": len(m.get("lossy", []))}
    html = out / "deck.html"
    if not html.exists():
        raise ToolError(f"提取结束但未找到 {html}")
    return {
        "command": "extract", "ok": True, "pptx": str(pptx), "out": str(out),
        "html": str(html), "embed": embed,
        "slides": info.get("slides"), "objects": info.get("objects"),
        "lossy": info.get("lossy"), "map": str(out / "map.json"),
        "bytes": html.stat().st_size, "elapsedSec": round(time.time() - t0, 2),
    }


def cmd_extract(args) -> int:
    try:
        pptx = require_file(Path(args.pptx), "PPTX 文件")
        out = Path(args.out).expanduser().resolve() if args.out else \
            pptx.parent / f"{pptx.stem}-html"
        r = do_extract(pptx, out, not args.no_embed)
    except ToolError as ex:
        return fail(args, str(ex))
    if args.json_mode:
        emit_json(r)
        return 0
    print("▶ extract  PPTX → HTML")
    print(f"  输入  {show_path(Path(r['pptx']))}")
    print(f"  输出  {show_path(Path(r['html']))}")
    print(f"  规模  {r['slides']} 页 · {r['objects']} 个对象 · lossy {r['lossy']}")
    print(f"  图片  {'内嵌 data URI（单文件）' if r['embed'] else '外链 assets/ 目录'}")
    print(f"  ✔ 完成 {fmt_sec(r['elapsedSec'])}")
    return 0


# ------------------------------------------------------------------ build
def read_metrics(out: Path) -> dict:
    p = out / "metrics.json"
    if not p.exists():
        raise ToolError(f"构建结束但未找到 {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def do_build(html: Path, out: Path, allow_bg: bool = False, strict_lint: bool = False) -> dict:
    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    node = node_bin()
    # 入口校验：默认只告警；strict_lint=True 时有 error 直接失败
    lint_argv = [node, str(ROOT / "prototype" / "src" / "lint.mjs"), str(html), "--json"]
    lp = subprocess.run(lint_argv, cwd=str(ROOT), capture_output=True, text=True)
    lint_info = {"error": 0, "warning": 0, "info": 0, "ok": True}
    try:
        rep = json.loads(lp.stdout or "{}")
        lint_info = {"error": rep["counts"]["error"], "warning": rep["counts"]["warning"],
                     "info": rep["counts"]["info"], "ok": rep["counts"]["error"] == 0}
    except Exception:
        pass
    if lint_info["error"]:
        msg = f"lint 发现 {lint_info['error']} 个 error（详见 htmlppt lint {html}）"
        if strict_lint:
            raise ToolError(msg)
        print(f"  ⚠ {msg}，继续构建")
    env = {"HTMLPPT_DECK": str(html), "HTMLPPT_OUT": str(out), "PYTHON": tool_python(),
           "ALLOW_BG_IMAGE": "1" if allow_bg else "0"}
    run([node, str(ROOT / "prototype" / "src" / "run.mjs")], env=env,
        timeout=1800, what="prototype 构建")
    m = read_metrics(out)
    gates = m.get("gates") or {}
    passed = sum(1 for v in gates.values() if v)
    deck = out / "deck.pptx"
    if not deck.exists():
        raise ToolError(f"构建结束但未找到 {deck}")
    return {
        "command": "build", "ok": True, "html": str(html), "out": str(out),
        "deck": str(deck), "metrics": str(out / "metrics.json"),
        "slides": (m.get("headline") or {}).get("slides")
        or (m.get("delivery") or {}).get("slides"),
        "verdict": m.get("verdict"), "gates": gates,
        "gatesPassed": passed, "gatesTotal": len(gates),
        "headline": m.get("headline") or {},
        "bytes": deck.stat().st_size,
        "elapsedSec": round(time.time() - t0, 2),
    }


def cmd_build(args) -> int:
    try:
        html = require_file(Path(args.html), "HTML 文件")
        out = Path(args.out).expanduser().resolve() if args.out else html.parent / "htmlppt-out"
        r = do_build(html, out)
    except ToolError as ex:
        return fail(args, str(ex))
    if args.json_mode:
        emit_json(r)
        return 0
    h = r["headline"]
    print("▶ build  HTML → 可编辑 PPTX")
    print(f"  输入  {show_path(Path(r['html']))}")
    print(f"  输出  {show_path(Path(r['deck']))}")
    mae = h.get("mae")
    cov = h.get("textCharsCoverage")
    print(f"  规模  {r['slides']} 页 · {r['bytes'] / 1024:.1f} KiB"
          + (f" · MAE {mae}" if mae is not None else "")
          + (f" · 字符覆盖 {cov * 100:.0f}%" if isinstance(cov, (int, float)) else ""))
    status = r["verdict"] or ("PASS" if r["gatesPassed"] == r["gatesTotal"] else "CHECK")
    print(f"  gates {r['gatesPassed']}/{r['gatesTotal']} · {status}")
    failed = [k for k, v in r["gates"].items() if not v]
    if failed:
        print(f"  未过  {', '.join(failed)}")
    print(f"  ✔ 完成 {fmt_sec(r['elapsedSec'])}")
    return 0


# ------------------------------------------------------------------ verify
def do_verify(pptx: Path, html: Path, out: Path) -> dict:
    t0 = time.time()
    py = tool_python()
    out.mkdir(parents=True, exist_ok=True)
    cmd = [py, str(ROOT / "pptx2html" / "verify.py"), "--pptx", str(pptx),
           "--html", str(html), "--out", str(out)]
    vj = out / "verify.json"
    data: dict = {}
    # LibreOffice 使用共享用户配置目录；刚跑完 build 的 soffice 可能还没退干净，
    # 导致第一次转换静默失败（0 页）。等待后重试，最多 3 次。
    for attempt in range(3):
        vj.unlink(missing_ok=True)
        for pat in ("pptx/page-*.png", "html/slide-*.png"):
            for f in out.glob(pat):
                f.unlink(missing_ok=True)
        pdfdir = out / "pptx" / "pdf"
        if pdfdir.is_dir():
            for f in pdfdir.glob("*.pdf"):
                f.unlink(missing_ok=True)
        run(cmd, timeout=1200, what="verify 回渲比对")
        if vj.exists():
            data = json.loads(vj.read_text(encoding="utf-8"))
        if data.get("perSlide"):
            break
        if attempt < 2:
            print("  … 回渲未产出页面（soffice 配置目录可能被占用），2 秒后重试",
                  file=sys.stderr)
            time.sleep(2)
    if not data.get("perSlide"):
        raise ToolError(
            "verify 未比对到任何页面：LibreOffice 可能被另一个 soffice 进程占用，"
            "请关闭正在运行的 LibreOffice 后重试；或检查 PDF 回渲目录 "
            f"{out / 'pptx' / 'pdf'}")
    return {
        "command": "verify", "ok": True, "pptx": str(pptx), "html": str(html),
        "out": str(out), "perSlide": data.get("perSlide", []),
        "aggregate": data.get("aggregate", {}), "report": str(vj),
        "compare": str(out / "compare.png") if (out / "compare.png").exists() else None,
        "elapsedSec": round(time.time() - t0, 2),
    }


def cmd_verify(args) -> int:
    try:
        pptx = require_file(Path(args.pptx), "PPTX 文件")
        html = require_file(Path(args.html), "HTML 文件")
        out = Path(args.out).expanduser().resolve() if args.out else html.parent / "verify"
        r = do_verify(pptx, html, out)
    except ToolError as ex:
        return fail(args, str(ex))
    if args.json_mode:
        emit_json(r)
        return 0
    agg = r["aggregate"]
    print("▶ verify  HTML vs PPTX 回渲")
    print(f"  PPTX  {show_path(Path(r['pptx']))}")
    print(f"  HTML  {show_path(Path(r['html']))}")
    print()
    print(table(["页", "MAE", "diff>16%", "diff>48%"],
                [[str(x.get("slide")), str(x.get("mae")), str(x.get("pct_gt16")),
                  str(x.get("pct_gt48"))] for x in r["perSlide"]]))
    print()
    print(f"  合计  {agg.get('slides')} 页 · 平均 MAE {agg.get('mae')} · "
          f">16 {agg.get('pct_gt16')}% · >48 {agg.get('pct_gt48')}%")
    if r["compare"]:
        print(f"  对比图 {show_path(Path(r['compare']))}")
    print(f"  ✔ 完成 {fmt_sec(r['elapsedSec'])}")
    return 0


# ------------------------------------------------------------------ bench
def load_bench_rows() -> list[dict]:
    rows: list[dict] = []
    runs = ROOT / "bench" / "runs"
    for d in sorted(runs.iterdir()) if runs.is_dir() else []:
        if not d.is_dir():
            continue
        sc = d / "score.json"
        if not sc.exists():
            rows.append({"label": d.name, "status": "not-run"})
            continue
        try:
            s = json.loads(sc.read_text(encoding="utf-8"))
        except Exception as ex:
            rows.append({"label": d.name, "status": f"bad-score-json: {ex}"})
            continue
        if s.get("status") != "ok":
            rows.append({"label": s.get("label", d.name), "status": s.get("status")})
            continue
        e = s.get("editability") or {}
        v = (s.get("visual") or {}).get("aggregate") or {}
        g = s.get("gates") or {}
        rows.append({
            "label": s.get("label", d.name), "status": "ok",
            "slides": s.get("slides"), "slidesExpected": s.get("slidesExpected"),
            "elapsedSec": s.get("elapsedSec"),
            "pptxKiB": round((s.get("pptxBytes") or 0) / 1024, 1),
            "charCoverage": e.get("char_coverage"), "aTRuns": e.get("a_t_runs"),
            "pSp": e.get("p_sp"), "pPic": e.get("p_pic"), "tables": e.get("a_tbl"),
            "custGeom": e.get("custGeom"), "gradFill": e.get("gradFill"),
            "fullPagePics": e.get("full_page_pictures"),
            "mae": v.get("mae"), "pct16": v.get("pct_gt16"), "pct48": v.get("pct_gt48"),
            "gatesPassed": sum(1 for x in g.values() if x), "gatesTotal": len(g),
        })
    order = ["ours", "hasasasa", "gx", "yuna78", "mmoollee", "designarena",
             "junyuaini", "abdelkrimkr"]
    rows.sort(key=lambda r: (order.index(r["label"]) if r["label"] in order else 99,
                             r["label"]))
    return rows


def cmd_bench(args) -> int:
    t0 = time.time()
    try:
        rows = load_bench_rows()
    except Exception as ex:
        return fail(args, f"读取 bench 结果失败：{ex}")
    scored = [r for r in rows if r.get("status") == "ok"]
    if not scored and not rows:
        return fail(args, "bench/runs 下没有评测结果")
    result = {"command": "bench", "ok": True, "quick": args.quick,
              "runs": rows, "scored": len(scored),
              "matrix": str(ROOT / "bench" / "matrix.json"),
              "elapsedSec": round(time.time() - t0, 2)}
    if args.json_mode:
        emit_json(result)
        return 0
    print("bench · 引擎基准矩阵（bench/runs/*/score.json）")
    if args.quick:
        print(table(["引擎", "页数", "MAE", ">16%", "闸门", "耗时s"],
                    [[r["label"], f"{r.get('slides')}/{r.get('slidesExpected')}",
                      str(r.get("mae", "—")), str(r.get("pct16", "—")),
                      f"{r.get('gatesPassed')}/{r.get('gatesTotal')}",
                      str(r.get("elapsedSec", "—"))] for r in scored]))
    else:
        print(table(["引擎", "页数", "覆盖", "a:t", "p:sp", "p:pic", "表", "cust", "grad",
                     "整页图", "MAE", ">16%", "闸门", "耗时s"],
                    [[r["label"], f"{r.get('slides')}/{r.get('slidesExpected')}",
                      f"{(r.get('charCoverage') or 0) * 100:.0f}%", str(r.get("aTRuns")),
                      str(r.get("pSp")), str(r.get("pPic")), str(r.get("tables")),
                      str(r.get("custGeom")), str(r.get("gradFill")),
                      str(r.get("fullPagePics")), str(r.get("mae")), str(r.get("pct16")),
                      f"{r.get('gatesPassed')}/{r.get('gatesTotal')}",
                      str(r.get("elapsedSec"))] for r in scored]))
    print(f"\n  {len(scored)} 个引擎有分数 · 矩阵 {show_path(Path(result['matrix']))}")
    return 0


# ------------------------------------------------------------------ stack
def _run_replace(py: str, argv: list[str]) -> int:
    return subprocess.call([py, str(ROOT / "pptx2html" / "replace.py")] + argv)


def cmd_lint(args) -> int:
    html = require_file(Path(args.html), "HTML 文件")
    node = node_bin()
    argv = [node, str(ROOT / "prototype" / "src" / "lint.mjs"), str(html)]
    if args.strict:
        argv.append("--strict")
    if args.json_mode:
        argv.append("--json")
    # lint 的结论就是退出码，直接透传输出（不走 run()，避免把报告吞掉）
    rc = subprocess.call(argv, cwd=str(ROOT))
    return 0 if rc == 0 else 1


def cmd_describe(args) -> int:
    """从 potx/pptx 生成机器可读契约（describe.json / layout.md / deck 清单）。"""
    py = tool_python()
    script = ROOT / "tools" / "contract" / "describe.py"
    src = Path(args.potx).expanduser().resolve() if args.potx else (
        ROOT.parent / "PPT 复刻" / "out" / "gold-template" / "国金模板.potx")
    if not src.exists():
        raise ToolError(f"找不到模板文件：{src}")
    out_json = Path(args.out).expanduser().resolve() if args.out else ROOT / "contracts" / "describe.json"
    cmd = [py, str(script), str(src), "--json", str(out_json)]
    if args.layout_md:
        cmd += ["--layout-md", str(Path(args.layout_md).expanduser().resolve())]
    if args.deck_out:
        cmd += ["--deck-out", str(Path(args.deck_out).expanduser().resolve())]
    if args.contract:
        cmd += ["--contract", str(Path(args.contract).expanduser().resolve())]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise ToolError((r.stderr or "").strip()[-1500:] or "describe 失败")
    payload = json.loads(out_json.read_text(encoding="utf-8"))
    summary = {"command": "describe", "ok": True, "source": str(src), "describe": str(out_json),
               "layouts": payload["totals"]["layouts"], "slots": payload["totals"]["slots"],
               "byType": payload["totals"]["by_type"], "themes": len(payload["themes"]),
               "components": len(payload.get("components") or [])}
    if args.json_mode:
        emit_json({"command": "describe", "ok": True, "describePath": str(out_json), **payload})
    else:
        print(f"▶ {summary['layouts']} 版式 · {summary['slots']} 槽位 · "
              f"{summary['themes']} 主题 · {summary['components']} 组件 → {show_path(out_json)}")
    return 0


def cmd_patch(args) -> int:
    pptx = require_file(Path(args.pptx), "PPTX 文件")
    changes = require_file(Path(args.changes), "changes.json")
    out = Path(args.out).expanduser().resolve() if args.out else pptx.parent / f"{pptx.stem}-patched.pptx"
    py = tool_python()
    rc = subprocess.call([py, str(ROOT / "tools" / "patch-pptx.py"), str(pptx), str(changes), str(out)])
    if rc != 0:
        return 1
    if args.json_mode:
        emit_json({"command": "patch", "pptx": str(pptx), "changes": str(changes), "out": str(out), "ok": True})
    else:
        print(f"\n▶ 已生成 {out}")
    return 0


def cmd_slots(args) -> int:
    d = Path(args.dir).expanduser().resolve()
    if not d.exists():
        raise ToolError(f"目录不存在: {d}")
    py = tool_python()
    slots = json.loads((d / "slots.json").read_text(encoding="utf-8")) if (d / "slots.json").exists() else {"slots": []}
    if args.json_mode:
        emit_json({"command": "slots", "dir": str(d), **slots})
        return 0
    rc = _run_replace(py, ["list", str(d)])
    return 0 if rc == 0 else 1


def cmd_replace(args) -> int:
    d = Path(args.dir).expanduser().resolve()
    if not d.exists():
        raise ToolError(f"目录不存在: {d}")
    py = tool_python()
    argv: list[str] = []
    if args.bg_slide:
        if not args.image:
            raise ToolError("替换背景需要 --image")
        argv = ["background", str(d), "--slide", str(args.bg_slide), "--image", str(Path(args.image).expanduser().resolve())]
    else:
        if not (args.slot and args.image):
            raise ToolError("替换内容图需要 --slot 与 --image（槽位用 htmlppt slots <dir> 查）")
        argv = ["image", str(d), "--slot", args.slot,
                "--image", str(Path(args.image).expanduser().resolve())]
    if args.out:
        argv += ["--out", str(Path(args.out).expanduser().resolve())]
    rc = _run_replace(py, argv)
    if rc != 0:
        return 1
    if args.json_mode:
        emit_json({"command": "replace", "dir": str(d), "argv": argv, "ok": True})
    return 0


def cmd_stack(args) -> int:
    t0 = time.time()
    steps: dict = {}
    current = "extract"
    try:
        pptx = require_file(Path(args.pptx), "PPTX 文件")
        root = Path(args.out).expanduser().resolve() if args.out else \
            pptx.parent / f"{pptx.stem}-stack"
        ext_dir, build_dir, verify_dir = root / "extract", root / "build", root / "verify"

        current = "extract"
        steps["extract"] = do_extract(pptx, ext_dir, bool(getattr(args, "single_file", False)))
        if not args.json_mode:
            print(f"▶ 1/3 extract  {steps['extract']['slides']} 页 · "
                  f"{steps['extract']['objects']} 对象 → {show_path(ext_dir)}")

        current = "build"
        steps["build"] = do_build(Path(steps["extract"]["html"]), build_dir, allow_bg=True)
        if not args.json_mode:
            b = steps["build"]
            print(f"▶ 2/3 build    {b['slides']} 页 · gates {b['gatesPassed']}/"
                  f"{b['gatesTotal']} · 字符覆盖 "
                  f"{(b['headline'].get('textCharsCoverage') or 0) * 100:.0f}% → "
                  f"{show_path(Path(b['deck']))}")

        current = "verify"
        steps["verify"] = do_verify(pptx, Path(steps["extract"]["html"]), verify_dir)
        if not args.json_mode:
            agg = steps["verify"]["aggregate"]
            print(f"▶ 3/3 verify   平均 MAE {agg.get('mae')} · "
                  f"{agg.get('slides')} 页 → {show_path(Path(steps['verify']['report']))}")

        result = {
            "command": "stack", "ok": True, "pptx": str(pptx), "out": str(root),
            "steps": steps,
            "summary": {
                "slides": steps["extract"]["slides"],
                "objects": steps["extract"]["objects"],
                "gatesPassed": steps["build"]["gatesPassed"],
                "gatesTotal": steps["build"]["gatesTotal"],
                "verdict": steps["build"]["verdict"],
                "mae": steps["verify"]["aggregate"].get("mae"),
                "charCoverage": steps["build"]["headline"].get("textCharsCoverage"),
            },
            "elapsedSec": round(time.time() - t0, 2),
        }
        if args.json_mode:
            emit_json(result)
        else:
            s = result["summary"]
            print(f"\n闭环  {s['slides']} 页 · {s['objects']} 对象 · "
                  f"gates {s['gatesPassed']}/{s['gatesTotal']} · "
                  f"回渲 MAE {s['mae']} · 字符覆盖 "
                  f"{(s['charCoverage'] or 0) * 100:.0f}%")
            print(f"所有产物 {show_path(root)} · 总耗时 {fmt_sec(result['elapsedSec'])}")
        return 0
    except ToolError as ex:
        msg = f"stack 在 {current} 阶段失败：{ex}"
        if args.json_mode:
            emit_json({"command": "stack", "ok": False, "stage": current,
                       "error": msg, "steps": steps,
                       "elapsedSec": round(time.time() - t0, 2)})
        print(f"✘ {msg}", file=sys.stderr)
        return 1


# ------------------------------------------------------------------ argparse
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="htmlppt", description="HTMLPPT 统一命令行：提取 / 生成 / 质检 / 基准 / 闭环",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python3 cli/htmlppt.py doctor\n"
               "  python3 cli/htmlppt.py extract deck.pptx -o out/html\n"
               "  python3 cli/htmlppt.py build out/html/deck.html\n"
               "  python3 cli/htmlppt.py verify --pptx deck.pptx --html out/html/deck.html -o out/verify\n"
               "  python3 cli/htmlppt.py bench --quick\n"
               "  python3 cli/htmlppt.py stack deck.pptx -o out/roundtrip")
    ap.add_argument("--version", action="version", version="htmlppt 1.0")
    ap.add_argument("--json", action="store_true", dest="json_global",
                    help="机器可读 JSON（也可写在子命令后）")
    sub = ap.add_subparsers(dest="command", metavar="<command>")

    d = sub.add_parser("doctor", help="检查依赖工具与关键字体")
    d.add_argument("--json", action="store_true", dest="json")

    e = sub.add_parser("extract", help="PPTX → 可编辑 HTML")
    e.add_argument("pptx")
    e.add_argument("-o", "--out", help="输出目录（默认 <pptx目录>/<stem>-html）")
    e.add_argument("--single-file", action="store_true", help="图片内联成单文件 HTML（默认链接式，便于换图）")
    e.add_argument("--json", action="store_true", dest="json")

    b = sub.add_parser("build", help="HTML → 可编辑 PPTX（含 12 项 gates）")
    b.add_argument("html")
    b.add_argument("-o", "--out", help="输出目录（默认 <html目录>/htmlppt-out）")
    b.add_argument("--strict-lint", action="store_true", dest="strict_lint", help="lint 有 error 时直接失败")
    b.add_argument("--json", action="store_true", dest="json")

    v = sub.add_parser("verify", help="HTML vs PPTX 回渲逐页 MAE")
    v.add_argument("--pptx", required=True)
    v.add_argument("--html", required=True)
    v.add_argument("-o", "--out", help="输出目录（默认 <html目录>/verify）")
    v.add_argument("--json", action="store_true", dest="json")

    be = sub.add_parser("bench", help="打印引擎基准矩阵")
    be.add_argument("--quick", action="store_true", help="精简列")
    be.add_argument("--json", action="store_true", dest="json")

    li = sub.add_parser("lint", help="按 HTMLPPT 契约做入口校验（转换前检查）")
    li.add_argument("html", help="待检查的 HTML")
    li.add_argument("--strict", action="store_true", help="warning 也算失败")
    li.add_argument("--json", action="store_true", dest="json")

    de = sub.add_parser("describe", help="从 potx 生成契约（describe.json / layout.md / deck 清单）")
    de.add_argument("potx", nargs="?", help="模板文件（默认 国金模板.potx）")
    de.add_argument("-o", "--out", help="describe.json 输出路径")
    de.add_argument("--layout-md", help="生成每个版式的 layout.md 到该目录")
    de.add_argument("--deck-out", help="生成 deck 清单示例 JSON")
    de.add_argument("--contract", help="槽位契约.md（用于补 sample/required）")
    de.add_argument("--json", action="store_true", dest="json")

    pt = sub.add_parser("patch", help="原 PPTX 打补丁（只改文字/图片，几何 100% 不变）")
    pt.add_argument("pptx", help="原始 PPTX")
    pt.add_argument("changes", help="编辑器导出的 changes.json")
    pt.add_argument("-o", "--out", help="输出 PPTX（默认 <pptx目录>/<stem>-patched.pptx）")
    pt.add_argument("--json", action="store_true", dest="json")

    sl = sub.add_parser("slots", help="列出可替换的图片槽位（内容图）")
    sl.add_argument("dir", help="extract 产物目录")
    sl.add_argument("--json", action="store_true", dest="json")

    rp = sub.add_parser("replace", help="替换内容图槽位 / 整页背景")
    rp.add_argument("dir", help="extract 产物目录")
    rp.add_argument("--slot", help="槽位 id，如 img-6-1（用 slots 命令查）")
    rp.add_argument("--image", help="新图片路径")
    rp.add_argument("--background-slide", type=int, dest="bg_slide", help="替换第 N 页背景组件")
    rp.add_argument("--out", help="输出到新目录（默认原地替换，原图备份到 assets/_originals/）")
    rp.add_argument("--json", action="store_true", dest="json")

    s = sub.add_parser("stack", help="extract → build → verify 闭环自检")
    s.add_argument("pptx")
    s.add_argument("-o", "--out", help="产物根目录（默认 <pptx目录>/<stem>-stack）")
    s.add_argument("--single-file", action="store_true", help="extract 阶段内联成单文件")
    s.add_argument("--json", action="store_true", dest="json")

    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "command", None):
        ap.print_help()
        return 2
    args.json_mode = bool(getattr(args, "json", False) or getattr(args, "json_global", False))
    handlers = {
        "doctor": cmd_doctor, "extract": cmd_extract, "build": cmd_build,
        "verify": cmd_verify, "bench": cmd_bench, "stack": cmd_stack,
        "slots": cmd_slots, "replace": cmd_replace, "lint": cmd_lint, "patch": cmd_patch,
        "describe": cmd_describe,
    }
    try:
        return handlers[args.command](args)
    except ToolError as ex:
        return fail(args, str(ex))
    except KeyboardInterrupt:
        print("\n✘ 已中断", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
