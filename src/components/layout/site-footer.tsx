import Image from "next/image";
import Link from "next/link";

const LINK_GROUPS: {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
}[] = [
  {
    title: "产品",
    links: [
      { label: "首页", href: "/" },
      { label: "设计风格", href: "/style-packs" },
      { label: "我的项目", href: "/projects" },
    ],
  },
  {
    title: "账户",
    links: [
      { label: "积分明细", href: "/account/credits" },
      { label: "购买与兑换", href: "/recharge" },
    ],
  },
];

export function SiteFooter({
  serviceEmail,
  tutorialUrl,
}: {
  serviceEmail: string;
  tutorialUrl: string;
}) {
  const supportLinks = [
    ...(tutorialUrl
      ? [{ label: "使用指南", href: tutorialUrl, external: true }]
      : []),
    { label: "联系客服", href: `mailto:${serviceEmail}`, external: true },
  ];

  return (
    <footer className="mt-20">
      <div className="grid gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-10">
        <div>
          <div className="flex items-center gap-2.5">
            <Image
              src="/brand/anppt-fish-logo.png"
              alt="AnPPT 品牌 Logo"
              width={611}
              height={414}
              className="h-8 w-auto"
            />
            <span className="text-[17px] font-semibold text-ink">AnPPT</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-ink-3">
            AnPPT · 专业PPT设计机构出品 · 顶尖AI模型加持
          </p>
        </div>
        {LINK_GROUPS.map((group) => (
          <div key={group.title}>
            <h4 className="text-sm font-semibold text-ink">{group.title}</h4>
            <ul className="mt-4 space-y-3">
              {group.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-ink-3 transition hover:text-brand"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <h4 className="text-sm font-semibold text-ink">支持</h4>
          <ul className="mt-4 space-y-3">
            {supportLinks.map((link) => (
              <li key={link.label}>
                <a
                  href={link.href}
                  target={link.external ? "_blank" : undefined}
                  rel={link.external ? "noreferrer" : undefined}
                  className="text-sm text-ink-3 transition hover:text-brand"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-t border-line px-6 py-5 lg:px-10">
        <p className="text-xs text-ink-4">© 2026 AnPPT</p>
      </div>
    </footer>
  );
}
