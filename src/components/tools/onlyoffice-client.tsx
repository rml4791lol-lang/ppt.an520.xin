"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CheckIcon,
  CoinIcon,
  DownloadIcon,
  FileIcon,
  MonitorIcon,
  SparklesIcon,
} from "@/components/icons";

interface MeView {
  loggedIn: boolean;
  unlocked: boolean;
}

interface ReleaseAssetView {
  filename: string;
  size: number;
  sha256: string;
}

interface ReleaseView {
  version: string;
  publishedAt: string;
  assets: Record<"x64" | "x86" | "arm64", ReleaseAssetView>;
}

const FALLBACK_RELEASE: ReleaseView = {
  version: "9.4.0",
  publishedAt: "2026-05-19T09:55:56Z",
  assets: {
    x64: {
      filename: "DesktopEditors_x64.exe",
      size: 373_575_296,
      sha256: "a3b4a7353946a2d836eadfb8f59799f98b906ab961421c05c0bee00be9307a9f",
    },
    x86: {
      filename: "DesktopEditors_x86.exe",
      size: 351_950_968,
      sha256: "9c555431bf1dd5c68f0c6a2bf213027bb936e50752175120373a54565b56020f",
    },
    arm64: {
      filename: "DesktopEditors_arm64.exe",
      size: 339_981_432,
      sha256: "52c5650d516901265585a960aca5326599defdaa947092e8181779da570e9d34",
    },
  },
};

const INSTALLERS = [
  {
    arch: "x64" as const,
    title: "Windows x64",
    eyebrow: "推荐",
    description: "适合绝大多数 Intel / AMD 64 位 Windows 电脑。",
  },
  {
    arch: "x86" as const,
    title: "Windows x86",
    eyebrow: "旧设备",
    description: "仅用于仍在运行 32 位 Windows 的较老电脑。",
  },
  {
    arch: "arm64" as const,
    title: "Windows ARM64",
    eyebrow: "ARM 设备",
    description: "适合骁龙等 ARM 架构的 Windows 电脑。",
  },
];

const COMPARISON_ROWS = [
  {
    label: "付费方式",
    anppt: "任意充值一次，长期解锁下载入口与附带服务",
    subscription: "高级云服务、AI、模板等权益常按月或按年订阅",
  },
  {
    label: "到期以后",
    anppt: "下载入口、兼容工具包与衔接服务不设会员到期",
    subscription: "订阅权益通常在到期后结束或降级",
  },
  {
    label: "桌面软件",
    anppt: "ONLYOFFICE Desktop Editors 本身开源免费",
    subscription: "基础编辑可能免费；高级权益按具体产品与授权计算",
  },
  {
    label: "演示文稿",
    anppt: "本地打开、编辑 PPTX / PPT / ODP",
    subscription: "通常支持，兼容范围与高级能力因产品而异",
  },
  {
    label: "PDF 与本地文件",
    anppt: "可本地导出 PDF，文件可以留在自己的电脑",
    subscription: "多数可导出；部分增值 PDF 或云能力可能需会员",
  },
  {
    label: "AnPPT 衔接",
    anppt: "下载中心、可编辑转换、兼容清单与问题指引",
    subscription: "通常不包含 AnPPT 文件衔接与本站兼容支持",
  },
];

function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatReleaseDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function BenefitAction({ me, compact = false }: { me: MeView | null; compact?: boolean }) {
  const className = compact
    ? "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
    : "inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#101114] transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#101114]";

  if (!me) {
    return <span className={`${className} cursor-wait opacity-60`}>正在确认权益…</span>;
  }
  if (me.unlocked) {
    return (
      <a href="#windows-downloads" className={className}>
        <DownloadIcon width={16} height={16} />
        选择 Windows 版本
      </a>
    );
  }
  if (me.loggedIn) {
    return (
      <Link href="/recharge?benefit=onlyoffice" className={className}>
        <CoinIcon width={16} height={16} />
        充值任意套餐后解锁
      </Link>
    );
  }
  return (
    <Link href="/login?next=%2Ftools%2Fonlyoffice" className={className}>
      登录后解锁下载
    </Link>
  );
}

