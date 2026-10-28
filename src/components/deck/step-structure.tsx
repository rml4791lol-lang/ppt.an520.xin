"use client";

// Step 2 内容梳理（WORKBENCH-UI-SPEC §5）：逐页 tagged DSL 结构化预览 + 状态 + 失败重试 + 冻结确认。
// DSL 渲染与可视化编辑共用 src/lib/client/dsl.ts，保存仍走 update-slide 的服务端权限与校验。
import { useMemo, useState } from "react";
import type { DeckSlide } from "@/lib/client/deck-api";
import type { DeckCtx } from "@/components/deck/deck-workbench";
import {
  DSL_TAGS,
  groupDsl,
  isTableDividerRow,
  parseDsl,
  serializeDsl,
  tableRowCells,
  type DslBlock,
  type DslTag,
} from "@/lib/client/dsl";
import { Spinner } from "@/components/deck/ui";

const STATUS_LABEL: Record<string, string> = {
  pending: "待梳理",
  running: "梳理中",
  ok: "内容已梳理",
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

interface StructureEditorDraft {
  slideId: string;
  title: string;
  blocks: DslBlock[];
  rawText: string;
  mode: "visual" | "raw";
  errors: string[];
}

function cloneBlocks(blocks: DslBlock[]): DslBlock[] {
  return blocks.map((block) => ({ ...block, tableRows: [...block.tableRows] }));
}

function makeBlock(tag: DslTag, lineNo = 1): DslBlock {
  return {
    tag,
    arg: tag === "区域" ? "新区域" : "",
    content: "",
    tableRows: tag === "表格" ? ["| 项目 | 内容 |", "| --- | --- |", "| 示例 | 请填写 |"] : [],
    lineNo,
  };
}

function syncTitleBlock(blocks: DslBlock[], title: string): DslBlock[] {
  const next = cloneBlocks(blocks);
  const titleIndex = next.findIndex((block) => block.tag === "标题");
  if (titleIndex === -1) {
    next.unshift({ ...makeBlock("标题"), content: title });
  } else {
    next[titleIndex] = { ...next[titleIndex], content: title };
  }
  return next;
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
  const readOnly = !ctx.availability.contentEditable;
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<StructureEditorDraft | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const done = slides.filter((s) => s.structureStatus === "ok").length;
  const failed = slides.filter((s) => s.structureStatus === "failed").length;
  const runningLocal = pendingIds.size;

  const structureOne = async (slide: DeckSlide) => {
    if (pendingIds.has(slide.slideId) || readOnly) return;
    if (editor) {
      toast("请先保存或取消正在编辑的页面。");
      return;
    }
    setPendingIds((prev) => new Set(prev).add(slide.slideId));
    // 失败提示由动作目录生成（梳理免费 → 「请重试」，不再手写未扣星承诺）
    await run({ kind: "structureSlide", params: { slideId: slide.slideId } });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(slide.slideId);
      return next;
    });
  };

  const openEditor = (slide: DeckSlide) => {
    const parsed = parseDsl(slide.structuredContent);
    const blocks = parsed.blocks.length > 0 ? syncTitleBlock(parsed.blocks, slide.title) : parsed.blocks;
    setEditor({
      slideId: slide.slideId,
      title: slide.title,
      blocks,
      rawText: slide.structuredContent,
      mode: parsed.errors.length > 0 || parsed.blocks.length === 0 ? "raw" : "visual",
      errors: parsed.errors,
    });
  };

  const saveEditor = async () => {
    if (!editor || savingId) return;
    const title = editor.title.trim();
    if (!title) {
      toast("页面标题不能为空。");
      return;
    }
    const source = editor.mode === "raw" ? parseDsl(editor.rawText.trim()) : { blocks: editor.blocks, errors: [] };
    if (source.blocks.length === 0 || source.errors.length > 0) {
      toast(source.errors[0] || "梳理内容不能为空，请至少保留一个内容模块。");
      return;
    }
    const structuredContent = serializeDsl(syncTitleBlock(source.blocks, title));
    const parsed = parseDsl(structuredContent);
    if (parsed.blocks.length === 0 || parsed.errors.length > 0) {
      toast(parsed.errors[0] || "梳理内容不能为空，请至少保留一个内容模块。");
      return;
    }
    setSavingId(editor.slideId);
    const result = await run({
      kind: "updateSlide",
      params: { slideId: editor.slideId, title, structuredContent },
    });
    setSavingId(null);
    if (result) {
      setEditor(null);
      toast("本页内容已保存，后续生成将使用修改后的版本。");
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
            disabled={structuring || runningLocal > 0 || editor !== null}
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
        AI 不会添加原文中没有的事实、结论或建议；重复、空泛或弱相关信息可能不再呈现。失败页可单独重试。
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
                      <>
                        <button
                          type="button"
                          disabled={isRunning || editor !== null}
                          onClick={() => openEditor(slide)}
                          className="rounded-full bg-brand px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
                        >
                          编辑内容
                        </button>
                        <button
                          type="button"
                          disabled={isRunning || editor !== null}
                          onClick={() => void structureOne(slide)}
                          className="rounded-full border border-line-strong px-3.5 py-1.5 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-40"
                        >
                          重新梳理本页
                        </button>
                      </>
                    )}
                  </span>
                )}
              </header>

              <div className="px-5 py-4">
                {editor?.slideId === slide.slideId ? (
                  <DslEditor
                    draft={editor}
                    saving={savingId === slide.slideId}
                    onChange={setEditor}
                    onCancel={() => setEditor(null)}
                    onSave={() => void saveEditor()}
                  />
                ) : isRunning && !slide.structuredContent ? (
                  <div className="flex items-center gap-3 py-6 text-sm text-ink-3">
                    <Spinner className="text-[16px]" />
                    正在梳理本页的内容逻辑，预计需要 1–2 分钟…
                  </div>
                ) : slide.structuredContent ? (
                  <DslPreview text={slide.structuredContent} />
                ) : slide.structureStatus === "failed" ? (
                  <p className="py-4 text-sm text-danger">
                    处理失败：{friendlyStructureError(slide.structureWarnings[0])}
                    （可单独重试本页）
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
                disabled={structuring || runningLocal > 0 || editor !== null}
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
                disabled={slides.length === 0 || structuring || runningLocal > 0 || editor !== null}
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

/* ---------------- tagged DSL 可视化编辑 ---------------- */

const TAG_LABELS: Record<DslTag, string> = {
  标题: "页面标题",
  注释: "页脚注释",
  区域: "内容区域",
  模块标题: "模块标题",
  正文: "正文",
  重点正文: "重点内容",
  数据: "关键数据",
  数据组: "数据组",
  行头: "行头",
  表头: "表头",
  表格: "表格",
};

function editableTableText(rows: string[]): string {
  return rows
    .filter((row) => !isTableDividerRow(row))
    .map((row) => tableRowCells(row).join(" | "))
    .join("\n");
}

function tableRowsFromText(text: string): string[] {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const cells = row
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
      return `| ${cells.join(" | ")} |`;
    });
  if (rows.length === 0) return [];
  const columns = Math.max(1, tableRowCells(rows[0]).length);
  return [rows[0], `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`, ...rows.slice(1)];
}

