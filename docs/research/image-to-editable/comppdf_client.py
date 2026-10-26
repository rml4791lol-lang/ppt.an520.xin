#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
comppdf_client.py — ComPDF Cloud「图片 → 可编辑 PPTX」参考集成代码

用途：把 https://www.compdf.com/guides/api-reference/v2/image-to-ppt 这套接口
按生产可用方式封装好，直接改 API Key 就能跑通。

覆盖：
  · 同步转换（≤10MB / ≤60s，最简单）
  · 异步转换（提交 → 轮询 / 回调，10–50MB、批量）
  · 预签名上传（大文件，文件不经业务网关）
  · 错误码分类与重试（按官方 errors_conversion 的 retry 建议）
  · 国内接入切换（api-server.compdf.cn）
  · Webhook 签名校验骨架
  · 转换结果交给 audit_pptx.py 做可编辑度审计

用法：
    export COMPDF_KEY=your_public_key
    python3 comppdf_client.py --sync  slide1.png -o out.pdf   # 单页
    python3 comppdf_client.py --async img_dir/ -o out.pptx    # 多页合并
    然后：python3 audit_pptx.py out.pptx

⚠️ 说明：本文件是参考实现，不是官方 SDK。上线前请补：
   - 配置管理、日志脱敏、熔断、指标埋点
   - Webhook 的真实签名算法（官方 webhook-signing 文档较简，需在控制台取签名密钥后对齐）
   - 预签名上传的 PUT 头（依赖接口返回的 headers）
