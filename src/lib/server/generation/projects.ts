// 项目列表（整套 deck + 单页项目）。删除软删；超过保留期后在列表访问时物理清理
// （行级联删除 + 生成图文件删除；导出文件与 uploads 不动）。
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { ApiError } from '../http';
import { getGenerationConfig } from './config';
import { getGenDb, nowMs } from './db';
import { absPathForRelPath } from './storage';
import { cleanString } from './types';

type Row = Record<string, string | number | null>;

export interface ProjectItem {
  id: string;
  projectType: 'deck' | 'single-page';
  title: string;
  status: string;
  pageCount: number;
  coverUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectListResult {
  items: ProjectItem[];
  total: number;
  page: number;
  pageSize: number;
  /** UI 层文案用：项目保留 N 天，过期自动删除（软删策略） */
  retentionDays: number;
}

function deckToItem(row: Row): ProjectItem {
  const deckId = String(row.id);
  const db = getGenDb();
  const pageCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM deck_slides WHERE deck_id = ?').get(deckId)?.c || 0,
  );
  const cover = db
    .prepare(
      `SELECT v.image_url FROM deck_slides s JOIN slide_versions v ON v.id = s.active_version_id
       WHERE s.deck_id = ? AND s.gen_status IN ('succeeded','stale') ORDER BY s.page_index ASC LIMIT 1`,
    )
    .get(deckId);
  return {
    id: deckId,
    projectType: 'deck',
    title: String(row.title || '未命名项目'),
    status: String(row.status || 'parsed'),
    pageCount,
    coverUrl: String(cover?.image_url || ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function singleProjectToItem(row: Row): ProjectItem {
  const projectId = String(row.id);
  const db = getGenDb();
  const pageCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM single_pages WHERE project_id = ?').get(projectId)?.c || 0,
  );
  const cover = db
    .prepare(
      `SELECT v.image_url FROM single_pages p JOIN single_page_versions v ON v.id = p.active_version_id
       WHERE p.project_id = ? AND p.status = 'succeeded' ORDER BY p.page_index ASC LIMIT 1`,
    )
    .get(projectId);
  return {
    id: projectId,
    projectType: 'single-page',
    title: String(row.title || '未命名单页项目'),
    status: pageCount > 0 ? 'active' : 'empty',
    pageCount,
    coverUrl: String(cover?.image_url || ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 物理清理软删超过保留期的项目：删行（FK 级联 slides/pages/versions）+ 删生成图。
 * deck 图在 generated/{userId}/{deckId}/ 整目录删除；单页图按 version.image_path
 * 逐个删（共用 single/ 目录）。导出文件与 uploads 不在清理范围。失败只忽略。
 */
function purgeExpiredProjects(userId: string): void {
  const db = getGenDb();
  const config = getGenerationConfig();
  const cutoff = nowMs() - config.projectRetentionDays * 24 * 60 * 60 * 1000;

  const deadDecks = db
    .prepare('SELECT id FROM decks WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?')
    .all(userId, cutoff) as Array<{ id: string }>;
  for (const row of deadDecks) {
    db.prepare('DELETE FROM generation_jobs WHERE deck_id = ?').run(row.id);
    db.prepare('DELETE FROM decks WHERE id = ?').run(row.id);
    void rm(path.join(config.generatedDir, userId, row.id), { recursive: true, force: true }).catch(() => {});
  }

  const deadProjects = db
    .prepare('SELECT id FROM single_page_projects WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?')
    .all(userId, cutoff) as Array<{ id: string }>;
  for (const row of deadProjects) {
    const files = db
      .prepare(
        "SELECT image_path FROM single_page_versions WHERE image_path != '' AND page_id IN (SELECT id FROM single_pages WHERE project_id = ?)",
      )
      .all(row.id) as Array<{ image_path: string }>;
    db.prepare('DELETE FROM single_page_projects WHERE id = ?').run(row.id);
    for (const file of files) {
      const absPath = absPathForRelPath(String(file.image_path), config);
      if (absPath) void rm(absPath, { force: true }).catch(() => {});
    }
  }
}

export function listProjects(
  userId: string,
  query: { projectType?: string; page?: number; pageSize?: number } = {},
): ProjectListResult {
  const db = getGenDb();
  purgeExpiredProjects(userId);
  const type = cleanString(query.projectType, 20);
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  let items: ProjectItem[] = [];
  if (!type || type === 'deck') {
    const rows = db
      .prepare('SELECT * FROM decks WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(userId) as Row[];
    items = items.concat(rows.map(deckToItem));
  }
  if (!type || type === 'single-page') {
    const rows = db
      .prepare('SELECT * FROM single_page_projects WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(userId) as Row[];
    items = items.concat(rows.map(singleProjectToItem));
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  const total = items.length;
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    retentionDays: getGenerationConfig().projectRetentionDays,
  };
}

function findDeckOwned(userId: string, id: string): Row | undefined {
  return getGenDb()
    .prepare('SELECT * FROM decks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, userId) as Row | undefined;
}

function findSingleProjectOwned(userId: string, id: string): Row | undefined {
  return getGenDb()
    .prepare('SELECT * FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, userId) as Row | undefined;
}

export function renameProject(userId: string, id: string, title: string): ProjectItem {
  const clean = cleanString(id, 80);
  const name = cleanString(title, 120);
  if (!name) throw new ApiError('VALIDATION_ERROR', '标题不能为空', 400, false);
  const db = getGenDb();
  const ts = nowMs();
  const deck = findDeckOwned(userId, clean);
  if (deck) {
    db.prepare('UPDATE decks SET title = ?, updated_at = ? WHERE id = ?').run(name, ts, clean);
    return deckToItem({ ...deck, title: name, updated_at: ts });
  }
  const project = findSingleProjectOwned(userId, clean);
  if (project) {
    db.prepare('UPDATE single_page_projects SET title = ?, updated_at = ? WHERE id = ?').run(name, ts, clean);
    return singleProjectToItem({ ...project, title: name, updated_at: ts });
  }
  throw new ApiError('PROJECT_NOT_FOUND', '项目不存在或已删除', 404, false);
}

/** 软删：仅打 deleted_at 标记；超过保留期后由 listProjects 懒清理物理删除 */
export function deleteProject(userId: string, id: string): { id: string; projectType: string } {
  const clean = cleanString(id, 80);
  const db = getGenDb();
  const ts = nowMs();
  if (findDeckOwned(userId, clean)) {
    db.prepare('UPDATE decks SET deleted_at = ? WHERE id = ?').run(ts, clean);
    return { id: clean, projectType: 'deck' };
  }
  if (findSingleProjectOwned(userId, clean)) {
    db.prepare('UPDATE single_page_projects SET deleted_at = ? WHERE id = ?').run(ts, clean);
    return { id: clean, projectType: 'single-page' };
  }
  throw new ApiError('PROJECT_NOT_FOUND', '项目不存在或已删除', 404, false);
}
