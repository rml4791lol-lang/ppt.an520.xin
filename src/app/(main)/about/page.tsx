import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, HeadsetIcon, LayersIcon, ShieldIcon, SparklesIcon } from "@/components/icons";
import { getSiteConfig } from "@/data/site-config";

export const metadata: Metadata = {
  title: "关于 AnPPT",
  description:
    "AnPPT 是面向真实汇报场景的 AI PPT 工具：先规划结构，再生成设计，最后交付可编辑文件。",
  alternates: { canonical: "/about" },
};

const PRINCIPLES = [
  {
    icon: LayersIcon,
    title: "结构优先",
    text: "先确认大纲和页面逻辑，再进入视觉生成。PPT 首先是讲清楚，其次才是好看。",
  },
  {
    icon: SparklesIcon,
    title: "设计有出处",
    text: "风格包由设计团队维护，强调配色、栅格、字体层级和配图规则，而不是随机堆效果。",
  },
  {
    icon: ShieldIcon,
    title: "交付可检查",
    text: "图片版、可编辑版、扣费和退款记录都可回溯。AI 结果需要人工核验，我们不会把它包装成绝对正确。",
  },
];

export default function AboutPage() {
  const config = getSiteConfig();
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <header className="max-w-3xl">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand">ABOUT ANPPT</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          把做 PPT 的时间，还给内容本身
        </h1>
        <p className="mt-4 text-sm leading-7 text-ink-3">
          AnPPT 面向工作汇报、竞赛路演、政企汇报、教学课件和科研答辩等真实场景。
          我们希望把「读文档、理结构、找参考、排版、改字、导出」串成一条可检查的流程，
          让 AI 负责重复劳动，你保留判断和表达。
        </p>
      </header>

      <section className="mt-12 grid gap-4 md:grid-cols-3">
        {PRINCIPLES.map((item) => (
          <div key={item.title} className="rounded-2xl border border-line bg-card p-6 shadow-card">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <item.icon width={18} height={18} />
            </span>
            <h2 className="mt-4 text-lg font-semibold text-ink">{item.title}</h2>
            <p className="mt-2 text-sm leading-7 text-ink-3">{item.text}</p>
          </div>
        ))}
      </section>

      <section className="mt-14 grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-line bg-card p-6 shadow-card sm:p-8">
          <h2 className="text-2xl font-bold tracking-tight text-ink">我们怎么工作</h2>
          <div className="mt-5 space-y-5 text-sm leading-7 text-ink-3">
            <p>
              <strong className="text-ink">输入：</strong>
              你可以上传 PDF、Word、Markdown、TXT，也可以逐页粘贴文案；
              已有版面想保留时，可以把 PPT 另存为 PDF 使用「PPT 美化」。
            </p>
            <p>
              <strong className="text-ink">规划：</strong>
              系统先把材料整理成大纲和页面结构，确认后再选择风格包生成。
              这一步决定内容是否讲得清楚，也决定后面返工多不多。
            </p>
            <p>
              <strong className="text-ink">生成：</strong>
              每个页面按页型、文案和风格规则生成，失败或中断的部分会按积分规则退回。
            </p>
            <p>
              <strong className="text-ink">交付：</strong>
              默认导出图片版 PPTX；需要继续编辑时，可以按 20🌟/页转可编辑 PPTX，
              单次最多 20 页，导出后建议人工检查字体、图表和版式。
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-line bg-card p-6 shadow-card">
            <h2 className="text-base font-semibold text-ink">适合谁</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-ink-3">
              <li>需要快速完成汇报材料的职场用户</li>
              <li>准备竞赛、路演和答辩的学生与团队</li>
              <li>需要统一视觉风格的政企、科研与教学场景</li>
              <li>已经有完整文档，只差一套成稿的创作者</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-brand-line bg-brand-softer p-6">
            <h2 className="text-base font-semibold text-ink">联系与反馈</h2>
            <p className="mt-3 text-sm leading-6 text-ink-3">
              产品建议、合作咨询或问题反馈，欢迎邮件联系。
            </p>
            <a
              href={`mailto:${config.serviceEmail}`}
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-brand hover:text-brand-strong"
            >
              <HeadsetIcon width={16} height={16} />
              {config.serviceEmail}
            </a>
          </div>
        </div>
      </section>

      <section className="mt-14 flex flex-col items-start justify-between gap-4 rounded-2xl border border-line bg-card p-6 shadow-card sm:flex-row sm:items-center sm:p-8">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">从一份文档开始试试</h2>
          <p className="mt-2 text-sm text-ink-3">注册即送 {config.signupBonusPoints} 🌟，先看清楚流程再决定要不要充值。</p>
        </div>
        <Link
          href="/#start"
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-medium text-white transition hover:bg-brand-strong"
        >
          开始制作
          <ArrowRightIcon width={14} height={14} />
        </Link>
      </section>

      <div className="mt-8 flex flex-wrap gap-4 text-xs text-ink-4">
        <Link href="/help" className="transition hover:text-brand">帮助中心</Link>
        <Link href="/legal/privacy" className="transition hover:text-brand">隐私政策</Link>
        <Link href="/legal/terms" className="transition hover:text-brand">服务条款</Link>
        <Link href="/legal/refund" className="transition hover:text-brand">退款说明</Link>
      </div>
    </div>
  );
}
