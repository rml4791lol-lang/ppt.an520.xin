"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BeautifyBannerView, BeautifyPageCard, BeautifySegmented } from "./beautify-ui";
import { UploadIcon } from "@/components/icons";
import { ApiClientError } from "@/lib/client/api";
import {
  exportSinglePagesImagePptx,
  generateSinglePage,
  getLatestBeautifyBatch,
  getSinglePageProject,
  planBeautifyCopy,
  refineSinglePage,
  saveBeautifyDraft,
  startBeautifyBatch,
  startUploadedEditableExport,
  uploadAsset,
  type BeautifyBatch,
  type BeautifyBatchDetail,
} from "./beautify-api";
import { takeBeautifyFiles } from "./beautify-handoff";
import {
  applyPlanToPages,
  BEAUTIFY_DRAFT_KEY,
  BEAUTIFY_EXPORT_BATCH,
  type BeautifyBanner,
  type BeautifyColorMode,
  type BeautifyCopyMode,
  type BeautifyGapPolicy,
  type BeautifyPage,
  buildExportFinishBanner,
  buildGenerateFinishBanner,
  emptyBeautifyPage,
  firstCopyLine,
  indexesNeedingGenerate,
  newBeautifyRequestId,
  newBeautifySession,
  parseBeautifyDraft,
  remainingEditableCredits,
  remainingGenerateCredits,
  restoreProjectHint,
} from "./beautify-pages";
import { estimateCredits, getAuthSession, getFeatureFlags, getMe } from "@/lib/client/deck-api";
import { blobFromUrl, canvasToBlob, filesToShellCanvases, mapPool, toJpegFile } from "./replicate-shell";
import { beautifyHref, safeReplicateFileUrl } from "./replicate-urls";

