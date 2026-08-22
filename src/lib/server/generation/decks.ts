// deck 整套 PPT 状态机的存储与纯数据操作。
// 状态机（契约 §4）：
//   parse → outline（可增/删/重排/拆页）→ structure → confirm-structure（内容冻结）
//   → style → generate（逐页生图）→ deliver（图片版导出免费，可编辑导出占位）
// 冻结后内容类 action 一律拒绝，需 unlock-structure 解锁（作废已生成页）。
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../http';
import { withTransaction } from '../db';
import { genId, getGenDb, nowMs } from './db';
import { reconcileDeckGeneration } from './recovery';
import {
  cleanString,
  cleanStringArray,
  isSlideRole,
  type DeckStatus,
  type GenStatus,
  type JobStatus,
  type OutlineSlide,
  type SlideRole,
  type StructureStatus,
} from './types';

export interface DeckRow {
  id: string;
  userId: string;
  title: string;
  sourceFileName: string;
  sourceText: string;
  durationMinutes: number;
  targetPageCount: number;
  qualityTier: string;
  stylePackId: string;
  status: DeckStatus;
  error: string;
  confirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeckSlideRow extends OutlineSlide {
  slideId: string;
  deckId: string;
  structureStatus: StructureStatus;
  structureWarnings: string[];
  structuredContent: string;
  genStatus: GenStatus;
  genError: string;
  activeVersionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SlideVersionRow {
  versionId: string;
  slideId: string;
  deckId: string;
  versionNo: number;
  kind: string;
  prompt: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  imagePath: string;
  imageUrl: string;
  error: string;
  jobId: string;
  createdAt: number;
  updatedAt: number;
}

export interface GenerationJobRow {
  jobId: string;
  userId: string;
  deckId: string;
  kind: string;
  status: JobStatus;
  total: number;
  succeeded: number;
  failed: number;
  error: string;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, string | number | null>;

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function toDeckRow(row: Row): DeckRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title || ''),
    sourceFileName: String(row.source_file_name || ''),
    sourceText: String(row.source_text || ''),
    durationMinutes: Number(row.duration_minutes) || 15,
    targetPageCount: Number(row.target_page_count) || 10,
    qualityTier: String(row.quality_tier || 'standard'),
    stylePackId: String(row.style_pack_id || ''),
    status: String(row.status || 'parsed') as DeckStatus,
    error: String(row.error || ''),
    confirmedAt: row.confirmed_at == null ? null : Number(row.confirmed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSlideRow(row: Row): DeckSlideRow {
  return {
    slideId: String(row.id),
    deckId: String(row.deck_id),
    pageIndex: Number(row.page_index),
    role: String(row.role || 'content') as SlideRole,
    chapter: String(row.chapter || ''),
    pageType: String(row.page_type || ''),
    title: String(row.title || ''),
    goal: String(row.goal || ''),
    mustKeep: parseJsonArray(row.must_keep),
    rawText: String(row.raw_text || ''),
    summary: parseJsonArray(row.summary),
    visualNote: String(row.visual_note || ''),
    structuredContent: String(row.structured_content || ''),
    structureStatus: String(row.structure_status || 'pending') as StructureStatus,
    structureWarnings: parseJsonArray(row.structure_warnings),
    genStatus: String(row.gen_status || 'idle') as GenStatus,
    genError: String(row.gen_error || ''),
    activeVersionId: String(row.active_version_id || ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toVersionRow(row: Row): SlideVersionRow {
  return {
    versionId: String(row.id),
    slideId: String(row.slide_id),
    deckId: String(row.deck_id),
    versionNo: Number(row.version_no),
    kind: String(row.kind || 'generate'),
    prompt: String(row.prompt || ''),
    status: String(row.status || 'queued') as SlideVersionRow['status'],
    imagePath: String(row.image_path || ''),
    imageUrl: String(row.image_url || ''),
    error: String(row.error || ''),
    jobId: String(row.job_id || ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toJobRow(row: Row): GenerationJobRow {
  return {
    jobId: String(row.id),
    userId: String(row.user_id),
    deckId: String(row.deck_id || ''),
    kind: String(row.kind || ''),
    status: String(row.status || 'queued') as JobStatus,
    total: Number(row.total),
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    error: String(row.error || ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------- 读取 ----------

export function getOwnedDeck(userId: string, deckId: string): DeckRow {
  const row = getGenDb()
    .prepare('SELECT * FROM decks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cleanString(deckId, 80), userId) as Row | undefined;
  if (!row) throw new ApiError('DECK_NOT_FOUND', '项目不存在或已删除', 404, false);
  return toDeckRow(row);
}

export function listSlides(deckId: string): DeckSlideRow[] {
  const rows = getGenDb()
    .prepare('SELECT * FROM deck_slides WHERE deck_id = ? ORDER BY page_index ASC')
    .all(deckId) as Row[];
  return rows.map(toSlideRow);
}

export function getSlide(deckId: string, slideId: string): DeckSlideRow {
  const row = getGenDb()
    .prepare('SELECT * FROM deck_slides WHERE deck_id = ? AND id = ?')
    .get(deckId, cleanString(slideId, 80)) as Row | undefined;
  if (!row) throw new ApiError('SLIDE_NOT_FOUND', '页面不存在', 404, false);
  return toSlideRow(row);
}

export function listVersions(slideId: string): SlideVersionRow[] {
  const rows = getGenDb()
    .prepare('SELECT * FROM slide_versions WHERE slide_id = ? ORDER BY version_no DESC')
    .all(slideId) as Row[];
  return rows.map(toVersionRow);
}

export function latestJob(deckId: string): GenerationJobRow | null {
  const row = getGenDb()
    .prepare('SELECT * FROM generation_jobs WHERE deck_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(deckId) as Row | undefined;
  return row ? toJobRow(row) : null;
}

export function runningJob(deckId: string): GenerationJobRow | null {
  const row = getGenDb()
    .prepare(
      "SELECT * FROM generation_jobs WHERE deck_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
    )
    .get(deckId) as Row | undefined;
  return row ? toJobRow(row) : null;
}

// ---------- 写入 ----------

export interface CreateDeckInput {
  title: string;
  sourceFileName: string;
  sourceText: string;
  durationMinutes: number;
  targetPageCount: number;
  qualityTier: string;
  stylePackId: string;
}

export function createDeck(userId: string, input: CreateDeckInput): DeckRow {
  const ts = nowMs();
  const id = genId('deck');
  getGenDb()
    .prepare(
      `INSERT INTO decks
        (id, user_id, title, source_file_name, source_text, duration_minutes, target_page_count,
         quality_tier, style_pack_id, status, error, confirmed_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed', '', NULL, ?, ?, NULL)`,
    )
    .run(
      id,
      userId,
      cleanString(input.title, 120) || '未命名项目',
      cleanString(input.sourceFileName, 200),
      input.sourceText,
      input.durationMinutes,
      input.targetPageCount,
      cleanString(input.qualityTier, 20) || 'standard',
      cleanString(input.stylePackId, 80),
      ts,
      ts,
    );
  return getOwnedDeck(userId, id);
}

export function touchDeck(deckId: string, patch: Partial<Pick<DeckRow, 'status' | 'stylePackId' | 'error' | 'title'>> & { confirmedAt?: number | null } = {}): void {
  const db = getGenDb();
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [nowMs()];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.stylePackId !== undefined) {
    sets.push('style_pack_id = ?');
    params.push(patch.stylePackId);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(cleanString(patch.title, 120));
  }
  if (patch.confirmedAt !== undefined) {
    sets.push('confirmed_at = ?');
    params.push(patch.confirmedAt);
  }
  params.push(deckId);
  db.prepare(`UPDATE decks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/** 整批替换大纲页（outline 生成 / 强制重生成）。仅内容未冻结时调用。 */
export function replaceSlides(deckId: string, slides: OutlineSlide[]): void {
  const db = getGenDb();
  withTransaction(db, () => {
    db.prepare('DELETE FROM deck_slides WHERE deck_id = ?').run(deckId);
    const ts = nowMs();
    const insert = db.prepare(
      `INSERT INTO deck_slides
        (id, deck_id, page_index, role, chapter, page_type, title, goal, must_keep, raw_text, summary,
         visual_note, structured_content, structure_status, structure_warnings, gen_status, gen_error,
         active_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'pending', '[]', 'idle', '', '', ?, ?)`,
    );
    slides.forEach((slide, index) => {
      insert.run(
        genId('slide'),
        deckId,
        index,
        slide.role,
        slide.chapter,
        slide.pageType,
        slide.title,
        slide.goal,
        JSON.stringify(slide.mustKeep),
        slide.rawText,
        JSON.stringify(slide.summary),
        slide.visualNote,
        ts,
        ts,
      );
    });
  });
}

function reindexSlides(db: DatabaseSync, deckId: string): void {
  const rows = db
    .prepare('SELECT id FROM deck_slides WHERE deck_id = ? ORDER BY page_index ASC, created_at ASC')
    .all(deckId) as Row[];
  rows.forEach((row, index) => {
    db.prepare('UPDATE deck_slides SET page_index = ? WHERE id = ?').run(index, String(row.id));
  });
}

export function insertSlide(deckId: string, atIndex: number, slide?: Partial<OutlineSlide>): void {
  const db = getGenDb();
  withTransaction(db, () => {
    const count = Number(db.prepare('SELECT COUNT(*) AS c FROM deck_slides WHERE deck_id = ?').get(deckId)?.c || 0);
    const target = Math.max(0, Math.min(count, Math.floor(atIndex)));
    db.prepare('UPDATE deck_slides SET page_index = page_index + 1 WHERE deck_id = ? AND page_index >= ?').run(deckId, target);
    const ts = nowMs();
    db.prepare(
      `INSERT INTO deck_slides
        (id, deck_id, page_index, role, chapter, page_type, title, goal, must_keep, raw_text, summary,
         visual_note, structured_content, structure_status, structure_warnings, gen_status, gen_error,
         active_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', ?, ?, '[]', ?, '[]', ?, '', 'pending', '[]', 'idle', '', '', ?, ?)`,
    ).run(
      genId('slide'),
      deckId,
      target,
      slide?.role || 'content',
      cleanString(slide?.title, 200) || `第 ${target + 1} 页`,
      cleanString(slide?.goal, 500),
      cleanString(slide?.rawText, 8000),
      cleanString(slide?.visualNote, 500),
      ts,
      ts,
    );
    reindexSlides(db, deckId);
  });
}

export function deleteSlide(deckId: string, slideId: string): void {
  const db = getGenDb();
  withTransaction(db, () => {
    db.prepare('DELETE FROM deck_slides WHERE deck_id = ? AND id = ?').run(deckId, slideId);
    reindexSlides(db, deckId);
  });
}

export function reorderSlides(deckId: string, order: string[]): void {
  const db = getGenDb();
  withTransaction(db, () => {
    const rows = db.prepare('SELECT id FROM deck_slides WHERE deck_id = ?').all(deckId) as Row[];
    const existing = new Set(rows.map((row) => String(row.id)));
    const wanted = order.map((id) => cleanString(id, 80)).filter(Boolean);
    if (wanted.length !== existing.size || !wanted.every((id) => existing.has(id))) {
      throw new ApiError('VALIDATION_ERROR', 'order 必须包含全部页面且不多不少', 400, false);
    }
    wanted.forEach((id, index) => {
      db.prepare('UPDATE deck_slides SET page_index = ? WHERE id = ?').run(index, id);
    });
  });
}

export function replaceSlideWithMany(deckId: string, slideId: string, slides: OutlineSlide[]): void {
  const db = getGenDb();
  withTransaction(db, () => {
    const source = db.prepare('SELECT * FROM deck_slides WHERE deck_id = ? AND id = ?').get(deckId, slideId) as Row | undefined;
    if (!source) throw new ApiError('SLIDE_NOT_FOUND', '页面不存在', 404, false);
    const baseIndex = Number(source.page_index);
    db.prepare('DELETE FROM deck_slides WHERE id = ?').run(slideId);
    const ts = nowMs();
    const insert = db.prepare(
      `INSERT INTO deck_slides
        (id, deck_id, page_index, role, chapter, page_type, title, goal, must_keep, raw_text, summary,
         visual_note, structured_content, structure_status, structure_warnings, gen_status, gen_error,
         active_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'pending', '[]', 'idle', '', '', ?, ?)`,
    );
    slides.forEach((slide, offset) => {
      insert.run(
        genId('slide'),
        deckId,
        baseIndex + offset,
        slide.role,
        slide.chapter,
        slide.pageType,
        slide.title,
        slide.goal,
        JSON.stringify(slide.mustKeep),
        slide.rawText,
        JSON.stringify(slide.summary),
        slide.visualNote,
        ts,
        ts,
      );
    });
    reindexSlides(db, deckId);
  });
}

export function updateSlideStructure(
  deckId: string,
  slideId: string,
  result: { ok: boolean; structuredContent: string; warnings: string[]; errors: string[] },
): void {
  getGenDb()
    .prepare(
      `UPDATE deck_slides SET structured_content = ?, structure_status = ?, structure_warnings = ?, updated_at = ?
       WHERE deck_id = ? AND id = ?`,
    )
    .run(
      result.structuredContent,
      result.ok ? 'ok' : 'failed',
      JSON.stringify(result.warnings.concat(result.errors).slice(0, 10)),
      nowMs(),
      deckId,
      slideId,
    );
}

/** 在线编辑大纲页字段（未冻结时由 action 层调用）。标题/原文变更会作废该页梳理结果。 */
export function updateSlideContent(
  deckId: string,
  slideId: string,
  patch: Partial<Pick<OutlineSlide, 'role' | 'chapter' | 'pageType' | 'title' | 'goal' | 'rawText' | 'summary' | 'visualNote'>> & {
    structuredContent?: string;
  },
): { contentChanged: boolean } {
  const db = getGenDb();
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [nowMs()];
  let contentChanged = false;
  if (patch.role !== undefined) {
    sets.push('role = ?');
    params.push(isSlideRole(patch.role) ? patch.role : 'content');
  }
  if (patch.chapter !== undefined) {
    sets.push('chapter = ?');
    params.push(cleanString(patch.chapter, 120));
  }
  if (patch.pageType !== undefined) {
    sets.push('page_type = ?');
    params.push(cleanString(patch.pageType, 80));
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(cleanString(patch.title, 200) || '未命名页');
    contentChanged = true;
  }
  if (patch.goal !== undefined) {
    sets.push('goal = ?');
    params.push(cleanString(patch.goal, 500));
  }
  if (patch.rawText !== undefined) {
    sets.push('raw_text = ?');
    params.push(cleanString(patch.rawText, 8000));
    contentChanged = true;
  }
  if (patch.summary !== undefined) {
    sets.push('summary = ?');
    params.push(JSON.stringify(cleanStringArray(patch.summary, 12, 300)));
  }
  if (patch.visualNote !== undefined) {
    sets.push('visual_note = ?');
    params.push(cleanString(patch.visualNote, 500));
  }
  if (patch.structuredContent !== undefined) {
    // 人工直改结构化内容 = 人工确认该页结构
    sets.push('structured_content = ?', 'structure_status = ?', "structure_warnings = '[]'");
    const value = cleanString(patch.structuredContent, 12000);
    params.push(value, value ? 'ok' : 'pending');
  } else if (contentChanged) {
    sets.push("structured_content = ''", "structure_status = 'pending'", "structure_warnings = '[]'");
  }
  params.push(deckId, slideId);
  const res = db
    .prepare(`UPDATE deck_slides SET ${sets.join(', ')} WHERE deck_id = ? AND id = ?`)
    .run(...params);
  if (!res.changes) throw new ApiError('SLIDE_NOT_FOUND', '页面不存在', 404, false);
  return { contentChanged };
}

/** 版本回退：把某页的活动版本切到历史成功版本；slide 处于 stale（内容已作废）时拒绝。 */
export function setActiveVersion(deckId: string, slideId: string, versionId: string): void {
  const db = getGenDb();
  const slide = db
    .prepare('SELECT gen_status FROM deck_slides WHERE deck_id = ? AND id = ?')
    .get(deckId, cleanString(slideId, 80)) as Row | undefined;
  if (!slide) throw new ApiError('SLIDE_NOT_FOUND', '页面不存在', 404, false);
  if (String(slide.gen_status) === 'stale') {
    throw new ApiError('CONTENT_UNLOCKED', '内容已解锁作废，请重新确认并生成', 409, false);
  }
  const version = db
    .prepare('SELECT id, status FROM slide_versions WHERE deck_id = ? AND slide_id = ? AND id = ?')
    .get(deckId, cleanString(slideId, 80), cleanString(versionId, 80)) as Row | undefined;
  if (!version) throw new ApiError('VERSION_NOT_FOUND', '版本不存在', 404, false);
  if (String(version.status) !== 'succeeded') {
    throw new ApiError('VERSION_NOT_READY', '只能切换到生成成功的版本', 409, false);
  }
  db.prepare(
    "UPDATE deck_slides SET active_version_id = ?, gen_status = 'succeeded', gen_error = '', updated_at = ? WHERE deck_id = ? AND id = ?",
  ).run(String(version.id), nowMs(), deckId, cleanString(slideId, 80));
}

export function markSlidesGenStale(deckId: string): number {
  const result = getGenDb()
    .prepare("UPDATE deck_slides SET gen_status = 'stale', updated_at = ? WHERE deck_id = ? AND gen_status = 'succeeded'")
    .run(nowMs(), deckId);
  return Number(result.changes || 0);
}

// ---------- job / version 写入（generate.ts 也用） ----------

export function createJob(userId: string, deckId: string, kind: string, total: number): GenerationJobRow {
  const ts = nowMs();
  const id = genId('job');
  getGenDb()
    .prepare(
      `INSERT INTO generation_jobs (id, user_id, deck_id, kind, status, total, succeeded, failed, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, '', ?, ?)`,
    )
    .run(id, userId, deckId, kind, total, ts, ts);
  return {
    jobId: id,
    userId,
    deckId,
    kind,
    status: 'queued',
    total,
    succeeded: 0,
    failed: 0,
    error: '',
    createdAt: ts,
    updatedAt: ts,
  };
}

export function updateJob(jobId: string, patch: Partial<Pick<GenerationJobRow, 'status' | 'succeeded' | 'failed' | 'error'>>): void {
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [nowMs()];
  for (const key of ['status', 'succeeded', 'failed', 'error'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key === 'status' ? 'status' : key} = ?`);
      params.push(patch[key] as string | number);
    }
  }
  params.push(jobId);
  getGenDb().prepare(`UPDATE generation_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function nextVersionNo(slideId: string): number {
  const row = getGenDb().prepare('SELECT MAX(version_no) AS m FROM slide_versions WHERE slide_id = ?').get(slideId);
  return (Number(row?.m) || 0) + 1;
}

export function createSlideVersion(
  slide: DeckSlideRow,
  opts: { kind: string; prompt: string; jobId: string },
): SlideVersionRow {
  const ts = nowMs();
  const id = genId('ver');
  const versionNo = nextVersionNo(slide.slideId);
  getGenDb()
    .prepare(
      `INSERT INTO slide_versions
        (id, slide_id, deck_id, version_no, kind, prompt, status, image_path, image_url, error, job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', '', '', '', ?, ?, ?)`,
    )
    .run(id, slide.slideId, slide.deckId, versionNo, opts.kind, opts.prompt, opts.jobId, ts, ts);
  return {
    versionId: id,
    slideId: slide.slideId,
    deckId: slide.deckId,
    versionNo,
    kind: opts.kind,
    prompt: opts.prompt,
    status: 'queued',
    imagePath: '',
    imageUrl: '',
    error: '',
    jobId: opts.jobId,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function updateSlideVersion(
  versionId: string,
  patch: Partial<Pick<SlideVersionRow, 'status' | 'imagePath' | 'imageUrl' | 'error'>>,
): void {
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [nowMs()];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.imagePath !== undefined) {
    sets.push('image_path = ?');
    params.push(patch.imagePath);
  }
  if (patch.imageUrl !== undefined) {
    sets.push('image_url = ?');
    params.push(patch.imageUrl);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }
  params.push(versionId);
  getGenDb().prepare(`UPDATE slide_versions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function updateSlideGen(
  deckId: string,
  slideId: string,
  patch: { genStatus?: GenStatus; genError?: string; activeVersionId?: string },
): void {
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [nowMs()];
  if (patch.genStatus !== undefined) {
    sets.push('gen_status = ?');
    params.push(patch.genStatus);
  }
  if (patch.genError !== undefined) {
    sets.push('gen_error = ?');
    params.push(patch.genError);
  }
  if (patch.activeVersionId !== undefined) {
    sets.push('active_version_id = ?');
    params.push(patch.activeVersionId);
  }
  params.push(deckId, slideId);
  getGenDb().prepare(`UPDATE deck_slides SET ${sets.join(', ')} WHERE deck_id = ? AND id = ?`).run(...params);
}

// ---------- 全量状态（前端 2.5s 轮询用） ----------

export function getDeckState(userId: string, deckId: string) {
  let deck = getOwnedDeck(userId, deckId);
  // 懒恢复：重启/崩溃留下的 generating 死锁与孤儿扣费在读状态时收敛
  if (reconcileDeckGeneration(deck)) deck = getOwnedDeck(userId, deck.id);
  const slides = listSlides(deck.id);
  const job = latestJob(deckId);
  const contentLocked = ['confirmed', 'generating', 'generated', 'partial'].includes(deck.status);
  const slideViews = slides.map((slide) => ({
    slideId: slide.slideId,
    pageIndex: slide.pageIndex,
    role: slide.role,
    chapter: slide.chapter,
    pageType: slide.pageType,
    title: slide.title,
    goal: slide.goal,
    mustKeep: slide.mustKeep,
    rawText: slide.rawText,
    summary: slide.summary,
    visualNote: slide.visualNote,
    structuredContent: slide.structuredContent,
    structureStatus: slide.structureStatus,
    structureWarnings: slide.structureWarnings,
    genStatus: slide.genStatus,
    genError: slide.genError,
    activeVersionId: slide.activeVersionId,
    versions: listVersions(slide.slideId).map((version) => ({
      versionId: version.versionId,
      versionNo: version.versionNo,
      kind: version.kind,
      status: version.status,
      imageUrl: version.imageUrl,
      error: version.error,
      jobId: version.jobId,
      createdAt: version.createdAt,
    })),
  }));
  const summary = { total: slides.length, idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0, stale: 0 };
  for (const slide of slides) {
    if (slide.genStatus in summary) summary[slide.genStatus as keyof typeof summary] += 1;
  }
  return {
    deck: {
      id: deck.id,
      title: deck.title,
      status: deck.status,
      stylePackId: deck.stylePackId,
      qualityTier: deck.qualityTier,
      durationMinutes: deck.durationMinutes,
      targetPageCount: deck.targetPageCount,
      sourceFileName: deck.sourceFileName,
      error: deck.error,
      confirmedAt: deck.confirmedAt,
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
    },
    slides: slideViews,
    activeJob:
      job && (job.status === 'queued' || job.status === 'running')
        ? {
            jobId: job.jobId,
            kind: job.kind,
            status: job.status,
            total: job.total,
            succeeded: job.succeeded,
            failed: job.failed,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
          }
        : null,
    pageSummary: summary,
    contentLocked,
  };
}