function DslEditor({
  draft,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: StructureEditorDraft;
  saving: boolean;
  onChange: (next: StructureEditorDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const updateBlocks = (blocks: DslBlock[]) => {
    onChange({ ...draft, blocks, errors: [] });
  };

  const updateBlock = (index: number, patch: Partial<DslBlock>) => {
    const blocks = cloneBlocks(draft.blocks);
    blocks[index] = { ...blocks[index], ...patch };
    updateBlocks(blocks);
  };

  const moveBlock = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.blocks.length) return;
    const blocks = cloneBlocks(draft.blocks);
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    updateBlocks(blocks);
  };

  const removeBlock = (index: number) => {
    updateBlocks(draft.blocks.filter((_, blockIndex) => blockIndex !== index));
  };

  const setMode = (mode: "visual" | "raw") => {
    if (mode === draft.mode) return;
    if (mode === "raw") {
      onChange({
        ...draft,
        mode,
        rawText: serializeDsl(syncTitleBlock(draft.blocks, draft.title.trim() || "未命名页")),
        errors: [],
      });
      return;
    }
    const parsed = parseDsl(draft.rawText);
    if (parsed.blocks.length === 0 || parsed.errors.length > 0) {
      onChange({
        ...draft,
        errors: parsed.errors.length > 0 ? parsed.errors : ["内容为空，暂时无法切换到可视化编辑。"],
      });
      return;
    }
    onChange({
      ...draft,
      mode,
      blocks: syncTitleBlock(parsed.blocks, draft.title.trim() || "未命名页"),
      errors: [],
    });
  };

  return (
    <div className="rounded-xl border border-brand-line bg-brand-softer/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">编辑本页内容</p>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            标题、区域、模块和正文都可修改；保存后会用于后续页面生成。
          </p>
        </div>
        <div className="inline-flex rounded-full border border-line bg-card p-0.5" role="group" aria-label="编辑模式">
          <button
            type="button"
            onClick={() => setMode("visual")}
            className={`rounded-full px-3 py-1.5 text-xs transition ${
              draft.mode === "visual" ? "bg-brand text-white" : "text-ink-3 hover:text-ink"
            }`}
          >
            可视化编辑
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={`rounded-full px-3 py-1.5 text-xs transition ${
              draft.mode === "raw" ? "bg-brand text-white" : "text-ink-3 hover:text-ink"
            }`}
          >
            高级文本
          </button>
        </div>
      </div>

      <label className="mt-4 block text-xs font-medium text-ink-2">
        页面标题
        <input
          value={draft.title}
          maxLength={200}
          onChange={(event) => {
            const title = event.target.value;
            onChange({
              ...draft,
              title,
              blocks: draft.mode === "visual" ? syncTitleBlock(draft.blocks, title) : draft.blocks,
            });
          }}
          className="mt-1.5 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink outline-none transition focus:border-brand"
          placeholder="请输入页面标题"
        />
      </label>

      {draft.mode === "visual" ? (
        <div className="mt-4 space-y-3">
          {draft.blocks.length === 0 && (
            <p className="rounded-lg border border-dashed border-line-strong bg-card px-3 py-6 text-center text-xs text-ink-4">
              暂无内容模块，请点击下方按钮添加。
            </p>
          )}
          {draft.blocks.map((block, index) => {
            const firstTitleIndex = draft.blocks.findIndex((item) => item.tag === "标题");
            const titleSynced = block.tag === "标题" && index === firstTitleIndex;
            return (
              <div key={`${index}-${block.tag}`} className="rounded-xl border border-line bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={block.tag}
                    aria-label={`第 ${index + 1} 个内容块类型`}
                    onChange={(event) => {
                      const tag = event.target.value as DslTag;
                      const replacement = makeBlock(tag, block.lineNo);
                      updateBlock(index, {
                        ...replacement,
                        content: tag === "标题" && firstTitleIndex === -1 ? draft.title : replacement.content,
                      });
                    }}
                    className="rounded-lg border border-line-strong bg-card px-2.5 py-1.5 text-xs font-medium text-ink outline-none focus:border-brand"
                  >
                    {DSL_TAGS.map((tag) => (
                      <option key={tag} value={tag}>
                        {TAG_LABELS[tag]}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-ink-4">内容块 {index + 1}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveBlock(index, -1)}
                      className="rounded-md px-2 py-1 text-xs text-ink-3 transition hover:bg-page disabled:opacity-30"
                      aria-label={`上移第 ${index + 1} 个内容块`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === draft.blocks.length - 1}
                      onClick={() => moveBlock(index, 1)}
                      className="rounded-md px-2 py-1 text-xs text-ink-3 transition hover:bg-page disabled:opacity-30"
                      aria-label={`下移第 ${index + 1} 个内容块`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      disabled={titleSynced}
                      onClick={() => removeBlock(index)}
                      className="rounded-md px-2 py-1 text-xs text-danger transition hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label={`删除第 ${index + 1} 个内容块`}
                      title={titleSynced ? "页面标题请在上方修改" : "删除内容块"}
                    >
                      删除
                    </button>
                  </div>
                </div>

                {block.tag === "区域" ? (
                  <label className="mt-2 block text-xs text-ink-3">
                    区域名称
                    <input
                      value={block.arg}
                      maxLength={120}
                      onChange={(event) => updateBlock(index, { arg: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-line bg-page/50 px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                      placeholder="例如：左侧协同机制"
                    />
                  </label>
                ) : block.tag === "表格" ? (
                  <div className="mt-2 space-y-2">
                    <label className="block text-xs text-ink-3">
                      表格说明（可选）
                      <input
                        value={block.content}
                        maxLength={300}
                        onChange={(event) => updateBlock(index, { content: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-line bg-page/50 px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                      />
                    </label>
                    <label className="block text-xs text-ink-3">
                      表格内容（每行一行，列之间用“|”分隔；第一行为表头）
                      <textarea
                        value={editableTableText(block.tableRows)}
                        onChange={(event) => updateBlock(index, { tableRows: tableRowsFromText(event.target.value) })}
                        rows={4}
                        className="mt-1 w-full resize-y rounded-lg border border-line bg-page/50 px-3 py-2 font-mono text-xs leading-5 text-ink outline-none focus:border-brand"
                        placeholder={"项目 | 内容\nAI初筛 | 9928项自动评分"}
                      />
                    </label>
                  </div>
                ) : titleSynced ? (
                  <p className="mt-2 rounded-lg bg-page/60 px-3 py-2 text-sm text-ink-2">
                    {draft.title || "（请在上方填写页面标题）"}
                  </p>
                ) : (
                  <label className="mt-2 block text-xs text-ink-3">
                    {TAG_LABELS[block.tag]}内容
                    <textarea
                      value={block.content}
                      maxLength={2000}
                      onChange={(event) => updateBlock(index, { content: event.target.value })}
                      rows={block.tag === "正文" || block.tag === "重点正文" || block.tag === "注释" ? 3 : 2}
                      className="mt-1 w-full resize-y rounded-lg border border-line bg-page/50 px-3 py-2 text-sm leading-6 text-ink outline-none focus:border-brand"
                      placeholder={block.tag === "数据组" ? "多个数据可用分号分隔" : `请输入${TAG_LABELS[block.tag]}`}
                    />
                  </label>
                )}
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => updateBlocks([...draft.blocks, makeBlock("正文", draft.blocks.length + 1)])}
            className="w-full rounded-xl border border-dashed border-brand-line bg-card px-4 py-2.5 text-xs font-medium text-brand transition hover:bg-brand-soft"
          >
            ＋ 添加内容块
          </button>
        </div>
      ) : (
        <div className="mt-4">
          <label className="block text-xs font-medium text-ink-2">
            高级结构化文本
            <textarea
              value={draft.rawText}
              onChange={(event) => onChange({ ...draft, rawText: event.target.value, errors: [] })}
              rows={14}
              spellCheck={false}
              className="mt-1.5 w-full resize-y rounded-xl border border-line-strong bg-card px-3 py-2 font-mono text-xs leading-6 text-ink outline-none transition focus:border-brand"
            />
          </label>
          <p className="mt-1.5 text-[11px] leading-5 text-ink-4">
            高级模式适合熟悉标签格式的用户；切回可视化编辑时会先检查内容格式。
          </p>
        </div>
      )}

      {draft.errors.length > 0 && (
        <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs leading-5 text-danger" role="alert">
          {draft.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="rounded-full border border-line-strong px-4 py-2 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onSave}
          className="inline-flex min-w-24 items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
        >
          {saving && <Spinner className="text-[12px]" />}
          {saving ? "保存中…" : "保存修改"}
        </button>
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
