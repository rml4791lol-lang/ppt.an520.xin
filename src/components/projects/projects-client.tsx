"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PlusIcon } from "@/components/icons";
import { beautifyHref } from "@/modules/ppt-replicate/client/replicate-urls";

interface Project {
  id: string;
  title?: string;
  name?: string;
  projectType?: string;
  source?: "single" | "replicate";
  updatedAt?: string;
  createdAt?: string;
  coverUrl?: string | null;
}

export function ProjectsClient() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setUnauthorized(false);
    try {
      const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const session = await sessionResponse.json().catch(() => null);
      if (!sessionResponse.ok || !session?.ok || !session.data?.authenticated) {
        setUnauthorized(true);
        setProjects(null);
        return;
      }
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
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const remove = async (id: string) => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "DELETE",
        headers: { "x-anppt-action": "1" },
      });
      if (res.ok) {
        setConfirmingId(null);
        await load();
      } else {
        setError("删除失败，请稍后重试");
      }
    } catch {
      setError("网络异常，删除失败");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div id="recent" className="space-y-5">
      {error && (
        <p className="rounded-xl bg-danger-soft px-4 py-2.5 text-sm text-danger">{error}</p>
      )}
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
      ) : unauthorized ? null : projects && projects.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <div key={p.id} className="group relative">
              <Link
                href={
                  p.source === "replicate"
                    ? beautifyHref(p.id)
                    : p.projectType === "single-page"
                      ? `/single-page?projectId=${p.id}`
                      : `/deck/${p.id}`
                }
                className="block rounded-2xl border border-line bg-card p-4 shadow-card transition hover:shadow-pop"
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
                  {p.source === "replicate" ? "美化 · " : ""}
                  {p.title ?? p.name ?? "未命名项目"}
                </p>
                <p className="mt-1 text-xs text-ink-4">
                  {p.updatedAt ?? p.createdAt
                    ? `更新于 ${new Date(p.updatedAt ?? p.createdAt!).toLocaleString("zh-CN")}`
                    : ""}
                </p>
              </Link>
              {confirmingId === p.id ? (
                <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 shadow-pop">
                  <span className="text-[11px] text-ink-3">确认删除？</span>
                  <button
                    type="button"
                    disabled={removing}
                    onClick={() => void remove(p.id)}
                    className="rounded-full bg-danger-soft px-2.5 py-0.5 text-[11px] font-medium text-danger transition hover:bg-danger/15 disabled:opacity-50"
                  >
                    {removing ? "删除中…" : "删除"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(null)}
                    className="rounded-full px-2 py-0.5 text-[11px] text-ink-4 transition hover:text-ink"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={`删除项目 ${p.title ?? p.name ?? ""}`}
                  onClick={() => setConfirmingId(p.id)}
                  className="absolute right-2 top-2 z-10 rounded-full border border-line bg-card/95 px-2.5 py-1 text-[11px] text-ink-4 shadow-card transition hover:border-danger/30 hover:text-danger"
                >
                  删除
                </button>
              )}
            </div>
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
