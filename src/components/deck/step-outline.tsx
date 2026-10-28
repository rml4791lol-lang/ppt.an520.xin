"use client";

// Step 1 编辑大纲（WORKBENCH-UI-SPEC §4）。
// 章节/页面卡片、增/删页（撤销 toast）、拖拽重排、拆页 2–5、章节管理、重新生成大纲。
// 在线编辑标题/原文走 update-slide action（后端该 action 待补，见交接报告风险清单）。
import { useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/icons";
import type { DeckSlide, DeckSlideDraft, DeckSlidePatch, SlideRole } from "@/lib/client/deck-api";
import type { DeckCtx } from "@/components/deck/deck-workbench";
import { GripIcon, Modal, Spinner } from "@/components/deck/ui";

const ROLE_LABEL: Record<SlideRole, string> = {
  cover: "封面",
  toc: "目录",
  section: "章节过渡页",
  content: "内容页",
  ending: "结尾页",
};

const ROLE_TONE: Record<SlideRole, string> = {
  cover: "bg-brand-soft text-brand",
  toc: "bg-brand-soft text-brand",
  section: "bg-[#eef4ff] text-[#3b6fd4]",
  content: "bg-page text-ink-2",
  ending: "bg-emerald-50 text-emerald-600",
};

interface ChapterGroup {
  name: string;
  slides: DeckSlide[];
}

/** 连续同章节名的页面聚合成章节组 */
function groupByChapter(slides: DeckSlide[]): ChapterGroup[] {
  const groups: ChapterGroup[] = [];
  for (const slide of slides) {
    const last = groups[groups.length - 1];
    if (last && last.name === slide.chapter) last.slides.push(slide);
    else groups.push({ name: slide.chapter, slides: [slide] });
  }
  return groups;
}

export function StepOutline({
  ctx,
  busy,
  onEnterStructure,
  onRegenOutline,
  onUnlock,
}: {
  ctx: DeckCtx;
  busy: boolean;
  onEnterStructure: () => void;
  onRegenOutline: () => void;
  onUnlock: () => void;
}) {
  const { state, run, toast } = ctx;
  const slides = useMemo(
    () => [...state.slides].sort((a, b) => a.pageIndex - b.pageIndex),
    [state.slides],
  );
  const chapters = useMemo(() => groupByChapter(slides), [slides]);
  const readOnly = !ctx.availability.contentEditable;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [splitTarget, setSplitTarget] = useState<DeckSlide | null>(null);
  const [chapterModal, setChapterModal] = useState<
    | { kind: "add"; afterChapter: string | null }
    | { kind: "rename"; chapter: string }
    | { kind: "delete"; chapter: string }
    | null
  >(null);
  const [operating, setOperating] = useState(false);
  const lastDeletedRef = useRef<{ slide: DeckSlide; atIndex: number } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const withLock = async (fn: () => Promise<unknown>) => {
    if (operating) return;
    setOperating(true);
    try {
      await fn();
    } finally {
      setOperating(false);
    }
  };

  // ---------- 页面操作 ----------
  const deleteSlide = (slide: DeckSlide) =>
    withLock(async () => {
      const atIndex = slides.findIndex((s) => s.slideId === slide.slideId);
      const result = await run({ kind: "removeSlide", params: { slideId: slide.slideId } });
      if (result) {
        lastDeletedRef.current = { slide, atIndex };
        toast(`已删除「${slide.title || `第 ${slide.pageIndex + 1} 页`}」（P${slide.pageIndex + 1}）`, {
          actionLabel: "撤销上一次删除",
          duration: 8000,
          onAction: () => {
            const snapshot = lastDeletedRef.current;
            if (!snapshot) return;
            void run({
              kind: "addSlide",
              params: {
                atIndex: snapshot.atIndex,
                slide: {
                  role: snapshot.slide.role,
                  chapter: snapshot.slide.chapter,
                  title: snapshot.slide.title,
                  goal: snapshot.slide.goal,
                  rawText: snapshot.slide.rawText,
                  visualNote: snapshot.slide.visualNote,
                } satisfies DeckSlideDraft,
              },
            }).then((ok) => {
              if (!ok) toast("撤销删除失败，请重新尝试。");
            });
          },
        });
      }
    });

  const moveSlide = (slide: DeckSlide, delta: -1 | 1) =>
    withLock(async () => {
      const index = slides.findIndex((s) => s.slideId === slide.slideId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= slides.length) return;
      const order = slides.map((s) => s.slideId);
      [order[index], order[target]] = [order[target], order[index]];
      const result = await run({ kind: "reorderSlides", params: { order } });
      if (!result) toast("调整顺序失败，请重新尝试。");
    });

  const addSlideAfter = (index: number, chapter: string) =>
    withLock(async () => {
      const result = await run({
        kind: "addSlide",
        params: { atIndex: index + 1, slide: { role: "content", chapter } },
      });
      if (!result) toast("新增页面失败，请重新尝试。");
    });

  const onDropCard = (targetId: string) =>
    withLock(async () => {
      const dragId = dragIdRef.current;
      setDragOverId(null);
      if (!dragId || dragId === targetId) return;
      const from = slides.findIndex((s) => s.slideId === dragId);
      const to = slides.findIndex((s) => s.slideId === targetId);
      if (from < 0 || to < 0) return;
      const order = slides.map((s) => s.slideId);
      order.splice(from, 1);
      order.splice(to, 0, dragId);
      // 跨章节拖动：跟随落点相邻页面的章节（best-effort，依赖 update-slide）
      const moved = slides[from];
      const neighbor = slides[to];
      if (neighbor && moved.chapter !== neighbor.chapter) {
        await run(
          { kind: "updateSlide", params: { slideId: dragId, chapter: neighbor.chapter } },
          { silent: true },
        );
      }
      const result = await run({ kind: "reorderSlides", params: { order } });
      if (!result) toast("调整顺序失败，请重新尝试。");
    });

  // ---------- 渲染 ----------
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pb-28 pt-6 sm:px-6">
      {readOnly && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-brand-line bg-brand-softer px-4 py-3">
          <p className="text-sm text-ink-2">
            内容已冻结：大纲当前为只读。如需修改，请先解锁（解锁将作废已生成的页面图）。
          </p>
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
          结构总览
          <span className="ml-2 text-sm font-normal text-ink-3">
            {chapters.filter((c) => c.name).length} 章 · {slides.length} 页 · 点击卡片即可编辑内容
          </span>
        </h2>
      </div>

      {slides.length === 0 ? (
        <div className="mt-16 text-center">
          <p className="text-base font-semibold text-ink">暂无大纲内容</p>
          <p className="mt-2 text-sm text-ink-3">大纲可能生成失败或已被清空，可重新生成</p>
          <button
            type="button"
            onClick={onRegenOutline}
            className="mt-6 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            重新生成大纲
          </button>
        </div>
      ) : (
        <div className="mt-5 space-y-6">
          {chapters.map((chapter) => (
            <section key={`${chapter.name}-${chapter.slides[0]?.slideId ?? "empty"}`}>
              {/* 章节头 */}
              <div className="flex items-center gap-2 px-1">
                <span className="min-w-0 truncate text-sm font-semibold text-ink">
                  {chapter.name || "未分章"}
                </span>
                <span className="shrink-0 text-xs text-ink-4">{chapter.slides.length} 页</span>
                {!readOnly && (
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {chapter.name && (
                      <>
                        <button
                          type="button"
                          title="重命名章节"
                          className="rounded-lg p-1.5 text-ink-3 transition hover:bg-card hover:text-ink"
                          onClick={() => setChapterModal({ kind: "rename", chapter: chapter.name })}
                        >
                          <PencilIcon width={13} height={13} />
                        </button>
                        <button
                          type="button"
                          title="删除章节"
                          className="rounded-lg p-1.5 text-ink-3 transition hover:bg-card hover:text-danger"
                          onClick={() => setChapterModal({ kind: "delete", chapter: chapter.name })}
                        >
                          <TrashIcon width={13} height={13} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      title="添加章节过渡页"
                      onClick={() =>
                        void withLock(async () => {
                          await run({
                            kind: "addSlide",
                            params: {
                              atIndex: chapter.slides[0]?.pageIndex ?? slides.length,
                              slide: { role: "section", chapter: chapter.name, title: chapter.name },
                            },
                          });
                        })
                      }
                      className="rounded-lg px-2 py-1 text-xs text-ink-3 transition hover:bg-card hover:text-brand"
                    >
                      ＋ 过渡页
                    </button>
                    <button
                      type="button"
                      title="在该章节末尾新增内容页"
                      onClick={() =>
                        void addSlideAfter(
                          chapter.slides[chapter.slides.length - 1]?.pageIndex ?? slides.length - 1,
                          chapter.name,
                        )
                      }
                      className="rounded-lg px-2 py-1 text-xs text-ink-3 transition hover:bg-card hover:text-brand"
                    >
                      ＋ 内容页
                    </button>
                  </span>
                )}
              </div>

              {/* 页面卡 */}
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {chapter.slides.map((slide) => (
                  <div
                    key={slide.slideId}
                    draggable={!readOnly && !operating}
                    onDragStart={() => {
                      dragIdRef.current = slide.slideId;
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverId(slide.slideId);
                    }}
                    onDragLeave={() => setDragOverId((v) => (v === slide.slideId ? null : v))}
                    onDrop={() => void onDropCard(slide.slideId)}
                    onDragEnd={() => {
                      dragIdRef.current = null;
                      setDragOverId(null);
                    }}
                    className={`group relative rounded-2xl border bg-card p-4 shadow-card transition ${
                      dragOverId === slide.slideId
                        ? "border-brand ring-2 ring-brand/30"
                        : "border-line hover:border-brand-line"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] ${ROLE_TONE[slide.role]}`}>
                        {ROLE_LABEL[slide.role]}
                      </span>
                      <span className="text-xs text-ink-4">P{slide.pageIndex + 1}</span>
                      {!readOnly && (
                        <span
                          className="ml-auto cursor-grab text-ink-4 opacity-0 transition group-hover:opacity-100"
                          title="拖动调整顺序"
                        >
                          <GripIcon />
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      title="点击编辑"
                      onClick={() => setEditingId(slide.slideId)}
                      className="mt-2 block w-full truncate text-left text-sm font-medium text-ink transition hover:text-brand"
                    >
                      {slide.title || "（未命名页面）"}
                    </button>
                    <p className="mt-1 line-clamp-2 min-h-5 text-xs leading-5 text-ink-3">
                      {slide.rawText
                        ? slide.rawText.slice(0, 80)
                        : slide.role === "content"
                          ? "原文缺失"
                          : "—"}
                    </p>

                    {!readOnly && (
                      <div className="mt-3 flex items-center gap-0.5 border-t border-line pt-2.5 text-ink-3">
                        <button
                          type="button"
                          title="前移"
                          disabled={slide.pageIndex === 0 || operating}
                          onClick={() => void moveSlide(slide, -1)}
                          className="rounded-md p-1.5 transition hover:bg-page hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <ChevronLeftIcon width={13} height={13} />
                        </button>
                        <button
                          type="button"
                          title="后移"
                          disabled={slide.pageIndex === slides.length - 1 || operating}
                          onClick={() => void moveSlide(slide, 1)}
                          className="rounded-md p-1.5 transition hover:bg-page hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <ChevronRightIcon width={13} height={13} />
                        </button>
                        <button
                          type="button"
                          title="新增页面"
                          disabled={operating}
                          onClick={() => void addSlideAfter(slide.pageIndex, slide.chapter)}
                          className="rounded-md p-1.5 transition hover:bg-page hover:text-ink disabled:opacity-30"
                        >
                          <PlusIcon width={13} height={13} />
                        </button>
                        <button
                          type="button"
                          title={
                            slide.rawText
                              ? "AI 拆分为 2–5 页"
                              : "原文为空，无法拆页"
                          }
                          disabled={!slide.rawText || operating}
                          onClick={() => setSplitTarget(slide)}
                          className="rounded-md px-1.5 py-1 text-xs transition hover:bg-page hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          ⧉ 拆页
                        </button>
                        <button
                          type="button"
                          title={slide.role === "cover" ? "封面页不可删除" : "删除页面"}
                          disabled={slide.role === "cover" || slides.length <= 1 || operating}
                          onClick={() => void deleteSlide(slide)}
                          className="ml-auto rounded-md p-1.5 transition hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <TrashIcon width={13} height={13} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {!readOnly && (
                <button
                  type="button"
                  title="在该章节后新增章节"
                  onClick={() => setChapterModal({ kind: "add", afterChapter: chapter.name || null })}
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-2.5 text-sm text-ink-3 transition hover:border-brand-line hover:text-brand"
                >
                  <PlusIcon width={14} height={14} /> 新增章节
                </button>
              )}
            </section>
          ))}
        </div>
      )}

      {/* 底部动作条 */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="text-sm text-ink-3">
            {chapters.filter((c) => c.name).length} 章 · {slides.length} 页
          </span>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={onRegenOutline}
              disabled={busy || operating}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line disabled:opacity-40"
            >
              {busy ? "正在重新生成大纲…" : "重新生成大纲"}
            </button>
            {readOnly ? (
              <button
                type="button"
                onClick={() => ctx.goStep(2)}
                className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
              >
                查看内容梳理
              </button>
            ) : (
              <button
                type="button"
                title="确认大纲，逐页梳理逻辑结构"
                onClick={onEnterStructure}
                disabled={slides.length === 0 || busy || operating}
                className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                进入内容梳理
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 编辑本页内容弹窗 */}
      {editingId && (
        <EditPageModal
          slides={slides}
          slideId={editingId}
          readOnly={readOnly}
          operating={operating}
          onClose={() => setEditingId(null)}
          onNavigate={(id) => setEditingId(id)}
          onSave={(id, patch) => run({ kind: "updateSlide", params: { slideId: id, ...patch } })}
          onMove={(slide, delta) => void moveSlide(slide, delta)}
          onAdd={(slide) => void addSlideAfter(slide.pageIndex, slide.chapter)}
          onSplit={(slide) => {
            setEditingId(null);
            setSplitTarget(slide);
          }}
          onDelete={(slide) => {
            setEditingId(null);
            void deleteSlide(slide);
          }}
        />
      )}

      {/* 拆页弹窗 */}
      {splitTarget && (
        <SplitModal
          slide={splitTarget}
          onClose={() => setSplitTarget(null)}
          onSubmit={(into) =>
            withLock(async () => {
              // 成功/失败提示由动作目录生成（拆页免费 → 失败只说重试）
              const result = await run({
                kind: "splitSlide",
                params: { slideId: splitTarget.slideId, into },
              });
              if (result) setSplitTarget(null);
            })
          }
        />
      )}

      {/* 章节弹窗 */}
      {chapterModal?.kind === "add" && (
        <ChapterNameModal
          title="新增章节"
          description="创建后将自动生成该章节的第一张空白页面，可直接编辑标题与原文。"
          existing={chapters.map((c) => c.name).filter(Boolean)}
          onClose={() => setChapterModal(null)}
          onSubmit={(name) =>
            withLock(async () => {
              const after = chapterModal.afterChapter;
              const group = chapters.find((c) => c.name === after);
              const atIndex = group
                ? group.slides[group.slides.length - 1].pageIndex + 1
                : slides.length;
              const result = await run({
                kind: "addSlide",
                params: { atIndex, slide: { role: "content", chapter: name, title: "" } },
              });
              if (result) setChapterModal(null);
            })
          }
        />
      )}
      {chapterModal?.kind === "rename" && (
        <ChapterNameModal
          title="重命名章节"
          description="将逐页更新该章节下所有页面的章节名，并同步目录页文本。"
          initial={chapterModal.chapter}
          existing={chapters.map((c) => c.name).filter((n) => n && n !== chapterModal.chapter)}
          onClose={() => setChapterModal(null)}
          onSubmit={(name) =>
            withLock(async () => {
              const targets = slides.filter((s) => s.chapter === chapterModal.chapter);
              for (const slide of targets) {
                const ok = await run(
                  { kind: "updateSlide", params: { slideId: slide.slideId, chapter: name } },
                  { silent: true },
                );
                if (!ok) {
                  toast("章节重命名失败：当前后端尚未支持在线修改（update-slide），请稍后再试。");
                  return;
                }
              }
              setChapterModal(null);
            })
          }
        />
      )}
      {chapterModal?.kind === "delete" && (
        <DeleteChapterModal
          chapter={chapterModal.chapter}
          pageCount={slides.filter((s) => s.chapter === chapterModal.chapter).length}
          onClose={() => setChapterModal(null)}
          onSubmit={(keepPages) =>
            withLock(async () => {
              const targets = slides.filter((s) => s.chapter === chapterModal.chapter);
              if (!keepPages && targets.length >= slides.length) {
                toast("至少保留一页");
                return;
              }
              if (keepPages) {
                // 内容页并入相邻章节；章节过渡页删除
                const firstIndex = slides.findIndex((s) => s.chapter === chapterModal.chapter);
                const neighbor =
                  slides[firstIndex - 1]?.chapter ?? slides[firstIndex + targets.length]?.chapter ?? "";
                for (const slide of targets) {
                  if (slide.role === "section") {
                    const ok = await run({ kind: "removeSlide", params: { slideId: slide.slideId } });
                    if (!ok) {
                      toast("删除章节失败，请重新尝试。");
                      return;
                    }
                  } else {
                    const ok = await run(
                      { kind: "updateSlide", params: { slideId: slide.slideId, chapter: neighbor } },
                      { silent: true },
                    );
                    if (!ok) {
                      toast("移动页面失败：当前后端尚未支持在线修改（update-slide），请稍后再试。");
                      return;
                    }
                  }
                }
              } else {
                for (const slide of targets) {
                  const ok = await run({ kind: "removeSlide", params: { slideId: slide.slideId } });
                  if (!ok) {
                    toast("删除章节失败，请重新尝试。");
                    return;
                  }
                }
              }
              setChapterModal(null);
            })
          }
        />
      )}
    </div>
  );
}

/* ---------------- 编辑本页内容弹窗 ---------------- */

function EditPageModal({
  slides,
  slideId,
  readOnly,
  operating,
  onClose,
  onNavigate,
  onSave,
  onMove,
  onAdd,
  onSplit,
  onDelete,
}: {
  slides: DeckSlide[];
  slideId: string;
  readOnly: boolean;
  operating: boolean;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onSave: (id: string, patch: DeckSlidePatch) => Promise<unknown>;
  onMove: (slide: DeckSlide, delta: -1 | 1) => void;
  onAdd: (slide: DeckSlide) => void;
  onSplit: (slide: DeckSlide) => void;
  onDelete: (slide: DeckSlide) => void;
}) {
  const slide = slides.find((s) => s.slideId === slideId);
  const [title, setTitle] = useState(slide?.title ?? "");
  const [rawText, setRawText] = useState(slide?.rawText ?? "");
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);

  if (!slide) return null;
  const index = slides.findIndex((s) => s.slideId === slideId);
  const isEnding = slide.role === "ending";

  const flushSave = async () => {
    if (readOnly || !dirtyRef.current) return;
    setSaving(true);
    const result = await onSave(slide.slideId, { title: title.trim(), rawText });
    setSaving(false);
    if (result === null) return; // 错误已由 run 统一 toast
    dirtyRef.current = false;
  };

  const go = (nextId: string) => {
    void flushSave().then(() => onNavigate(nextId));
    setTitle(slides.find((s) => s.slideId === nextId)?.title ?? "");
    setRawText(slides.find((s) => s.slideId === nextId)?.rawText ?? "");
    dirtyRef.current = false;
  };

  return (
    <Modal
      title={`编辑本页内容 · P${slide.pageIndex + 1}`}
      ariaLabel="编辑本页内容"
      width="max-w-2xl"
      onClose={() => {
        void flushSave();
        onClose();
      }}
    >
      <label className="block text-xs font-medium text-ink-3">本页标题</label>
      <input
        value={title}
        maxLength={200}
        readOnly={readOnly}
        placeholder={isEnding ? "结尾页可不填标题" : "请输入本页标题"}
        onChange={(e) => {
          setTitle(e.target.value);
          dirtyRef.current = true;
        }}
        className="mt-1.5 w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
      />

      <div className="mt-4 flex items-center justify-between">
        <label className="text-xs font-medium text-ink-3">本页原文</label>
        <span className="text-xs text-ink-4">请核对本页内容，后续 AI 将基于此内容继续梳理</span>
      </div>
      <textarea
        value={rawText}
        rows={8}
        readOnly={readOnly}
        placeholder="请输入此页原文内容"
        onChange={(e) => {
          setRawText(e.target.value);
          dirtyRef.current = true;
        }}
        className="mt-1.5 w-full resize-y rounded-xl border border-line bg-card px-3 py-2.5 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
      />
      {slide.role === "content" && !rawText.trim() && (
        <p className="mt-1.5 text-xs text-danger">内容页原文不能为空，确认大纲前需补充</p>
      )}

      {!readOnly && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
          <span className="text-xs text-ink-4">本页操作：</span>
          <button
            type="button"
            disabled={index === 0 || operating}
            onClick={() => onMove(slide, -1)}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-30"
          >
            ← 前移
          </button>
          <button
            type="button"
            disabled={index === slides.length - 1 || operating}
            onClick={() => onMove(slide, 1)}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-30"
          >
            后移 →
          </button>
          <button
            type="button"
            disabled={operating}
            onClick={() => onAdd(slide)}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-30"
          >
            ＋ 新增
          </button>
          <button
            type="button"
            disabled={!slide.rawText || operating}
            title={slide.rawText ? "AI 拆分为 2–5 页" : "原文为空，无法拆页"}
            onClick={() => onSplit(slide)}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-brand-line disabled:opacity-30"
          >
            ⧉ 拆页
          </button>
          <button
            type="button"
            disabled={slide.role === "cover" || slides.length <= 1 || operating}
            title={slide.role === "cover" ? "封面页不可删除" : "删除此页"}
            onClick={() => onDelete(slide)}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-danger transition hover:bg-danger-soft disabled:opacity-30"
          >
            删除此页
          </button>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => go(slides[index - 1].slideId)}
          className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line disabled:opacity-30"
        >
          ← 上一页
        </button>
        <span className="text-xs text-ink-4">
          {saving ? "保存中…" : "修改在切换或完成时自动保存"}
        </span>
        {index < slides.length - 1 ? (
          <button
            type="button"
            onClick={() => go(slides[index + 1].slideId)}
            className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line"
          >
            下一页 →
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              void flushSave();
              onClose();
            }}
            className="rounded-full bg-brand px-6 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <span className="flex items-center gap-1.5">
              <CheckIcon width={13} height={13} /> 完成
            </span>
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- 拆页弹窗 ---------------- */

function SplitModal({
  slide,
  onClose,
  onSubmit,
}: {
  slide: DeckSlide;
  onClose: () => void;
  onSubmit: (into: number) => Promise<void>;
}) {
  const [into, setInto] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  return (
    <Modal title="拆分页面" ariaLabel="拆分页面" onClose={onClose}>
      <p className="text-sm leading-6 text-ink-2">
        AI 将把「{slide.title || `第 ${slide.pageIndex + 1} 页`}」的原文拆分为多页（2–5 页），
        拆分失败自动回退为按段落均分。
      </p>
      <div className="mt-4 flex items-center gap-2">
        {[2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setInto(n)}
            className={`h-10 w-14 rounded-xl border text-sm font-medium transition ${
              into === n
                ? "border-brand bg-brand-soft text-brand"
                : "border-line text-ink-2 hover:border-brand-line"
            }`}
          >
            {n} 页
          </button>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
        >
          取消
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true);
            void onSubmit(into).finally(() => setSubmitting(false));
          }}
          className="flex items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
        >
          {submitting && <Spinner />}
          {submitting ? "正在拆分本页" : "拆页"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 章节名弹窗（新增/重命名） ---------------- */

function ChapterNameModal({
  title,
  description,
  initial = "",
  existing,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  initial?: string;
  existing: string[];
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = () => {
    const clean = name.trim();
    if (!clean) {
      setError("请输入章节名称");
      return;
    }
    if (existing.includes(clean)) {
      setError("章节名称已存在");
      return;
    }
    setSubmitting(true);
    void onSubmit(clean).finally(() => setSubmitting(false));
  };

  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-xs leading-5 text-ink-3">{description}</p>
      <input
        autoFocus
        value={name}
        maxLength={60}
        placeholder="请输入章节名称"
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        className="mt-3 w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
      />
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
        >
          取消
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={submit}
          className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
        >
          确定
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 删除章节弹窗 ---------------- */

function DeleteChapterModal({
  chapter,
  pageCount,
  onClose,
  onSubmit,
}: {
  chapter: string;
  pageCount: number;
  onClose: () => void;
  onSubmit: (keepPages: boolean) => Promise<void>;
}) {
  const [keepPages, setKeepPages] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  return (
    <Modal title={`删除章节「${chapter}」`} onClose={onClose}>
      <p className="text-sm text-ink-2">请选择删除方式：</p>
      <div className="mt-3 space-y-2">
        {[
          {
            value: true,
            label: "保留页面，移到相邻章节",
            desc: "删除该章节的章节过渡页，内容页并入相邻章节",
          },
          {
            value: false,
            label: "连同页面一起删除",
            desc: `该章节下 ${pageCount} 个页面将被删除`,
          },
        ].map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => setKeepPages(opt.value)}
            className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${
              keepPages === opt.value
                ? "border-brand bg-brand-softer"
                : "border-line hover:border-brand-line"
            }`}
          >
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                keepPages === opt.value ? "border-brand bg-brand text-white" : "border-line-strong"
              }`}
            >
              {keepPages === opt.value && <CheckIcon width={10} height={10} />}
            </span>
            <span>
              <span className="block text-sm font-medium text-ink">{opt.label}</span>
              <span className="mt-0.5 block text-xs text-ink-3">{opt.desc}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
        >
          取消
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true);
            void onSubmit(keepPages).finally(() => setSubmitting(false));
          }}
          className="rounded-full bg-danger px-5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          删除章节
        </button>
      </div>
    </Modal>
  );
}