export function OnlyOfficeClient() {
  const [me, setMe] = useState<MeView | null>(null);
  const [release, setRelease] = useState<ReleaseView>(FALLBACK_RELEASE);

  useEffect(() => {
    let cancelled = false;

    const loadMe = fetch("/api/auth/session", { cache: "no-store" })
      .then(async (sessionResponse) => {
        const session = await sessionResponse.json().catch(() => null);
        if (!sessionResponse.ok || !session?.ok || !session.data?.authenticated) {
          return { loggedIn: false, unlocked: false };
        }
        const meResponse = await fetch("/api/me", { cache: "no-store" });
        const mePayload = await meResponse.json().catch(() => null);
        return {
          loggedIn: Boolean(meResponse.ok && mePayload?.ok),
          unlocked: Boolean(meResponse.ok && mePayload?.data?.benefits?.onlyOfficeToolkit),
        };
      })
      .catch(() => ({ loggedIn: false, unlocked: false }));

    const loadRelease = fetch("/api/tools/onlyoffice/release", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        return response.ok && payload?.ok && payload.data?.assets
          ? (payload.data as ReleaseView)
          : FALLBACK_RELEASE;
      })
      .catch(() => FALLBACK_RELEASE);

    Promise.all([loadMe, loadRelease]).then(([nextMe, nextRelease]) => {
      if (cancelled) return;
      setMe(nextMe);
      setRelease(nextRelease);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-0">
      <section className="relative overflow-hidden rounded-[28px] bg-[#101114] text-white shadow-card">
        <div className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-36 left-1/3 h-72 w-72 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="relative grid gap-9 px-6 py-9 sm:px-10 sm:py-12 lg:grid-cols-[1.12fr_.88fr] lg:items-center lg:px-12 lg:py-14">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs font-medium text-white/80">
              <SparklesIcon width={14} height={14} />
              会员附带服务 · 一次充值永久解锁
            </span>
            <h1 className="mt-5 max-w-3xl text-3xl font-bold leading-[1.12] tracking-tight sm:text-4xl lg:text-[46px]">
              不用为了继续编辑 PPT，<span className="text-emerald-300">反复续费。</span>
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-7 text-white/65 sm:text-base">
              AnPPT 已充值用户可永久使用三套 Windows 一键下载、版本校验与兼容服务。
              安装的是第三方开源免费的 ONLYOFFICE Desktop Editors，可作为 PowerPoint、WPS 演示之外的日常本地编辑选择。
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <BenefitAction me={me} />
              <span className="text-xs leading-5 text-white/45">没有下一年续费，也没有安装包会员到期。</span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <article className="rounded-3xl border border-emerald-300/25 bg-emerald-300/10 p-6">
              <p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-200">AnPPT 附带方案</p>
              <p className="mt-4 text-4xl font-bold tracking-tight">1 次</p>
              <p className="mt-1 text-sm text-white/70">充值后长期解锁</p>
              <ul className="mt-5 space-y-2.5 text-sm text-white/80">
                <li className="flex gap-2"><CheckIcon className="mt-0.5 shrink-0 text-emerald-300" width={16} height={16} />三个 Windows 安装包</li>
                <li className="flex gap-2"><CheckIcon className="mt-0.5 shrink-0 text-emerald-300" width={16} height={16} />兼容工具包与文件衔接</li>
                <li className="flex gap-2"><CheckIcon className="mt-0.5 shrink-0 text-emerald-300" width={16} height={16} />无需按年续费此项权益</li>
              </ul>
            </article>
            <article className="rounded-3xl border border-white/10 bg-white/5 p-6">
              <p className="text-xs font-semibold uppercase tracking-[.18em] text-white/45">常见订阅型高级权益</p>
              <p className="mt-4 text-4xl font-bold tracking-tight text-white/55">每年</p>
              <p className="mt-1 text-sm text-white/45">到期后通常需要续订</p>
              <p className="mt-5 text-sm leading-6 text-white/50">
                AI、云空间、模板库、部分 PDF 工具等增值能力，常随月度或年度会员提供；具体以各产品规则为准。
              </p>
            </article>
          </div>
        </div>
      </section>

      <section id="windows-downloads" className="scroll-mt-6 pt-12 sm:pt-14">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-brand">Windows 一键下载</p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">选对你的电脑版本，点击就开始下载</h2>
          </div>
          <p className="text-xs text-ink-4">
            当前版本 {release.version} · {formatReleaseDate(release.publishedAt)}
          </p>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-3">
          {INSTALLERS.map((installer) => {
            const asset = release.assets[installer.arch] ?? FALLBACK_RELEASE.assets[installer.arch];
            const downloadHref = `/api/tools/onlyoffice/download/${installer.arch}`;
            return (
              <article
                key={installer.arch}
                className={`relative flex min-h-[330px] flex-col rounded-3xl border bg-card p-6 shadow-card ${
                  installer.arch === "x64" ? "border-brand-line ring-1 ring-brand-line" : "border-line"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                    <MonitorIcon width={21} height={21} />
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    installer.arch === "x64" ? "bg-brand text-white" : "bg-page text-ink-3"
                  }`}>
                    {installer.eyebrow}
                  </span>
                </div>
                <h3 className="mt-5 text-xl font-bold text-ink">{installer.title}</h3>
                <p className="mt-2 min-h-12 text-sm leading-6 text-ink-3">{installer.description}</p>
                <div className="mt-5 flex items-center gap-2 text-xs text-ink-4">
                  <FileIcon width={15} height={15} />
                  <span>{asset.filename}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatSize(asset.size)}</span>
                </div>

                <div className="mt-auto pt-6">
                  {me?.unlocked ? (
                    <a
                      href={downloadHref}
                      download={asset.filename}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                      <DownloadIcon width={17} height={17} />
                      立即下载 {installer.arch.toUpperCase()}
                    </a>
                  ) : (
                    <BenefitAction me={me} compact />
                  )}
                  <details className="group mt-3 rounded-xl bg-page px-3 py-2.5 text-xs text-ink-4">
                    <summary className="cursor-pointer select-none font-medium text-ink-3">查看 SHA-256 校验值</summary>
                    <code className="mt-2 block break-all font-mono text-[10px] leading-4 text-ink-4">{asset.sha256}</code>
                  </details>
                </div>
              </article>
            );
          })}
        </div>
        <p className="mt-4 text-xs leading-5 text-ink-4">
          不确定选哪个？绝大多数电脑选择 x64。只有“系统类型”明确写着 32 位时选 x86；骁龙 Windows 电脑通常选 ARM64。
        </p>
      </section>

      <section className="mt-14 overflow-hidden rounded-[28px] border border-line bg-card shadow-card">
        <div className="border-b border-line px-6 py-7 sm:px-9">
          <p className="text-sm font-semibold text-brand">把账算清楚</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">一次解锁，和持续订阅有什么不同？</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-3">
            我们不把第三方免费软件包装成自研产品。你充值获得的是星星，以及 AnPPT 提供的长期下载、校验、兼容与文件衔接服务。
          </p>
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="w-[18%] bg-page px-6 py-4 font-medium text-ink-3">对比项目</th>
                <th className="w-[41%] bg-brand px-6 py-4 font-semibold text-white">AnPPT 充值附带方案</th>
                <th className="w-[41%] bg-[#202126] px-6 py-4 font-semibold text-white/75">常见订阅型办公套件高级服务</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.label} className="border-t border-line align-top">
                  <th className="bg-page/70 px-6 py-4 font-semibold text-ink">{row.label}</th>
                  <td className="px-6 py-4 leading-6 text-ink-2">
                    <span className="flex gap-2">
                      <CheckIcon className="mt-1 shrink-0 text-brand" width={15} height={15} />
                      {row.anppt}
                    </span>
                  </td>
                  <td className="px-6 py-4 leading-6 text-ink-3">{row.subscription}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-line md:hidden">
          {COMPARISON_ROWS.map((row) => (
            <article key={row.label} className="px-5 py-5">
              <h3 className="text-sm font-bold text-ink">{row.label}</h3>
              <div className="mt-3 rounded-2xl bg-brand-soft p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-brand">AnPPT 充值附带方案</p>
                <p className="mt-2 flex gap-2 text-sm leading-6 text-ink-2">
                  <CheckIcon className="mt-1 shrink-0 text-brand" width={15} height={15} />
                  {row.anppt}
                </p>
              </div>
              <div className="mt-2 rounded-2xl bg-page p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-ink-4">常见订阅型高级服务</p>
                <p className="mt-2 text-sm leading-6 text-ink-3">{row.subscription}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-10 grid gap-5 md:grid-cols-3">
        {[
          {
            icon: DownloadIcon,
            title: "版本帮你整理好",
            text: "不用跳转官网翻列表。三个 Windows 架构、版本、大小和校验值都在一个页面。",
          },
          {
            icon: MonitorIcon,
            title: "接住可编辑结果",
            text: "从 AnPPT 下载可编辑 PPTX 后，可直接本地打开继续改字、排版、演示并导出 PDF。",
          },
          {
            icon: CheckIcon,
            title: "交付前少踩坑",
            text: "附带字体、页眉 Logo、动画和版式兼容清单。好作品值得多检查一遍。",
          },
        ].map(({ icon: Icon, title, text }) => (
          <article key={title} className="rounded-2xl border border-line bg-card p-6 shadow-card">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <Icon width={19} height={19} />
            </span>
            <h3 className="mt-4 font-semibold text-ink">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-ink-3">{text}</p>
          </article>
        ))}
      </section>

      <section className="mt-8 rounded-2xl border border-line bg-page px-5 py-4 text-xs leading-5 text-ink-4 sm:px-6">
        <strong className="font-semibold text-ink-3">说明：</strong>
        ONLYOFFICE Desktop Editors 是第三方开源软件，不是 AnPPT 自研产品。软件本身遵循其原始开源许可证；
        AnPPT 充值对应星星与长期附带服务，不是软件销售或授权费。复杂宏、少数高级动画、特殊字体和专有对象可能存在兼容差异。
      </section>
    </div>
  );
}
