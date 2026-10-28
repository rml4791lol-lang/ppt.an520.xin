// 复刻的项目/页实体与生成入口：草稿写入与结构/配色合同归本模块；
// 逐页提示词装配走视觉计划的 replicate 模式（保壳世界），扣费/退款/版本/懒恢复仍只有平台单页运行时一份。
import { ApiError, validationError } from '@/lib/server/http';
import { withTransaction } from '@/lib/server/db';
import { genId, getGenDb, nowMs } from '@/lib/server/generation/db';
import {
  assertOwnedUpload,
  cleanPageId,
  getOrCreateProject,
  runSinglePageJob,
  upsertPage,
  type SinglePageDeps,
  type SingleRunResult,
} from '@/lib/server/generation/single-pages';
import { parseOwnedUploadRelPath } from '@/lib/server/generation/storage';
import { cleanString } from '@/lib/server/generation/types';
import { buildVisualPlan } from '@/lib/server/generation/visual-plan';
import {
  parseIncomingStructure,
  resolveReplicateColorMode,
} from './replicate';

export interface ReplicateDraftInput {
  projectId?: string;
  title?: string;
  pages: Array<{
    pageId?: string;
    title?: string;
    content?: string;
    imagePath?: string;
  }>;
}

/** PPT 美化草稿：只保存项目/页面/参考稿路径，不生成、不扣星。 */
export function saveReplicateDraft(
  userId: string,
  input: ReplicateDraftInput,
): { projectId: string; pageCount: number } {
  const rawPages = Array.isArray(input.pages) ? input.pages : [];
  if (rawPages.length === 0) throw validationError('草稿至少要有 1 页');
  if (rawPages.length > 40) throw new ApiError('TOO_MANY_PAGES', '一次最多保存 40 页', 400, false);
  const title = cleanString(input.title, 120) || 'PPT 美化';
  const db = getGenDb();
  return withTransaction(db, () => {
    const projectId = getOrCreateProject(userId, input.projectId, title, 'replicate');
    db.prepare('UPDATE single_page_projects SET title = ?, source = ?, updated_at = ? WHERE id = ?').run(
      title,
      'replicate',
      nowMs(),
      projectId,
    );
    const pages = rawPages.map((page, index) => {
      const pageId = cleanString(page.pageId, 80) || genId('spp_page');
      const imagePath = page.imagePath
        ? parseOwnedUploadRelPath(userId, page.imagePath)
        : null;
      if (page.imagePath && !imagePath) {
        throw new ApiError('INVALID_IMAGE_PATH', `第 ${index + 1} 页参考稿路径无效`, 400, false);
      }
      return {
        pageId,
        title: cleanString(page.title, 120) || `第 ${index + 1} 页`,
        content: cleanString(page.content, 8000),
        imagePath: imagePath || '',
      };
    });
    for (const page of pages) {
      upsertPage(userId, {
        pageId: page.pageId,
        projectId,
        title: page.title,
        content: page.content,
        projectSource: 'replicate',
        shellPath: page.imagePath,
      });
    }
    return { projectId, pageCount: pages.length };
  });
}

export interface ReplicateGenerateInput {
  pageId: string;
  projectId?: string;
  title?: string;
  content: string;
  stylePackId?: string;
  /** 壳图（参考稿 /api/assets/upload 返回的 path）；复刻必须有 */
  imagePath?: string;
  /** follow-shell（默认）| new-theme */
  colorMode?: string;
  /** 客户端幂等键（可选）；缺省用服务端 jobId */
  requestId?: string;
  /** 为 true 时用 structure（可空）当结构卡，不再抽 VLM */
  structureProvided?: boolean;
  structure?: unknown;
}

/** 复刻一页：结构参考 + 换文案，指令按本模块合同装配后交给平台单页运行时。 */
export async function generateReplicatePage(
  userId: string,
  input: ReplicateGenerateInput,
  deps: SinglePageDeps = {},
): Promise<SingleRunResult> {
  const content = cleanString(input.content, 8000);
  if (!content) throw validationError('页面内容不能为空');
  if (!input.imagePath) throw validationError('复刻需要上传壳页图');
  const shellPath = assertOwnedUpload(userId, input.imagePath);
  const page = upsertPage(userId, {
    pageId: cleanPageId(input.pageId),
    projectId: input.projectId,
    title: input.title,
    content,
    stylePackId: input.stylePackId,
    projectSource: 'replicate',
    shellPath,
  });
  const plan = buildVisualPlan({
    slide: {
      pageIndex: page.pageIndex,
      pageType: '',
      role: 'content',
      title: page.title,
      goal: '',
      summary: page.content.split(/\n+/).map((line) => line.trim()).filter(Boolean),
    },
    deckContext: { totalPages: 1, pageIndex: page.pageIndex },
    // 壳图就是复刻的画面世界：不叠加风格/模板参考图
    stylePack: null,
    template: null,
    mode: 'replicate',
    replicate: {
      structure: input.structureProvided ? parseIncomingStructure(input.structure) : null,
      colorMode: resolveReplicateColorMode(input.colorMode),
    },
  });
  return runSinglePageJob(
    page,
    {
      kind: 'single-generate',
      requestId: input.requestId,
      sourceImagePath: shellPath,
      plan,
      editInstruction: plan.prompt,
    },
    deps,
  );
}
