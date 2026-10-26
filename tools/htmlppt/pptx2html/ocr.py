#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ocr.py —— macOS Vision OCR（可选能力）

用途：判断一张图是不是"文字截图"（这类图应当被重建为可编辑文本，而不是当照片保留）。
不可用时返回 None，调用方自动降级。
"""
from __future__ import annotations

import io


def available() -> bool:
    try:
        import Vision  # noqa: F401
        from Foundation import NSData  # noqa: F401
        return True
    except Exception:
        return False


def ocr_png_bytes(png_bytes: bytes, langs=("zh-Hans", "en-US")) -> str | None:
    """返回识别出的文本（按行拼空格），失败返回 None。"""
    try:
        import Vision
        from Foundation import NSData
    except Exception:
        return None
    try:
        data = NSData.dataWithBytes_length_(png_bytes, len(png_bytes))
        handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLanguages_(list(langs))
        req.setRecognitionLevel_(0)  # accurate
        handler.performRequests_error_([req], None)
        lines = []
        for r in (req.results() or []):
            cands = r.topCandidates_(1)
            if cands:
                lines.append(cands[0].string())
        return " ".join(lines).strip()
    except Exception:
        return None
