"use client";

// Step 4 生成页面画布（WORKBENCH-UI-SPEC §8/§9，剔除样稿与可编辑转换）。
// 网格逐页卡 + 状态/重试 + 放大预览 + ✦ 优化本页浮窗（版本历史可回退）+ 图片集导出。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, WandIcon } from "@/components/icons";
import {
  estimateCredits,
  getExportRecord,
  startEditableExport,
  type DeckSlide,
} from "@/lib/client/deck-api";
import { ApiClientError } from "@/lib/client/api";
import type { DeckCtx } from "@/components/deck/deck-workbench";
import { DownloadIcon, Modal, RefreshIcon, Spinner, WarnIcon } from "@/components/deck/ui";
import { notifyCreditsRefresh } from "@/components/deck/use-deck-state";

const GEN_LABEL: Record<string, string> = {
  idle: "待生成",
  queued: "生成中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  stale: "已作废",
};

function genChipClass(status: string): string {
  switch (status) {
    case "succeeded":
      return "bg-emerald-50 text-emerald-600";
    case "failed":
      return "bg-danger-soft text-danger";
    case "queued":
    case "running":
      return "bg-brand-soft text-brand";
    case "stale":
      return "bg-page text-ink-4 line-through";
    default:
      return "bg-page text-ink-3";
  }
}

/** 当前应展示的图：activeVersion 优先，其次最新成功版本 */
export function slideImageUrl(slide: DeckSlide): string | null {
  const active = slide.versions.find((v) => v.versionId === slide.activeVersionId);
  if (active?.imageUrl) return active.imageUrl;
  const latestOk = [...slide.versions]
    .filter((v) => v.status === "succeeded" && v.imageUrl)
    .sort((a, b) => b.versionNo - a.versionNo)[0];
  return latestOk?.imageUrl ?? null;
}

