"use client";

// 单页生成器（创意页面生成器）/single-page 根组件（SINGLEPAGE-UI-SPEC 施工图）。
// 三栏：左 页面队列 / 中 画布+步骤条 / 右 按步面板（选风格 ↔ 导出）。
// 未登录可编辑草稿（localStorage），点生成时 401 → 跳登录；回来后草稿自动恢复。
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ImageIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
} from "@/components/icons";
import { ApiClientError, getSession } from "@/lib/client/api";
import {
  exportSinglePagesImagePptx,
  generateSinglePage,
  getSinglePageProject,
  refineSinglePage,
  selectSinglePageVersion,
  startSingleEditableExport,
  uploadAsset,
} from "@/lib/client/single-page-api";
import {
  estimateCredits,
  getCreditBalance,
  renameProject,
} from "@/lib/client/deck-api";
import {
  singlePageActionDefinition,
  type SinglePageAction,
  type SinglePageActionOutcome,
  type SinglePageGenerateAction,
  type SinglePageRefineAction,
  type SinglePageSelectVersionAction,
} from "@/lib/client/single-page-actions";
import { useSinglePageActions } from "@/components/single-page/use-single-page-actions";
import { beautifyHref } from "@/modules/ppt-replicate/client/replicate-urls";
import {
  createPage,
  loadDraft,
  pageStep,
  pasteHint,
  saveDraft,
  SP_MAX_PAGES,
  SP_STATUS_LABEL,
  type SpPage,
} from "@/lib/client/single-page-store";
import { AddPageModal, type AddedPage } from "@/components/single-page/add-page-modal";
import {
  ExportPanel,
  RefineBar,
  StylePanel,
  VersionBar,
  type VersionCount,
} from "@/components/single-page/sp-panels";
import { Modal, Spinner, ToastStack, useToasts } from "@/components/deck/ui";
import { useEditableExport } from "@/modules/editable-export/client/use-editable-export";

const FLOW_STEPS = ["添加内容", "选择风格", "生成结果", "下载可编辑版本"] as const;

