import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  BookIcon,
  CheckIcon,
  CoinIcon,
  DownloadIcon,
  FileIcon,
  HeadsetIcon,
  ImageIcon,
  LayersIcon,
  MonitorIcon,
  ShieldIcon,
  SparklesIcon,
  UploadIcon,
} from "@/components/icons";
import { getSiteConfig } from "@/data/site-config";

export const metadata: Metadata = {
  title: "帮助中心",
  description:
    "AnPPT 使用指南：支持的文件格式、生成流程、PPT 美化、转可编辑、积分与退款、账号与安全。",
  alternates: { canonical: "/help" },
};

const QUICK_LINKS = [
  { href: "#formats", label: "支持的文件格式", icon: FileIcon },
  { href: "#workflow", label: "从文档到 PPT", icon: SparklesIcon },
  { href: "#beautify", label: "PPT 美化", icon: MonitorIcon },
  { href: "#editable", label: "转可编辑 PPTX", icon: LayersIcon },
  { href: "#credits", label: "积分与退款", icon: CoinIcon },
  { href: "#faq", label: "常见问题", icon: BookIcon },
];

const FORMAT_ROWS = [
  {
    scene: "导入文档生成",
    formats: "TXT / MD / PDF / DOCX",
    limit: "单文件 ≤ 30MB；解析文字上限 100,000 字",
    note: "PDF 按页读取文字；扫描版 PDF 如果没有文字层，需要先做 OCR。",
  },
  {
    scene: "按页录入",
    formats: "直接粘贴文字",
    limit: "单页 ≤ 1,500 字；整套 1–40 页",
    note: "适合已经有逐页文案、只希望 AI 排版和配图的情况。",
  },
  {
    scene: "PPT 美化",
    formats: "PDF / PNG / JPG / WebP",
    limit: "单文件 ≤ 30MB；一次最多 40 页",
    note: "PPTX 请先在 PowerPoint / WPS 中另存为 PDF，再上传。",
  },
  {
    scene: "转可编辑 PPTX",
    formats: "站内作品 / PDF / 图片",
    limit: "单次最多 20 页；20🌟/页",
    note: "还原程度受页面复杂度、字体和上游服务影响，导出后建议人工检查。",
  },
];

const FAQ = [
  {
    q: "生成出来的是图片还是可编辑 PPT？",
    a: "默认生成的是图片版 PPT，视觉效果稳定，适合直接演示和汇报。需要文字、形状可编辑时，可以在生成完成后选择「转可编辑 PPTX」，按 20🌟/页计费，单次最多 20 页。",
  },
  {
    q: "为什么上传 PDF 后提示解析失败？",
    a: "常见原因有：文件超过 30MB、PDF 加密需要密码、扫描版没有文字层、文件扩展名与实际格式不一致。可以先解除密码、压缩文件，或把扫描页做 OCR 后再上传。若仍失败，请把文件名和错误提示发给客服。",
  },
  {
    q: "生成失败了，星星会退吗？",
    a: "因平台或上游服务原因导致未完成的部分会自动退回，记录可以在「积分明细」查看。已经成功生成并交付的页面不支持以不满意为由退款。详细规则见退款说明。",
  },
  {
    q: "超过 20 页还能转可编辑吗？",
    a: "目前单次转可编辑上限是 20 页。超过 20 页可以拆成多个项目分别导出，或者先导出图片版 PPTX 使用。页面上会在生成前提示限制。",
  },
  {
    q: "可以上传自己的 PPT 模板吗？",
    a: "当前支持把自己的 PPT 另存为 PDF 后做「PPT 美化」，保留原页面画面并替换文案。直接上传 PPTX 作为母版的功能还在规划中，暂未开放。",
  },
  {
    q: "我的文档和生成内容安全吗？",
    a: "我们使用 HTTPS 传输、登录会话和访问控制保护数据。文档与生成内容仅用于完成你发起的服务，并可能交由 AI 模型或图片服务商处理。不要上传与你无关的敏感个人信息或未获授权的材料。更多说明见隐私政策。",
  },
  {
    q: "支持手机使用吗？",
    a: "网站采用响应式布局，手机可以上传文件、查看项目和下载结果。复杂编辑和大量页面生成建议使用桌面浏览器，内存和操作体验更稳定。",
  },
  {
    q: "遇到问题怎么联系客服？",
    a: "发送邮件到服务邮箱，附上账号、项目名称、任务时间和截图。我们通常会在 1 个工作日内回复。",
  },
];

