import Link from "next/link";
import {
  ArrowRightIcon,
  CheckIcon,
  CoinIcon,
  DownloadIcon,
  FileIcon,
  ImageIcon,
  LayersIcon,
  MonitorIcon,
  ShieldIcon,
  SparklesIcon,
  UploadIcon,
} from "@/components/icons";

const WORKFLOW = [
  {
    icon: UploadIcon,
    title: "导入材料",
    text: "PDF、Word、Markdown、TXT，或直接逐页粘贴文案。",
  },
  {
    icon: LayersIcon,
    title: "确认结构",
    text: "先看大纲、章节和页面逻辑，不合适可以继续调整。",
  },
  {
    icon: SparklesIcon,
    title: "选择风格并生成",
    text: "按场景选设计风格，逐页生成，失败页自动退回。",
  },
  {
    icon: DownloadIcon,
    title: "导出与继续编辑",
    text: "下载图片版 PPTX；需要改字时再转可编辑文件。",
  },
];

const FEATURES = [
  {
    icon: FileIcon,
    title: "多种输入方式",
    text: "文档导入、逐页录入、PDF / 图片美化，覆盖从零开始和已有成稿两种场景。",
  },
  {
    icon: ImageIcon,
    title: "40 页型与风格包",
    text: "赛事、政企、科研、教学、企业汇报等页型，配合设计团队维护的风格规则。",
  },
  {
    icon: MonitorIcon,
    title: "保留画面的 PPT 美化",
    text: "参考稿的构图、道具和画面风格保留，文案换成你的主题或大纲。",
  },
  {
    icon: LayersIcon,
    title: "转可编辑 PPTX",
    text: "把图片版页面转成带文本框和形状的文件，方便二次改字和交给同事。",
  },
  {
    icon: ShieldIcon,
    title: "失败自动退回",
    text: "未完成的页面按积分规则退回，扣费和退款记录都能在积分明细里查。",
  },
  {
    icon: DownloadIcon,
    title: "项目与下载中心",
    text: "项目云端保存，导出文件集中管理，刷新或换设备后仍可继续下载。",
  },
];

const USE_CASES = [
  "工作汇报",
  "竞赛路演",
  "政企汇报",
  "教学课件",
  "科研答辩",
  "商业计划",
  "项目复盘",
  "培训分享",
];

const FAQ = [
  {
    q: "生成的是图片还是可编辑 PPT？",
    a: "默认是图片版 PPTX，适合直接演示。需要改字时可以在生成完成后转可编辑 PPTX（按页计费），单次最多 20 页。",
  },
  {
    q: "支持哪些文件？",
    a: "导入文档支持 TXT、MD、PDF、DOCX；PPT 美化支持 PDF、PNG、JPG、WebP。PPTX 请先另存为 PDF。",
  },
  {
    q: "生成失败会扣星星吗？",
    a: "因平台或上游服务原因未完成的页面会自动退回；已成功生成并交付的页面不支持以不满意为由退款。",
  },
  {
    q: "第一次用，建议从哪开始？",
    a: "准备一份 5–15 页的文档，先走「导入文档 → 确认大纲 → 选风格 → 生成」流程。帮助中心有完整的格式和计费说明。",
  },
];

export function WorkflowSection() {
  return (
    <section className="mt-16">
      <div className="max-w-2xl">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand">HOW IT WORKS</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
          从一份文档到一套成稿
        </h2>
        <p className="mt-3 text-sm leading-7 text-ink-3">
          不是把文字直接塞进模板。先理结构，再定视觉，最后交付可以检查的文件。
        </p>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {WORKFLOW.map((step, index) => (
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
  );
}

export function FeatureSection() {
  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold tracking-[0.16em] text-brand">CAPABILITIES</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            一套流程，覆盖生成、美化和交付
          </h2>
        </div>
        <Link
          href="/help"
          className="inline-flex items-center gap-1 text-sm font-medium text-brand transition hover:text-brand-strong"
        >
          查看使用说明
          <ArrowRightIcon width={14} height={14} />
        </Link>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <div key={feature.title} className="rounded-2xl border border-line bg-card p-5 shadow-card">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <feature.icon width={17} height={17} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-ink">{feature.title}</h3>
            <p className="mt-2 text-sm leading-6 text-ink-3">{feature.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function UseCaseSection() {
  return (
    <section className="mt-16">
      <div className="rounded-2xl border border-line bg-card px-6 py-8 shadow-card sm:px-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-xl">
            <p className="text-sm font-semibold tracking-[0.16em] text-brand">USE CASES</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              为真实汇报场景准备，而不是只做一张好看的封面
            </h2>
            <p className="mt-3 text-sm leading-7 text-ink-3">
              页型、信息密度和叙事节奏会随场景变化。你可以先选一个接近的场景，再用自己的材料调整。
            </p>
          </div>
          <div className="flex max-w-xl flex-wrap gap-2">
            {USE_CASES.map((item) => (
              <span
                key={item}
                className="rounded-full border border-line bg-page px-3.5 py-1.5 text-sm text-ink-2"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function TrustSection() {
  return (
    <section className="mt-16 grid gap-4 md:grid-cols-3">
      {[
        {
          icon: ShieldIcon,
          title: "数据与隐私",
          text: "HTTPS 传输、登录会话和访问控制。文档仅用于完成你发起的服务。",
          href: "/legal/privacy",
          link: "隐私政策",
        },
        {
          icon: CoinIcon,
          title: "计费透明",
          text: "生成按页计费，可编辑导出单独计价，扣费和退回记录可查。",
          href: "/recharge",
          link: "查看扣费明细",
        },
        {
          icon: CheckIcon,
          title: "失败自动退",
          text: "未完成的生成或转换按规则退回，不让你为失败的服务买单。",
          href: "/legal/refund",
          link: "退款说明",
        },
      ].map((item) => (
        <div key={item.title} className="rounded-2xl border border-line bg-card p-5 shadow-card">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
            <item.icon width={17} height={17} />
          </span>
          <h3 className="mt-4 text-base font-semibold text-ink">{item.title}</h3>
          <p className="mt-2 text-sm leading-6 text-ink-3">{item.text}</p>
          <Link
            href={item.href}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand transition hover:text-brand-strong"
          >
            {item.link}
            <ArrowRightIcon width={12} height={12} />
          </Link>
        </div>
      ))}
    </section>
  );
}

export function HomeFaqSection() {
  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold tracking-[0.16em] text-brand">FAQ</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            开始前，你可能想知道
          </h2>
        </div>
        <Link
          href="/help"
          className="inline-flex items-center gap-1 text-sm font-medium text-brand transition hover:text-brand-strong"
        >
          全部问题
          <ArrowRightIcon width={14} height={14} />
        </Link>
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
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
  );
}

export function HomeCtaSection({ signupBonusPoints }: { signupBonusPoints: number }) {
  return (
    <section className="mt-16 rounded-2xl border border-brand-line bg-brand-softer px-6 py-8 sm:px-8">
      <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">从一份文档开始</h2>
          <p className="mt-2 text-sm leading-6 text-ink-3">
            注册即送 {signupBonusPoints} 🌟，先看清楚流程，再决定使用哪个风格。
          </p>
        </div>
        <Link
          href="#start"
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-medium text-white transition hover:bg-brand-strong"
        >
          上传文档
          <ArrowRightIcon width={14} height={14} />
        </Link>
      </div>
    </section>
  );
}
