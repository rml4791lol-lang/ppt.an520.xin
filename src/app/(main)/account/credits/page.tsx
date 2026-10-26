import type { Metadata } from "next";
import Link from "next/link";
import { CreditsClient } from "@/components/account/credits-client";

export const metadata: Metadata = {
  title: "积分明细",
  description: "查看每个项目的星星使用、生成中占用和退回记录。",
  robots: { index: false, follow: false },
};

export default function CreditsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <p className="text-sm font-medium text-brand">账号与权益</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">积分明细</h1>
          <p className="mt-2 text-sm text-ink-3">
            查看每个项目的星星使用、生成中占用和退回记录。
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Link
            href="/recharge?tab=redeem"
            className="rounded-full bg-brand-soft px-5 py-2 text-sm font-medium text-brand transition hover:bg-brand-line"
          >
            兑换积分
          </Link>
          <Link
            href="/recharge"
            className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            购买积分
          </Link>
        </div>
      </div>

      <div className="mt-8">
        <CreditsClient />
      </div>
    </div>
  );
}
