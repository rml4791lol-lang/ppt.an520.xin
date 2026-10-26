"use client";

import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import type { ShowcaseCase } from "@/data/showcase-cases";

/**
 * Before/After 滑块对比：拖动中间手柄查看「原始 → 生成」对比。
 * 支持鼠标与触摸（pointer events）。
 */
export function BeforeAfterSlider({ item }: { item: ShowcaseCase }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);
  const dragging = useRef(false);

  const update = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(96, Math.max(4, pct)));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    update(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) update(e.clientX);
  };
  const stop = () => {
    dragging.current = false;
  };

  return (
    <div className="flex flex-col rounded-2xl border border-line bg-card p-3 shadow-card">
      <div
        ref={trackRef}
        className="relative aspect-[16/9] w-full cursor-ew-resize touch-none select-none overflow-hidden rounded-xl bg-page"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        role="slider"
        aria-label={`${item.title} 生成前后对比`}
        aria-valuenow={Math.round(pos)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setPos((p) => Math.max(4, p - 5));
          if (e.key === "ArrowRight") setPos((p) => Math.min(96, p + 5));
        }}
      >
        {/* After 垫底（完整） */}
        <Image
          src={item.afterImageUrl}
          alt={`${item.title} 生成后`}
          fill
          sizes="(max-width: 768px) 100vw, 560px"
          className="object-cover"
          draggable={false}
        />
        {/* Before 按位置裁切（clip-path，图层始终保持全幅不变形） */}
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        >
          <Image
            src={item.beforeImageUrl}
            alt={`${item.title} 原始`}
            fill
            sizes="(max-width: 768px) 100vw, 560px"
            className="object-cover"
            draggable={false}
          />
        </div>

        {/* 标签 */}
        <span className="absolute left-2.5 top-2.5 rounded-full bg-dark/80 px-2.5 py-1 text-[11px] font-medium leading-none text-white">
          {item.beforeLabel} · BEFORE
        </span>
        <span className="absolute right-2.5 top-2.5 rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium leading-none text-white">
          {item.afterLabel} · AFTER
        </span>

        {/* 手柄 */}
        <div
          className="absolute inset-y-0"
          style={{ left: `${pos}%` }}
        >
          <div className="absolute inset-y-0 -left-px w-0.5 bg-white/90 shadow" />
          <div className="absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-ink shadow-pop">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m9 6-4 6 4 6M15 6l4 6-4 6" />
            </svg>
          </div>
        </div>
      </div>
      <h3 className="mt-3 px-1 text-[15px] font-semibold text-ink">
        {item.title}
      </h3>
    </div>
  );
}