export default function HelpPage() {
  const config = getSiteConfig();
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <header className="max-w-3xl">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand">HELP CENTER</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          帮助中心
        </h1>
        <p className="mt-3 text-sm leading-7 text-ink-3">
          从支持的文件格式到积分退款，这里汇总了使用 AnPPT 最常遇到的问题。
          如果仍然找不到答案，可以直接联系客服。
        </p>
      </header>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {QUICK_LINKS.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="group flex items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3.5 shadow-card transition hover:border-brand-line"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <item.icon width={17} height={17} />
            </span>
            <span className="text-sm font-medium text-ink">{item.label}</span>
            <ArrowRightIcon
              width={14}
              height={14}
              className="ml-auto text-ink-4 transition group-hover:text-brand"
            />
          </a>
        ))}
      </div>

      <section id="workflow" className="mt-14 scroll-mt-6">
        <h2 className="text-2xl font-bold tracking-tight text-ink">从文档到成稿，四步完成</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {[
            { icon: UploadIcon, title: "导入", text: "上传 PDF / Word / Markdown，或逐页粘贴文案。" },
            { icon: SparklesIcon, title: "规划", text: "先确认大纲、章节和页面结构，再进入生成。" },
            { icon: ImageIcon, title: "生成", text: "选择设计风格，逐页生成图片版页面。" },
            { icon: DownloadIcon, title: "导出", text: "下载图片版 PPTX，或按需转可编辑 PPTX。" },
          ].map((step, index) => (
            <div key={step.title} className="rounded-2xl border border-line bg-card p-5 shadow-card">
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
                  <step.icon width={17} height={17} />
                </span>
                <span className="text-xs font-semibold tracking-[0.18em] text-ink-4">
                  0{index + 1}
                </span>
              </div>
              <h3 className="mt-4 text-base font-semibold text-ink">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-ink-3">{step.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="formats" className="mt-14 scroll-mt-6">
        <h2 className="text-2xl font-bold tracking-tight text-ink">支持的文件格式与限制</h2>
        <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-card shadow-card">
          <div className="hidden grid-cols-[150px_190px_1fr] gap-4 border-b border-line bg-page px-5 py-3 text-xs font-medium text-ink-3 md:grid">
            <span>使用场景</span>
            <span>支持格式 / 限制</span>
            <span>说明</span>
          </div>
          {FORMAT_ROWS.map((row) => (
            <div
              key={row.scene}
              className="grid gap-2 border-b border-line px-5 py-4 last:border-b-0 md:grid-cols-[150px_190px_1fr] md:gap-4"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <CheckIcon width={14} height={14} className="text-brand" />
                {row.scene}
              </div>
              <div className="text-xs leading-6 text-ink-2">
                <p>{row.formats}</p>
                <p className="text-ink-4">{row.limit}</p>
              </div>
              <p className="text-xs leading-6 text-ink-3">{row.note}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="beautify" className="mt-14 scroll-mt-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-6 shadow-card">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <MonitorIcon width={17} height={17} />
              </span>
              <h2 className="text-xl font-bold tracking-tight text-ink">PPT 美化</h2>
            </div>
            <p className="mt-4 text-sm leading-7 text-ink-3">
              上传 PDF 或图片作为参考稿，AnPPT 会保留原页面的构图、道具和画面风格，
              把你提供的主题、大纲或材料替换成新的文案。适合已有完整版面、只想换内容的场景。
            </p>
            <ul className="mt-4 space-y-2 text-sm leading-6 text-ink-2">
              <li className="flex gap-2"><CheckIcon width={14} height={14} className="mt-1 text-brand" />一次最多 40 页，单文件不超过 30MB。</li>
              <li className="flex gap-2"><CheckIcon width={14} height={14} className="mt-1 text-brand" />PPTX 请先另存为 PDF，浏览器无法直接把 PPTX 拆成位图。</li>
              <li className="flex gap-2"><CheckIcon width={14} height={14} className="mt-1 text-brand" />生成按 10🌟/页计费，失败未完成部分自动退回。</li>
            </ul>
            <Link href="/beautify" className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-strong">
              打开 PPT 美化 <ArrowRightIcon width={14} height={14} />
            </Link>
          </div>

          <div id="editable" className="scroll-mt-6 rounded-2xl border border-line bg-card p-6 shadow-card">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <LayersIcon width={17} height={17} />
              </span>
              <h2 className="text-xl font-bold tracking-tight text-ink">转可编辑 PPTX</h2>
            </div>
            <p className="mt-4 text-sm leading-7 text-ink-3">
              生成完成后，可以把图片版页面转换为带文本框和形状的可编辑 PPTX。
              适合需要二次改字、换配色或交给同事继续编辑的场合。
            </p>
            <ul className="mt-4 space-y-2 text-sm leading-6 text-ink-2">
              <li className="flex gap-2"><CheckIcon width={14} height={14} className="mt-1 text-brand" />20🌟/页，单次最多 20 页。</li>
              <li className="flex gap-2"><CheckIcon width={14} height={14} className="mt-1 text-brand" />转换完成后在「下载中心」获取，不重复扣费。</li>
              <li className="flex gap-2"><CheckIcon width={14} height={14} className="mt-1 text-brand" />复杂图表和特殊字体的还原度会有差异，请导出后检查。</li>
            </ul>
            <Link href="/exports" className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-strong">
              前往下载中心 <ArrowRightIcon width={14} height={14} />
            </Link>
          </div>
        </div>
      </section>

      <section id="credits" className="mt-14 scroll-mt-6">
        <h2 className="text-2xl font-bold tracking-tight text-ink">积分与退款</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[
            { title: "注册赠送", value: `${config.signupBonusPoints} 🌟`, text: "新用户注册后自动到账，可直接用于生成。" },
            { title: "页面生成", value: `${config.pointsPerPage} 🌟/页`, text: "标准模式按实际成功的页面扣除，失败未完成部分退回。" },
            { title: "可编辑导出", value: "20 🌟/页", text: "转换成功才扣费；上游失败会退回，单次最多 20 页。" },
          ].map((item) => (
            <div key={item.title} className="rounded-2xl border border-line bg-card p-5 shadow-card">
              <p className="text-xs text-ink-4">{item.title}</p>
              <p className="mt-2 text-2xl font-bold tracking-tight text-brand">{item.value}</p>
              <p className="mt-2 text-sm leading-6 text-ink-3">{item.text}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <Link href="/recharge" className="inline-flex items-center gap-1.5 font-medium text-brand hover:text-brand-strong">
            查看充值套餐 <ArrowRightIcon width={14} height={14} />
          </Link>
          <Link href="/legal/refund" className="text-ink-3 transition hover:text-brand">
            退款说明
          </Link>
          <Link href="/account/credits" className="text-ink-3 transition hover:text-brand">
            积分明细
          </Link>
        </div>
      </section>

      <section id="faq" className="mt-14 scroll-mt-6">
        <h2 className="text-2xl font-bold tracking-tight text-ink">常见问题</h2>
        <div className="mt-6 space-y-3">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group rounded-2xl border border-line bg-card px-5 py-4 shadow-card"
            >
              <summary className="cursor-pointer list-none text-sm font-medium text-ink marker:hidden">
                <span className="flex items-center justify-between gap-4">
                  {item.q}
                  <span className="text-lg leading-none text-ink-4 transition group-open:rotate-45">+</span>
                </span>
              </summary>
              <p className="mt-3 border-t border-line pt-3 text-sm leading-7 text-ink-3">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </section>

      <section id="contact" className="mt-14 scroll-mt-6 rounded-2xl border border-brand-line bg-brand-softer p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <HeadsetIcon width={18} height={18} />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-ink">还需要帮助？</h2>
              <p className="mt-1 text-sm leading-6 text-ink-3">
                发送账号、项目名称、任务时间和截图到 {config.serviceEmail}，我们通常会在 1 个工作日内回复。
              </p>
            </div>
          </div>
          <a
            href={`mailto:${config.serviceEmail}`}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <HeadsetIcon width={16} height={16} />
            联系客服
          </a>
        </div>
      </section>

      <div className="mt-8 flex flex-wrap items-center gap-4 text-xs text-ink-4">
        <Link href="/legal/privacy" className="transition hover:text-brand">隐私政策</Link>
        <Link href="/legal/terms" className="transition hover:text-brand">服务条款</Link>
        <Link href="/legal/refund" className="transition hover:text-brand">退款说明</Link>
        <span className="inline-flex items-center gap-1">
          <ShieldIcon width={13} height={13} /> 账号与数据安全说明
        </span>
      </div>
    </div>
  );
}
