"use client";

// Step 2 内容梳理（WORKBENCH-UI-SPEC §5）：逐页 tagged DSL 结构化预览 + 状态 + 失败重试 + 冻结确认。
// DSL 渲染用 src/lib/client/dsl.ts 的轻解析器；编辑模块弹窗本期不做（阶段 D 任务未要求）。
import { useMemo, useState } from "react";
import type { DeckSlide } from "@/lib/client/deck-api";
import type { DeckCtx } from "@/components/deck/deck-workbench";
import { groupDsl, isTableDividerRow, parseDsl, tableRowCells, type DslBlock } from "@/lib/client/dsl";
import { Spinner } from "@/components/deck/ui";

const STATUS_LABEL: Record<string, string> = {
  pending: "待梳理",
  running: "梳理中",
  ok: "AI 已完成梳理",
  failed: "梳理失败",
};

function statusChipClass(status: string): string {
  switch (status) {
    case "ok":
      return "bg-emerald-50 text-emerald-600";
    case "failed":
      return "bg-danger-soft text-danger";
    case "running":
      return "bg-brand-soft text-brand";
    default:
      return "bg-page text-ink-3";
  }
}

/** 上游技术错误转用户可读文案；未识别的保留原文（多为 DSL 校验提示，本身面向用户） */
function friendlyStructureError(raw?: string): string {
  const s = String(raw || "");
  if (/402|balance|余额/i.test(s)) return "AI 服务额度暂时不可用，请稍后重试";
  if (/timeout|超时|aborted/i.test(s)) return "AI 处理超时，请稍后重试";
  if (/HTTP \d+|upstream|ECONN|fetch failed/i.test(s))
    return "AI 服务暂时不可用，请稍后重试";
  return s || "处理失败，请重试";
}

