"use client";

// 整套 PPT 工作台 /deck/[id] 根组件。
// 状态机（不看样稿流程，与用户对齐）：大纲编辑 → 内容梳理 → 确认冻结 → 选择风格 → 整套生成 → 导出。
// 规格：anppt-v2-recon/WORKBENCH-UI-SPEC.md（sample/confirm-sample 步骤按产品决策剔除）。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, StarIcon } from "@/components/icons";
import {
  deckIntentAction,
  estimateCredits,
  exportDeckImage,
  renameProject,
  type DeckIntentResult,
  type DeckState,
} from "@/lib/client/deck-api";
import { ApiClientError } from "@/lib/client/api";
import { deriveDeckAvailability, type DeckAvailability } from "@/lib/client/deck-availability";
import type { DeckIntent, DeckIntentKind } from "@/lib/deck-intents";
import { StepPrepare } from "@/components/deck/step-prepare";
import { StepOutline } from "@/components/deck/step-outline";
import { StepStructure } from "@/components/deck/step-structure";
import { StepStyle } from "@/components/deck/step-style";
import { StepGenerate } from "@/components/deck/step-generate";
import { Modal, Spinner, ToastStack, useToasts } from "@/components/deck/ui";
import {
  notifyCreditsRefresh,
  useCreditBalance,
  useDeckState,
} from "@/components/deck/use-deck-state";

export const DECK_STEPS = ["上传内容", "编辑大纲", "内容梳理", "选择风格", "生成页面"] as const;

/** deck.status → 当前步（0-4）。生成中/完成/部分失败都钉在生成画布 */
export function deriveStep(state: DeckState): number {
  switch (state.deck.status) {
    case "parsed":
      return 0;
    case "outlined":
      return 1;
    case "structured":
      return 2;
    case "confirmed":
      return 3;
    case "generating":
    case "generated":
    case "partial":
      return 4;
    default:
      return 0;
  }
}

/** 意图执行器：响应附带字段由 kind 决定（见 DeckIntentResult） */
export type DeckRun = <K extends DeckIntentKind>(
  intent: Extract<DeckIntent, { kind: K }>,
  opts?: { silent?: boolean },
) => Promise<DeckIntentResult<K> | null>;

/** 各步组件共享的操作上下文 */
export interface DeckCtx {
  state: DeckState;
  /** 按钮可用性统一从 deck 状态派生，组件不再各写布尔判断 */
  availability: DeckAvailability;
  run: DeckRun;
  toast: (text: string, opts?: { actionLabel?: string; onAction?: () => void; duration?: number }) => void;
  goStep: (step: number) => void;
}

type ConfirmKind =
  | { kind: "confirm-structure" }
  | { kind: "regen-outline" }
  | { kind: "unlock-structure" }
  | { kind: "generate"; forceRegenerate: boolean };