export function BeautifyClient() {
  const searchParams = useSearchParams();
  const openingProjectId = searchParams.get("projectId") || "";
  const loginNext = `/login?next=${encodeURIComponent(beautifyHref(openingProjectId))}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef(newBeautifySession());
  const sourceFileRef = useRef<HTMLInputElement>(null);
  const outlineFileRef = useRef<HTMLInputElement>(null);
  const ingesting = useRef(false);
  const pagesRef = useRef<BeautifyPage[]>([]);
  const projectIdRef = useRef("");
  const draftReady = useRef(false);
  const draftTimerRef = useRef<number | null>(null);
  const batchPollingRef = useRef(false);

  const [gate, setGate] = useState<"loading" | "login" | "closed" | "ready">("loading");
  const [username, setUsername] = useState("");
  const [balance, setBalance] = useState(0);
  // 单价来自 /api/credits/estimate（可被 CREDIT_ACTION_PRICES / ANPPT_V2_SINGLE_PAGE_CREDITS 覆盖）
  const [unitPrices, setUnitPrices] = useState<{ generate: number; editable: number } | null>(null);
  const [colorMode, setColorMode] = useState<BeautifyColorMode>("follow-shell");
  const [copyMode, setCopyMode] = useState<BeautifyCopyMode>("improve");
  const [gapPolicy, setGapPolicy] = useState<BeautifyGapPolicy>("topic");
  const [topic, setTopic] = useState("");
  const [outline, setOutline] = useState("");
  const [source, setSource] = useState("");
  const [pages, setPages] = useState<BeautifyPage[]>([]);
  const [uploadStatus, setUploadStatus] = useState("");
  const [planBanner, setPlanBanner] = useState<BeautifyBanner | null>(null);
  const [runBanner, setRunBanner] = useState<BeautifyBanner | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [batch, setBatch] = useState<BeautifyBatch | null>(null);
  const [exporting, setExporting] = useState(false);
  const [imageExporting, setImageExporting] = useState(false);
  const [exportJobs, setExportJobs] = useState<{ pageCount: number; status: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const replacePages = useCallback((next: BeautifyPage[]) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  const patchPage = useCallback((index: number, patch: Partial<BeautifyPage>) => {
    const next = pagesRef.current.map((page, i) => (i === index ? { ...page, ...patch } : page));
    pagesRef.current = next;
    setPages(next);
  }, []);

  const applyBatchDetail = useCallback((detail: BeautifyBatchDetail) => {
    const remoteById = new Map(detail.pages.map((page) => [page.pageId, page]));
    const active = detail.batch?.status === "queued" || detail.batch?.status === "running";
    const targets = new Set(active ? detail.batch?.targetIds ?? [] : []);
    const next = pagesRef.current.map((page) => {
      const remote = remoteById.get(page.pageId);
      if (!remote) return page;
      const imageUrl = safeReplicateFileUrl(remote.imageUrl || "");
      const status =
        remote.status === "succeeded" && imageUrl
          ? "已生成"
          : remote.status === "failed"
            ? remote.error || "生成失败"
            : remote.status === "queued" || remote.status === "running"
              ? "图生图中…"
              : imageUrl
                ? "已生成"
                : targets.has(page.pageId)
                  ? "排队中…"
                  : "待生成";
      return {
        ...page,
        imageUrl: imageUrl || page.imageUrl,
        error:
          remote.status === "succeeded" || remote.status === "queued" || remote.status === "running"
            ? ""
            : remote.error || page.error,
        status,
        busy: false,
      };
    });
    pagesRef.current = next;
    setPages(next);
    setBatch(detail.batch);
  }, []);

  const persistDraft = useCallback(async () => {
    const snapshot = pagesRef.current;
    if (snapshot.length === 0) return null;
    const result = await saveBeautifyDraft({
      projectId: projectIdRef.current || undefined,
      title: firstCopyLine(snapshot[0]?.copy || "") || "PPT 美化",
      pages: snapshot.map((page, index) => ({
        pageId: page.pageId,
        title: firstCopyLine(page.copy) || `第 ${index + 1} 页`,
        content: page.copy,
        imagePath: page.imagePath || undefined,
      })),
    });
    if (result.projectId && result.projectId !== projectIdRef.current) {
      projectIdRef.current = result.projectId;
      window.history.replaceState(null, "", beautifyHref(result.projectId));
    }
    return result;
  }, []);

  // 文案编辑自动保存：停止输入约 1.2s 后写草稿；生成/规划期间跳过，避免撞 running 状态。
  useEffect(() => {
    if (gate !== "ready" || !projectIdRef.current || pages.length === 0 || running || planning) return;
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(() => {
      void persistDraft().catch(() => {});
    }, 1200);
    return () => {
      if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    };
  }, [gate, pages, persistDraft, planning, running]);

  useEffect(() => {
    if (gate !== "ready") return;
    if (!draftReady.current) {
      draftReady.current = true;
      return;
    }
    try {
      localStorage.setItem(
        BEAUTIFY_DRAFT_KEY,
        JSON.stringify({ topic, outline, source, copyMode, colorMode, gapPolicy }),
      );
    } catch {
      /* quota */
    }
  }, [gate, topic, outline, source, copyMode, colorMode, gapPolicy]);

  const ingestFiles = useCallback(
    async (fileList: FileList | File[] | null) => {
      const files = fileList ? [...fileList] : [];
      if (!files.length || ingesting.current) return;
      ingesting.current = true;
      setUploadStatus("正在读取参考稿…");
      try {
        const canvases = await filesToShellCanvases(files);
        sessionRef.current = newBeautifySession();
        projectIdRef.current = "";
        setBatch(null);
        setRunning(false);
        setRunBanner(null);
        window.history.replaceState(null, "", "/beautify");
        const next = canvases.map((canvas, i) =>
          emptyBeautifyPage(`${sessionRef.current}p${i}`, {
            shellUrl: canvas.toDataURL("image/png"),
            canvas,
          }),
        );
        replacePages(next);
        setUploadStatus(`已读入 ${next.length} 页，正在保存参考稿…`);
        let uploaded = 0;
        let uploadError = "";
        try {
          await mapPool(next, 3, async (page, index) => {
            const current = pagesRef.current[index];
            if (!current?.canvas) return;
            const blob = await canvasToBlob(current.canvas, "image/jpeg", 0.86);
            const file = new File([blob], `${current.pageId}.jpg`, { type: "image/jpeg" });
            const saved = await uploadAsset(file, "replicate");
            patchPage(index, { imagePath: saved.path });
            uploaded += 1;
            setUploadStatus(`正在保存参考稿 ${uploaded}/${next.length}…`);
          });
        } catch (error) {
          uploadError = error instanceof Error ? error.message : "参考稿上传失败";
        }
        try {
          await persistDraft();
          setUploadStatus(
            uploadError
              ? `已读入 ${next.length} 页，草稿已保存；${uploaded}/${next.length} 页参考稿上传成功，其余可在生成时补传。`
              : `已读入并保存 ${next.length} 页。刷新后可从当前项目继续，换参考稿不会带上一次的文案。`,
          );
        } catch {
          setUploadStatus(
            uploadError
              ? `已读入 ${next.length} 页，但参考稿上传/草稿保存失败：${uploadError}。可直接生成，生成时仍会尝试保存。`
              : `已读入 ${next.length} 页，但草稿保存失败；可以直接生成，生成时仍会保存。`,
          );
        }
      } catch (error) {
        setUploadStatus(error instanceof Error ? error.message : "读取失败");
      } finally {
        ingesting.current = false;
      }
    },
    [patchPage, persistDraft, replacePages],
  );

  const restoreProject = useCallback(
    async (id: string) => {
      const detail = await getSinglePageProject(id);
      if (!detail?.project?.id) throw new Error("项目不存在");
      projectIdRef.current = detail.project.id;
      setBatch(null);
      setRunning(false);
      setRunBanner(null);
      window.history.replaceState(null, "", beautifyHref(detail.project.id));
      const restored = (detail.pages ?? []).map((page, i) => {
        const versions = page.versions ?? [];
        // 优先当前生效版本（单页工作台可切版本），找不到再回落最新成功版本
        const active = page.activeVersionId
          ? versions.find((item) => item.versionId === page.activeVersionId && item.imageUrl)
          : undefined;
        const succeeded =
          active
          || (page.status === "succeeded"
            ? versions.find((item) => item.status === "succeeded" && item.imageUrl)
            : undefined);
        const imageUrl = safeReplicateFileUrl(succeeded?.imageUrl || "");
        const imagePath = String(page.shellPath || "");
        const shellUrl = imagePath ? safeReplicateFileUrl(`/api/files/${imagePath}`) : imageUrl;
        return emptyBeautifyPage(String(page.pageId || `${sessionRef.current}p${i}`), {
          shellUrl,
          copy: String(page.content || page.title || ""),
          imagePath,
          status:
            page.status === "succeeded" && imageUrl
              ? "已生成"
              : page.status === "failed"
                ? page.error || "生成失败"
                : page.status === "queued" || page.status === "running"
                  ? "图生图中…"
                  : imageUrl
                    ? "已生成"
                    : "待生成",
          imageUrl,
          error: page.error || "",
        });
      });
      replacePages(restored);
      setUploadStatus(restoreProjectHint(restored));
      try {
        const batchDetail = await getLatestBeautifyBatch(detail.project.id);
        applyBatchDetail(batchDetail);
        const latest = batchDetail.batch;
        if (latest && (latest.status === "queued" || latest.status === "running")) {
          setRunning(true);
          setRunBanner({
            kind: "warn",
            text: `已接上后台生成任务：已完成 ${latest.succeeded}/${latest.total} 页${latest.failed > 0 ? ` · 失败 ${latest.failed}` : ""}。可以离开页面，任务会继续。`,
          });
        } else if (latest?.status === "succeeded") {
          setRunBanner({ kind: "ok", text: `最近一批已完成 ${latest.succeeded}/${latest.total} 页，结果已回填。` });
        } else if (latest && (latest.status === "partial" || latest.status === "failed")) {
          setRunBanner({ kind: latest.succeeded > 0 ? "warn" : "err", text: latest.error || "上一批未全部完成，可重试未生成页。" });
        }
      } catch {
        // 项目本身已恢复；批量状态接口暂时失败不阻塞继续编辑。
      }
    },
    [applyBatchDetail, replacePages],
  );

  const pollBatch = useCallback(
    async (projectId: string) => {
      if (batchPollingRef.current) return;
      batchPollingRef.current = true;
      try {
        const detail = await getLatestBeautifyBatch(projectId);
        applyBatchDetail(detail);
        const latest = detail.batch;
        if (!latest) {
          setRunning(false);
          return;
        }
        if (latest.status === "queued" || latest.status === "running") {
          setRunning(true);
          setRunBanner({
            kind: "warn",
            text: `后台生成中：已完成 ${latest.succeeded}/${latest.total} 页${latest.failed > 0 ? ` · 失败 ${latest.failed}` : ""}。可以离开页面，任务会继续。`,
          });
          return;
        }
        setRunning(false);
        if (latest.status === "succeeded") {
          setRunBanner({ kind: "ok", text: `已完成 ${latest.succeeded}/${latest.total} 页，结果已全部回填。` });
        } else {
          setRunBanner({
            kind: latest.succeeded > 0 ? "warn" : "err",
            text: latest.error || `已完成 ${latest.succeeded}/${latest.total} 页，未完成页可重新生成。`,
          });
        }
        try {
          const me = await getMe();
          setBalance(me.balance);
        } catch {
          // 余额刷新失败不影响结果回填。
        }
      } catch {
        setRunBanner((current) => current ?? {
          kind: "warn",
          text: "批量结果同步暂时失败，正在自动重试…",
        });
      } finally {
        batchPollingRef.current = false;
      }
    },
    [applyBatchDetail],
  );

  const recoverPageResult = useCallback(async (pageId: string): Promise<boolean> => {
    const projectId = projectIdRef.current;
    if (!projectId) return false;
    try {
      const detail = await getLatestBeautifyBatch(projectId);
      applyBatchDetail(detail);
      const remote = detail.pages.find((page) => page.pageId === pageId);
      return remote?.status === "succeeded" && Boolean(remote.imageUrl);
    } catch {
      return false;
    }
  }, [applyBatchDetail]);

  useEffect(() => {
    if (gate !== "ready" || !running || !projectIdRef.current) return;
    const projectId = projectIdRef.current;
    void pollBatch(projectId);
    const timer = window.setInterval(() => void pollBatch(projectId), 2500);
    return () => window.clearInterval(timer);
  }, [gate, pollBatch, running]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 先看开关再看登录：功能不开放时不该先要求登录（入口消失后深链也能得到明确提示）
        const features = await getFeatureFlags();
        if (cancelled) return;
        if (!features.flags.ppt_replicate) {
          setGate("closed");
          return;
        }
        const session = await getAuthSession();
        if (cancelled) return;
        if (!session.authenticated) {
          setGate("login");
          return;
        }
        const me = await getMe();
        if (cancelled) return;
        setUsername(me.user.username);
        setBalance(me.balance);
        const [genPrice, editablePrice] = await Promise.all([
          estimateCredits("single_page_generate", 1).then((e) => e.unitPrice).catch(() => null),
          estimateCredits("export_editable", 1).then((e) => e.unitPrice).catch(() => null),
        ]);
        if (cancelled) return;
        if (typeof genPrice === "number" && typeof editablePrice === "number") {
          setUnitPrices({ generate: genPrice, editable: editablePrice });
        }
        const draft = parseBeautifyDraft(localStorage.getItem(BEAUTIFY_DRAFT_KEY));
        if (draft) {
          setTopic(draft.topic);
          setOutline(draft.outline);
          setSource(draft.source);
          setGapPolicy(draft.gapPolicy);
          setCopyMode(draft.copyMode);
          setColorMode(draft.colorMode);
        }
        setGate("ready");
        if (openingProjectId) {
          try {
            await restoreProject(openingProjectId);
          } catch (error) {
            setPlanBanner({ kind: "err", text: error instanceof Error ? error.message : "无法打开项目" });
          }
        } else {
          const handed = takeBeautifyFiles();
          if (handed.length) await ingestFiles(handed);
        }
      } catch {
        if (!cancelled) setGate("login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingestFiles, openingProjectId, restoreProject]);

  async function ensureShells(onProgress?: (done: number, total: number) => void): Promise<string[]> {
    const snapshot = pagesRef.current;
    const pending = snapshot.filter((page) => !page.imagePath);
    let done = snapshot.length - pending.length;
    await mapPool(pending, 3, async (page) => {
      const index = snapshot.findIndex((item) => item.pageId === page.pageId);
      if (!page.canvas) throw new Error("参考稿已过期或未上传，请重新上传 PDF/图片");
      const blob = await canvasToBlob(page.canvas, "image/jpeg", 0.86);
      const file = new File([blob], `${page.pageId}.jpg`, { type: "image/jpeg" });
      const saved = await uploadAsset(file, "replicate");
      patchPage(index, { imagePath: saved.path });
      done += 1;
      onProgress?.(done, snapshot.length);
    });
    // 定长按页对齐：缺壳图的页留空串，服务端按下标挂结构卡（过滤塌缩会让结构卡串页）
    return pagesRef.current.map((page) => page.imagePath);
  }

  async function generateOne(index: number, force: boolean) {
    const page = pagesRef.current[index];
    if (!page) throw new Error("页面不存在");
    if (!force && page.imageUrl) return;
    patchPage(index, { error: "", status: page.imagePath ? "图生图中…" : "上传参考稿…" });
    let imagePath = pagesRef.current[index]?.imagePath || "";
    if (!imagePath) {
      const current = pagesRef.current[index];
      if (!current?.canvas) throw new Error("参考稿已过期或未上传，请重新上传 PDF/图片");
      const blob = await canvasToBlob(current.canvas, "image/jpeg", 0.86);
      const file = new File([blob], `${current.pageId}.jpg`, { type: "image/jpeg" });
      const saved = await uploadAsset(file, "replicate");
      imagePath = saved.path;
      patchPage(index, { imagePath, status: "图生图中…" });
    }
    const latest = pagesRef.current[index];
    const result = await generateSinglePage({
      pageId: latest.pageId,
      projectId: projectIdRef.current || undefined,
      title: firstCopyLine(latest.copy) || `第 ${index + 1} 页`,
      content: latest.copy.trim(),
      imagePath,
      mode: "replicate",
      colorMode,
      requestId: newBeautifyRequestId(latest.pageId),
      ...(latest.structureReady ? { structure: latest.structure ?? null } : {}),
    });
    if (result.projectId) {
      projectIdRef.current = result.projectId;
      window.history.replaceState(null, "", beautifyHref(result.projectId));
    }
    if (typeof result.balance === "number") setBalance(result.balance);
    if (result.status !== "succeeded" || !result.imageUrl) {
      throw new Error(result.error || "本页生成失败");
    }
    patchPage(index, { imageUrl: safeReplicateFileUrl(result.imageUrl), status: "已生成", error: "" });
    void persistDraft().catch(() => {});
  }

  async function planCopy() {
    if (planning || running) return;
    if (!pagesRef.current.length) {
      setPlanBanner({ kind: "err", text: "请先上传参考稿" });
      return;
    }
    if (!topic.trim() && !outline.trim() && !outlineFileRef.current?.files?.[0]) {
      setPlanBanner({ kind: "err", text: "请先填写主题或 PPT 大纲" });
      return;
    }
    setPlanning(true);
    setPlanBanner({ kind: "warn", text: "正在上传参考稿并读取结构…" });
    try {
      const imagePaths = await ensureShells((done, total) => {
        setPlanBanner({ kind: "warn", text: `正在上传参考稿 ${done}/${total}，随后按结构完善文案…` });
      });
      const form = new FormData();
      form.append("topic", topic.trim());
      form.append("outlineText", outline);
      form.append("sourceText", source);
      form.append("pageCount", String(pagesRef.current.length));
      form.append("gapPolicy", gapPolicy);
      form.append("copyMode", copyMode);
      form.append("imagePaths", JSON.stringify(imagePaths));
      const file = sourceFileRef.current?.files?.[0];
      if (file) form.append("file", file);
      const outlineFile = outlineFileRef.current?.files?.[0];
      if (outlineFile) form.append("outlineFile", outlineFile);
      const result = await planBeautifyCopy(form);
      const slides = result.slides ?? [];
      const structures = result.structures ?? [];
      const usedOutline = slides.some((slide) => slide.source === "outline");
      const extracted = Number(result.structureExtracted) || 0;
      const previouslyDone = new Set(pagesRef.current.filter((page) => page.imageUrl).map((page) => page.pageId));
      replacePages(applyPlanToPages(pagesRef.current, slides, structures));
      try {
        await persistDraft();
      } catch {
        // 草稿保存失败不阻塞文案生成；页面内仍是当前内容。
      }
      const stale = pagesRef.current.filter(
        (page) => previouslyDone.has(page.pageId) && page.copy.trim() && !page.imageUrl,
      ).length;
      const staleHint = stale > 0 ? `文案有变的 ${stale} 页会重新生成并扣星。` : "";
      const total = pagesRef.current.length;
      if (extracted < total) {
        setPlanBanner({
          kind: stale ? "warn" : "ok",
          text: `各页文案已完善（读到 ${extracted}/${total} 页结构，其余按主题铺开）。${staleHint || "可改后再生成画面。"}`,
        });
      } else {
        setPlanBanner({
          kind: stale ? "warn" : "ok",
          text: `${usedOutline ? "已按大纲铺到各页" : "各页文案已完善"}。${staleHint || "可改后再生成画面。"}`,
        });
      }
    } catch (error) {
      setPlanBanner({ kind: "err", text: error instanceof Error ? error.message : "拆文案失败" });
    } finally {
      setPlanning(false);
    }
  }

  async function runAll() {
    if (running || planning) return;
    const current = pagesRef.current;
    const ids = indexesNeedingGenerate(current);
    const skippedEmpty = current.filter((page) => !page.copy.trim()).length;
    const skippedDone = current.filter((page) => page.copy.trim() && page.imageUrl).length;
    if (!ids.length && !skippedDone) {
      setRunBanner({ kind: "err", text: "请先生成各页文案，或在页面里填写" });
      return;
    }
    if (!ids.length) {
      setRunBanner(buildGenerateFinishBanner({ newlyOk: 0, failed: 0, skippedDone, stoppedForCredits: false }));
      return;
    }
    setRunBanner(
      skippedEmpty || skippedDone
        ? {
            kind: "warn",
            text: [
              skippedDone ? `${skippedDone} 页已生成，跳过不扣星` : "",
              skippedEmpty ? `${skippedEmpty} 页没有文案，已跳过` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          }
        : null,
    );
    setBatch(null);
    setRunning(true);
    try {
      await ensureShells((done, total) => {
        setRunBanner({ kind: "warn", text: `上传参考稿 ${done}/${total}` });
      });
      await persistDraft();
      const projectId = projectIdRef.current;
      if (!projectId) throw new Error("项目尚未保存，请重新上传参考稿");
      const pageIds = ids.map((index) => pagesRef.current[index]?.pageId).filter((id): id is string => Boolean(id));
      const structures: Record<string, unknown> = {};
      for (const id of pageIds) {
        const page = pagesRef.current.find((item) => item.pageId === id);
        if (page?.structureReady) structures[id] = page.structure;
      }
      const started = await startBeautifyBatch({ projectId, pageIds, colorMode, structures });
      setBatch(started);
      setRunBanner({
        kind: "warn",
        text: started.reused
          ? `已接上正在运行的后台任务：已完成 ${started.succeeded}/${started.total} 页。`
          : `已提交后台生成：0/${started.total} 页。可以离开页面，任务会继续。`,
      });
    } catch (error) {
      setRunBanner({ kind: "err", text: error instanceof Error ? error.message : "生成失败" });
      setRunning(false);
    }
  }

  async function retryPage(index: number) {
    const page = pagesRef.current[index];
    if (!page?.copy.trim() || page.busy || running || planning) return;
    patchPage(index, { busy: true });
    try {
      await generateOne(index, true);
    } catch (error) {
      if (await recoverPageResult(page.pageId)) return;
      const message = error instanceof Error ? error.message : "本页生成失败";
      patchPage(index, { error: message, status: message });
    } finally {
      patchPage(index, { busy: false });
    }
  }

  async function tweakPage(index: number) {
    const page = pagesRef.current[index];
    const instruction = page?.tweak.trim() || "";
    if (!page?.imageUrl || !instruction || page.busy || running) return;
    patchPage(index, { busy: true, error: "" });
    try {
      const result = await refineSinglePage({
        pageId: page.pageId,
        editInstruction: `保持当前画面的媒介、场景、构图和道具，只做这一处改动：${instruction}`,
        requestId: newBeautifyRequestId(page.pageId, "tw"),
      });
      if (typeof result.balance === "number") setBalance(result.balance);
      if (result.status !== "succeeded" || !result.imageUrl) {
        throw new Error(result.error || "改图失败");
      }
      patchPage(index, {
        imageUrl: safeReplicateFileUrl(result.imageUrl),
        status: "已改图",
        error: "",
        tweak: "",
        busy: false,
      });
    } catch (error) {
      if (await recoverPageResult(page.pageId)) return;
      const message = error instanceof Error ? error.message : "改图失败";
      patchPage(index, { status: message, error: message, busy: false });
    }
  }

  async function downloadImagePptx() {
    if (imageExporting || running || planning || exporting) return;
    const projectId = projectIdRef.current;
    if (!projectId) {
      setRunBanner({ kind: "err", text: "请先生成至少一页，再导出图片版 PPTX" });
      return;
    }
    setImageExporting(true);
    try {
      const title = firstCopyLine(pagesRef.current[0]?.copy || "") || "PPT美化";
      const result = await exportSinglePagesImagePptx({ projectId, title });
      const a = document.createElement("a");
      a.href = result.url;
      a.download = `${title}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setRunBanner({
        kind: "ok",
        text: `图片版 PPTX 已开始下载（${result.pageCount} 页），文件也已保存到下载中心。`,
      });
    } catch (error) {
      setRunBanner({
        kind: "err",
        text: error instanceof ApiClientError ? error.message : "导出图片版 PPTX 失败",
      });
    } finally {
      setImageExporting(false);
    }
  }

  async function queueEditable() {
    if (exporting || running) return;
    const ready = pagesRef.current.filter((page) => page.imageUrl);
    if (!ready.length) return;
    const need = remainingEditableCredits(ready, unitPrices?.editable ?? 0);
    if (unitPrices && balance < need) {
      setRunBanner({ kind: "err", text: `星星不足：转可编辑约需 ${need}，当前 ${balance}` });
      return;
    }
    setExporting(true);
    const jobs: { pageCount: number; status: string }[] = [];
    try {
      for (let start = 0; start < ready.length; start += BEAUTIFY_EXPORT_BATCH) {
        const chunk = ready.slice(start, start + BEAUTIFY_EXPORT_BATCH);
        const files: File[] = [];
        for (let i = 0; i < chunk.length; i += 1) {
          const blob = await blobFromUrl(chunk[i].imageUrl);
          files.push(await toJpegFile(blob, `page-${String(start + i + 1).padStart(2, "0")}.jpg`));
        }
        const started = await startUploadedEditableExport(files);
        jobs.push({ pageCount: started.pageCount, status: started.status });
        if (typeof started.credits === "number") {
          setBalance((current) => Math.max(0, current - started.credits));
        }
      }
      setExportJobs(jobs);
      setRunBanner(buildExportFinishBanner({ queued: jobs.length }));
    } catch (error) {
      setExportJobs(jobs);
      setRunBanner(
        buildExportFinishBanner({
          queued: jobs.length,
          error: error instanceof Error ? error.message : "转换失败",
        }),
      );
    } finally {
      setExporting(false);
    }
  }

  const locked = planning || running || exporting || imageExporting;
  const canExport = pages.some((page) => page.imageUrl);
  const generateCredits = remainingGenerateCredits(pages, unitPrices?.generate ?? 0);
  const editableCredits = remainingEditableCredits(pages, unitPrices?.editable ?? 0);

  if (gate === "loading") {
    return <p className="py-20 text-center text-sm text-ink-3">正在打开 PPT 美化…</p>;
  }
  if (gate === "login") {
    return (
      <div className="rounded-2xl border border-line bg-card p-8 text-center shadow-card">
        <h1 className="text-xl font-semibold text-ink">请先登录</h1>
        <p className="mt-2 text-sm text-ink-3">登录后即可上传参考稿，把画面留下来、把文案换成你的。</p>
        <Link
          href={loginNext}
          className="mt-6 inline-flex rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-strong"
        >
          去登录
        </Link>
      </div>
    );
  }
  if (gate === "closed") {
    return (
      <div className="rounded-2xl border border-line bg-card p-8 text-center shadow-card">
        <h1 className="text-xl font-semibold text-ink">功能尚未开放</h1>
        <p className="mt-2 text-sm text-ink-3">PPT 美化正在内测，开放后会出现在首页「PPT美化」和模板库。</p>
        <Link href="/" className="mt-6 inline-flex text-sm font-medium text-brand hover:text-brand-strong">
          返回首页
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-brand">模板库 · 自己的 PPT</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">PPT 美化</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-3">
            画面跟参考稿：构图、道具、画风都留下。文案换成你的主题或大纲。不是套官方风格翻新。
          </p>
        </div>
        <p className="text-sm text-ink-2">
          {username} · {balance} 星
        </p>
      </div>

      <section className="mt-8 rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6">
        <h2 className="text-base font-semibold text-ink">1. 参考稿</h2>
        <p className="mt-1 text-sm text-ink-3">
          PDF 按页拆图，或一次选多张 PNG / JPG / WebP。一次最多 40 页。PPTX 请先另存为 PDF。每小时最多上传 60
          个文件，40 页会占 40 次。
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void ingestFiles(event.dataTransfer.files);
          }}
          className={`mt-4 flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center transition ${
            dragOver ? "border-brand bg-brand-softer" : "border-line-strong bg-page hover:border-brand-line hover:bg-brand-softer"
          }`}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <UploadIcon width={22} height={22} />
          </span>
          <p className="mt-4 text-base font-semibold text-ink">拖入 PDF 或图片</p>
          <p className="mt-1.5 text-sm text-ink-3">点击选择文件</p>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp"
          multiple
          className="hidden"
          onChange={(event) => {
            void ingestFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {uploadStatus && <p className="mt-3 text-sm text-ink-2">{uploadStatus}</p>}
      </section>

      <section className="mt-4 rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6">
        <h2 className="text-base font-semibold text-ink">2. 配色</h2>
        <p className="mt-1 text-sm text-ink-3">默认跟随原页色板，只换文案。要换色、仍保留原页场景，再选「只换色板」。</p>
        <div className="mt-4">
          <BeautifySegmented
            value={colorMode}
            onChange={setColorMode}
            options={[
              { value: "follow-shell", label: "跟随原页" },
              { value: "new-theme", label: "只换色板" },
            ]}
          />
        </div>
      </section>

      <section className="mt-4 rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6">
        <h2 className="text-base font-semibold text-ink">3. 主题、大纲与材料</h2>
        <p className="mt-1 text-sm text-ink-3">
          有大纲就按大纲铺到参考稿页数上。材料用来写实。默认会润色、补结构，不编造数据。
        </p>
        <label className="mt-4 block text-sm text-ink-2">
          主题
          <input
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：妇科门诊护士岗前培训（有大纲时可留空）"
            className="mt-1.5 w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm text-ink outline-none focus:border-brand-line"
          />
        </label>
        <label className="mt-4 block text-sm text-ink-2">
          PPT 大纲（可选）
          <textarea
            value={outline}
            onChange={(event) => setOutline(event.target.value)}
            rows={6}
            placeholder={"有大纲请贴在这里，例如：\n1. 封面：岗前培训\n2. 接诊流程\n也支持 AnPPT 大纲或 Markdown 标题。"}
            className="mt-1.5 w-full resize-y rounded-xl border border-line bg-card px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand-line"
          />
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm text-ink-3">
          大纲文件
          <input ref={outlineFileRef} type="file" accept=".txt,.md,.docx,.pdf,text/plain" />
        </label>
        <label className="mt-4 block text-sm text-ink-2">
          官方材料
          <textarea
            value={source}
            onChange={(event) => setSource(event.target.value)}
            rows={8}
            placeholder="粘贴讲义、制度、操作规范……越详细，替换越详细。"
            className="mt-1.5 w-full resize-y rounded-xl border border-line bg-card px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand-line"
          />
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm text-ink-3">
          材料文件
          <input ref={sourceFileRef} type="file" accept=".txt,.md,.docx,.pdf,text/plain" />
        </label>
        <p className="mt-4 text-sm text-ink-2">文案策略</p>
        <div className="mt-2">
          <BeautifySegmented
            value={copyMode}
            onChange={setCopyMode}
            options={[
              { value: "improve", label: "完善创新" },
              { value: "strict", label: "严格按材料" },
            ]}
          />
        </div>
        <label className="mt-4 block text-sm text-ink-2">
          材料或大纲盖不住的页
          <select
            value={gapPolicy}
            onChange={(event) => setGapPolicy(event.target.value as BeautifyGapPolicy)}
            className="mt-1.5 rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-brand-line"
          >
            <option value="topic">按主题补全结构（默认）</option>
            <option value="brief">只写标题和一句</option>
            <option value="skip">跳过，不生成该页</option>
          </select>
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={locked}
            onClick={() => void planCopy()}
            className="rounded-full bg-page px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-brand-soft hover:text-brand disabled:opacity-50"
          >
            {planning ? "完善文案中…" : "生成并完善各页文案"}
          </button>
          {pages.length > 0 && <span className="text-sm text-ink-3">共 {pages.length} 页</span>}
        </div>
        {planBanner && (
          <div className="mt-3">
            <BeautifyBannerView kind={planBanner.kind} text={planBanner.text} />
          </div>
        )}
      </section>

      {pages.length > 0 && (
        <div className="mt-4 space-y-4">
          {pages.map((page, i) => (
            <BeautifyPageCard
              key={page.pageId}
              page={page}
              index={i}
              locked={locked}
              onCopy={(value) => {
                const current = pagesRef.current[i];
                if (current?.imageUrl && value !== current.copy) {
                  patchPage(i, { copy: value, imageUrl: "", status: "文案已更新，需重新生成", error: "" });
                  return;
                }
                patchPage(i, { copy: value });
              }}
              onTweak={(value) => patchPage(i, { tweak: value })}
              onRetry={() => void retryPage(i)}
              onRefine={() => void tweakPage(i)}
            />
          ))}
        </div>
      )}

      <section className="mt-4 rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6">
        <h2 className="text-base font-semibold text-ink">4. 生成与导出</h2>
        <p className="mt-1 text-sm text-ink-3">
          {unitPrices
            ? `画面跟参考稿，只换各页文案。未生成的页 ${unitPrices.generate} 星/页；已生成的整批再点不会重复扣星。转可编辑 ${unitPrices.editable} 星/页，按 ${BEAUTIFY_EXPORT_BATCH} 页一批排队。`
            : `画面跟参考稿，只换各页文案。未生成的页按页扣星，已生成的整批再点不会重复扣星。转可编辑按页扣星，按 ${BEAUTIFY_EXPORT_BATCH} 页一批排队。`}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={locked}
            onClick={() => void runAll()}
            className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
          >
            {running && batch
              ? `后台生成中 ${batch.succeeded}/${batch.total}`
              : running
                ? "正在启动…"
                : "按画面生成页面"}
          </button>
          <button
            type="button"
            disabled={locked || !canExport}
            onClick={() => void downloadImagePptx()}
            className="rounded-full bg-page px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-brand-soft hover:text-brand disabled:opacity-50"
          >
            {imageExporting ? "导出中…" : "导出图片版 PPTX"}
          </button>
          <button
            type="button"
            disabled={locked || !canExport}
            onClick={() => void queueEditable()}
            className="rounded-full bg-page px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-brand-soft hover:text-brand disabled:opacity-50"
          >
            {exporting ? "排队中…" : "转可编辑 PPTX"}
          </button>
          <Link
            href="/exports"
            className="text-sm font-medium text-brand transition hover:text-brand-strong"
          >
            打开下载中心
          </Link>
          <span className="text-sm text-ink-3">
            {pages.length && unitPrices
              ? `待生成约 ${generateCredits} 星 · 转可编辑约 ${editableCredits} 星 · 余额 ${balance}`
              : `余额 ${balance}`}
          </span>
        </div>
        {runBanner && (
          <div className="mt-3">
            <BeautifyBannerView kind={runBanner.kind} text={runBanner.text} />
          </div>
        )}
        <p className="mt-3 text-xs leading-5 text-ink-4">
          图片版 PPTX 免费，生成完成后可直接下载；可编辑版按页计费，转换完成后在下载中心获取。
        </p>
        {exportJobs.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-ink-2">
            {exportJobs.map((job, i) => (
              <li key={`${job.pageCount}-${i}`}>
                批次 {i + 1} · {job.pageCount} 页 · {job.status === "succeeded" ? "已完成" : "排队中"} ·{" "}
                <Link href="/exports" className="text-brand hover:text-brand-strong">
                  打开下载中心
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