export function StepStructure({
  ctx,
  structuring,
  onConfirmFreeze,
  onUnlock,
}: {
  ctx: DeckCtx;
  structuring: boolean;
  onConfirmFreeze: () => void;
  onUnlock: () => void;
}) {
  const { state, run, toast } = ctx;
  const slides = useMemo(
    () => [...state.slides].sort((a, b) => a.pageIndex - b.pageIndex),
    [state.slides],
  );
  const readOnly = state.contentLocked;
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const done = slides.filter((s) => s.structureStatus === "ok").length;
  const failed = slides.filter((s) => s.structureStatus === "failed").length;
  const runningLocal = pendingIds.size;

  const structureOne = async (slide: DeckSlide) => {
    if (pendingIds.has(slide.slideId) || readOnly) return;
    setPendingIds((prev) => new Set(prev).add(slide.slideId));
    const result = await run("structure-slide", { slideId: slide.slideId }, { silent: true });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(slide.slideId);
      return next;
    });
    if (!result) {
      toast("本页梳理失败，本次失败不扣除星星，可重新尝试。");
    }
  };

  const retryFailed = async () => {
    const failedSlides = slides.filter((s) => s.structureStatus === "failed");
    for (const slide of failedSlides) {
      await structureOne(slide);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-28 pt-6 sm:px-6">
      {readOnly && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-brand-line bg-brand-softer px-4 py-3">
          <p className="text-sm text-ink-2">内容已确认冻结，当前为只读。如需调整请先解锁。</p>
          <button
            type="button"
            onClick={onUnlock}
            className="shrink-0 rounded-full border border-brand-line bg-card px-4 py-1.5 text-xs font-medium text-brand transition hover:bg-brand-soft"
          >
            解锁修改
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">
          内容梳理
          <span className="ml-2 text-sm font-normal text-ink-3">
            完成 {done} / {slides.length}
            {failed > 0 && <span className="text-danger"> · 失败 {failed}</span>}
          </span>
        </h2>
        {!readOnly && slides.some((s) => s.structureStatus !== "ok") && (
          <button
            type="button"
            disabled={structuring || runningLocal > 0}
            onClick={() => {
              const targets = slides.filter((s) => s.structureStatus !== "ok");
              void (async () => {
                for (const slide of targets) await structureOne(slide);
              })();
            }}
            className="rounded-full border border-line-strong px-4 py-1.5 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-40"
          >
            梳理全部待处理页
          </button>
        )}
      </div>

      <p className="mt-2 text-xs leading-5 text-ink-4">
        AI 不会添加原文中没有的事实、结论或建议；重复、空泛或弱相关信息可能不再呈现。失败页重试不扣除星星。
      </p>

      <div className="mt-5 space-y-4">
        {slides.map((slide) => {
          const isRunning = structuring || pendingIds.has(slide.slideId);
          const status = isRunning ? "running" : slide.structureStatus;
          return (
            <article
              key={slide.slideId}
              className="rounded-2xl border border-line bg-card shadow-card"
            >
              <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
                <span className="text-xs font-medium text-ink-4">P{slide.pageIndex + 1}</span>
                <span className="rounded-md bg-page px-2 py-0.5 text-[11px] text-ink-2">
                  {slide.chapter || "未分章"}
                </span>
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                  {slide.title || "（未命名页面）"}
                </h3>
                <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${statusChipClass(status)}`}>
                  {status === "running" && <Spinner className="text-[10px]" />}
                  {STATUS_LABEL[status]}
                </span>
                {!readOnly && (
                  <span className="flex items-center gap-2">
                    {slide.structureStatus === "pending" && (
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => void structureOne(slide)}
                        className="rounded-full bg-brand px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
                      >
                        开始梳理本页
                      </button>
                    )}
                    {slide.structureStatus === "failed" && (
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => void structureOne(slide)}
                        className="rounded-full bg-danger px-3.5 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                      >
                        重试本页
                      </button>
                    )}
                    {slide.structureStatus === "ok" && (
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => void structureOne(slide)}
                        className="rounded-full border border-line-strong px-3.5 py-1.5 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-40"
                      >
                        重新梳理本页
                      </button>
                    )}
                  </span>
                )}
              </header>

              <div className="px-5 py-4">
                {isRunning && !slide.structuredContent ? (
                  <div className="flex items-center gap-3 py-6 text-sm text-ink-3">
                    <Spinner className="text-[16px]" />
                    正在梳理本页的内容逻辑，预计需要 1–2 分钟…
                  </div>
                ) : slide.structuredContent ? (
                  <DslPreview text={slide.structuredContent} />
                ) : slide.structureStatus === "failed" ? (
                  <p className="py-4 text-sm text-danger">
                    处理失败：{friendlyStructureError(slide.structureWarnings[0])}
                    （失败页重试不扣除星星）
                  </p>
                ) : (
                  <p className="py-4 text-sm text-ink-4">
                    点击上方「开始梳理本页」立即开始
                  </p>
                )}
                {slide.structureStatus === "ok" && slide.structureWarnings.length > 0 && (
                  <p className="mt-2 rounded-lg bg-brand-softer px-3 py-1.5 text-xs text-brand">
                    提示：{slide.structureWarnings[0]}
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/* 底部动作条 */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2 text-sm text-ink-3">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                failed > 0 ? "bg-danger" : done === slides.length ? "bg-emerald-500" : "bg-brand"
              }`}
            />
            完成 {done} / {slides.length}
            {runningLocal > 0 && ` · 处理中 ${runningLocal}`}
            {failed > 0 && <span className="text-danger"> · 失败 {failed}</span>}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {failed > 0 && !readOnly && (
              <button
                type="button"
                disabled={structuring || runningLocal > 0}
                onClick={() => void retryFailed()}
                className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line disabled:opacity-40"
              >
                重试失败页
              </button>
            )}
            {readOnly ? (
              <button
                type="button"
                onClick={() => ctx.goStep(3)}
                className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
              >
                查看选择风格
              </button>
            ) : (
              <button
                type="button"
                title={
                  done === slides.length
                    ? "确认后进入「选择风格」"
                    : `还有 ${slides.length - done} 页未完成，暂不可确认`
                }
                onClick={onConfirmFreeze}
                disabled={slides.length === 0 || structuring || runningLocal > 0}
                className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                确认内容，开始选风格
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- tagged DSL 结构化预览 ---------------- */

function DslPreview({ text }: { text: string }) {
  const { blocks, errors } = useMemo(() => parseDsl(text), [text]);
  const tree = useMemo(() => groupDsl(blocks), [blocks]);

  if (blocks.length === 0) {
    return <pre className="whitespace-pre-wrap text-xs leading-6 text-ink-3">{text}</pre>;
  }

  return (
    <div className="space-y-4">
      {tree.title && <h4 className="text-[15px] font-semibold text-ink">{tree.title}</h4>}

      {tree.looseModules.map((mod, i) => (
        <ModuleView key={`loose-${i}`} heading={mod.heading} blocks={mod.blocks} />
      ))}

      {tree.regions.map((region, i) => (
        <section key={`region-${i}`} className="rounded-xl border border-line bg-page/60 p-3">
          <p className="px-1 text-xs font-semibold tracking-wide text-brand">区域：{region.name}</p>
          <div className="mt-2 space-y-3">
            {region.modules.map((mod, j) => (
              <ModuleView key={j} heading={mod.heading} blocks={mod.blocks} />
            ))}
          </div>
        </section>
      ))}

      {tree.annotation && (
        <p className="border-t border-line pt-3 text-xs text-ink-4">注：{tree.annotation}</p>
      )}

      {errors.length > 0 && (
        <details className="text-xs text-ink-4">
          <summary className="cursor-pointer">DSL 解析提示（{errors.length}）</summary>
          <pre className="mt-1 whitespace-pre-wrap">{errors.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function ModuleView({ heading, blocks }: { heading: string; blocks: DslBlock[] }) {
  if (!heading && blocks.length === 0) return null;
  return (
    <div className="rounded-xl border border-line bg-card p-3.5">
      {heading && <p className="text-sm font-medium text-ink">{heading}</p>}
      <div className={`space-y-2 ${heading ? "mt-2" : ""}`}>
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: DslBlock }) {
  switch (block.tag) {
    case "正文":
      return <p className="text-[13px] leading-6 text-ink-2">{block.content}</p>;
    case "重点正文":
      return (
        <p className="border-l-2 border-brand bg-brand-softer px-3 py-1.5 text-[13px] font-medium leading-6 text-ink">
          {block.content}
        </p>
      );
    case "数据":
      return (
        <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-page px-3 py-1.5">
          <span className="text-base font-bold text-brand">{block.content}</span>
        </span>
      );
    case "数据组":
      return (
        <div className="flex flex-wrap gap-2">
          {block.content
            .split(/[;；\n]/)
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item, i) => (
              <span key={i} className="rounded-lg bg-page px-3 py-1.5 text-[13px] font-medium text-ink">
                {item}
              </span>
            ))}
        </div>
      );
    case "行头":
      return <p className="text-xs font-medium text-ink-3">{block.content}</p>;
    case "表头":
      return <p className="text-xs font-semibold text-ink-2">{block.content}</p>;
    case "表格": {
      const rows = block.tableRows.filter((row) => !isTableDividerRow(row));
      if (rows.length === 0) return null;
      const [head, ...body] = rows.map(tableRowCells);
      return (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-page">
                {head.map((cell, i) => (
                  <th key={i} className="px-3 py-2 font-semibold text-ink-2">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, i) => (
                <tr key={i} className="border-t border-line">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-2 text-ink-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "标题":
      return <p className="text-sm font-semibold text-ink">{block.content}</p>;
    case "注释":
    case "区域":
    case "模块标题":
      // 已在 groupDsl 树层处理
      return null;
    default:
      return <p className="text-[13px] leading-6 text-ink-2">{block.content}</p>;
  }
}