export function DeckWorkbench({ deckId }: { deckId: string }) {
  const router = useRouter();
  const { state, fatalError, applyState } = useDeckState(deckId);
  const balance = useCreditBalance();
  const { toasts, push: toast, dismiss } = useToasts();

  const [viewStep, setViewStep] = useState<number | null>(null);
  const [busyKind, setBusyKind] = useState<"outline" | "structure" | null>(null);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [insufficient, setInsufficient] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState<{ url: string; pageCount: number } | null>(null);
  const [estimate, setEstimate] = useState<{ credits: number; unitPrice: number; pages: number } | null>(null);
  const outlineRequestedRef = useRef(false);

  const derivedStep = state ? deriveStep(state) : 0;
  const activeStep = viewStep ?? derivedStep;
  const availability = useMemo(
    () => (state ? deriveDeckAvailability(state) : null),
    [state],
  );
  const generating = availability?.generating ?? false;

  const goStep = useCallback(
    (step: number) => {
      setViewStep(step === derivedStep ? null : step);
    },
    [derivedStep],
  );

  // ---------- 统一意图执行：错误归一化（402 → 星星不足弹窗，其余 toast） ----------
  const run = useCallback(
    async <K extends DeckIntentKind,>(
      intent: Extract<DeckIntent, { kind: K }>,
      opts: { silent?: boolean } = {},
    ): Promise<DeckIntentResult<K> | null> => {
      try {
        const result = await deckIntentAction(deckId, intent);
        applyState(result);
        return result;
      } catch (error) {
        const err =
          error instanceof ApiClientError
            ? error
            : new ApiClientError("UNKNOWN", "操作失败，请重新尝试", 0, true);
        if (err.isInsufficientCredits) {
          setInsufficient(err.message || "🌟 星星不足，请充值后继续");
        } else if (!opts.silent) {
          toast(err.message);
        }
        return null;
      }
    },
    [deckId, applyState, toast],
  );

  // ---------- 大纲生成：进入页面时若尚未有大纲则自动触发（同步长请求，等待屏承载） ----------
  const triggerOutline = useCallback(
    async (force: boolean) => {
      setBusyKind("outline");
      setOutlineError(null);
      const result = await run({ kind: "generateOutline", params: force ? { force: true } : {} }, { silent: true });
      setBusyKind(null);
      if (!result) {
        setOutlineError("大纲生成失败，本次失败不扣除星星，可重新尝试。");
      }
    },
    [run],
  );

  useEffect(() => {
    if (!state || outlineRequestedRef.current) return;
    if (state.deck.status === "parsed" && state.slides.length === 0) {
      outlineRequestedRef.current = true;
      let started = false;
      const timer = window.setTimeout(() => {
        started = true;
        void triggerOutline(false);
      }, 0);
      return () => {
        window.clearTimeout(timer);
        if (!started) outlineRequestedRef.current = false;
      };
    }
  }, [state, triggerOutline]);

  // ---------- 项目改名 ----------
  const [savingTitle, setSavingTitle] = useState(false);
  const saveTitle = useCallback(
    async (title: string) => {
      if (!state || !title.trim() || title.trim() === state.deck.title) return;
      setSavingTitle(true);
      try {
        await renameProject(deckId, title.trim());
        applyState({ ...state, deck: { ...state.deck, title: title.trim() } });
      } catch (error) {
        toast(error instanceof ApiClientError ? error.message : "项目名保存失败，请重新尝试");
      } finally {
        setSavingTitle(false);
      }
    },
    [deckId, state, applyState, toast],
  );

  // ---------- 导出图片集 PPT ----------
  const doExport = useCallback(async () => {
    if (!state || exporting) return;
    setExporting(true);
    try {
      const result = await exportDeckImage(deckId);
      const a = document.createElement("a");
      a.href = result.url;
      a.download = `${state.deck.title || "整套PPT"}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setExportDone({ url: result.url, pageCount: result.pageCount });
      notifyCreditsRefresh();
    } catch (error) {
      const err = error instanceof ApiClientError ? error : null;
      if (err?.isInsufficientCredits) setInsufficient(err.message);
      else toast(err?.message ?? "导出失败，请重新尝试");
    } finally {
      setExporting(false);
    }
  }, [state, exporting, deckId, toast]);

  // ---------- 确认弹窗的确认动作 ----------
  const confirmBusy = busyKind !== null;
  const onConfirm = useCallback(async () => {
    if (!confirm || !state) return;
    if (confirm.kind === "confirm-structure") {
      setConfirm(null);
      setBusyKind("structure");
      const result = await run({ kind: "structureSlides", params: {} }, { silent: true });
      setBusyKind(null);
      if (result) {
        const failed = result.failedSlides?.length ?? 0;
        toast(
          failed > 0
            ? `内容梳理完成，${failed} 页失败（失败页重试不扣除星星）`
            : "内容梳理完成",
        );
        goStep(2);
      } else {
        toast("内容梳理失败，本次失败不扣除星星，可重新尝试。");
        goStep(2);
      }
    } else if (confirm.kind === "regen-outline") {
      setConfirm(null);
      await triggerOutline(true);
      setViewStep(1 === derivedStep ? null : 1);
      toast("大纲已重新生成");
    } else if (confirm.kind === "unlock-structure") {
      setConfirm(null);
      const result = await run({ kind: "unlockStructure", params: {} });
      if (result) {
        toast("已解锁，可修改内容；已生成的页面图已作废，需重新生成并重新计费");
      }
    } else if (confirm.kind === "generate") {
      setConfirm(null);
      const result = await run({
        kind: "generateSlides",
        params: confirm.forceRegenerate ? { forceRegenerate: true } : {},
      });
      if (result) {
        notifyCreditsRefresh();
        setViewStep(null); // 钉到生成画布
      }
    }
  }, [confirm, state, run, toast, goStep, triggerOutline, derivedStep]);

  // 打开生成计费弹窗时先拉报价
  const openGenerateConfirm = useCallback(
    (forceRegenerate: boolean) => {
      setEstimate(null);
      if (!state || !availability) return;
      const pages = forceRegenerate ? state.slides.length : availability.pendingGeneration;
      if (!forceRegenerate && pages === 0) {
        toast("所有页面都已生成完毕，无需重复生成。");
        return;
      }
      setConfirm({ kind: "generate", forceRegenerate });
      estimateCredits("deck_page_generate", Math.max(1, pages))
        .then((e) => setEstimate({ credits: e.credits, unitPrice: e.unitPrice, pages: e.pages }))
        .catch(() => setEstimate(null));
    },
    [state, availability, toast],
  );

  const ctx: DeckCtx | null = useMemo(
    () => (state && availability ? { state, availability, run, toast, goStep } : null),
    [state, availability, run, toast, goStep],
  );

  // ---------- 终态错误屏（401/404） ----------
  if (fatalError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-page px-4 text-center">
        <p className="text-lg font-semibold text-ink">
          {fatalError.status === 401 ? "请先登录" : "项目不存在或已删除"}
        </p>
        <p className="mt-2 text-sm text-ink-3">{fatalError.message}</p>
        <div className="mt-6 flex items-center gap-3">
          {fatalError.status === 401 ? (
            <Link
              href={`/login?next=${encodeURIComponent(`/deck/${deckId}`)}`}
              className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              去登录
            </Link>
          ) : (
            <Link
              href="/projects"
              className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              返回我的项目
            </Link>
          )}
          <Link href="/" className="text-sm text-ink-3 transition hover:text-brand">
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  return (
    <section
      className="flex min-h-screen flex-col bg-page"
      aria-label={`${DECK_STEPS[activeStep]}工作区`}
    >
      {/* 顶部条 */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-card px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="返回首页">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/anppt-fish-logo.png" alt="AnPPT" className="h-7 w-auto" />
          <span className="hidden text-[15px] font-semibold text-ink sm:inline">AnPPT</span>
        </Link>
        <span className="text-line-strong">|</span>

        {state ? (
          <EditableTitle
            title={state.deck.title}
            saving={savingTitle}
            onSave={saveTitle}
          />
        ) : (
          <span className="h-5 w-32 animate-pulse rounded bg-page" />
        )}

        <div className="ml-auto flex items-center gap-2.5">
          <Link
            href="/projects"
            className="rounded-full border border-line-strong px-3.5 py-1.5 text-[13px] text-ink-2 transition hover:border-brand-line hover:text-brand"
          >
            我的项目
          </Link>
          <span className="flex items-center overflow-hidden rounded-full border border-brand-line bg-brand-softer text-[13px]">
            <span className="flex items-center gap-1 px-3 py-1.5 text-ink-2">
              <StarIcon width={13} height={13} className="text-brand" />
              🌟 {balance === null ? "--" : balance}
            </span>
            <Link
              href="/recharge"
              className="border-l border-brand-line px-3 py-1.5 font-medium text-brand transition hover:bg-brand-soft"
            >
              充值
            </Link>
          </span>
          <button
            type="button"
            onClick={doExport}
            disabled={exporting || !availability?.canExport}
            title={availability?.canExport ? "导出图片集 PPT（免费）" : "尚无生成完成的页面"}
            className="rounded-full bg-dark px-4 py-1.5 text-[13px] font-medium text-white transition hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exporting ? "导出中…" : "导出"}
          </button>
        </div>
      </header>

      {/* 步骤条 */}
      <nav aria-label="生成流程" className="border-b border-line bg-card px-4 py-3 sm:px-6">
        <ol className="mx-auto flex max-w-3xl items-center">
          {DECK_STEPS.map((label, i) => {
            const done = i < derivedStep;
            const current = i === activeStep;
            const clickable =
              !generating && i > 0 && i <= derivedStep && !confirmBusy && busyKind === null;
            return (
              <li key={label} className="flex min-w-0 flex-1 items-center last:flex-none">
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => goStep(i)}
                  title={
                    i === 0
                      ? "上传内容不可返回"
                      : i > derivedStep
                        ? "完成当前步骤后解锁"
                        : done
                          ? `跳到「${label}」`
                          : undefined
                  }
                  className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[13px] transition ${
                    current
                      ? "bg-brand font-medium text-white"
                      : done
                        ? "text-ink-2 hover:bg-brand-soft hover:text-brand"
                        : "cursor-not-allowed text-ink-4"
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                      current ? "bg-white/25" : done ? "bg-brand-soft text-brand" : "bg-page"
                    }`}
                  >
                    {done ? <CheckIcon width={11} height={11} /> : i + 1}
                  </span>
                  <span className="hidden sm:inline">{label}</span>
                </button>
                {i < DECK_STEPS.length - 1 && (
                  <span className="mx-1 min-w-3 flex-1 border-t border-line-strong sm:mx-2" />
                )}
              </li>
            );
          })}
        </ol>
        <p className="mt-1.5 text-center text-xs text-ink-4 sm:hidden">
          第 {activeStep + 1} 步 / 共 {DECK_STEPS.length} 步 · {DECK_STEPS[activeStep]}
        </p>
      </nav>

      {/* 主区 */}
      <main className="flex min-h-0 flex-1 flex-col">
        {!state ? (
          <div className="flex flex-1 items-center justify-center py-32 text-sm text-ink-3">
            <Spinner className="mr-2 text-[16px]" /> 正在加载项目…
          </div>
        ) : (
          <>
            {activeStep === 0 && (
              <StepPrepare
                state={state}
                busy={busyKind === "outline"}
                error={outlineError ?? (state.deck.error || null)}
                onRetry={() => void triggerOutline(true)}
              />
            )}
            {ctx && activeStep === 1 && (
              <StepOutline
                ctx={ctx}
                busy={busyKind === "outline"}
                onEnterStructure={() => setConfirm({ kind: "confirm-structure" })}
                onRegenOutline={() => setConfirm({ kind: "regen-outline" })}
                onUnlock={() => setConfirm({ kind: "unlock-structure" })}
              />
            )}
            {ctx && activeStep === 2 && (
              <StepStructure
                ctx={ctx}
                structuring={busyKind === "structure"}
                onConfirmFreeze={() => {
                  if (!ctx.availability.structureReady) {
                    toast(`还有 ${ctx.availability.pendingStructure} 页未完成梳理，暂不可确认`);
                    return;
                  }
                  // 冻结：确认后内容锁定，进入选择风格
                  void (async () => {
                    const result = await run({ kind: "confirmStructure", params: {} });
                    if (result) setViewStep(null);
                  })();
                }}
                onUnlock={() => setConfirm({ kind: "unlock-structure" })}
              />
            )}
            {ctx && activeStep === 3 && (
              <StepStyle
                ctx={ctx}
                onGenerate={() => {
                  // 全部页都已成功 → 整套重做（force）；否则只补未完成页，已生成页不重复扣费
                  openGenerateConfirm(ctx.availability.pendingGeneration === 0);
                }}
              />
            )}
            {ctx && activeStep === 4 && (
              <StepGenerate
                ctx={ctx}
                onExport={doExport}
                exporting={exporting}
                onReselectStyle={() => goStep(3)}
              />
            )}
          </>
        )}
      </main>

      {/* 梳理/大纲长请求遮罩 */}
      {busyKind === "structure" && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-page/80 backdrop-blur-sm">
          <div className="flex flex-col items-center rounded-2xl border border-line bg-card px-10 py-8 shadow-pop">
            <Spinner className="text-[28px]" />
            <p className="mt-4 text-sm font-medium text-ink">正在梳理内容…</p>
            <p className="mt-1 text-xs text-ink-3">按页拆分 → 提炼要点 → 校验结构，预计 1–2 分钟</p>
          </div>
        </div>
      )}

      {/* 确认弹窗组 */}
      {confirm?.kind === "confirm-structure" && state && (
        <Modal title="按当前大纲页数开始梳理内容" onClose={() => setConfirm(null)}>
          <p className="text-sm leading-6 text-ink-2">
            大纲页面总计 <b>{state.slides.length}</b> 页，将调用 AI 模型逐页梳理内容结构。
          </p>
          <p className="mt-2 rounded-xl bg-brand-softer px-3 py-2 text-xs leading-5 text-brand">
            内容梳理免费，不消耗 🌟 星星。进入下一步后当前大纲将锁定，如需调整可解锁修改。
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              确认大纲，开始梳理
            </button>
          </div>
        </Modal>
      )}

      {confirm?.kind === "regen-outline" && (
        <Modal title="重新生成大纲" onClose={() => setConfirm(null)}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-ink-2">
            <li>重新生成后，当前大纲及你的修改内容将被覆盖。</li>
            <li>重新生成大纲不消耗 🌟 星星；之后的内容梳理同样免费。</li>
          </ul>
          <p className="mt-3 text-xs text-ink-4">*页面生成阶段才按 10🌟/页 计费</p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              重新生成
            </button>
          </div>
        </Modal>
      )}

      {confirm?.kind === "unlock-structure" && (
        <Modal title="解锁修改内容" onClose={() => setConfirm(null)}>
          <p className="text-sm leading-6 text-ink-2">
            解锁后可修改大纲与梳理内容；<b className="text-danger">已生成的页面图将作废</b>
            ，重新确认后需重新生成并重新计费（10🌟/页）。
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="rounded-full bg-danger px-5 py-2 text-sm font-medium text-white transition hover:opacity-90"
            >
              解锁并作废已生成页
            </button>
          </div>
        </Modal>
      )}

      {confirm?.kind === "generate" && state && (
        <Modal
          title={confirm.forceRegenerate ? "按选中设计风格重新生成整套" : "确认所选风格并生成页面"}
          onClose={() => setConfirm(null)}
        >
          <p className="text-sm leading-6 text-ink-2">
            {confirm.forceRegenerate
              ? `将按当前选中设计风格，重新生成整套 ${state.slides.length} 页（覆盖已有页面图）。`
              : "将使用选中的设计风格，调用 AI 模型生成页面；已完成的页面不重复生成、不重复扣费。"}
          </p>
          <div className="mt-3 rounded-xl bg-page px-4 py-3 text-sm text-ink-2">
            {estimate ? (
              <>
                生成页面 <b>{estimate.pages}</b> 页 × {estimate.unitPrice}🌟 ={" "}
                <b className="text-brand">{estimate.credits} 🌟</b>
              </>
            ) : (
              "正在获取本次生成报价…"
            )}
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-3">
            开始生成则星星冻结{confirm.forceRegenerate ? "，无法终止" : ""}
            ，按成功页数结算，失败自动退还。
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              {confirm.forceRegenerate ? "确认风格重新生成" : "确认并生成页面"}
            </button>
          </div>
        </Modal>
      )}

      {/* 星星不足 */}
      {insufficient !== null && (
        <Modal title="🌟 星星不足" onClose={() => setInsufficient(null)}>
          <p className="text-sm leading-6 text-ink-2">{insufficient}</p>
          <p className="mt-2 text-xs text-ink-3">充值后可继续当前操作，已完成的页面不受影响。</p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setInsufficient(null)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => router.push("/recharge")}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              前往充值
            </button>
          </div>
        </Modal>
      )}

      {/* 导出完成 */}
      {exportDone && (
        <Modal title="下载图片集PPT" onClose={() => setExportDone(null)}>
          <p className="text-sm leading-6 text-ink-2">
            已将 {exportDone.pageCount} 页图片拼成图片集 PPT 版本（不可编辑修改），文件已开始下载。
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              新建项目
            </button>
            <button
              type="button"
              onClick={() => router.push("/projects")}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              查看项目
            </button>
          </div>
        </Modal>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}

/** 项目名：点击进入编辑，失焦/Enter 保存（PATCH /api/projects/{id}） */
function EditableTitle({
  title,
  saving,
  onSave,
}: {
  title: string;
  saving: boolean;
  onSave: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  if (!editing) {
    return (
      <button
        type="button"
        title="点击编辑项目名称"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        className="min-w-0 max-w-72 truncate rounded-lg px-2 py-1 text-left text-sm font-medium text-ink transition hover:bg-page"
      >
        {title || "未命名项目"}
        {saving && <span className="ml-2 text-xs text-ink-4">保存中…</span>}
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setEditing(false);
        }
      }}
      className="w-56 rounded-lg border border-brand-line bg-card px-2 py-1 text-sm text-ink outline-none"
      aria-label="项目名称"
    />
  );
}