export function SinglePageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toasts, push: toast, dismiss } = useToasts();

  const [hydrated, setHydrated] = useState(false);
  const [pages, setPages] = useState<SpPage[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [title, setTitle] = useState("未命名单页项目");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [versionCount, setVersionCount] = useState<VersionCount>(1);
  const [viewStep, setViewStep] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [insufficient, setInsufficient] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [replicateOrigin, setReplicateOrigin] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  // ---------- 转可编辑 PPTX（WPS 免费优先 / Image2PPT / Codia 备用，按页计费） ----------
  const [editableOpen, setEditableOpen] = useState(false);
  const [editableForce, setEditableForce] = useState(false);
  const [editableUnit, setEditableUnit] = useState(20);
  const [balance, setBalance] = useState<number | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const filesRef = useRef<Map<string, File>>(new Map()); // 图片页待上传的本地 File（不可持久化）

  const activePage = pages.find((p) => p.pageId === activeId) ?? pages[0];
  const refreshBalance = useCallback(() => {
    void getCreditBalance().then(setBalance).catch(() => {});
  }, []);
  const startEditableRequest = useCallback(
    (force: boolean) => {
      if (!projectId) return Promise.reject(new Error("项目尚未创建"));
      return startSingleEditableExport(projectId, force);
    },
    [projectId],
  );
  const editable = useEditableExport({
    refType: "single-page",
    refId: projectId,
    title: title || "单页PPT",
    startRequest: startEditableRequest,
    toast,
    onCreditsChanged: refreshBalance,
  });

  // ---------- 初始化：恢复草稿 / 打开既有项目 / 探登录态 ----------
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const draft = loadDraft();
      if (draft && draft.pages.length > 0) {
        // objectURL 不可持久化：恢复时剔除失效的本地预览
        const restored = draft.pages.map((p) => ({
          ...p,
          sourceImageUrl: p.sourceImagePath ? p.sourceImageUrl : undefined,
          status: p.status === "generating" || p.status === "uploading" ? "ready" : p.status,
        }));
        setPages(restored);
        setActiveId(restored[0].pageId);
        setTitle(draft.projectTitle || "未命名单页项目");
        setProjectId(draft.projectId);
      } else {
        const first = createPage();
        setPages([first]);
        setActiveId(first.pageId);
      }
      setHydrated(true);

      getSession()
        .catch(() => ({ authenticated: false, user: null }))
        .then((session) => {
          if (cancelled) return;
          const user = session.user;
          setLoggedIn(!!user);
          if (user) void getCreditBalance().then((value) => {
            if (!cancelled) setBalance(value);
          });
        })
        .catch(() => {
          if (!cancelled) setLoggedIn(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // 可编辑转换单价
  useEffect(() => {
    estimateCredits("export_editable", 1)
      .then((e) => setEditableUnit(e.unitPrice))
      .catch(() => {});
  }, []);

  // ?projectId= 打开既有单页项目：拉详情重建页面队列（含状态/版本列表），并刷新 localStorage 草稿
  useEffect(() => {
    const pid = searchParams.get("projectId");
    if (!pid || !hydrated) return;
    let cancelled = false;
    getSinglePageProject(pid)
      .then((detail) => {
        if (cancelled) return;
        const restored: SpPage[] = detail.pages.map((p) => ({
          pageId: p.pageId,
          kind: "text" as const, // 详情接口不暴露原稿图路径，恢复后按文本页处理
          text: p.content,
          stylePackId: p.stylePackId || undefined,
          status:
            p.status === "succeeded"
              ? ("done" as const)
              : p.status === "failed"
                ? ("error" as const)
                : p.status === "queued" || p.status === "running"
                  ? ("generating" as const)
                  : p.content.trim()
                    ? ("ready" as const)
                    : ("idle" as const),
          versions: p.versions
            .filter((v) => v.status === "succeeded" && v.imageUrl)
            .map((v) => ({
              versionId: v.versionId,
              imageUrl: v.imageUrl,
              createdAt: v.createdAt,
              optimized: v.kind === "refine",
            })),
          activeVersionId: p.activeVersionId || undefined,
          error: p.error || undefined,
        }));
        setProjectId(detail.project.id);
        setTitle(detail.project.title || "未命名单页项目");
        setReplicateOrigin(detail.project.source === "replicate");
        if (restored.length > 0) {
          setPages(restored);
          setActiveId((current) =>
            restored.some((p) => p.pageId === current) ? current : restored[0].pageId,
          );
        }
        setBanner(null);
        setViewStep(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const err = error instanceof ApiClientError ? error : null;
        if (err?.isUnauthorized) return; // 未登录时安静忽略，保留本地草稿
        if (err?.status === 404) {
          toast("项目不存在或已删除");
          setProjectId(null);
          setReplicateOrigin(false);
          router.replace("/single-page");
          return;
        }
        setBanner("打开项目失败");
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams, hydrated, router, toast]);

  // ---------- 草稿自动保存（防抖 400ms） ----------
  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      saveDraft({
        projectTitle: title,
        projectId,
        pages: pages.map((p) => ({
          ...p,
          // 本地 objectURL 不持久化；服务端已上传的保留 URL
          sourceImageUrl: p.sourceImagePath ? p.sourceImageUrl : undefined,
        })),
        savedAt: Date.now(),
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [pages, title, projectId, hydrated]);

  const updatePage = useCallback((pageId: string, patch: Partial<SpPage>) => {
    setPages((prev) => prev.map((p) => (p.pageId === pageId ? { ...p, ...patch } : p)));
  }, []);

  // ---------- 页面队列操作 ----------
  const addPages = (added: AddedPage[]) => {
    const newPages = added.map((item) => {
      const page = createPage({
        kind: item.kind,
        text: item.text,
        sourceImageUrl: item.previewUrl,
        status: item.kind === "image" ? "ready" : item.text ? "ready" : "idle",
      });
      if (item.file) filesRef.current.set(page.pageId, item.file);
      return page;
    });
    setPages((prev) => [...prev, ...newPages].slice(0, SP_MAX_PAGES));
    setActiveId(newPages[0].pageId);
    setViewStep(null);
  };

  const removePage = (pageId: string) => {
    setPages((prev) => {
      if (prev.length <= 1) return prev;
      const index = prev.findIndex((p) => p.pageId === pageId);
      const next = prev.filter((p) => p.pageId !== pageId);
      if (activeId === pageId) setActiveId(next[Math.max(0, index - 1)].pageId);
      return next;
    });
    filesRef.current.delete(pageId);
  };

  // ---------- 图片页原稿上传（已登录才上服务端；未登录仅本地预览） ----------
  const ensureImageUploaded = async (page: SpPage): Promise<SpPage> => {
    if (page.sourceImagePath || page.kind !== "image") return page;
    const file = filesRef.current.get(page.pageId);
    if (!file) return page;
    const saved = await uploadAsset(file, "uploads");
    const next = { ...page, sourceImagePath: saved.path, sourceImageUrl: saved.url };
    updatePage(page.pageId, { sourceImagePath: saved.path, sourceImageUrl: saved.url });
    filesRef.current.delete(page.pageId);
    return next;
  };

  // ---------- 三个动作的领域流程（执行器只管忙/互斥/401/402/文案，流程留在页面） ----------
  const [genProgress, setGenProgress] = useState<string>("");

  const runGenerate = async (action: SinglePageGenerateAction): Promise<SinglePageActionOutcome> => {
    const { page, versions } = action;
    setViewStep(null);
    updatePage(page.pageId, { status: "generating", error: undefined });
    const uploaded = await ensureImageUploaded(page);
    const content =
      uploaded.text.trim() ||
      (uploaded.kind === "image"
        ? `请参考上传的原稿图重新设计这一页 PPT（原稿文件：${uploaded.sourceImagePath ?? "见上传图片"}）。`
        : "");
    let pid = projectId;
    let succeeded = 0;
    try {
      for (let k = 0; k < versions; k++) {
        setGenProgress(`正在生成第 ${k + 1}/${versions} 个版本…`);
        const res = await generateSinglePage({
          pageId: page.pageId,
          projectId: pid ?? undefined,
          title,
          content,
          stylePackId: page.stylePackId,
          imagePath: uploaded.sourceImagePath,
        });
        if (!pid) {
          pid = res.projectId;
          setProjectId(pid);
          router.replace(`/single-page?projectId=${pid}`);
        }
        setBalance(res.balance);
        if (res.status === "succeeded" && res.imageUrl) {
          succeeded += 1;
          setPages((prev) =>
            prev.map((p) => {
              if (p.pageId !== page.pageId) return p;
              const versionList = [
                ...p.versions,
                { versionId: res.versionId, imageUrl: res.imageUrl, createdAt: Date.now(), optimized: false },
              ];
              return { ...p, versions: versionList, activeVersionId: res.versionId, status: "done" as const };
            }),
          );
        } else {
          updatePage(page.pageId, {
            status: succeeded > 0 ? "done" : "error",
            error: res.error || singlePageActionDefinition("generatePage").failure,
          });
          break;
        }
      }
      if (succeeded === 0) {
        setPages((prev) =>
          prev.map((p) =>
            p.pageId === page.pageId && p.status === "generating"
              ? { ...p, status: "error", error: p.error ?? "生成失败，请重试" }
              : p,
          ),
        );
      }
      return {};
    } finally {
      setGenProgress("");
    }
  };

  const runRefine = async (action: SinglePageRefineAction): Promise<SinglePageActionOutcome> => {
    const res = await refineSinglePage({ pageId: action.pageId, editInstruction: action.instruction });
    setBalance(res.balance);
    if (res.status === "succeeded" && res.imageUrl) {
      setPages((prev) =>
        prev.map((p) =>
          p.pageId === action.pageId
            ? {
                ...p,
                versions: [
                  ...p.versions,
                  { versionId: res.versionId, imageUrl: res.imageUrl, createdAt: Date.now(), optimized: true },
                ],
                activeVersionId: res.versionId,
                status: "done",
              }
            : p,
        ),
      );
      return {};
    }
    return { failure: { message: res.error || undefined } };
  };

  const runSelectVersion = async (
    action: SinglePageSelectVersionAction,
  ): Promise<SinglePageActionOutcome> => {
    const res = await selectSinglePageVersion({ pageId: action.pageId, versionId: action.versionId });
    updatePage(action.pageId, { activeVersionId: res.activeVersionId });
    return {};
  };

  const dispatch = (action: SinglePageAction): Promise<SinglePageActionOutcome> => {
    switch (action.kind) {
      case "generatePage":
        return runGenerate(action);
      case "refinePage":
        return runRefine(action);
      case "selectVersion":
        return runSelectVersion(action);
    }
  };

  // 服务端/恢复现场仍在生成的页面视作「生成在飞」：切版本按目录声明被它拦住
  const pageRunning = useCallback(
    (pageId: string) => pages.some((p) => p.pageId === pageId && p.status === "generating"),
    [pages],
  );

  const { run, busy, inflight } = useSinglePageActions({
    dispatch,
    onUnauthorized: () => router.push("/login?next=%2Fsingle-page"),
    onInsufficientCredits: setInsufficient,
    toast,
    isPageRunning: pageRunning,
  });

  const generate = (page: SpPage) => {
    if (replicateOrigin) {
      toast("这是美化作品，请到 PPT 美化继续生成");
      return;
    }
    if (!page.stylePackId) return;
    void run(
      { kind: "generatePage", pageId: page.pageId, page, versions: versionCount },
      {
        silent: true,
        onFailure: (failure) =>
          updatePage(page.pageId, {
            status: page.versions.length > 0 ? "done" : "error",
            error: failure.message,
          }),
      },
    );
  };

  const refine = (page: SpPage, instruction: string) => {
    void run({ kind: "refinePage", pageId: page.pageId, instruction });
  };

  const selectVersion = (page: SpPage, versionId: string) => {
    if (versionId === page.activeVersionId) return;
    void run({ kind: "selectVersion", pageId: page.pageId, versionId });
  };

  // ---------- 导出图片版 PPTX ----------
  const doExport = async () => {
    if (!projectId || exporting) return;
    setExporting(true);
    try {
      const result = await exportSinglePagesImagePptx({ projectId, title });
      const a = document.createElement("a");
      a.href = result.url;
      a.download = `${title || "单页PPT"}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setExported(true);
      toast("图片版 PPTX 已开始下载");
    } catch (error) {
      const err = error instanceof ApiClientError ? error : null;
      if (err?.isUnauthorized) {
        router.push("/login?next=%2Fsingle-page");
        return;
      }
      toast(err?.message ?? "导出失败");
    } finally {
      setExporting(false);
    }
  };

  // ---------- 转可编辑 PPTX（WPS 免费优先 / Image2PPT / Codia 备用，按页计费，失败退星） ----------
  const doneCount = pages.filter((p) => p.status === "done").length;
  const editableTotal = doneCount * editableUnit;

  const submitEditable = async () => {
    if (!projectId || editable.submitting) return;
    try {
      const started = await editable.start(editableForce);
      if (started) setEditableOpen(false);
    } catch (error) {
      const err = error instanceof ApiClientError ? error : null;
      if (err?.isUnauthorized) {
        router.push("/login?next=%2Fsingle-page");
        return;
      }
      if (err?.isInsufficientCredits) {
        setEditableOpen(false);
        setInsufficient(err.message);
        return;
      }
      toast(err?.message ?? "发起可编辑转换失败，请重新尝试");
    }
  };

  // ---------- 步骤条 ----------
  const currentStep = useMemo(() => {
    if (!activePage) return 0;
    if (viewStep !== null) return viewStep;
    if (exported) return 3;
    return pageStep(activePage);
  }, [activePage, viewStep, exported]);

  const reachableStep = activePage ? (exported ? 3 : pageStep(activePage)) : 0;
  const goStep = (step: number) => {
    if (step > reachableStep) return;
    setViewStep(step === pageStep(activePage) ? null : step);
    if (step === 1 || step === 0) setExported(false);
  };

  const canvasStep = viewStep !== null && viewStep <= 2 ? viewStep : activePage ? pageStep(activePage) : 0;
  const showStylePanel = currentStep === 1;
  const showExportPanel = currentStep >= 2;

  if (!hydrated || !activePage) {
    return <div className="min-h-screen bg-page" />;
  }

  const generating = busy("generatePage", activePage.pageId);
  const refining = busy("refinePage", activePage.pageId);
  const switchingVersionId =
    inflight.find((action) => action.kind === "selectVersion" && action.entityId === activePage.pageId)
      ?.versionId ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-page" data-state={currentStep}>
      {/* 顶部细条 */}
      <header className="flex items-center gap-3 border-b border-line bg-card px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="返回首页">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/anppt-fish-logo.png" alt="AnPPT" className="h-7 w-auto" />
        </Link>
        <Link
          href="/projects"
          className="flex items-center gap-1 text-sm text-ink-3 transition hover:text-brand"
        >
          <ChevronLeftIcon width={14} height={14} /> 我的项目
        </Link>
        <div className="ml-auto flex items-center gap-2.5">
          {loggedIn && (
            <span className="flex items-center overflow-hidden rounded-full border border-brand-line bg-brand-softer text-[13px]">
              <span className="flex items-center gap-1 px-3 py-1.5 text-ink-2">
                <StarIcon width={13} height={13} className="text-brand" />
                🌟 {balance === null ? "--" : balance}
              </span>
              <Link
                href="/recharge"
                className="border-l border-brand-line px-3 py-1.5 font-medium text-brand transition hover:bg-brand-soft"
              >
                充值
              </Link>
            </span>
          )}
          {loggedIn === false && (
            <Link
              href="/login?next=%2Fsingle-page"
              className="flex h-8 items-center rounded-full bg-dark px-4 text-[13px] font-medium text-white transition hover:bg-ink"
            >
              登录
            </Link>
          )}
        </div>
      </header>

      {replicateOrigin && projectId && (
        <div className="border-b border-brand-line bg-brand-softer px-4 py-2 text-center text-xs text-brand">
          这是美化作品，工作台生成会冲掉原画面。
          <Link href={beautifyHref(projectId)} className="ml-2 underline">
            打开 PPT 美化
          </Link>
        </div>
      )}
      {banner && (
        <div className="border-b border-brand-line bg-brand-softer px-4 py-2 text-center text-xs text-brand">
          {banner}
          <button type="button" className="ml-2 underline" onClick={() => setBanner(null)}>
            知道了
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 左栏：页面队列（移动端为顶部横排） */}
        <aside className="shrink-0 border-b border-line bg-card px-4 py-4 lg:w-60 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-ink">页面队列</h2>
            <span className="text-xs text-ink-4">{pages.length} 页</span>
          </div>
          <div className="mt-3 flex gap-3 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {pages.map((page, i) => {
              const active = page.pageId === activePage.pageId;
              const thumb =
                page.versions.find((v) => v.versionId === page.activeVersionId)?.imageUrl ??
                page.sourceImageUrl;
              return (
                <div
                  key={page.pageId}
                  className={`group relative w-40 shrink-0 rounded-2xl border-2 p-2 text-left transition lg:w-full ${
                    active ? "border-brand" : "border-line hover:border-brand-line"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(page.pageId);
                      setViewStep(null);
                    }}
                    className="block w-full"
                  >
                    <span className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-lg bg-page text-xs text-ink-4">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt={`Page ${i + 1}`} className="h-full w-full object-cover" />
                      ) : (
                        <ImageIcon width={18} height={18} />
                      )}
                    </span>
                    <span className="mt-1.5 flex items-center justify-between px-0.5">
                      <span className="text-xs font-medium text-ink">
                        Page {String(i + 1).padStart(2, "0")}
                      </span>
                      <span
                        className={`flex items-center gap-1 text-[10px] ${
                          page.status === "error"
                            ? "text-danger"
                            : page.status === "done"
                              ? "text-emerald-600"
                              : page.status === "generating" || page.status === "uploading"
                                ? "text-brand"
                                : "text-ink-4"
                        }`}
                      >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                        {SP_STATUS_LABEL[page.status]}
                      </span>
                    </span>
                  </button>
                  {pages.length > 1 && (
                    <button
                      type="button"
                      aria-label="删除页面"
                      title="删除页面"
                      onClick={() => removePage(page.pageId)}
                      className="absolute right-1.5 top-1.5 hidden rounded-full bg-card/90 p-1 text-ink-3 shadow-card hover:text-danger group-hover:block"
                    >
                      <TrashIcon width={12} height={12} />
                    </button>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              disabled={pages.length >= SP_MAX_PAGES}
              onClick={() => setAddOpen(true)}
              className="flex w-40 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-2.5 text-sm text-ink-3 transition hover:border-brand-line hover:text-brand disabled:cursor-not-allowed disabled:opacity-40 lg:w-full"
            >
              <PlusIcon width={14} height={14} />
              {pages.length >= SP_MAX_PAGES ? `最多 ${SP_MAX_PAGES} 页` : "添加页面"}
            </button>
          </div>
        </aside>

        {/* 中栏：标题 + 步骤条 + 画布 */}
        <main className="min-w-0 flex-1 px-5 py-5 sm:px-8">
          <div className="flex items-center gap-2">
            <TitleEditor
              title={title}
              onSave={(next) => {
                setTitle(next);
                if (projectId) {
                  renameProject(projectId, next).catch(() => toast("自动保存失败"));
                }
              }}
            />
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <CheckIcon width={12} height={12} /> 已保存
            </span>
          </div>

          {/* 步骤条 */}
          <nav aria-label="生成流程" className="mt-4 overflow-x-auto pb-1">
            <ol className="flex items-center gap-2">
              {FLOW_STEPS.map((label, i) => {
                const done = i < currentStep;
                const current = i === currentStep;
                const clickable = i <= reachableStep && !generating;
                return (
                  <li key={label} className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={() => goStep(i)}
                      className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] transition ${
                        current
                          ? "bg-brand font-medium text-white"
                          : clickable
                            ? "bg-card text-ink-2 hover:text-brand"
                            : "cursor-not-allowed bg-card text-ink-4"
                      }`}
                    >
                      <span
                        className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[11px] ${
                          current ? "bg-white/25" : "bg-page"
                        }`}
                      >
                        {done ? <CheckIcon width={10} height={10} /> : i + 1}
                      </span>
                      {label}
                    </button>
                    {i < FLOW_STEPS.length - 1 && <span className="w-8 border-t border-line-strong" />}
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* 画布 */}
          <div className="mt-5">
            <Canvas
              key={activePage.pageId}
              page={activePage}
              step={canvasStep}
              generating={generating}
              refining={refining}
              genProgress={genProgress}
              onTextChange={(text) => updatePage(activePage.pageId, { text })}
              onAnalyze={() => {
                updatePage(activePage.pageId, { status: "ready" });
                setViewStep(1);
              }}
              onPickImage={(file, previewUrl) => {
                filesRef.current.set(activePage.pageId, file);
                updatePage(activePage.pageId, {
                  kind: "image",
                  sourceImageUrl: previewUrl,
                  status: "ready",
                });
                setViewStep(1);
              }}
              onOpenAdd={() => setAddOpen(true)}
              onRetryGenerate={() => void generate(activePage)}
              onBackToStyle={() => setViewStep(1)}
            />
          </div>

          {/* result 画布下方：优化条 + 版本条 */}
          {showExportPanel && activePage.versions.length > 0 && (
            <div className="mt-4 space-y-3">
              <RefineBar
                page={activePage}
                refining={refining}
                onSubmit={(instruction) => void refine(activePage, instruction)}
                onRevert={() => {
                  // 退回原版本：真实切换 activeVersion 到最近的非优化版本
                  const original = [...activePage.versions].reverse().find((v) => !v.optimized);
                  if (original) void selectVersion(activePage, original.versionId);
                }}
              />
              <VersionBar
                page={activePage}
                busy={busy("selectVersion", activePage.pageId)}
                switchingId={switchingVersionId}
                runningHint={
                  pageRunning(activePage.pageId)
                    ? singlePageActionDefinition("selectVersion").blockedNotice
                    : null
                }
                onSelect={(versionId) => selectVersion(activePage, versionId)}
              />
            </div>
          )}
        </main>

        {/* 右栏：按步面板 */}
        <aside className="shrink-0 border-t border-line bg-card px-4 py-4 lg:w-72 lg:border-l lg:border-t-0">
          {showStylePanel && (
            <StylePanel
              selectedId={activePage.stylePackId ?? null}
              versionCount={versionCount}
              generating={generating}
              onSelect={(id) => updatePage(activePage.pageId, { stylePackId: id })}
              onVersionCount={setVersionCount}
              onGenerate={() => void generate(activePage)}
            />
          )}
          {showExportPanel && (
            <ExportPanel
              pages={pages}
              exporting={exporting}
              onExportImage={() => void doExport()}
              onRestyle={() => {
                setExported(false);
                setViewStep(1);
              }}
              editableBusy={editable.running || editable.submitting}
              editableRunning={editable.running}
              editableSucceeded={editable.succeeded}
              editableProgressLabel={editable.progressLabel}
              editableWaitingCopy={editable.waitingCopy}
              editableTotal={editableTotal}
              onExportEditable={() => {
                if (editable.succeeded) editable.download();
                else {
                  setEditableForce(false);
                  setEditableOpen(true);
                }
              }}
              onReconvertEditable={editable.succeeded ? () => {
                setEditableForce(true);
                setEditableOpen(true);
              } : undefined}
            />
          )}
          {!showStylePanel && !showExportPanel && (
            <div className="px-1 text-xs leading-6 text-ink-4">
              <p className="font-medium text-ink-3">如何开始</p>
              <p className="mt-1">1. 在中间画布粘贴文本，或通过「添加页面」上传 PPT 原图。</p>
              <p className="mt-1">2. 选择风格后开始生成（每版按次计费，失败自动退还）。</p>
              <p className="mt-1">3. 生成后可继续对话式优化，最后导出图片版 PPTX（免费）。</p>
              <p className="mt-3 rounded-lg bg-page px-3 py-2">未登录也可编辑草稿，生成时再登录。</p>
            </div>
          )}
        </aside>
      </div>

      {addOpen && (
        <AddPageModal currentCount={pages.length} onClose={() => setAddOpen(false)} onAdd={addPages} />
      )}

      {insufficient !== null && (
        <Modal title="🌟 星星不足" onClose={() => setInsufficient(null)}>
          <p className="text-sm leading-6 text-ink-2">{insufficient}</p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setInsufficient(null)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => router.push("/recharge")}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              前往充值
            </button>
          </div>
        </Modal>
      )}

      {editableOpen && (
        <Modal title={editableForce ? "重新转换可编辑 PPTX" : "转可编辑 PPTX"} onClose={() => setEditableOpen(false)}>
          <p className="text-sm leading-6 text-ink-2">
            将把 <b>{doneCount}</b> 张已生成页面图转换为元素级可编辑的 PPTX
            （文字、图形、表格均可在 PowerPoint / WPS 中直接修改）。
          </p>
          <div className="mt-3 rounded-xl bg-page px-4 py-3 text-sm text-ink-2">
            {editableUnit}🌟/页 × {doneCount} 页 ={" "}
            <b className="text-brand">{editableTotal} 🌟</b>
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-3">
            WPS 免费通道仅在服务端已授权配置时启用并优先，失败自动回退 Image2PPT / Codia。
            WPS 通道受登录态与限时免费额度影响，实际以生成文件为准。
          </p>
          <p className="mt-2 text-xs leading-5 text-ink-3">
            {editableForce
              ? "这会创建一份新的转换结果并再次扣星；原文件仍保留在下载中心。"
              : "提交后可以安全刷新或离开；完成后会出现在「下载中心」，转换失败自动退还星星。"}
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setEditableOpen(false)}
              className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
            >
              取消
            </button>
            <button
              type="button"
              disabled={editable.submitting}
              onClick={() => void submitEditable()}
              className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editable.submitting ? "提交中…" : editableForce ? "确认重新转换" : "确认转换"}
            </button>
          </div>
        </Modal>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/* ---------------- 中栏画布 ---------------- */

function Canvas({
  page,
  step,
  generating,
  refining,
  genProgress,
  onTextChange,
  onAnalyze,
  onPickImage,
  onOpenAdd,
  onRetryGenerate,
  onBackToStyle,
}: {
  page: SpPage;
  step: number;
  generating: boolean;
  refining: boolean;
  genProgress: string;
  onTextChange: (text: string) => void;
  onAnalyze: () => void;
  onPickImage: (file: File, previewUrl: string) => void;
  onOpenAdd: () => void;
  onRetryGenerate: () => void;
  onBackToStyle: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const activeVersion = page.versions.find((v) => v.versionId === page.activeVersionId);
  const isEmpty = !page.text.trim() && !page.sourceImageUrl;

  // 空态
  if (isEmpty && step === 0 && !pasteOpen) {
    return (
      <div className="flex aspect-[16/9] flex-col items-center justify-center rounded-2xl border border-line bg-card text-center shadow-card">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <ImageIcon width={24} height={24} />
        </span>
        <p className="mt-5 text-base font-semibold text-ink">这一页还没有内容</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-3">
          点击下方「添加页面」上传 PPT 原图，或直接粘贴文本，开始生成这一页。
        </p>
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenAdd}
            className="flex items-center gap-1.5 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <PlusIcon width={14} height={14} /> 添加页面
          </button>
          <button
            type="button"
            onClick={() => setPasteOpen(true)}
            className="rounded-full border border-line-strong px-5 py-2.5 text-sm text-ink-2 transition hover:border-brand-line"
          >
            粘贴文本
          </button>
        </div>
        <p className="mt-4 text-xs text-ink-4">支持一次上传多张图片，一张图片追加一页</p>
      </div>
    );
  }

  // 生成中 / 优化中遮罩
  const busyOverlay = (generating || refining) && (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-card/80 text-center backdrop-blur-sm">
      <Spinner className="text-[26px]" />
      <p className="mt-4 text-sm font-medium text-ink">
        {refining ? "正在重新设计当前页面…" : "正在生成本页设计…"}
      </p>
      <p className="mt-1 text-xs text-ink-3">
        {genProgress || "此页处理中，预计需要 3–5 分钟"}
      </p>
    </div>
  );

  // step 0：粘贴文本编辑
  if (step === 0) {
    return (
      <div className="rounded-2xl border border-line bg-card p-4 shadow-card">
        <textarea
          rows={10}
          value={page.text}
          autoFocus
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && page.text.trim()) onAnalyze();
          }}
          placeholder="在此粘贴文本内容，AI 会自动提炼标题、要点与结构…（Ctrl/⌘+Enter 分析）"
          className="w-full resize-y rounded-xl border border-line bg-page px-3.5 py-3 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-ink-4">{page.text.replace(/\s/g, "").length} 字</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="text-xs text-ink-3 underline underline-offset-2 hover:text-brand"
            >
              或上传 PPT 原图
            </button>
            <button
              type="button"
              disabled={!page.text.trim()}
              onClick={onAnalyze}
              className="rounded-full bg-brand px-6 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
            >
              分析内容
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs leading-5 text-brand">{pasteHint(page.text, page.kind)}</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPickImage(file, URL.createObjectURL(file));
            e.target.value = "";
          }}
        />
      </div>
    );
  }

  // step 1：待生成（原稿 / 文稿预览）
  if (step === 1) {
    return (
      <div className="relative aspect-[16/9] overflow-hidden rounded-2xl border border-line bg-card shadow-card">
        {busyOverlay}
        {page.sourceImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={page.sourceImageUrl} alt="原稿" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col p-6">
            <span className="rounded-md bg-page px-2 py-0.5 text-[11px] text-ink-3">待生成文稿</span>
            <pre className="mt-3 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-ink-2">
              {page.text}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // step 2：生成结果
  return (
    <div>
      <div className="relative aspect-[16/9] overflow-hidden rounded-2xl border border-line bg-card shadow-card">
        {busyOverlay}
        {page.status === "error" && !activeVersion ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-base font-semibold text-ink">本页生成未完成</p>
            <p className="mt-2 max-w-sm text-xs leading-5 text-ink-3">
              {page.error || "页面处理过程中出现异常，请重新尝试。"}
            </p>
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={onRetryGenerate}
                className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong"
              >
                重新生成
              </button>
              <button
                type="button"
                onClick={onBackToStyle}
                className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
              >
                返回编辑
              </button>
            </div>
          </div>
        ) : showOriginal && page.sourceImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={page.sourceImageUrl} alt="原稿" className="h-full w-full object-contain" />
        ) : activeVersion ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={activeVersion.imageUrl} alt="生成结果" className="h-full w-full object-contain" />
        ) : (
          <span className="flex h-full items-center justify-center text-sm text-ink-4">
            该版本没有可显示的图片
          </span>
        )}
      </div>
      {page.sourceImageUrl && activeVersion && (
        <div className="mt-3 flex justify-center" aria-label="画布显示切换">
          <div className="flex gap-1 rounded-full bg-card p-1 shadow-card">
            {[
              { key: false, label: "生成结果" },
              { key: true, label: "原稿" },
            ].map((opt) => (
              <button
                key={String(opt.key)}
                type="button"
                onClick={() => setShowOriginal(opt.key)}
                className={`rounded-full px-4 py-1.5 text-xs transition ${
                  showOriginal === opt.key ? "bg-brand font-medium text-white" : "text-ink-3 hover:text-ink"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 项目标题（点击编辑） ---------------- */

function TitleEditor({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  if (!editing) {
    return (
      <button
        type="button"
        title="点击编辑项目名称"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        className="flex min-w-0 items-center gap-1.5 rounded-lg px-1 py-0.5 text-lg font-semibold text-ink transition hover:bg-card"
      >
        <span className="truncate">{title}</span>
        <PencilIcon width={13} height={13} className="shrink-0 text-ink-4" />
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft.trim()) onSave(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
      className="rounded-lg border border-brand-line bg-card px-2 py-1 text-lg font-semibold text-ink outline-none"
      aria-label="项目名称"
    />
  );
}
