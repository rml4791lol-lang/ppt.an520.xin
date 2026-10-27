// 项目列表（整套 deck + 单页项目）。删除软删；超过保留期后在列表访问时物理清理
// （行级联删除 + 生成图文件删除；复刻壳图随项目过期清理；导出文件不清）。
import path from 'node:path';
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { ApiError } from '../http';
import { getGenerationConfig } from './config';
import { getGenDb, nowMs } from './db';
import { reconcileDeckGeneration } from './recovery';
import { absPathForRelPath, purgeExpiredKindUploads } from './storage';
import { cleanString } from './types';

type Row = Record<string, string | number | null>;

export interface ProjectItem {
  id: string;
  projectType: 'deck' | 'single-page';
  /** 单页项目来源：single=创意单页，replicate=美化复刻；整套 deck 无此字段 */
  source?: 'single' | 'replicate';
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
  const pageCount = row.page_count != null
    ? Number(row.page_count)
    : Number(db.prepare('SELECT COUNT(*) AS c FROM deck_slides WHERE deck_id = ?').get(deckId)?.c || 0);
  const coverUrl = row.cover_url != null
    ? String(row.cover_url)
    : String(
      db
        .prepare(
          `SELECT v.image_url FROM deck_slides s JOIN slide_versions v ON v.id = s.active_version_id
           WHERE s.deck_id = ? AND s.gen_status IN ('succeeded','stale') ORDER BY s.page_index ASC LIMIT 1`,
        )
        .get(deckId)?.image_url || '',
    );
  return {
    id: deckId,
    projectType: 'deck',
    title: String(row.title || '未命名项目'),
    status: String(row.status || 'parsed'),
    pageCount,
    coverUrl,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function singleProjectToItem(row: Row): ProjectItem {
  const projectId = String(row.id);
  const db = getGenDb();
  const pageCount = row.page_count != null
    ? Number(row.page_count)
    : Number(db.prepare('SELECT COUNT(*) AS c FROM single_pages WHERE project_id = ?').get(projectId)?.c || 0);
  const coverUrl = row.cover_url != null
    ? String(row.cover_url)
    : String(
      db
        .prepare(
          `SELECT v.image_url FROM single_pages p JOIN single_page_versions v ON v.id = p.active_version_id
           WHERE p.project_id = ? AND p.status = 'succeeded' ORDER BY p.page_index ASC LIMIT 1`,
        )
        .get(projectId)?.image_url || '',
    );
  return {
    id: projectId,
    projectType: 'single-page',
    source: String(row.source || '') === 'replicate' ? 'replicate' : 'single',
    title: String(row.title || '未命名单页项目'),
    status: pageCount > 0 ? 'active' : 'empty',
    pageCount,
    coverUrl,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 物理清理软删超过保留期的项目：删行（FK 级联 slides/pages/versions）+ 删生成图。
 * deck 图在 generated/{userId}/{deckId}/ 整目录删除；单页图按 version.image_path
 * 逐个删。复刻壳图（shell_path / uploads/{userId}/replicate/）随项目过期删；
 * 导出文件仍不清。失败只忽略。
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
    const shells = db
      .prepare("SELECT shell_path FROM single_pages WHERE project_id = ? AND shell_path != ''")
      .all(row.id) as Array<{ shell_path: string }>;
    db.prepare('DELETE FROM single_page_projects WHERE id = ?').run(row.id);
    for (const file of files) {
      const absPath = absPathForRelPath(String(file.image_path), config);
      if (absPath) void rm(absPath, { force: true }).catch(() => {});
    }
    for (const shell of shells) {
      const absPath = absPathForRelPath(String(shell.shell_path), config);
      if (!absPath) continue;
      try {
        rmSync(absPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const liveShells = (
    db
      .prepare(
        `SELECT shell_path FROM single_pages
         WHERE user_id = ? AND shell_path != ''
           AND project_id IN (SELECT id FROM single_page_projects WHERE user_id = ? AND deleted_at IS NULL)`,
      )
      .all(userId, userId) as Array<{ shell_path: string }>
  ).map((row) => String(row.shell_path));
  void purgeExpiredKindUploads(userId, 'replicate', liveShells, cutoff, config).catch(() => {});
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
      .prepare(
        `SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
           (SELECT COUNT(*) FROM deck_slides s WHERE s.deck_id = d.id) AS page_count,
           (SELECT v.image_url FROM deck_slides s JOIN slide_versions v ON v.id = s.active_version_id
            WHERE s.deck_id = d.id AND s.gen_status IN ('succeeded','stale')
            ORDER BY s.page_index ASC LIMIT 1) AS cover_url
         FROM decks d
         WHERE d.user_id = ? AND d.deleted_at IS NULL
         ORDER BY d.updated_at DESC`,
      )
      .all(userId) as Row[];
    // 读点即收敛：列表里卡在 generating 的 deck 先懒恢复——用户不打开详情也能解除死锁
    for (const row of rows) {
      if (String(row.status) !== 'generating') continue;
      const deckId = String(row.id);
      if (!reconcileDeckGeneration({ id: deckId, userId, status: 'generating' })) continue;
      const healed = db.prepare('SELECT status, updated_at FROM decks WHERE id = ?').get(deckId) as Row | undefined;
      row.status = String(healed?.status ?? row.status);
      row.updated_at = Number(healed?.updated_at ?? row.updated_at);
    }
    items = items.concat(rows.map(deckToItem));
  }
  if (!type || type === 'single-page') {
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.source, p.created_at,
           MAX(p.updated_at, COALESCE((SELECT MAX(sp.updated_at) FROM single_pages sp WHERE sp.project_id = p.id), 0)) AS updated_at,
           (SELECT COUNT(*) FROM single_pages sp WHERE sp.project_id = p.id) AS page_count,
           (SELECT v.image_url FROM single_pages sp JOIN single_page_versions v ON v.id = sp.active_version_id
            WHERE sp.project_id = p.id AND sp.status = 'succeeded'
            ORDER BY sp.page_index ASC LIMIT 1) AS cover_url
         FROM single_page_projects p
         WHERE p.user_id = ? AND p.deleted_at IS NULL
         ORDER BY updated_at DESC`,
      )
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
