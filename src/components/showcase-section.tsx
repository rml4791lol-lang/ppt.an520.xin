import { BeforeAfterSlider } from "@/components/before-after-slider";
import { SHOWCASE_CASES } from "@/data/showcase-cases";

export function ShowcaseSection() {
  return (
    <section className="mt-16">
      <h2 className="text-2xl font-bold tracking-tight text-ink">
        生成效果展示
      </h2>
      <p className="mt-2 text-sm text-ink-3">
        基于真实案例的生成效果展示，AI 每次生成均有不同，仅作参考
      </p>
      <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
        {SHOWCASE_CASES.map((item) => (
          <BeforeAfterSlider key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
