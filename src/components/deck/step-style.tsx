"use client";

// Step 3 选择风格（WORKBENCH-UI-SPEC §6，剔除样稿步骤：确认风格后直接整套生成）。
// 数据用 src/data/style-packs.ts 的正式风格包（测试资产已过滤）。
import Image from "next/image";
import { useMemo, useState } from "react";
import { CheckIcon } from "@/components/icons";
import { STYLE_PACK_CATEGORIES, STYLE_PACKS } from "@/data/style-packs";
import { useGatedStylePacks } from "@/components/use-gated-style-packs";
import type { DeckCtx } from "@/components/deck/deck-workbench";

export function StepStyle({
  ctx,
  onGenerate,
}: {
  ctx: DeckCtx;
  onGenerate: () => void;
}) {
  const { state, availability, run, toast } = ctx;
  const [category, setCategory] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const gatedPacks = useGatedStylePacks();
  const allPacks = useMemo(
    () => (gatedPacks.length > 0 ? [...STYLE_PACKS, ...gatedPacks] : STYLE_PACKS),
    [gatedPacks],
  );

  const selectedId = state.deck.stylePackId || null;
  const selectedPack = allPacks.find((p) => p.id === selectedId) ?? null;
  const { hasGenerated, generating, pendingGeneration: pendingCount, canGenerate } = availability;

  const filtered = useMemo(
    () =>
      [...allPacks]
        .sort((a, b) => b.recommendationWeight - a.recommendationWeight)
        .filter((p) => !category || p.category === category),
    [category, allPacks],
  );

  const select = async (stylePackId: string | null) => {
    if (saving) {
      toast("风格选择正在保存，请稍候。");
      return;
    }
    setSaving(true);
    if (stylePackId === null) {
      // 清除选择：后端 style action 要求风格存在，清除用空串更新由后端校验；失败则提示
      setSaving(false);
      toast("暂不支持清除为「无风格」，可直接改选其他风格。");
      return;
    }
    const result = await run({ kind: "setStyle", params: { stylePackId } });
    setSaving(false);
    if (!result) toast("选择风格失败，请重新尝试。");
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pb-28 pt-6 sm:px-6">
      {!canGenerate && (
        <div className="mb-4 rounded-xl border border-brand-line bg-brand-softer px-4 py-3 text-sm text-ink-2">
          内容尚未确认冻结。请先在「内容梳理」步点击「确认内容，开始选风格」。
        </div>
      )}

      <h2 className="text-base font-semibold text-ink">选择设计风格</h2>
      <p className="mt-1 text-sm text-ink-3">
        为整套页面选定一种风格，确认后将按所选风格生成整套页面（10🌟/页，失败自动退还）。
      </p>

      {/* 分类筛选 */}
      <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="风格分类">
        <button
          type="button"
          role="tab"
          aria-selected={category === null}
          onClick={() => setCategory(null)}
          className={`rounded-full px-4 py-1.5 text-[13px] transition ${
            category === null ? "bg-brand font-medium text-white" : "bg-card text-ink-3 hover:text-brand"
          }`}
        >
          全部
        </button>
        {STYLE_PACK_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={category === c}
            onClick={() => setCategory((v) => (v === c ? null : c))}
            className={`rounded-full px-4 py-1.5 text-[13px] transition ${
              category === c ? "bg-brand font-medium text-white" : "bg-card text-ink-3 hover:text-brand"
            }`}
          >
            {c}
          </button>
        ))}
        {category && (
          <button
            type="button"
            onClick={() => setCategory(null)}
            className="text-xs text-ink-4 underline underline-offset-2 hover:text-brand"
          >
            清除筛选
          </button>
        )}
      </div>

      {/* 风格卡网格 */}
      {filtered.length === 0 ? (
        <div className="mt-16 text-center">
          <p className="text-sm text-ink-3">没有符合当前筛选条件的风格</p>
          <button
            type="button"
            onClick={() => setCategory(null)}
            className="mt-4 rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2"
          >
            清除筛选
          </button>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((pack) => {
            const active = pack.id === selectedId;
            return (
              <div
                key={pack.id}
                className={`flex flex-col rounded-2xl border bg-card p-3 shadow-card transition ${
                  active ? "border-brand ring-2 ring-brand/25" : "border-line hover:shadow-pop"
                }`}
              >
                <div className="relative overflow-hidden rounded-xl">
                  <div className="relative aspect-[16/9] w-full bg-page">
                    <Image
                      src={pack.previewUrl}
                      alt={`${pack.name} 预览图`}
                      fill
                      sizes="(max-width: 640px) 100vw, (max-width: 1280px) 33vw, 280px"
                      className="object-cover"
                    />
                  </div>
                  {pack.badgeText && (
                    <span className="absolute left-2 top-2 rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium leading-none text-white">
                      {pack.badgeText}
                    </span>
                  )}
                  {active && (
                    <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium leading-none text-white">
                      <CheckIcon width={10} height={10} /> 当前风格
                    </span>
                  )}
                </div>

                <h3 className="mt-3 px-1 text-[15px] font-semibold text-ink">{pack.name}</h3>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
                  <span className="rounded-md bg-page px-2 py-0.5 text-xs text-ink-2">
                    {pack.category}
                  </span>
                  {pack.tags.slice(0, 2).map((tag) => (
                    <span key={tag} className="rounded-md bg-page px-2 py-0.5 text-xs text-ink-3">
                      # {tag}
                    </span>
                  ))}
                </div>
                {pack.description && (
                  <p className="mt-2 line-clamp-2 px-1 text-[13px] leading-5 text-ink-3">
                    {pack.description}
                  </p>
                )}

                <button
                  type="button"
                  disabled={saving || active}
                  onClick={() => void select(pack.id)}
                  className={`mt-3 w-full rounded-full py-2 text-sm font-medium transition ${
                    active
                      ? "cursor-default bg-brand-soft text-brand"
                      : "border border-line-strong text-ink hover:border-brand hover:text-brand disabled:opacity-50"
                  }`}
                >
                  {active ? "已选择" : saving ? "保存中…" : "使用此风格"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 底部动作条 */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2 text-sm text-ink-3">
            {selectedPack ? (
              <>
                <span className="inline-block h-2 w-2 rounded-full bg-brand" />
                {selectedPack.name}
              </>
            ) : (
              "尚未选择风格"
            )}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {hasGenerated && (
              <button
                type="button"
                onClick={() => ctx.goStep(4)}
                className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
              >
                返回生成结果
              </button>
            )}
            <button
              type="button"
              onClick={onGenerate}
              disabled={!selectedPack || !canGenerate || saving || generating}
              title={
                !selectedPack
                  ? "请先选择一个设计风格"
                  : !canGenerate
                    ? "请先完成内容梳理并确认"
                    : generating
                      ? "页面正在生成中，请到「生成页面」查看进度"
                      : hasGenerated && pendingCount === 0
                        ? "按新选择的风格重新生成整套（将重新按页冻结与结算星星）"
                        : pendingCount < state.slides.length
                          ? `只为尚未完成的 ${pendingCount} 页生成，已完成的页不重复扣费`
                          : "按当前风格生成整套页面"
              }
              className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {generating
                ? "正在生成中…"
                : hasGenerated && pendingCount === 0
                  ? `使用此风格重新生成 · ${state.slides.length * 10}🌟`
                  : pendingCount < state.slides.length
                    ? `生成剩余 ${pendingCount} 页 · ${pendingCount * 10}🌟`
                    : `生成整套页面 · ${state.slides.length * 10}🌟`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