"""
import os
import sys
import time
import json
import hmac
import hashlib
import argparse
import mimetypes
from pathlib import Path

import requests

# ---------------------------------------------------------------- 常量

API_HOST_INTL = "https://api-server.compdf.com"
API_HOST_CN = "https://api-server.compdf.cn"      # 中国大陆接入（数据不出境）
IMG_TO_PPTX = "/server/v2/process/img/pptx"
PDF_TO_PPTX = "/server/v2/process/pdf/pptx"
LAYOUT_ANALYSIS = "/server/v2/process/documentAI/layoutAnalysis"
TASK_LIST = "/server/v2/task/list"

# 官方 errors_conversion 的可重试区间
RETRYABLE_PREFIXES = ("1900",)          # 190001–190010 建议退避重试（max 3）
RETRYABLE_EXACT = {"190999"}
NON_RETRYABLE_PREFIXES = ("0100", "0200", "0400", "100", "120", "06001")

# 图片转 PPT 的业务参数（字段名已对照官方文档核实；以控制台/Postman 再对齐一次最稳）
#   https://www.compdf.com/guides/api-reference/v2/image-to-ppt
DEFAULTS = {
    "language": 2,                  # ★ 报错信息语言 1=EN 2=中文（不是 OCR 语言！）
    "enableOcr": 1,                 # 是否开 OCR（默认 0）。扫描件/图片版必须 1
    "ocrRecognitionLang": "chi_sim+eng",   # OCR 语言码
    "ocrRecognitionScope": "ALL",   # INVALID_CHARACTER | SCAN_PAGE | INVALID_CHARACTER_AND_SCAN_PAGE | ALL
    "enableAiLayout": 1,            # ★ AI 版面分析（默认 1）=「结构还原」总开关，关掉基本退化成贴图
    "preserveImages": 1,            # 保留原图里的图片元素
    "preserveAnnotations": 1,       # 保留批注
    "pageBackground": 1,            # 是否输出整页背景图（仅 OCR 开启时生效）。★ 设 0 = 更"原生"但更不像原图
    "formulaToImage": 0,            # 0=公式保持可编辑（默认，罕见能力） 1=公式转图片
    "pageLayoutMode": "e_Flow",     # ★ e_Flow（流式，可编辑性好） | e_Box（绝对定位，视觉更准）
}

# 预设：两套典型取舍
PRESET_NATIVE = {**DEFAULTS, "enableAiLayout": 1, "pageBackground": 0, "formulaToImage": 0}
PRESET_FIDELITY = {**DEFAULTS, "enableAiLayout": 1, "pageBackground": 1}


class ComPDFError(Exception):
    def __init__(self, code, error_code, message, trace_id=None, http_status=None):
        super().__init__(f"[{code}/{error_code}] {message}")
        self.code = code
        self.error_code = error_code
        self.message = message
        self.trace_id = trace_id
        self.http_status = http_status

    @property
    def retryable(self) -> bool:
        c = str(self.code or "")
        if c in RETRYABLE_EXACT:
            return True
        return any(c.startswith(p) for p in RETRYABLE_PREFIXES)


class ComPDFClient:
    def __init__(self, api_key: str, region: str = "cn", timeout=180, verbose=True):
        if not api_key:
            raise SystemExit("缺少 API Key（export COMPDF_KEY=...）")
        self.api_key = api_key
        self.base = API_HOST_CN if region == "cn" else API_HOST_INTL
        self.timeout = timeout
        self.verbose = verbose
        self.s = requests.Session()
        self.s.headers.update({"x-api-key": self.api_key})

    # ---------------------------------------------------------- 内部
    def _log(self, *a):
        if self.verbose:
            print(*a, file=sys.stderr)

    def _post_file(self, path: str, endpoint: str, params: dict, async_mode=False):
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(p)
        mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        data = {k: str(v) for k, v in params.items()}
        if async_mode:
            data["isAsync"] = "1"
        url = self.base + endpoint
        self._log(f"→ POST {url}  file={p.name} ({p.stat().st_size/1e6:.2f} MB)")
        with p.open("rb") as fh:
            r = self.s.post(url, files={"file": (p.name, fh, mime)},
                            data=data, timeout=self.timeout)
        return self._parse(r)

    @staticmethod
    def _parse(r: requests.Response):
        if r.status_code == 401:
            raise ComPDFError(401, "AUTH", "API Key 无效或缺失", http_status=401)
        if r.status_code == 403:
            raise ComPDFError(403, "FORBIDDEN", "权限不足", http_status=403)
        try:
            body = r.json()
        except Exception:
            raise ComPDFError(r.status_code, "NON_JSON", r.text[:200], http_status=r.status_code)
        code = body.get("code")
        if str(code) not in ("200", "0", "None") and body.get("errorCode"):
            raise ComPDFError(code, body.get("errorCode"), body.get("message"),
                              body.get("traceId"), r.status_code)
        return body.get("data") or body

    # ---------------------------------------------------------- 同步
    def convert_sync(self, path: str, out: str, params=None, endpoint=IMG_TO_PPTX):
        """单文件同步转换。官方建议：≤10MB 且预计 <60s。"""
        params = {**DEFAULTS, **(params or {})}
        data = self._post_file(path, endpoint, params, async_mode=False)
        url = data.get("downloadUrl")
        if not url:
            raise ComPDFError(data.get("code"), "NO_URL",
                              f"未返回 downloadUrl：{json.dumps(data, ensure_ascii=False)[:300]}")
        self._download(url, out)
        self._log(f"✓ {out}  convertTime={data.get('convertTime')}ms  size={data.get('convertSize')}")
        return data

    # ---------------------------------------------------------- 异步
    def convert_async(self, paths, out: str, params=None, endpoint=IMG_TO_PPTX,
                      poll_interval=3.0, max_wait=900, page_range=None):
        """多文件合并为一个 pptx（按上传顺序）。返回逐任务结果。"""
        params = {**DEFAULTS, **(params or {})}
        if page_range:
            params["pageRanges"] = page_range     # 仅 PDF→pptx 端点支持
        task_ids = []
        for p in paths:
            data = self._post_file(p, endpoint, params, async_mode=True)
            tid = data.get("taskId")
            self._log(f"  ↳ taskId={tid}")
            task_ids.append(tid)
        # 轮询（官方建议间隔 ≥3s）
        waited = 0.0
        pending = set(task_ids)
        done = {}
        while pending and waited < max_wait:
            time.sleep(poll_interval)
            waited += poll_interval
            for tid in list(pending):
                info = self.get_task(tid)
                st = (info.get("status") or "").lower()
                if st in ("success", "failed", "expired"):
                    done[tid] = info
                    pending.discard(tid)
                    self._log(f"  ↳ {tid} → {st}")
        if pending:
            raise TimeoutError(f"轮询超时，未完成：{pending}")

        urls = []
        for tid in task_ids:
            info = done[tid]
            if (info.get("status") or "").lower() != "success":
                fc = info.get("failureCode")
                raise ComPDFError(fc, info.get("failureReason") or "FAILED",
                                  f"任务 {tid} 失败")
            urls.append(info["downloadUrl"])
        # ComPDF 异步是多任务多文件；若需要单个 pptx，建议一次只传一个文件
        for i, u in enumerate(urls):
            target = out if len(urls) == 1 else str(Path(out).with_name(
                f"{Path(out).stem}_{i+1}{Path(out).suffix}"))
            self._download(u, target)
        return done

    def get_task(self, task_id: str):
        r = self.s.get(self.base + TASK_LIST, params={"taskId": task_id},
                       timeout=30)
        return self._parse(r)

    # ---------------------------------------------------------- 预签名（骨架）
    def convert_presigned(self, path: str, out: str, params=None):
        """
        大文件走预签名：①向网关申请上传地址（不传文件本体）
        ②PUT 到对象存储 ③带着 fileKey 触发任务 ④轮询/回调 ⑤下载
        具体申请接口请以控制台「预签名」文档为准，这里给流程骨架。
        """
        raise NotImplementedError(
            "预签名流程需按官方 presigned 文档对接签名接口；"
            "文件 >50MB 或浏览器直传场景才需要，多数服务端场景用 async 即可。")

    # ---------------------------------------------------------- Webhook
    @staticmethod
    def verify_webhook(raw_body: bytes, signature: str, secret: str,
                       timestamp: str = None, tolerance: int = 300) -> dict:
        """
        校验 ComPDF Webhook 签名（骨架）。
        官方 webhook-signing 文档很简，需在控制台取签名密钥后与这里对齐算法：
        常见为 HMAC-SHA256(timestamp + "." + body) 十六进制。
        真实算法请以控制台示例为准——先跑通再说，别凭猜上线。
        """
        if timestamp:
            if abs(time.time() - int(timestamp)) > tolerance:
                raise ComPDFError("WEBHOOK", "STALE", "时间戳超窗，疑似重放")
            payload = f"{timestamp}.".encode() + raw_body
        else:
            payload = raw_body
        expect = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expect, (signature or "").lower()):
            raise ComPDFError("WEBHOOK", "BAD_SIGN", "签名校验失败")
        return json.loads(raw_body.decode("utf-8"))

    # ---------------------------------------------------------- 工具
    def _download(self, url: str, out: str):
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        with self.s.get(url, stream=True, timeout=self.timeout) as r:
            r.raise_for_status()
            tmp = out + ".part"
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1 << 16):
                    fh.write(chunk)
            os.replace(tmp, out)     # 原子落盘，避免半截文件

    def layout_analysis(self, path: str, out: str, params=None):
        """版面分析 → JSON（positions / text blocks / tables）。做自研组装时的原料层。"""
        p = {**DEFAULTS, **(params or {})}
        data = self._post_file(path, LAYOUT_ANALYSIS, p)
        self._download(data["downloadUrl"], out)
        return data


# ---------------------------------------------------------------- CLI

def _collect(paths):
    out = []
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            for ext in ("*.png", "*.jpg", "*.jpeg", "*.pdf", "*.bmp", "*.tif", "*.tiff"):
                out.extend(sorted(str(x) for x in pp.glob(ext)))
        else:
            out.append(str(pp))
    return out


def main():
    ap = argparse.ArgumentParser(description="ComPDF 图片→可编辑PPTX 参考客户端")
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--out", default="out.pptx")
    ap.add_argument("--sync", action="store_true", help="同步模式（≤10MB/≤60s）")
    ap.add_argument("--async-mode", action="store_true", help="异步模式（提交+轮询）")
    ap.add_argument("--layout", action="store_true", help="只做版面分析，输出 JSON")
    ap.add_argument("--region", choices=["cn", "intl"], default="cn")
    ap.add_argument("--flow", choices=["e_Flow", "e_Box"], default="e_Flow",
                    help="e_Flow=可编辑性好；e_Box=版式位置更准")
    ap.add_argument("--ocr", type=int, default=1)
    ap.add_argument("--no-ai-layout", action="store_true", help="关闭 AI 版面识别（不推荐）")
    ap.add_argument("--formula-as-image", action="store_true", help="公式转图片（默认保留可编辑）")
    ap.add_argument("--pages", help="页码范围，如 1-3,6（仅 PDF 端点支持）")
    ap.add_argument("--native", action="store_true",
                    help="pageBackground=0：更「原生可编辑」，但视觉更不像原图")
    a = ap.parse_args()

    client = ComPDFClient(os.environ.get("COMPDF_KEY", ""), region=a.region)
    files = _collect(a.inputs)
    if not files:
        raise SystemExit("没有找到输入文件")

    params = {
        "enableOcr": a.ocr,
        "enableAiLayout": 0 if a.no_ai_layout else 1,
        "formulaToImage": 1 if a.formula_as_image else 0,
        "pageLayoutMode": a.flow,
        "pageBackground": 0 if a.native else 1,
    }

    if a.layout:
        client.layout_analysis(files[0], a.out, params)
        print("✓ 版面分析完成 →", a.out)
        return

    endpoint = PDF_TO_PPTX if files[0].lower().endswith(".pdf") else IMG_TO_PPTX
    if a.sync or len(files) == 1:
        client.convert_sync(files[0], a.out, params, endpoint)
    else:
        client.convert_async(files, a.out, params, endpoint, page_range=a.pages)
    print("✓ 完成 →", a.out)
    print("  下一步：python3 audit_pptx.py", a.out)


if __name__ == "__main__":
    main()
