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
      { label: "模板库", href: "/style-packs" },
      { label: "PPT 美化", href: "/beautify" },
      { label: "我的项目", href: "/projects" },
      { label: "下载中心", href: "/exports" },
    ],
  },
  {
    title: "资源",
    links: [
      { label: "帮助中心", href: "/help" },
      { label: "关于我们", href: "/about" },
      { label: "购买与兑换", href: "/recharge" },
      { label: "积分明细", href: "/account/credits" },
    ],
  },
  {
    title: "规则",
    links: [
      { label: "隐私政策", href: "/legal/privacy" },
      { label: "服务条款", href: "/legal/terms" },
      { label: "退款说明", href: "/legal/refund" },
    ],
  },
];

export function SiteFooter({
  serviceEmail,
  tutorialUrl,
  companyName,
  icpNumber,
}: {
  serviceEmail: string;
  tutorialUrl: string;
  companyName: string;
  icpNumber: string;
}) {
  const supportLinks = [
    { label: "帮助中心", href: "/help" },
    ...(tutorialUrl
      ? [{ label: "使用指南", href: tutorialUrl, external: true }]
      : []),
    { label: "联系客服", href: `mailto:${serviceEmail}`, external: true },
  ];

  return (
    <footer className="mt-20 border-t border-line bg-card/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr] lg:px-0">
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
          <p className="mt-3 max-w-xs text-sm leading-6 text-ink-3">
            面向真实汇报场景的 AI PPT 工具：先规划结构，再生成设计，最后交付可检查的文件。
          </p>
          <a
            href={`mailto:${serviceEmail}`}
            className="mt-3 inline-block text-xs text-ink-4 transition hover:text-brand"
          >
            {serviceEmail}
          </a>
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

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-5 text-xs text-ink-4 sm:flex-row sm:items-center sm:justify-between lg:px-0">
          <p>
            © {new Date().getFullYear()} {companyName} · AI 生成内容可能存在偏差，请在正式使用前人工核验。
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {icpNumber ? (
              <a
                href="https://beian.miit.gov.cn/"
                target="_blank"
                rel="noreferrer"
                className="transition hover:text-brand"
              >
                {icpNumber}
              </a>
            ) : null}
            <Link href="/legal/privacy" className="transition hover:text-brand">
              隐私政策
            </Link>
            <Link href="/legal/terms" className="transition hover:text-brand">
              服务条款
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