export function StepGenerate({
  ctx,
  onExport,
  exporting,
  onReselectStyle,
}: {
  ctx: DeckCtx;
  onExport: () => void;
  exporting: boolean;
  onReselectStyle: () => void;
}) {
  const { state, run, toast } = ctx;
  const slides = useMemo(
    () => [...state.slides].sort((a, b) => a.pageIndex - b.pageIndex),
    [state.slides],
  );
  const { pageSummary, activeJob } = state;
  const generating = state.deck.status === "generating" || activeJob !== null;

  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [refineTarget, setRefineTarget] = useState<DeckSlide | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // ---------- 转可编辑 PPTX（Codia 链，20🌟/页） ----------
  const [editableOpen, setEditableOpen] = useState(false);
  const [editableBusy, setEditableBusy] = useState(false);
  const [editableUnit, setEditableUnit] = useState(20);
  const editableTimerRef = useRef<number | null>(null);
  const allGenerated = state.deck.status === "generated";
  const editableTotal = slides.length * editableUnit;

  useEffect(() => {
    estimateCredits("export_editable", 1)
      .then((e) => setEditableUnit(e.unitPrice))
      .catch(() => {});
  }, []);

  useEffect(
    () => () => {
      if (editableTimerRef.current !== null) window.clearInterval(editableTimerRef.current);
    },
    [],
  );

  const pollEditable = (exportId: string) => {
    if (editableTimerRef.current !== null) window.clearInterval(editableTimerRef.current);
    editableTimerRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const rec = await getExportRecord(exportId);
          if (rec.status === "succeeded") {
            if (editableTimerRef.current !== null) window.clearInterval(editableTimerRef.current);
            editableTimerRef.current = null;
            setEditableBusy(false);
            const a = document.createElement("a");
            a.href = rec.url;
            a.download = `${state.deck.title || "整套PPT"}-可编辑.pptx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            toast("可编辑 PPTX 转换完成，已开始下载；可在下载中心随时再次下载", { duration: 8000 });
          } else if (rec.status === "failed") {
            if (editableTimerRef.current !== null) window.clearInterval(editableTimerRef.current);
            editableTimerRef.current = null;
            setEditableBusy(false);
            toast(rec.error || "可编辑转换失败，星星已退回", { duration: 8000 });
            notifyCreditsRefresh();
          }
        } catch {
          // 网络抖动：继续轮询
        }
      })();
    }, 4000);
  };

  const submitEditable = async () => {
    if (editableBusy) return;
    setEditableBusy(true);
    try {
      const started = await startEditableExport(state.deck.id);
      setEditableOpen(false);
      notifyCreditsRefresh();
      pollEditable(started.exportId);
    } catch (error) {
      setEditableBusy(false);
      const err = error instanceof ApiClientError ? error : null;
      toast(err?.message ?? "发起可编辑转换失败，请重新尝试");
    }
  };

  const retrySlide = async (slide: DeckSlide) => {
    if (retryingId) return;
    setRetryingId(slide.slideId);
    const result = await run("generate-slide", { slideId: slide.slideId });
    setRetryingId(null);
    if (result) notifyCreditsRefresh();
    else toast("本页生成失败，本次失败不扣除星星，可单页重试。");
  };

  const retryFailed = async () => {
    const result = await run("retry-failed");
    if (result) notifyCreditsRefresh();
  };

  // 预览键盘导航
  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPreviewIndex((i) => (i === null ? i : Math.max(0, i - 1)));
      if (e.key === "ArrowRight")
        setPreviewIndex((i) => (i === null ? i : Math.min(slides.length - 1, i + 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewIndex, slides.length]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pb-28 pt-6 sm:px-6">
      {/* 顶部 banner */}
      {pageSummary.failed > 0 && !generating && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-danger/20 bg-danger-soft px-4 py-3" role="alert">
          <p className="text-sm text-ink-2">
            整套生成已结束：{pageSummary.failed} 页失败。失败页不影响其他页面，可在画布中单页重试，重试不扣星星。
          </p>
          <button
            type="button"
            onClick={() => void retryFailed()}
            className="shrink-0 rounded-full bg-danger px-4 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
          >
            重试失败页
          </button>
        </div>
      )}
      {state.deck.error && (
        <div className="mb-4 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          {state.deck.error}
        </div>
      )}

      {slides.length === 0 ? (
        <div className="mt-20 text-center">
          <p className="text-base font-semibold text-ink">暂无可生成的页面</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-3">
            这套 PPT 目前没有可生成的页面。请返回内容梳理补充页面，或重新选择风格后再生成整套。
          </p>
          <button
            type="button"
            onClick={onReselectStyle}
            className="mt-6 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            重新选择风格
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">
              生成画布
              <span className="ml-2 text-sm font-normal text-ink-3">
                {generating
                  ? `正在生成 ${pageSummary.succeeded} / ${pageSummary.total} 页`
                  : `已完成 ${pageSummary.succeeded} / ${pageSummary.total} 页`}
                {pageSummary.failed > 0 && <span className="text-danger"> · 失败 {pageSummary.failed}</span>}
              </span>
            </h2>
            <p className="hidden text-xs text-ink-4 sm:block">
              缩略总览 · 点击任意页面进入大图查看与优化
            </p>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {slides.map((slide) => {
              const imageUrl = slideImageUrl(slide);
              const running =
                slide.genStatus === "running" || slide.genStatus === "queued" || retryingId === slide.slideId;
              return (
                <article
                  key={slide.slideId}
                  className="overflow-hidden rounded-2xl border border-line bg-card shadow-card"
                >
                  {/* 缩略区 */}
                  <button
                    type="button"
                    disabled={slide.genStatus !== "succeeded" || !imageUrl}
                    title={slide.genStatus === "succeeded" ? "点击放大查看" : undefined}
                    onClick={() => setPreviewIndex(slide.pageIndex)}
                    className="relative block aspect-[16/9] w-full bg-page text-left disabled:cursor-default"
                  >
                    {imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={imageUrl}
                        alt={`第 ${slide.pageIndex + 1} 页生成图`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full items-center justify-center bg-gradient-to-br from-brand-softer to-page text-xs text-ink-4">
                        P{slide.pageIndex + 1} · {slide.title || "待生成"}
                      </span>
                    )}
                    {running && (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card/70 text-xs text-ink-2">
                        <Spinner className="text-[20px]" />
                        正在生成本页设计...
                      </span>
                    )}
                    {slide.genStatus === "failed" && (
                      <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-danger text-white">
                        <WarnIcon width={14} height={14} />
                      </span>
                    )}
                  </button>

                  {/* 信息行 */}
                  <div className="flex items-center gap-2 px-3.5 py-2.5">
                    <span className="shrink-0 text-xs font-medium text-ink-4">
                      P{slide.pageIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                      {slide.title || "（未命名页面）"}
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${genChipClass(slide.genStatus)}`}>
                      {running && <Spinner className="mr-1 text-[9px]" />}
                      {GEN_LABEL[slide.genStatus]}
                    </span>
                  </div>

                  {/* 失败/操作行 */}
                  {(slide.genStatus === "failed" || slide.genStatus === "succeeded") && (
                    <div className="flex items-center gap-2 border-t border-line px-3.5 py-2">
                      {slide.genStatus === "failed" && (
                        <>
                          <span
                            className="min-w-0 flex-1 truncate text-xs text-danger"
                            title={slide.genError}
                          >
                            {slide.genError || "生成服务超时或返回异常。本次失败不扣除星星。"}
                          </span>
                          <button
                            type="button"
                            disabled={running}
                            onClick={() => void retrySlide(slide)}
                            className="flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-3 py-1 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-40"
                          >
                            <RefreshIcon /> 重新生成本页
                          </button>
                        </>
                      )}
                      {slide.genStatus === "succeeded" && (
                        <button
                          type="button"
                          onClick={() => setRefineTarget(slide)}
                          className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-brand-soft px-3 py-1 text-xs font-medium text-brand transition hover:bg-brand-line"
                        >
                          <WandIcon width={12} height={12} /> 优化本页
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}

      {/* 底部动作条 */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="text-sm text-ink-3">
            {generating
              ? `正在生成 ${pageSummary.succeeded} / ${pageSummary.total} 页，可稍后返回`
              : `已完成 ${pageSummary.succeeded} / ${pageSummary.total} 页`}
            {pageSummary.failed > 0 && <span className="text-danger"> · 失败 {pageSummary.failed}</span>}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={onReselectStyle}
              disabled={generating}
              className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line disabled:opacity-40"
            >
              重新选择风格
            </button>
            {pageSummary.failed > 0 && !generating && (
              <button
                type="button"
                onClick={() => void retryFailed()}
                className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line"
              >
                重试失败页
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditableOpen(true)}
              disabled={!allGenerated || generating || editableBusy}
              title={
                allGenerated
                  ? "把整套页面图转成元素级可编辑 PPTX"
                  : "还有页面未生成成功，完成整套生成后可转可编辑"
              }
              className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editableBusy ? (
                <>
                  <Spinner className="mr-1 text-[11px]" /> 转换中…
                </>
              ) : (
                `转可编辑 PPTX · ${editableTotal}🌟`
              )}
            </button>
            <button
              type="button"
              onClick={onExport}
              disabled={exporting || pageSummary.succeeded === 0}
              title={pageSummary.succeeded === 0 ? "尚无生成完成的页面" : "导出图片集 PPT（免费）"}
              className="flex items-center gap-1.5 rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              <DownloadIcon />
              {exporting ? "导出中…" : "下载图片集 PPT"}
            </button>
          </div>
        </div>
      </div>

      {/* 单页放大预览 */}
      {previewIndex !== null && slides[previewIndex] && (
        <SlidePreview
          slides={slides}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onNav={setPreviewIndex}
        />
      )}

      {/* 优化本页浮窗 */}
      {refineTarget && (
        <RefineDialog
          slide={refineTarget}
          ctx={ctx}
          onClose={() => setRefineTarget(null)}
        />
      )}

      {/* 转可编辑 PPTX 确认弹窗 */}
      {editableOpen && (
        <Modal title="转可编辑 PPTX" ariaLabel="转可编辑 PPTX" onClose={() => setEditableOpen(false)}>
          <p className="text-sm leading-6 text-ink-2">
            将把整套 <b>{slides.length}</b> 页页面图转换为元素级可编辑的 PPTX
            （文字、图形、表格均可在 PowerPoint / WPS 中直接修改），预计需要几分钟。
          </p>
          <div className="mt-3 rounded-xl bg-page px-4 py-3 text-sm text-ink-2">
            {editableUnit}🌟/页 × {slides.length} 页 ={" "}
            <b className="text-brand">{editableTotal} 🌟</b>
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-3">
            转换失败自动退还星星。完成后自动开始下载，也可在侧边栏「下载中心」随时再次下载。
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setEditableOpen(false)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              disabled={editableBusy}
              onClick={() => void submitEditable()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editableBusy ? "提交中…" : "确认转换"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- 单页放大预览 ---------------- */

function SlidePreview({
  slides,
  index,
  onClose,
  onNav,
}: {
  slides: DeckSlide[];
  index: number;
  onClose: () => void;
  onNav: (index: number) => void;
}) {
  const slide = slides[index];
  const imageUrl = slideImageUrl(slide);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-ink/80"
      role="dialog"
      aria-modal="true"
      aria-label="单页放大预览"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-5 py-3 text-white">
        <p className="text-sm font-medium">
          P{slide.pageIndex + 1} · {slide.title || "（未命名页面）"}
        </p>
        <button
          type="button"
          aria-label="关闭"
          className="rounded-full p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <CloseIcon width={18} height={18} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-16" onClick={onClose}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={`第 ${slide.pageIndex + 1} 页大图`}
            className="max-h-full max-w-full rounded-lg object-contain shadow-pop"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-sm text-white/70">该页暂无可显示的图片</span>
        )}
      </div>
      <div className="flex items-center justify-center gap-6 pb-6 text-white">
        <button
          type="button"
          disabled={index === 0}
          onClick={(e) => {
            e.stopPropagation();
            onNav(index - 1);
          }}
          className="flex items-center gap-1 rounded-full border border-white/25 px-4 py-1.5 text-sm transition hover:bg-white/10 disabled:opacity-30"
        >
          <ChevronLeftIcon width={14} height={14} /> 上一页
        </button>
        <span className="text-sm text-white/80">
          P{slide.pageIndex + 1} · 第 {index + 1} / {slides.length} 页
        </span>
        <button
          type="button"
          disabled={index === slides.length - 1}
          onClick={(e) => {
            e.stopPropagation();
            onNav(index + 1);
          }}
          className="flex items-center gap-1 rounded-full border border-white/25 px-4 py-1.5 text-sm transition hover:bg-white/10 disabled:opacity-30"
        >
          下一页 <ChevronRightIcon width={14} height={14} />
        </button>
      </div>
    </div>
  );
}

/* ---------------- ✦ 优化本页浮窗（对话改图 + 版本历史） ---------------- */

function RefineDialog({
  slide,
  ctx,
  onClose,
}: {
  slide: DeckSlide;
  ctx: DeckCtx;
  onClose: () => void;
}) {
  const { run, toast } = ctx;
  const [instruction, setInstruction] = useState("");
  const [quote, setQuote] = useState<{ credits: number } | null>(null);
  const [quoteState, setQuoteState] = useState<"loading" | "ok" | "error">("loading");
  const [submitting, setSubmitting] = useState(false);
  const [selectingVersion, setSelectingVersion] = useState<string | null>(null);

  // 报价：优化单页 = deck_page_generate × 1
  useEffect(() => {
    let cancelled = false;
    setQuoteState("loading");
    estimateCredits("deck_page_generate", 1)
      .then((e) => {
        if (!cancelled) {
          setQuote({ credits: e.credits });
          setQuoteState("ok");
        }
      })
      .catch(() => {
        if (!cancelled) setQuoteState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    const text = instruction.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    const result = await run("refine-slide", { slideId: slide.slideId, editInstruction: text });
    setSubmitting(false);
    if (result) {
      notifyCreditsRefresh();
      toast("已开始重新设计本页，完成后自动更新");
      onClose();
    } else {
      toast("单页优化失败，本次失败不扣除星星，可重新尝试。");
    }
  };

  const selectVersion = async (versionId: string) => {
    if (selectingVersion) return;
    setSelectingVersion(versionId);
    const result = await run("select-slide-version", { slideId: slide.slideId, versionId });
    setSelectingVersion(null);
    if (!result) {
      toast("切换版本失败：当前后端尚未支持版本回退（select-slide-version），请稍后再试。");
    }
  };

  // 最新状态（可能已被轮询刷新）
  const current = ctx.state.slides.find((s) => s.slideId === slide.slideId) ?? slide;
  const versions = [...current.versions].sort((a, b) => b.versionNo - a.versionNo);
  const refining = current.genStatus === "running" || current.genStatus === "queued";

  return (
    <Modal title={`优化本页 P${current.pageIndex + 1}`} ariaLabel="优化本页" width="max-w-xl" onClose={onClose}>
      {refining ? (
        <div className="flex flex-col items-center py-8 text-center">
          <Spinner className="text-[24px]" />
          <p className="mt-4 text-sm font-medium text-ink">正在重新设计本页...</p>
          <p className="mt-1 text-xs text-ink-3">根据你的二次修改要求重新调用 AI 模型设计，预计需要 1–3 分钟</p>
        </div>
      ) : (
        <>
          <textarea
            rows={5}
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="输入你想让AI修改的方向，请尽可能全面详细描述，例如：标题更突出，配色变成红色，图表区域放大1.2倍..."
            className="w-full resize-y rounded-xl border border-line bg-card px-3 py-2.5 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
          />

          <div className="mt-3 rounded-xl bg-page px-4 py-2.5 text-xs leading-5 text-ink-2" aria-live="polite">
            {quoteState === "loading" && "正在获取本次优化报价…"}
            {quoteState === "ok" && quote && (
              <>优化会再次调用 AI 模型，此页重新消耗 {quote.credits}🌟</>
            )}
            {quoteState === "error" && "获取报价失败，仍可尝试提交；失败不扣除星星。"}
          </div>

          <div className="mt-4 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!instruction.trim() || submitting || quoteState === "loading"}
              title={quoteState === "loading" ? "报价未就绪，无法确认" : undefined}
              onClick={() => void submit()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "提交中…" : "确认优化"}
            </button>
          </div>
        </>
      )}

      {/* 本页版本历史（当前选中版本将参与导出） */}
      <div className="mt-5 border-t border-line pt-4">
        <p className="text-xs font-medium text-ink-3">本页版本 · 当前选中版本将参与导出</p>
        {versions.length === 0 ? (
          <p className="mt-2 text-xs text-ink-4">本页暂无可切换的版本</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {versions.map((v) => {
              const active = v.versionId === current.activeVersionId;
              return (
                <li
                  key={v.versionId}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                    active ? "border-brand bg-brand-softer" : "border-line"
                  }`}
                >
                  <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-page text-[10px] text-ink-4">
                    {v.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.imageUrl} alt={`版本 ${v.versionNo}`} className="h-full w-full object-cover" />
                    ) : v.status === "failed" ? (
                      "失败"
                    ) : (
                      "生成中"
                    )}
                  </span>
                  <span className="text-xs text-ink-2">
                    版本 {v.versionNo}
                    {v.kind === "refine" && " · 优化"}
                    <span className="ml-1.5 text-ink-4">
                      {new Date(v.createdAt).toLocaleString("zh-CN")}
                    </span>
                  </span>
                  <span className="ml-auto">
                    {active ? (
                      <span className="text-xs font-medium text-brand">当前使用</span>
                    ) : (
                      v.status === "succeeded" && (
                        <button
                          type="button"
                          disabled={selectingVersion !== null}
                          onClick={() => void selectVersion(v.versionId)}
                          className="rounded-full border border-line-strong px-3 py-1 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-40"
                        >
                          {selectingVersion === v.versionId ? "切换中…" : "使用此版本"}
                        </button>
                      )
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
