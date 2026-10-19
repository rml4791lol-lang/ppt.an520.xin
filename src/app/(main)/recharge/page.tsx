import type { Metadata } from "next";
import Link from "next/link";
import { BenefitsCheck, RechargeClient } from "@/components/recharge/recharge-client";
import { PRICING_RULES, RECHARGE_BENEFITS, RECHARGE_PLANS } from "@/data/recharge";

export const metadata: Metadata = {
  title: "购买与兑换",
  description: "AnPPT 积分套餐：不再为 PPT 加班，生成、样稿与图片版导出都从这里开始。",
  alternates: { canonical: "/recharge" },
  robots: { index: false, follow: true },
};

export default function RechargePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <p className="text-sm font-medium text-brand">AnPPT · 上线限时优惠</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">
        不再为 PPT 加班
      </h1>
      <p className="mt-2 text-sm text-ink-3">
        选择合适的积分套餐，生成、样稿与图片版导出都从这里开始。
      </p>

      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-brand-line bg-brand-soft px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-brand">任意充值一次，永久解锁附带服务</p>
          <p className="mt-1 text-xs leading-5 text-ink-3">免费 ONLYOFFICE 下载导航、兼容工具包、可编辑文件衔接与会员问题支持。</p>
        </div>
        <Link href="/tools/onlyoffice" className="shrink-0 text-sm font-medium text-brand hover:text-brand-strong">查看会员权益 →</Link>
      </div>

      <div className="mt-8">
        <RechargeClient plans={RECHARGE_PLANS} />
      </div>

      <section className="mt-16">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          扣费明细 · 星星花在哪里
        </h2>
        <p className="mt-2 text-sm text-ink-3">
          星星只按实际成功的生成动作扣除，标注「免费」的环节不扣星星。
        </p>
        <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-card shadow-card">
          {PRICING_RULES.map((rule, i) => (
            <div key={`${rule.group}-${rule.action}`}>
              {(i === 0 || PRICING_RULES[i - 1].group !== rule.group) && (
                <div className="border-b border-line bg-page px-5 py-2.5 text-xs font-medium text-ink-3">
                  {rule.group}
                </div>
              )}
              <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-line px-5 py-4 last:border-b-0 sm:grid-cols-[200px_1fr_auto]">
                <span className="text-sm font-medium text-ink">{rule.action}</span>
                <span className="hidden text-xs leading-5 text-ink-3 sm:block">
                  {rule.description}
                </span>
                <span className="flex items-center gap-2 text-sm font-medium text-ink">
                  {rule.cost}
                  {rule.badge && (
                    <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">
                      {rule.badge}
                    </span>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          上线权益 · 任一套餐均包含
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-3">
          {RECHARGE_BENEFITS.map((col) => (
            <div
              key={col.title}
              className="rounded-2xl border border-line bg-card p-6 shadow-card"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-base">
                  {col.icon}
                </span>
                <h3 className="text-base font-semibold text-ink">{col.title}</h3>
              </div>
              <ul className="mt-4 space-y-2.5">
                {col.items.map((item) => (
                  <BenefitsCheck key={item.text} text={item.text} badge={item.badge} />
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-ink-3">
          积分规则 / 页面预估 / 常见问题
          <Link href="/help#credits" className="ml-1 font-medium text-brand hover:text-brand-strong">
            查看详细说明 →
          </Link>
        </p>
      </section>
    </div>
  );
}
