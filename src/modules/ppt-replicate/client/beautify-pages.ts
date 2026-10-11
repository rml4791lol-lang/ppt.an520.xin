/** 美化工作台的纯规则：扣费名单、失败文案、草稿、计划回写。不碰 React / fetch。 */

export type BeautifyColorMode = "follow-shell" | "new-theme";
export type BeautifyCopyMode = "improve" | "strict";
export type BeautifyGapPolicy = "topic" | "brief" | "skip";
export type BeautifyBannerKind = "err" | "warn" | "ok";

export const BEAUTIFY_PAGE_CREDITS = 10;
export const BEAUTIFY_EDITABLE_CREDITS = 20;
export const BEAUTIFY_EXPORT_BATCH = 20;
export const BEAUTIFY_DRAFT_KEY = "anppt-replicate-draft-v1";

export const BEAUTIFY_SOURCE_LABEL: Record<string, string> = {
  material: "材料",
  outline: "大纲",
  topic: "完善补全",
  brief: "概要",
  skip: "跳过",
};

export interface BeautifyPage {
  shellUrl: string;
  canvas: HTMLCanvasElement | null;
  copy: string;
  source: string;
  imagePath: string;
  structure: unknown;
  structureReady: boolean;
  status: string;
  imageUrl: string;
  pageId: string;
  error: string;
  busy: boolean;
  tweak: string;
}

export interface BeautifyDraft {
  topic: string;
  outline: string;
  source: string;
  copyMode: BeautifyCopyMode;
  colorMode: BeautifyColorMode;
  gapPolicy: BeautifyGapPolicy;
}

export interface BeautifyBanner {
  kind: BeautifyBannerKind;
  text: string;
}

export function newBeautifySession(): string {
  return `rp${Math.random().toString(36).slice(2, 10)}`;
}

/** 每次点击一枚新键。刷新后计数器会归零，不能用页内序号，否则会撞 DUPLICATE_REQUEST。 */
export function newBeautifyRequestId(pageId: string, kind: "gen" | "tw" = "gen"): string {
  const n =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return kind === "tw" ? `${pageId}-tw-${n}` : `${pageId}-${n}`;
}

export function firstCopyLine(text: string): string {
  return (text || "").split(/\n/)[0].trim().slice(0, 80);
}

export function emptyBeautifyPage(pageId: string, extra: Partial<BeautifyPage> = {}): BeautifyPage {
  return {
    shellUrl: "",
    canvas: null,
    copy: "",
    source: "",
    imagePath: "",
    structure: null,
    structureReady: false,
    status: "待生成",
    imageUrl: "",
    pageId,
    error: "",
    busy: false,
    tweak: "",
    ...extra,
  };
}

/** 有文案且还没有成品图的页才扣生成星；已生成的只走「重试本页」。 */
export function indexesNeedingGenerate(pages: BeautifyPage[]): number[] {
  return pages.reduce<number[]>((list, page, index) => {
    if (page.copy.trim() && !page.imageUrl) list.push(index);
    return list;
  }, []);
}

export function remainingGenerateCredits(pages: BeautifyPage[]): number {
  return indexesNeedingGenerate(pages).length * BEAUTIFY_PAGE_CREDITS;
}

export function remainingEditableCredits(pages: BeautifyPage[]): number {
  return pages.filter((page) => page.imageUrl).length * BEAUTIFY_EDITABLE_CREDITS;
}

export function parseBeautifyDraft(raw: string | null): BeautifyDraft | null {
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as Partial<BeautifyDraft>;
    const copyMode = draft.copyMode === "strict" ? "strict" : "improve";
    const colorMode = draft.colorMode === "new-theme" ? "new-theme" : "follow-shell";
    const gapPolicy =
      draft.gapPolicy === "brief" || draft.gapPolicy === "skip" ? draft.gapPolicy : "topic";
    return {
      topic: String(draft.topic || ""),
      outline: String(draft.outline || ""),
      source: String(draft.source || ""),
      copyMode,
      colorMode,
      gapPolicy,
    };
  } catch {
    return null;
  }
}

export function applyPlanToPages(
  pages: BeautifyPage[],
  slides: { title?: string; content?: string; source?: string }[],
  structures: unknown[],
): BeautifyPage[] {
  return pages.map((page, i) => {
    const slide = slides[i] || {};
    const copy = [String(slide.title || "").trim(), String(slide.content || "").trim()]
      .filter(Boolean)
      .join("\n");
    const source = String(slide.source || "");
    const copyChanged = copy !== page.copy;
    const keepImage = Boolean(copy) && !copyChanged && page.imageUrl;
    return {
      ...page,
      copy,
      source,
      imageUrl: keepImage ? page.imageUrl : "",
      structure: structures[i] ?? null,
      structureReady: true,
      status: !copy
        ? "跳过"
        : copyChanged && page.imageUrl
          ? "文案已更新，需重新生成"
          : source === "material"
            ? "已用材料填写"
            : source === "outline"
              ? "已按大纲填写"
              : "已完善补全",
    };
  });
}

export function buildGenerateFinishBanner(opts: {
  newlyOk: number;
  failed: number;
  skippedDone: number;
  stoppedForCredits: boolean;
  creditsMessage?: string;
}): BeautifyBanner | null {
  if (opts.stoppedForCredits) {
    const kept = opts.newlyOk > 0 ? `已生成的 ${opts.newlyOk} 页仍保留，未生成的页未扣成图星。` : "未生成的页未扣成图星。";
    return {
      kind: "err",
      text: `${opts.creditsMessage || "星星不足"} ${kept}`.trim(),
    };
  }
  if (opts.failed > 0 && opts.newlyOk > 0) {
    return {
      kind: "warn",
      text: `已完成 ${opts.newlyOk} 页，${opts.failed} 页失败。失败页可点「重试本页」，不要整批再点生成以免已成功页被理解成还要做。`,
    };
  }
  if (opts.failed > 0) {
    return { kind: "err", text: `${opts.failed} 页生成失败，可点「重试本页」。` };
  }
  if (opts.newlyOk > 0) {
    const skipped = opts.skippedDone > 0 ? `已跳过 ${opts.skippedDone} 页已生成、不重复扣星。` : "";
    return {
      kind: "ok",
      text: `已完成 ${opts.newlyOk} 页。${skipped}可继续改图，或排队转可编辑。`.replace(/\s+/g, " ").trim(),
    };
  }
  if (opts.skippedDone > 0) {
    return { kind: "ok", text: "这些页已经生成过。要重做请点「重试本页」，整批生成不会再扣星。" };
  }
  return null;
}

export function buildExportFinishBanner(opts: {
  queued: number;
  error?: string;
}): BeautifyBanner {
  if (opts.error && opts.queued > 0) {
    return {
      kind: "warn",
      text: `已排队 ${opts.queued} 批，后面的批次失败：${opts.error}。已排队的可在下载中心查看；已扣星的批次不会因为后面失败而退回。`,
    };
  }
  if (opts.error) return { kind: "err", text: opts.error };
  return { kind: "ok", text: `已排队 ${opts.queued} 个转换任务。可在下载中心查看。` };
}

export function restoreProjectHint(pages: { imagePath: string; imageUrl: string }[]): string {
  if (!pages.length) return "项目还没有页面，请先上传参考稿";
  const missingShell = pages.some((page) => !page.imagePath);
  if (missingShell) {
    return `已打开美化项目 ${pages.length} 页，部分参考稿已过期，请重新上传后再生成。`;
  }
  return `已打开美化项目 ${pages.length} 页。结构需再点「完善文案」才会重读；直接生成仍保画面。已生成的页整批再点不会重复扣星。`;
}
