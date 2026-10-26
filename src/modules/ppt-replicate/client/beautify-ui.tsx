"use client";

import type { BeautifyBanner, BeautifyPage } from "./beautify-pages";
import { BEAUTIFY_SOURCE_LABEL } from "./beautify-pages";
import { safeReplicateFileUrl, safeReplicateShellSrc } from "./replicate-urls";

export function BeautifyBannerView({ kind, text }: BeautifyBanner) {
  const tone =
    kind === "err"
      ? "bg-danger-soft text-danger"
      : kind === "ok"
        ? "bg-emerald-50 text-emerald-700"
        : "bg-brand-softer text-brand-strong";
  return <p className={`rounded-xl px-4 py-2 text-sm ${tone}`}>{text}</p>;
}

export function BeautifySegmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-full bg-page p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-full px-4 py-1.5 text-sm transition ${
            value === option.value
              ? "bg-card font-medium text-ink shadow-card"
              : "text-ink-2 hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function BeautifyPageCard({
  page,
  index,
  locked,
  onCopy,
  onTweak,
  onRetry,
  onRefine,
}: {
  page: BeautifyPage;
  index: number;
  locked: boolean;
  onCopy: (value: string) => void;
  onTweak: (value: string) => void;
  onRetry: () => void;
  onRefine: () => void;
}) {
  const shellSrc = safeReplicateShellSrc(page.shellUrl);
  const resultSrc = safeReplicateFileUrl(page.imageUrl);
  return (
    <article className="grid gap-4 rounded-2xl border border-line bg-card p-4 shadow-card lg:grid-cols-[200px_1fr_200px]">
      <div>
        {shellSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={`参考稿第 ${index + 1} 页`} src={shellSrc} className="aspect-video w-full rounded-xl bg-page object-contain" />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-xl bg-page text-xs text-ink-3">
            无参考稿
          </div>
        )}
        <p className="mt-2 text-xs text-ink-3">
          参考 · 第 {index + 1} 页
          {page.source ? ` · ${BEAUTIFY_SOURCE_LABEL[page.source] || page.source}` : ""}
        </p>
      </div>
      <div>
        <textarea
          value={page.copy}
          rows={6}
          placeholder="本页新标题和要点，换行分隔"
          onChange={(event) => onCopy(event.target.value)}
          className="w-full resize-y rounded-xl border border-line bg-page px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand-line"
        />
        <input
          value={page.tweak}
          placeholder="可选：生成后再改一句"
          onChange={(event) => onTweak(event.target.value)}
          className="mt-2 w-full rounded-xl border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-brand-line"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={locked || page.busy}
            onClick={onRetry}
            className="rounded-lg bg-page px-3 py-1.5 text-xs text-ink-2 hover:text-brand disabled:opacity-50"
          >
            重试本页
          </button>
          <button
            type="button"
            disabled={locked || page.busy || !page.imageUrl}
            onClick={onRefine}
            className="rounded-lg bg-page px-3 py-1.5 text-xs text-ink-2 hover:text-brand disabled:opacity-50"
          >
            改图
          </button>
        </div>
        <p className={`mt-2 text-xs ${page.error ? "text-danger" : page.imageUrl ? "text-emerald-600" : "text-ink-3"}`}>
          {page.status}
        </p>
      </div>
      <div>
        {resultSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={`美化第 ${index + 1} 页`} src={resultSrc} className="aspect-video w-full rounded-xl bg-page object-contain" />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-xl bg-page text-xs text-ink-3">
            尚未生成
          </div>
        )}
      </div>
    </article>
  );
}
