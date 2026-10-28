"use client";

// Step 4 生成页面画布（WORKBENCH-UI-SPEC §8/§9，剔除样稿与可编辑转换）。
// 网格逐页卡 + 状态/重试 + 单页编辑器（大图 + 指令微调 + 重生成 + 版本切换 + 下载原图）+ 图片集导出。
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, WandIcon } from "@/components/icons";
import {
  estimateCredits,
  getFeatureFlags,
  startEditableExport,
  startTextEditableExport,
  type DeckSlide,
} from "@/lib/client/deck-api";
import { ApiClientError } from "@/lib/client/api";
import { STYLE_PACKS } from "@/data/style-packs";
import { useGatedStylePacks } from "@/components/use-gated-style-packs";
import type { DeckCtx } from "@/components/deck/deck-workbench";
import { DownloadIcon, Modal, RefreshIcon, Spinner, WarnIcon } from "@/components/deck/ui";
import { notifyCreditsRefresh } from "@/components/deck/use-deck-state";
import { useEditableExport } from "@/modules/editable-export/client/use-editable-export";

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
  const { state, availability, run, toast } = ctx;
  const slides = useMemo(
    () => [...state.slides].sort((a, b) => a.pageIndex - b.pageIndex),
    [state.slides],
  );
  const { pageSummary } = state;
  const { generating } = availability;

  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // ---------- 转可编辑 PPTX（WPS 免费优先 / Image2PPT / Codia 备用，20🌟/页） ----------
  const [editableOpen, setEditableOpen] = useState(false);
  const [editableForce, setEditableForce] = useState(false);
  const [editableUnit, setEditableUnit] = useState(20);
  const allGenerated = availability.allGenerated;
  const editableTotal = slides.length * editableUnit;
  const startEditableRequest = useCallback(
    (force: boolean) => startEditableExport(state.deck.id, force),
    [state.deck.id],
  );
  const editable = useEditableExport({
    refType: "deck",
    refId: state.deck.id,
    title: state.deck.title || "整套PPT",
    startRequest: startEditableRequest,
    toast,
    onCreditsChanged: notifyCreditsRefresh,
  });

  useEffect(() => {
    estimateCredits("export_editable", 1)
      .then((e) => setEditableUnit(e.unitPrice))
      .catch(() => {});
  }, []);

  // ---------- 轻量文字可编辑导出（editable_text_overlay 开关功能，beta） ----------
  const [textExportVisible, setTextExportVisible] = useState(false);
  const [textEditableOpen, setTextEditableOpen] = useState(false);
  const [textEditableForce, setTextEditableForce] = useState(false);
  const [textEditableUnit, setTextEditableUnit] = useState(5);
  const startTextEditableRequest = useCallback(
    (force: boolean) => startTextEditableExport(state.deck.id, force),
    [state.deck.id],
  );
  const textEditable = useEditableExport({
    refType: "deck",
    refId: state.deck.id,
    title: state.deck.title || "整套PPT",
    startRequest: startTextEditableRequest,
    toast,
    onCreditsChanged: notifyCreditsRefresh,
    kind: "editable_text",
  });
  const textEditableTotal = slides.length * textEditableUnit;

  useEffect(() => {
    getFeatureFlags()
      .then(({ flags }) => setTextExportVisible(flags.editable_text_overlay === true))
      .catch(() => {});
    estimateCredits("export_editable_text", 1)
      .then((e) => setTextEditableUnit(e.unitPrice))
      .catch(() => {});
  }, []);

  const submitTextEditable = async () => {
    if (textEditable.submitting) return;
    try {
      const started = await textEditable.start(textEditableForce);
      if (started) setTextEditableOpen(false);
    } catch (error) {
      const err = error instanceof ApiClientError ? error : null;
      toast(err?.message ?? "发起文字可编辑转换失败，请重新尝试");
    }
  };

  const submitEditable = async () => {
    if (editable.submitting) return;
    try {
      const started = await editable.start(editableForce);
      if (started) setEditableOpen(false);
    } catch (error) {
      const err = error instanceof ApiClientError ? error : null;
      toast(err?.message ?? "发起可编辑转换失败，请重新尝试");
    }
  };

  const retrySlide = async (slide: DeckSlide) => {
    if (retryingId) return;
    setRetryingId(slide.slideId);
    const result = await run({ kind: "generateSlide", params: { slideId: slide.slideId } });
    setRetryingId(null);
    if (result) notifyCreditsRefresh();
  };

  const retryFailed = async () => {
    const result = await run({ kind: "retryFailedSlides", params: {} });
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
      {pageSummary.failed > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3" role="alert">
          <p className="text-sm text-ink-2">
            {generating
              ? `其余页面仍在生成中：已有 ${pageSummary.failed} 页失败（该次费用已自动退回），本轮结束后可一键重试失败页。`
              : `整套生成已结束：${pageSummary.failed} 页失败。失败页不影响其他页面；失败的星星已退回，重试会重新计费，再次失败仍会退回。`}
          </p>
          {availability.canRetryFailed && (
            <button
              type="button"
              onClick={() => void retryFailed()}
              className="shrink-0 rounded-full bg-danger px-4 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
            >
              重试失败页
            </button>
          )}
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
                            disabled={running || generating}
                            title={generating ? "整套生成进行中，结束后可重试本页" : undefined}
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
                          disabled={generating}
                          title={generating ? "整套生成进行中，结束后可优化本页" : "打开单页编辑器（微调/重生成/版本）"}
                          onClick={() => setPreviewIndex(slide.pageIndex)}
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
          <span className="min-w-0 text-sm text-ink-3">
            <span className="block">
              {generating
                ? `正在生成 ${pageSummary.succeeded} / ${pageSummary.total} 页，可稍后返回`
                : `已完成 ${pageSummary.succeeded} / ${pageSummary.total} 页`}
              {pageSummary.failed > 0 && <span className="text-danger"> · 失败 {pageSummary.failed}</span>}
            </span>
            {editable.running && (
              <span className="mt-0.5 block truncate text-xs text-brand" role="status">
                {editable.progressLabel} · {editable.waitingCopy}
              </span>
            )}
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
            {availability.canRetryFailed && (
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
              onClick={() => {
                if (editable.succeeded) editable.download();
                else {
                  setEditableForce(false);
                  setEditableOpen(true);
                }
              }}
              disabled={!allGenerated || generating || editable.running || editable.submitting}
              title={
                allGenerated
                  ? editable.succeeded
                    ? "下载最近一次可编辑 PPTX（不重复扣星）"
                    : "把整套页面图转成元素级可编辑 PPTX"
                  : "还有页面未生成成功，完成整套生成后可转可编辑"
              }
              className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editable.running || editable.submitting ? (
                <>
                  <Spinner className="mr-1 text-[11px]" /> {editable.progressLabel || "转换中…"}
                </>
              ) : editable.succeeded ? (
                "下载可编辑版"
              ) : (
                `转可编辑 PPTX · ${editableTotal}🌟`
              )}
            </button>
            {editable.succeeded && !generating && (
              <button
                type="button"
                onClick={() => {
                  setEditableForce(true);
                  setEditableOpen(true);
                }}
                className="hidden text-xs text-ink-4 underline decoration-dotted underline-offset-4 transition hover:text-brand sm:inline"
              >
                重新转换
              </button>
            )}
            {textExportVisible && (
              <button
                type="button"
                onClick={() => {
                  if (textEditable.succeeded) textEditable.download();
                  else {
                    setTextEditableForce(false);
                    setTextEditableOpen(true);
                  }
                }}
                disabled={!allGenerated || generating || textEditable.running || textEditable.submitting}
                title={
                  allGenerated
                    ? textEditable.succeeded
                      ? "下载最近一次文字可编辑 PPTX（不重复扣星）"
                      : "提取每页文字为可编辑文本框（轻量测试版）"
                    : "还有页面未生成成功，完成整套生成后可转文字可编辑"
                }
                className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line disabled:cursor-not-allowed disabled:opacity-40"
              >
                {textEditable.running || textEditable.submitting ? (
                  <>
                    <Spinner className="mr-1 text-[11px]" /> {textEditable.progressLabel || "转换中…"}
                  </>
                ) : textEditable.succeeded ? (
                  "下载文字可编辑版"
                ) : (
                  `转文字可编辑 · ${textEditableTotal}🌟`
                )}
              </button>
            )}
            {textExportVisible && textEditable.succeeded && !generating && (
              <button
                type="button"
                onClick={() => {
                  setTextEditableForce(true);
                  setTextEditableOpen(true);
                }}
                className="hidden text-xs text-ink-4 underline decoration-dotted underline-offset-4 transition hover:text-brand sm:inline"
              >
                重新转换
              </button>
            )}
            <button
              type="button"
              onClick={onExport}
              disabled={exporting || !availability.canExport}
              title={availability.canExport ? "导出图片集 PPT（免费）" : "尚无生成完成的页面"}
              className="flex items-center gap-1.5 rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              <DownloadIcon />
              {exporting ? "导出中…" : "下载图片集 PPT"}
            </button>
          </div>
        </div>
      </div>

      {/* 单页编辑器（大图 + 微调/重生成/版本/下载）；key 按页重挂载，切页自动清空输入态 */}
      {previewIndex !== null && slides[previewIndex] && (
        <SlideEditor
          key={slides[previewIndex].slideId}
          slides={slides}
          index={previewIndex}
          ctx={ctx}
          onClose={() => setPreviewIndex(null)}
          onNav={setPreviewIndex}
        />
      )}

      {/* 轻量文字可编辑 PPTX 确认弹窗（beta 开关功能） */}
      {textEditableOpen && (
        <Modal
          title={textEditableForce ? "重新转换文字可编辑 PPTX" : "转文字可编辑 PPTX"}
          ariaLabel={textEditableForce ? "重新转换文字可编辑 PPTX" : "转文字可编辑 PPTX"}
          onClose={() => setTextEditableOpen(false)}
        >
          <p className="text-sm leading-6 text-ink-2">
            将提取整套 <b>{slides.length}</b> 页的文字为可编辑文本框，覆盖在原图对应位置（文字区域用近似底色块遮盖原文字），可直接在 PowerPoint / WPS 中改字。
          </p>
          <div className="mt-3 rounded-xl bg-page px-4 py-3 text-sm text-ink-2">
            {textEditableUnit}🌟/页 × {slides.length} 页 ={" "}
            <b className="text-brand">{textEditableTotal} 🌟</b>
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-3">
            测试版说明：图形、照片等元素不可编辑，复杂背景上的文字遮盖可能留有痕迹；需要元素级可编辑时请用「转可编辑 PPTX」。
            {textEditableForce
              ? "这会创建一份新的转换结果并再次扣星；原文件仍保留在下载中心。"
              : "提交后可以安全刷新或离开；完成后会出现在侧边栏「下载中心」，转换失败自动退还星星。"}
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setTextEditableOpen(false)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              disabled={textEditable.submitting}
              onClick={() => void submitTextEditable()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {textEditable.submitting ? "提交中…" : textEditableForce ? "确认重新转换" : "确认转换"}
            </button>
          </div>
        </Modal>
      )}

      {/* 转可编辑 PPTX 确认弹窗 */}
      {editableOpen && (
        <Modal
          title={editableForce ? "重新转换可编辑 PPTX" : "转可编辑 PPTX"}
          ariaLabel={editableForce ? "重新转换可编辑 PPTX" : "转可编辑 PPTX"}
          onClose={() => setEditableOpen(false)}
        >
          <p className="text-sm leading-6 text-ink-2">
            将把整套 <b>{slides.length}</b> 页页面图转换为元素级可编辑的 PPTX
            （文字、图形、表格均可在 PowerPoint / WPS 中直接修改）。
          </p>
          <div className="mt-3 rounded-xl bg-page px-4 py-3 text-sm text-ink-2">
            {editableUnit}🌟/页 × {slides.length} 页 ={" "}
            <b className="text-brand">{editableTotal} 🌟</b>
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-3">
            WPS 免费通道仅在服务端已授权配置时启用并优先，失败自动回退 Image2PPT / Codia。
            WPS 通道受登录态与限时免费额度影响，实际以生成文件为准。
          </p>
          <p className="mt-2 text-xs leading-5 text-ink-3">
            {editableForce
              ? "这会创建一份新的转换结果并再次扣星；原文件仍保留在下载中心。"
              : "提交后可以安全刷新或离开；完成后会出现在侧边栏「下载中心」，转换失败自动退还星星。"}
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
              disabled={editable.submitting}
              onClick={() => void submitEditable()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editable.submitting ? "提交中…" : editableForce ? "确认重新转换" : "确认转换"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- 单页编辑器（大图 + 指令微调 + 重生成 + 版本切换 + 下载原图） ---------------- */

function SlideEditor({
  slides,
  index,
  ctx,
  onClose,
  onNav,
}: {
  slides: DeckSlide[];
  index: number;
  ctx: DeckCtx;
  onClose: () => void;
  onNav: (index: number) => void;
}) {
  const { run, toast } = ctx;
  // 轮询会刷新 ctx.state，编辑器内始终读实时页数据
  const live = ctx.state.slides.find((s) => s.slideId === slides[index]?.slideId);
  const slide = live ?? slides[index];
  const imageUrl = slideImageUrl(slide);
  const running = slide.genStatus === "running" || slide.genStatus === "queued";

  const [instruction, setInstruction] = useState("");
  const [refineCredits, setRefineCredits] = useState<number | null>(null);
  const [regenCredits, setRegenCredits] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [selectingVersion, setSelectingVersion] = useState<string | null>(null);

  // 报价：微调 = deck_page_refine（图生图），重生成 = deck_page_generate
  useEffect(() => {
    let cancelled = false;
    estimateCredits("deck_page_refine", 1)
      .then((e) => {
        if (!cancelled) setRefineCredits(e.credits);
      })
      .catch(() => {});
    estimateCredits("deck_page_generate", 1)
      .then((e) => {
        if (!cancelled) setRegenCredits(e.credits);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 键盘：ESC 退出；←/→ 切页（输入框聚焦时不劫持按键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      if (e.key === "ArrowLeft") onNav(Math.max(0, index - 1));
      if (e.key === "ArrowRight") onNav(Math.min(slides.length - 1, index + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, slides.length, onClose, onNav]);

  // 重生成二段确认 4 秒后自动复位
  useEffect(() => {
    if (!confirmRegen) return;
    const timer = setTimeout(() => setConfirmRegen(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRegen]);

  // ---------- 图片级编辑工具（开关板逐件显示：高精清除/图上改字/模板融合/设为参考图） ----------
  const [toolFlags, setToolFlags] = useState<Record<string, boolean>>({});
  const [eraseMode, setEraseMode] = useState(false);
  const [eraseStage, setEraseStage] = useState<{ w: number; h: number } | null>(null);
  const [hasMarks, setHasMarks] = useState(false);
  const [textEdit, setTextEdit] = useState("");
  const [fusionPackId, setFusionPackId] = useState("");
  const imageAreaRef = useRef<HTMLDivElement | null>(null);
  const eraseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const gatedPacks = useGatedStylePacks();
  const fusionPacks = useMemo(
    () =>
      [...STYLE_PACKS, ...gatedPacks].filter(
        (p) => p.kind === "template" && p.id !== ctx.state.deck.stylePackId,
      ),
    [gatedPacks, ctx.state.deck.stylePackId],
  );
  const anchorSlideId = ctx.state.deck.anchorSlideId || "";
  const isAnchor = anchorSlideId === slide.slideId;
  const anchorSlide = anchorSlideId
    ? ctx.state.slides.find((s) => s.slideId === anchorSlideId) ?? null
    : null;

  useEffect(() => {
    getFeatureFlags()
      .then(({ flags }) => setToolFlags(flags))
      .catch(() => {});
  }, []);

  // 涂抹舞台：按容器量出 16:9 可视区；canvas 内部坐标恒为 1536x864（与后端约定一致）
  useEffect(() => {
    if (!eraseMode) return;
    const update = () => {
      const box = imageAreaRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;
      const scale = Math.min(box.width / 1536, box.height / 864);
      setEraseStage({ w: Math.max(1, Math.round(1536 * scale)), h: Math.max(1, Math.round(864 * scale)) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [eraseMode]);

  const paintAt = (e: ReactPointerEvent<HTMLCanvasElement>, start: boolean) => {
    const canvas = eraseCanvasRef.current;
    const ctx2d = canvas?.getContext("2d");
    if (!canvas || !ctx2d) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    ctx2d.strokeStyle = "rgba(255, 0, 0, 0.5)";
    ctx2d.fillStyle = "rgba(255, 0, 0, 0.5)";
    ctx2d.lineWidth = canvas.width * 0.035;
    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
    if (start) {
      ctx2d.beginPath();
      ctx2d.arc(x, y, ctx2d.lineWidth / 2, 0, Math.PI * 2);
      ctx2d.fill();
    } else {
      const last = lastPointRef.current;
      if (!last) return;
      ctx2d.beginPath();
      ctx2d.moveTo(last.x, last.y);
      ctx2d.lineTo(x, y);
      ctx2d.stroke();
    }
    lastPointRef.current = { x, y };
    if (!hasMarks) setHasMarks(true);
  };

  const exitEraseMode = () => {
    setEraseMode(false);
    setHasMarks(false);
    drawingRef.current = false;
    lastPointRef.current = null;
  };

  const submitErase = async () => {
    const canvas = eraseCanvasRef.current;
    if (!canvas || !hasMarks || submitting || running) return;
    const markImageDataUrl = canvas.toDataURL("image/png");
    setSubmitting(true);
    const result = await run({
      kind: "eraseSlide",
      params: { slideId: slide.slideId, markImageDataUrl },
    });
    setSubmitting(false);
    if (result) {
      notifyCreditsRefresh();
      exitEraseMode();
      toast("已开始高精清除，完成后自动更新");
    } else {
      toast("高精清除提交失败，本次未扣除星星，可重新尝试。");
    }
  };

  const submitTextEdit = async () => {
    const text = textEdit.trim();
    if (!text || submitting || running) return;
    setSubmitting(true);
    const result = await run({
      kind: "editSlideText",
      params: { slideId: slide.slideId, editInstruction: text },
    });
    setSubmitting(false);
    if (result) {
      notifyCreditsRefresh();
      setTextEdit("");
      toast("已开始图上改字，完成后自动更新");
    } else {
      toast("图上改字提交失败，本次未扣除星星，可重新尝试。");
    }
  };

  const submitFusion = async () => {
    if (!fusionPackId || submitting || running) return;
    setSubmitting(true);
    const result = await run({
      kind: "fuseSlide",
      params: { slideId: slide.slideId, fusionPackId },
    });
    setSubmitting(false);
    if (result) {
      notifyCreditsRefresh();
      setFusionPackId("");
      toast("已开始模板融合，完成后自动更新");
    } else {
      toast("模板融合提交失败，本次未扣除星星，可重新尝试。");
    }
  };

  const toggleReference = async () => {
    if (submitting || running) return;
    setSubmitting(true);
    const result = await run({
      kind: "setReferenceImage",
      params: { slideId: isAnchor ? null : slide.slideId },
    });
    setSubmitting(false);
    if (result) {
      toast(isAnchor ? "已取消全套参考图" : "已设为全套参考图，后续生成与改图将优先对齐本页风格");
    } else {
      toast("参考图设置失败，请重试。");
    }
  };

  const submitRefine = async () => {
    const text = instruction.trim();
    if (!text || submitting || running) return;
    setSubmitting(true);
    const result = await run({
      kind: "refineSlide",
      params: { slideId: slide.slideId, editInstruction: text },
    });
    setSubmitting(false);
    if (result) {
      notifyCreditsRefresh();
      setInstruction("");
      toast("已开始微调本页，完成后自动更新");
    } else {
      toast("微调提交失败，本次未扣除星星，可重新尝试。");
    }
  };

  const submitRegen = async () => {
    if (submitting || running) return;
    if (!confirmRegen) {
      setConfirmRegen(true);
      return;
    }
    setConfirmRegen(false);
    setSubmitting(true);
    const result = await run({ kind: "generateSlide", params: { slideId: slide.slideId } });
    setSubmitting(false);
    if (result) {
      notifyCreditsRefresh();
      toast("已开始重新生成本页，完成后自动更新");
    } else {
      toast("重新生成提交失败，请重试。");
    }
  };

  const selectVersion = async (versionId: string) => {
    if (selectingVersion || running) return;
    setSelectingVersion(versionId);
    const result = await run({
      kind: "commitVersion",
      params: { slideId: slide.slideId, versionId },
    });
    setSelectingVersion(null);
    if (!result) toast("切换版本失败，请重试。");
  };

  const versions = [...slide.versions].sort((a, b) => b.versionNo - a.versionNo);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-ink/80"
      role="dialog"
      aria-modal="true"
      aria-label={`单页编辑器 P${slide.pageIndex + 1}`}
      onClick={onClose}
    >
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-5 py-3 text-white">
        <p className="text-sm font-medium">
          P{slide.pageIndex + 1} · {slide.title || "（未命名页面）"}
          <span className="ml-3 hidden text-xs font-normal text-white/50 sm:inline">ESC 退出 · ←/→ 切页</span>
        </p>
        <button
          type="button"
          aria-label="退出编辑器"
          className="rounded-full p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <CloseIcon width={18} height={18} />
        </button>
      </div>

      {/* 主区：大图 + 操作面板 */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row" onClick={onClose}>
        <div
          ref={imageAreaRef}
          className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4 lg:px-8"
          onClick={onClose}
        >
          {imageUrl ? (
            eraseMode && eraseStage ? (
              // 涂抹模式：canvas 与大图同尺寸叠放，导出 1536x864 红色半透明涂抹层 PNG
              <div
                className="relative"
                style={{ width: eraseStage.w, height: eraseStage.h }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt={`第 ${slide.pageIndex + 1} 页大图`}
                  className="block h-full w-full rounded-lg object-fill shadow-pop"
                  draggable={false}
                />
                <canvas
                  ref={eraseCanvasRef}
                  width={1536}
                  height={864}
                  className="absolute inset-0 h-full w-full cursor-crosshair rounded-lg touch-none"
                  onPointerDown={(e) => {
                    drawingRef.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    paintAt(e, true);
                  }}
                  onPointerMove={(e) => {
                    if (drawingRef.current) paintAt(e, false);
                  }}
                  onPointerUp={() => {
                    drawingRef.current = false;
                    lastPointRef.current = null;
                  }}
                  onPointerLeave={() => {
                    drawingRef.current = false;
                    lastPointRef.current = null;
                  }}
                />
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={`第 ${slide.pageIndex + 1} 页大图`}
                className="max-h-full max-w-full rounded-lg object-contain shadow-pop"
                onClick={(e) => e.stopPropagation()}
              />
            )
          ) : (
            <span className="text-sm text-white/70">该页暂无可显示的图片</span>
          )}
          {running && (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink/50 text-xs text-white">
              <Spinner className="text-[22px]" />
              正在重新设计本页…
            </span>
          )}
        </div>

        <aside
          className="w-full shrink-0 overflow-y-auto rounded-t-2xl bg-card px-4 py-4 lg:my-4 lg:mr-4 lg:w-80 lg:rounded-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 指令微调 */}
          <p className="text-xs font-medium text-ink-3">指令微调（保持版式与风格，按描述改图）</p>
          <textarea
            rows={3}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="例如：标题更突出、配色换成红色系、图表区域放大一点…"
            className="mt-2 w-full resize-y rounded-xl border border-line bg-card px-3 py-2 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
          />
          <button
            type="button"
            disabled={!instruction.trim() || submitting || running || refineCredits === null}
            onClick={() => void submitRefine()}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            <WandIcon width={13} height={13} />
            {submitting ? "提交中…" : `微调本页 · ${refineCredits ?? "…"}🌟`}
          </button>

          {/* 重生成 + 下载原图 */}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={submitting || running || regenCredits === null}
              onClick={() => void submitRegen()}
              title="丢弃当前图，按本页内容重新生成一张"
              className={`flex flex-1 items-center justify-center gap-1 rounded-full px-3 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                confirmRegen
                  ? "bg-danger text-white"
                  : "border border-line-strong text-ink-2 hover:border-brand-line"
              }`}
            >
              <RefreshIcon />
              {confirmRegen ? `确认消耗 ${regenCredits}🌟 重生成` : `重新生成 · ${regenCredits ?? "…"}🌟`}
            </button>
            {imageUrl && (
              <a
                href={imageUrl}
                download={`P${slide.pageIndex + 1}-${slide.title || "页面"}.png`}
                className="flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-3 py-2 text-xs text-ink-2 transition hover:border-brand-line"
              >
                <DownloadIcon /> 下载原图
              </a>
            )}
          </div>

          {/* 图片级编辑工具（开关板逐件显示；erase/改字/融合按微调价 deck_page_refine 扣费） */}
          {(toolFlags.magic_erase || toolFlags.image_text_edit || toolFlags.template_fusion || toolFlags.set_as_reference) && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs font-medium text-ink-3">图片级编辑工具</p>

              {toolFlags.magic_erase && (
                <div className="mt-3">
                  {eraseMode ? (
                    <>
                      <p className="text-xs leading-5 text-ink-3">在大图上涂抹要擦除的内容（红色区域），然后点确认。</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={!hasMarks || submitting || running || refineCredits === null}
                          onClick={() => void submitErase()}
                          className="flex flex-1 items-center justify-center gap-1 rounded-full bg-brand px-3 py-2 text-xs font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {submitting ? "提交中…" : `确认擦除 · ${refineCredits ?? "…"}🌟`}
                        </button>
                        <button
                          type="button"
                          onClick={exitEraseMode}
                          className="shrink-0 rounded-full border border-line-strong px-3 py-2 text-xs text-ink-2 transition hover:border-brand-line"
                        >
                          取消涂抹
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={submitting || running || !imageUrl}
                      onClick={() => setEraseMode(true)}
                      title="涂抹标记要擦除的元素，AI 移除后用周围底色自然填充"
                      className="flex w-full items-center justify-center gap-1 rounded-full border border-line-strong px-3 py-2 text-xs text-ink-2 transition hover:border-brand-line disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      高精清除 · 涂抹擦除区域
                    </button>
                  )}
                </div>
              )}

              {toolFlags.image_text_edit && (
                <div className="mt-3">
                  <input
                    value={textEdit}
                    onChange={(e) => setTextEdit(e.target.value)}
                    placeholder="图上改字，例如：把标题改成「2025 年度报告」"
                    className="w-full rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
                  />
                  <button
                    type="button"
                    disabled={!textEdit.trim() || submitting || running || refineCredits === null}
                    onClick={() => void submitTextEdit()}
                    className="mt-2 flex w-full items-center justify-center gap-1 rounded-full border border-line-strong px-3 py-2 text-xs text-ink-2 transition hover:border-brand-line disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    图上改字 · {refineCredits ?? "…"}🌟
                  </button>
                </div>
              )}

              {toolFlags.template_fusion && (
                <div className="mt-3">
                  <select
                    value={fusionPackId}
                    onChange={(e) => setFusionPackId(e.target.value)}
                    className="w-full rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink outline-none transition focus:border-brand-line"
                  >
                    <option value="">选择要融合的模板风格…</option>
                    {fusionPacks.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!fusionPackId || submitting || running || refineCredits === null}
                    onClick={() => void submitFusion()}
                    title="保留本页版式骨架与文字，视觉风格向所选模板靠拢"
                    className="mt-2 flex w-full items-center justify-center gap-1 rounded-full border border-line-strong px-3 py-2 text-xs text-ink-2 transition hover:border-brand-line disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    模板融合 · {refineCredits ?? "…"}🌟
                  </button>
                </div>
              )}

              {toolFlags.set_as_reference && (
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={submitting || running || (!isAnchor && !imageUrl)}
                    onClick={() => void toggleReference()}
                    title="把本页设为全套风格锚点：后续生成/改图优先对齐本页（免费）"
                    className={`flex w-full items-center justify-center gap-1 rounded-full px-3 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      isAnchor
                        ? "bg-brand-soft text-brand hover:bg-brand-line"
                        : "border border-line-strong text-ink-2 hover:border-brand-line"
                    }`}
                  >
                    {isAnchor ? "本页是全套参考图 · 点击取消" : "设为全套参考图 · 免费"}
                  </button>
                  {anchorSlide && !isAnchor && (
                    <p className="mt-1.5 text-[11px] leading-4 text-ink-4">
                      当前参考图：第 {anchorSlide.pageIndex + 1} 页
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 版本切换（选中的版本参与导出） */}
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-xs font-medium text-ink-3">本页版本 · 选中的版本参与导出</p>
            {versions.length === 0 ? (
              <p className="mt-2 text-xs text-ink-4">本页暂无可切换的版本</p>
            ) : (
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                {versions.map((v) => {
                  const active = v.versionId === slide.activeVersionId;
                  return (
                    <button
                      key={v.versionId}
                      type="button"
                      disabled={v.status !== "succeeded" || active || selectingVersion !== null || running}
                      onClick={() => void selectVersion(v.versionId)}
                      title={active ? "当前使用" : `切换到版本 ${v.versionNo}`}
                      className={`shrink-0 overflow-hidden rounded-lg border text-left transition disabled:cursor-default ${
                        active ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-brand-line"
                      }`}
                    >
                      <span className="flex h-14 w-24 items-center justify-center bg-page text-[10px] text-ink-4">
                        {v.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={v.imageUrl} alt={`版本 ${v.versionNo}`} className="h-full w-full object-cover" />
                        ) : v.status === "failed" ? (
                          "失败"
                        ) : (
                          "生成中"
                        )}
                      </span>
                      <span className="block px-1.5 py-1 text-[10px] text-ink-3">
                        v{v.versionNo}
                        {v.kind === "refine" && " · 优化"}
                        {active && <span className="ml-1 font-medium text-brand">使用中</span>}
                        {selectingVersion === v.versionId && " …"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* 底部切页 */}
      <div className="flex items-center justify-center gap-6 pb-5 text-white" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          disabled={index === 0}
          onClick={() => onNav(index - 1)}
          className="flex items-center gap-1 rounded-full border border-white/25 px-4 py-1.5 text-sm transition hover:bg-white/10 disabled:opacity-30"
        >
          <ChevronLeftIcon width={14} height={14} /> 上一页
        </button>
        <span className="text-sm text-white/80">第 {index + 1} / {slides.length} 页</span>
        <button
          type="button"
          disabled={index === slides.length - 1}
          onClick={() => onNav(index + 1)}
          className="flex items-center gap-1 rounded-full border border-white/25 px-4 py-1.5 text-sm transition hover:bg-white/10 disabled:opacity-30"
        >
          下一页 <ChevronRightIcon width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
