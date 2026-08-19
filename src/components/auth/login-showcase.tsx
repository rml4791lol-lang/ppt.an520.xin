"use client";

import Image from "next/image";
import { useState } from "react";
import { BeforeAfterSlider } from "@/components/before-after-slider";
import type { ShowcaseCase } from "@/data/showcase-cases";

export function LoginShowcase({ cases }: { cases: ShowcaseCase[] }) {
  const [activeId, setActiveId] = useState(cases[0]?.id);
  const active = cases.find((c) => c.id === activeId) ?? cases[0];
  if (!active) return null;

  return (
    <div className="flex h-full flex-col justify-center p-6 sm:p-10">
      <h2 className="text-center text-xl font-bold text-ink">生成效果实测展示</h2>
      <p className="mt-2 text-center text-xs text-ink-3">
        *AI 生成具有随机性，具体生成效果视页面内容而定
      </p>
      <div className="mt-6">
        <BeforeAfterSlider item={active} />
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2.5">
        {cases.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActiveId(c.id)}
            aria-label={`查看案例：${c.title}`}
            className={`relative aspect-[16/9] overflow-hidden rounded-lg border transition ${
              c.id === active.id
                ? "border-brand ring-2 ring-brand/30"
                : "border-line hover:border-brand-line"
            }`}
          >
            <Image
              src={c.afterImageUrl}
              alt={c.title}
              fill
              sizes="120px"
              className="object-cover"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
