"use client";

import { useMemo, useState } from "react";
import { StylePackCard } from "@/components/style-pack-card";
import type { StylePack } from "@/data/style-packs";

const ALL = "全部";

export function StylePackBrowser({
  packs,
  categories,
}: {
  packs: StylePack[];
  categories: string[];
}) {
  const [active, setActive] = useState(ALL);
  const filtered = useMemo(
    () => (active === ALL ? packs : packs.filter((p) => p.category === active)),
    [active, packs],
  );

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {[ALL, ...categories].map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActive(cat)}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              active === cat
                ? "bg-brand font-medium text-white"
                : "bg-card text-ink-2 hover:text-brand"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length > 0 ? (
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {filtered.map((pack) => (
            <StylePackCard key={pack.id} pack={pack} />
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-dashed border-line-strong bg-card px-6 py-16 text-center text-sm text-ink-3">
          该分类的风格包正在设计中，敬请期待
        </div>
      )}
    </div>
  );
}
