import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";

const LEGAL_NAV = [
  { href: "/legal/privacy", label: "隐私政策" },
  { href: "/legal/terms", label: "服务条款" },
  { href: "/legal/refund", label: "退款说明" },
  { href: "/help", label: "帮助中心" },
];

export function LegalShell({
  title,
  summary,
  updatedAt,
  children,
}: {
  title: string;
  summary: string;
  updatedAt: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <nav className="text-xs text-ink-4" aria-label="面包屑">
        <Link href="/" className="transition hover:text-brand">
          首页
        </Link>
        <span className="mx-2">/</span>
        <span>规则与条款</span>
        <span className="mx-2">/</span>
        <span className="text-ink-3">{title}</span>
      </nav>

      <header className="mt-5 max-w-3xl">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand">ANPPT LEGAL</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm leading-7 text-ink-3">{summary}</p>
        <p className="mt-3 text-xs text-ink-4">最后更新：{updatedAt}</p>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[220px_1fr]">
        <aside className="h-fit rounded-2xl border border-line bg-card p-3 shadow-card lg:sticky lg:top-6">
          <p className="px-3 py-2 text-xs font-medium text-ink-4">规则导航</p>
          <ul className="space-y-1">
            {LEGAL_NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex items-center justify-between rounded-xl px-3 py-2 text-sm text-ink-2 transition hover:bg-page hover:text-brand"
                >
                  {item.label}
                  <ArrowRightIcon width={13} height={13} />
                </Link>
              </li>
            ))}
          </ul>
        </aside>

        <article className="legal-prose rounded-2xl border border-line bg-card px-5 py-6 shadow-card sm:px-8 sm:py-8">
          {children}
          <div className="mt-10 rounded-xl border border-line bg-page px-4 py-3 text-xs leading-6 text-ink-4">
            本页面为 AnPPT 产品规则说明。若与运营主体正式签署的协议或适用法律存在冲突，以正式协议和适用法律为准。
          </div>
        </article>
      </div>
    </div>
  );
}
