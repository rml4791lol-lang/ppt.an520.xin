import type { Metadata } from "next";
import Link from "next/link";
import { PlusIcon } from "@/components/icons";
import { ProjectsClient } from "@/components/projects/projects-client";

export const metadata: Metadata = {
  title: "项目中心",
  description: "AnPPT 项目中心：全部项目按最近更新时间统一展示。",
  robots: { index: false, follow: false },
};

export default function ProjectsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <p className="text-sm font-medium text-brand">创作空间</p>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">项目中心</h1>
          <p className="mt-2 text-sm text-ink-3">
            “我的项目”和“最近项目”已合并；全部作品按最近更新时间统一排列。
          </p>
        </div>
        <Link
          href="/"
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
        >
          <PlusIcon width={14} height={14} />
          新建生成
        </Link>
      </div>

      <div className="mt-8">
        <ProjectsClient />
      </div>
    </div>
  );
}
