"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PlusIcon } from "@/components/icons";

interface Project {
  id: string;
  title?: string;
  name?: string;
  projectType?: string;
  updatedAt?: string;
  createdAt?: string;
  coverUrl?: string | null;
}

export function ProjectsClient() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setUnauthorized(false);
    try {
      const res = await fetch("/api/projects?pageSize=50", { cache: "no-store" });
      if (res.status === 401) {
        setUnauthorized(true);
        setProjects(null);
        return;
      }
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        const list = json.data?.projects ?? json.data?.items ?? json.data;
        if (Array.isArray(list)) setProjects(list);
        else setProjects([]);
      }
    } catch {
      /* 后端未就绪时保持占位 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div id="recent" className="space-y-5">
      {unauthorized && (
        <div className="flex items-center justify-between rounded-2xl border border-danger/20 bg-danger-soft px-5 py-4">
          <p className="text-sm text-danger">请先登录后再操作</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void load()}
              className="text-sm font-medium text-danger hover:underline"
            >
              重新加载
            </button>
            <Link
              href="/login?next=%2Fprojects"
              className="rounded-full bg-dark px-4 py-1.5 text-xs font-medium text-white"
            >
              去登录
            </Link>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-line bg-card px-6 py-24 text-center text-sm text-ink-3 shadow-card">
          加载中…
        </div>
      ) : projects && projects.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={p.projectType === "single-page" ? `/single-page?projectId=${p.id}` : `/deck/${p.id}`}
              className="group rounded-2xl border border-line bg-card p-4 shadow-card transition hover:shadow-pop"
            >
              <div className="flex aspect-[16/9] items-center justify-center rounded-xl bg-page text-ink-4">
                {p.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.coverUrl}
                    alt={`${p.title ?? p.name ?? "项目"} 封面`}
                    className="h-full w-full rounded-xl object-cover"
                  />
                ) : (
                  <span className="text-xs">暂无预览</span>
                )}
              </div>
              <p className="mt-3 truncate text-sm font-medium text-ink">
                {p.title ?? p.name ?? "未命名项目"}
              </p>
              <p className="mt-1 text-xs text-ink-4">
                {p.updatedAt ?? p.createdAt
                  ? `更新于 ${new Date(p.updatedAt ?? p.createdAt!).toLocaleString("zh-CN")}`
                  : ""}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-line bg-card px-6 py-24 text-center shadow-card">
          <p className="text-base font-semibold text-ink">还没有项目</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-3">
            从首页或创意页面生成器开始创建项目，创建后的项目都会出现在这里。
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <PlusIcon width={14} height={14} />
            去创建第一个项目
          </Link>
        </div>
      )}
    </div>
  );
}
