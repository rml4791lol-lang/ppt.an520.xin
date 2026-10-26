"use client";

import Link from "next/link";
import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, DownloadIcon, FileIcon, UploadIcon } from "@/components/icons";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { estimateCredits, getFeatureFlags } from "@/lib/client/deck-api";
import type JSZip from "jszip";
import { buildBaseJson, type SceneModel } from "./pptx-model";
import { parsePptx, type ParsedDeck } from "./pptx-parse";
import { makeZipImageLoader, renderSceneToCanvas, type ImageLoader } from "./pptx-render";
import { screenshotToBasePng } from "./image-prepare";

type Gate = "loading" | "closed" | "ready";

interface BaseResult {
  title: string;
  imageUrl: string;
  balance: number;
}

interface LoadedDeck {
  zip: JSZip;
  deck: ParsedDeck;
  loader: ImageLoader;
  name: string;
}

function baseName(fileName: string): string {
  return fileName.replace(/\.pptx?$/i, "") || "slide";
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function PptToBaseClient() {
  const shotInputRef = useRef<HTMLInputElement>(null);
  const pptxInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gate, setGate] = useState<Gate>("loading");

  // 主流程：截图 → AI 通用化底图
  const [shotPreview, setShotPreview] = useState("");
  const [shotFile, setShotFile] = useState<File | null>(null);
  const [quote, setQuote] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BaseResult | null>(null);
  const [error, setError] = useState("");
  const [draggingShot, setDraggingShot] = useState(false);

  // 次级流程：pptx 源文件本地转换（免费，保风格只去字）
  const [loaded, setLoaded] = useState<LoadedDeck | null>(null);
  const [selected, setSelected] = useState(0);
  const [showSlots, setShowSlots] = useState(true);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [pptxBusy, setPptxBusy] = useState(false);
  const [pptxError, setPptxError] = useState("");
  const [draggingPptx, setDraggingPptx] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then((features) => {
        if (!cancelled) setGate(features.flags.ppt_to_base ? "ready" : "closed");
      })
      .catch(() => {
        if (!cancelled) setGate("closed");
      });
    estimateCredits("ppt_to_base")
      .then((e) => {
        if (!cancelled) setQuote(e.credits);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const scene: SceneModel | null = loaded ? loaded.deck.slides[selected] ?? null : null;

  useEffect(() => {
    if (!loaded || !scene || !canvasRef.current) return;
    let cancelled = false;
    renderSceneToCanvas(scene, loaded.loader, { showSlots })
      .then((canvas) => {
        if (cancelled || !canvasRef.current) return;
        canvasRef.current.width = canvas.width;
        canvasRef.current.height = canvas.height;
        canvasRef.current.getContext("2d")?.drawImage(canvas, 0, 0);
      })
      .catch(() => {
        if (!cancelled) setPptxError("渲染失败，请换一页或重传文件");
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, scene, showSlots]);

  // 多页缩略图条：后台逐页渲染，不打断主预览（thumbs 已在 onPptxFile 里随新文件清空）
  useEffect(() => {
    if (!loaded || loaded.deck.slides.length <= 1) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < loaded.deck.slides.length; i += 1) {
        try {
          const canvas = await renderSceneToCanvas(loaded.deck.slides[i], loaded.loader);
          if (cancelled) return;
          const thumb = document.createElement("canvas");
          thumb.width = 192;
          thumb.height = 108;
          thumb.getContext("2d")?.drawImage(canvas, 0, 0, 192, 108);
          const url = thumb.toDataURL("image/png");
          setThumbs((prev) => ({ ...prev, [i]: url }));
        } catch {
          // 单页缩略图失败不影响其余页
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  const onShotFile = useCallback(async (file: File) => {
    setError("");
    setResult(null);
    try {
      const png = await screenshotToBasePng(file);
      setShotFile(png);
      setShotPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(png);
      });
    } catch (err) {
      setShotFile(null);
      setShotPreview("");
      setError(err instanceof Error ? err.message : "图片读取失败");
    }
  }, []);

  const submitShot = async () => {
    if (!shotFile || running) return;
    setRunning(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", shotFile);
      form.set("requestId", crypto.randomUUID());
      const data = await apiFetch<BaseResult>("/api/tools/ppt-to-base", { formData: form });
      setResult(data);
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthorized) {
        setError("请先登录后再使用");
      } else if (err instanceof ApiClientError && err.isInsufficientCredits) {
        setError("🌟 星星不足，请充值后重试");
      } else {
        setError(err instanceof Error ? err.message : "生成失败，请重试");
      }
    } finally {
      setRunning(false);
    }
  };

  const downloadResult = async () => {
    if (!result) return;
    const res = await fetch(result.imageUrl, { credentials: "include" });
    if (!res.ok) {
      setError("读取底图失败，请重试");
      return;
    }
    downloadBlob(await res.blob(), `${result.title || "通用模版"}-底座.png`);
  };

  const resetShot = () => {
    setShotFile(null);
    setShotPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    setResult(null);
    setError("");
  };

  const onPptxFile = useCallback(async (file: File) => {
    setPptxError("");
    if (!/\.pptx$/i.test(file.name)) {
      setPptxError("请上传 .pptx 文件（老格式 .ppt 请先用 PowerPoint/WPS 另存为 .pptx）");
      return;
    }
    setPptxBusy(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const deck = await parsePptx(zip);
      setThumbs({});
      setLoaded({ zip, deck, loader: makeZipImageLoader(zip), name: baseName(file.name) });
      setSelected(0);
    } catch (err) {
      setLoaded(null);
      setPptxError(err instanceof Error ? err.message : "PPTX 解析失败");
    } finally {
      setPptxBusy(false);
    }
  }, []);

  const downloadPptxPng = async () => {
    if (!loaded || !scene) return;
    setPptxBusy(true);
    try {
      const canvas = await renderSceneToCanvas(scene, loaded.loader); // 导出不含叠加层
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片编码失败"))), "image/png");
      });
      downloadBlob(blob, `${loaded.name}-p${selected + 1}-base.png`);
    } catch (err) {
      setPptxError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setPptxBusy(false);
    }
  };

  const downloadPptxJson = () => {
    if (!loaded || !scene) return;
    const json = buildBaseJson(scene, `${loaded.name}.pptx`);
    downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), `${loaded.name}-p${selected + 1}-base.json`);
  };

  if (gate === "loading") {
    return <p className="py-20 text-center text-sm text-ink-3">正在检查功能开放状态…</p>;
  }
  if (gate === "closed") {
    return <p className="py-20 text-center text-sm text-ink-3">功能不存在或尚未开放</p>;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-0">
      <div className="text-center">
        <span className="inline-flex rounded-full bg-brand-soft px-3 py-1 text-xs font-medium text-brand">
          AI 通用化 · {quote !== null ? `${quote}🌟/张` : "按张计星"}
        </span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink sm:text-4xl">PPT 转模版底座</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-ink-3">
          上传一张 PPT 截图，AI 把版式原样保留、风格去成中性浅色、图上文字全部换成「标题/正文/要点/图片」这类位置角色词，
          产出可直接灌内容换风格的通用模版底图，并提取原标题文字。
        </p>
      </div>

      {/* 主流程：截图上传 */}
      <div
        className={`mt-9 flex cursor-pointer flex-col items-center justify-center rounded-[28px] border-2 border-dashed px-6 py-10 text-center transition ${
          draggingShot ? "border-brand bg-brand-soft" : "border-line bg-card hover:border-brand"
        }`}
        onClick={() => shotInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDraggingShot(true);
        }}
        onDragLeave={() => setDraggingShot(false)}
        onDrop={(e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          setDraggingShot(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void onShotFile(file);
        }}
      >
        <UploadIcon className="h-8 w-8 text-ink-4" />
        <p className="mt-3 text-sm text-ink-2">点击或拖拽上传 PPT 截图（PNG / JPG / WebP，最大 10MB）</p>
        <p className="mt-2 text-xs leading-5 text-ink-4">上传后会在本地整理成 1536×864 白底再提交；文件只用于本次生成</p>
        <input
          ref={shotInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) void onShotFile(file);
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
          {error.includes("登录") && (
            <Link href="/login" className="ml-2 underline">
              去登录
            </Link>
          )}
          {error.includes("充值") && (
            <Link href="/recharge" className="ml-2 underline">
              去充值
            </Link>
          )}
        </p>
      )}

      {shotPreview && !result && (
        <div className="mt-4 rounded-[28px] border border-line bg-card p-5 shadow-card sm:p-6">
          <p className="mb-3 text-sm text-ink-2">待转换截图（已整理为 1536×864）</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shotPreview} alt="待转换截图" className="w-full rounded-lg border border-line" />
          <div className="mt-4 flex items-center justify-end gap-3">
            <button type="button" onClick={resetShot} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:border-brand">
              换一张
            </button>
            <button
              type="button"
              onClick={submitShot}
              disabled={running}
              className="rounded-lg bg-brand px-4 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              {running ? "正在通用化（约半分钟）…" : `生成通用底图${quote !== null ? `（${quote}🌟）` : ""}`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-[28px] border border-line bg-card p-5 shadow-card sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-2">
              提取到标题：<span className="font-semibold text-ink">{result.title || "（未识别到标题）"}</span>
            </p>
            <div className="flex items-center gap-3">
              {result.title && (
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(result.title)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:border-brand"
                >
                  复制标题
                </button>
              )}
              <button
                type="button"
                onClick={downloadResult}
                className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:opacity-90"
              >
                <DownloadIcon className="h-4 w-4" /> 下载底图 PNG
              </button>
              <button type="button" onClick={resetShot} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:border-brand">
                再来一张
              </button>
            </div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={result.imageUrl} alt="通用模版底图" className="mt-4 w-full rounded-lg border border-line" />
          <p className="mt-3 flex items-center gap-2 text-xs text-ink-4">
            <CheckIcon className="h-4 w-4 text-emerald-600" />
            底图上的「标题/正文/要点/图片/数据」都是位置占位词，生成新 PPT 时直接替换成你的内容并套用新风格即可。
          </p>
        </div>
      )}

      {/* 次级流程：pptx 源文件本地转换 */}
      <details className="mt-10 rounded-[28px] border border-line bg-card p-5 shadow-card sm:p-6">
        <summary className="cursor-pointer text-sm font-medium text-ink-2">
          有 .pptx 源文件？本地免费转换（保留原风格、仅去除文字，附带槽位 JSON）
        </summary>

        <div
          className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition ${
            draggingPptx ? "border-brand bg-brand-soft" : "border-line hover:border-brand"
          }`}
          onClick={() => pptxInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDraggingPptx(true);
          }}
          onDragLeave={() => setDraggingPptx(false)}
          onDrop={(e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            setDraggingPptx(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void onPptxFile(file);
          }}
        >
          <UploadIcon className="h-7 w-7 text-ink-4" />
          <p className="mt-2 text-sm text-ink-2">{pptxBusy ? "正在解析渲染…" : "点击或拖拽上传 .pptx（一次最多 40 页）"}</p>
          <p className="mt-1 text-xs leading-5 text-ink-4">
            纯浏览器本地解析，不上传不扣星；表格/图表/SmartArt 不渲染，未识别图形按矩形近似
          </p>
          <input
            ref={pptxInputRef}
            type="file"
            accept=".pptx"
            className="sr-only"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const file = e.target.files?.[0];
              if (file) void onPptxFile(file);
              e.target.value = "";
            }}
          />
        </div>

        {pptxError && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{pptxError}</p>}

        {loaded && (
          <p className="mt-4 flex items-center gap-2 text-sm text-ink-2">
            <FileIcon className="h-4 w-4 text-ink-4" />
            {loaded.name}.pptx · {loaded.deck.slides.length} 页
          </p>
        )}

        {loaded && loaded.deck.slides.length > 1 && (
          <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
            {loaded.deck.slides.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelected(i)}
                className={`shrink-0 overflow-hidden rounded-lg border-2 transition ${
                  i === selected ? "border-brand" : "border-transparent hover:border-brand"
                }`}
              >
                {thumbs[i] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbs[i]} alt={`第 ${i + 1} 页`} className="block h-[72px] w-[128px] object-cover" />
                ) : (
                  <span className="flex h-[72px] w-[128px] items-center justify-center bg-card text-xs text-ink-4">第 {i + 1} 页</span>
                )}
              </button>
            ))}
          </div>
        )}

        {scene && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-2">
                第 {selected + 1} 页 · 槽位 {scene.slots.length} 个
                {scene.skippedFrames > 0 && <span className="text-amber-600">（{scene.skippedFrames} 个表格/图表元素未渲染）</span>}
              </p>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={showSlots} onChange={(e) => setShowSlots(e.target.checked)} />
                  预览槽位标注
                </label>
                <button
                  type="button"
                  onClick={downloadPptxJson}
                  className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:border-brand"
                >
                  <DownloadIcon className="h-4 w-4" /> 槽位 JSON
                </button>
                <button
                  type="button"
                  onClick={downloadPptxPng}
                  disabled={pptxBusy}
                  className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
                >
                  <DownloadIcon className="h-4 w-4" /> 下载底座 PNG
                </button>
              </div>
            </div>
            <canvas ref={canvasRef} className="mt-4 w-full rounded-lg border border-line" />
          </div>
        )}
      </details>
    </div>
  );
}
