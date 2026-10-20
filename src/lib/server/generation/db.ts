// 生成链自有的 sqlite 表。import 既有 getDb（不改它的文件），首次访问时
// CREATE TABLE IF NOT EXISTS 自己的表。
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db';

const GENERATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  source_file_name TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 15,
  target_page_count INTEGER NOT NULL DEFAULT 10,
  quality_tier TEXT NOT NULL DEFAULT 'standard',
  style_pack_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'parsed',
  error TEXT NOT NULL DEFAULT '',
  anchor_slide_id TEXT NOT NULL DEFAULT '',
  anchor_image_path TEXT NOT NULL DEFAULT '',
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_decks_user_updated ON decks(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS deck_slides (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'content',
  chapter TEXT NOT NULL DEFAULT '',
  page_type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  must_keep TEXT NOT NULL DEFAULT '[]',
  raw_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '[]',
  visual_note TEXT NOT NULL DEFAULT '',
  structured_content TEXT NOT NULL DEFAULT '',
  structure_status TEXT NOT NULL DEFAULT 'pending',
  structure_warnings TEXT NOT NULL DEFAULT '[]',
  gen_status TEXT NOT NULL DEFAULT 'idle',
  gen_error TEXT NOT NULL DEFAULT '',
  active_version_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deck_slides_deck ON deck_slides(deck_id, page_index);

CREATE TABLE IF NOT EXISTS slide_versions (
  id TEXT PRIMARY KEY,
  slide_id TEXT NOT NULL REFERENCES deck_slides(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'generate',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  image_path TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  job_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slide_versions_slide ON slide_versions(slide_id, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_slide_versions_deck ON slide_versions(deck_id, slide_id, version_no DESC);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_deck ON generation_jobs(deck_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_user ON generation_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_active ON generation_jobs(status, updated_at)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS single_page_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '未命名单页项目',
  source TEXT NOT NULL DEFAULT 'single',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_single_projects_user ON single_page_projects(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS single_pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES single_page_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  style_pack_id TEXT NOT NULL DEFAULT '',
  shell_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT NOT NULL DEFAULT '',
  active_version_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_single_pages_project ON single_pages(project_id, page_index);

CREATE TABLE IF NOT EXISTS single_page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES single_pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'generate',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  image_path TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  job_id TEXT NOT NULL DEFAULT '',
  charge_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_single_versions_page ON single_page_versions(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS single_page_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES single_page_projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  target_ids TEXT NOT NULL DEFAULT '[]',
  start_versions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_single_page_batches_project
  ON single_page_batches(user_id, project_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_page_batches_active
  ON single_page_batches(project_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT 'deck',
  ref_id TEXT NOT NULL DEFAULT '',
  source_fingerprint TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  source_mime TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'image',
  status TEXT NOT NULL DEFAULT 'succeeded',
  page_count INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  completed_pages INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  file_url TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  upstream_task_id TEXT NOT NULL DEFAULT '',
  upstream_provider TEXT NOT NULL DEFAULT '',
  charged_credits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_user ON export_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_jobs_ref ON export_jobs(user_id, ref_type, ref_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_jobs_active ON export_jobs(status, updated_at)
  WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS ppt_to_base_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  charge_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ppt_to_base_jobs_user ON ppt_to_base_jobs(user_id, status, updated_at);
`;

const migrated = new WeakSet<DatabaseSync>();

/** 取共享 db 并确保生成链表结构已建（幂等） */
export function getGenDb(): DatabaseSync {
  const db = getDb();
  if (!migrated.has(db)) {
    db.exec(GENERATION_SCHEMA_SQL);
    // 幂等迁移：老库补 export_jobs 可编辑导出列（新库 CREATE TABLE 已含，
    // 模式参考 src/lib/server/db.ts 的 users.phone）
    const exportCols = db.prepare("SELECT name FROM pragma_table_info('export_jobs')").all() as Array<{ name: string }>;
    const colNames = new Set(exportCols.map((c) => c.name));
    if (!colNames.has('error')) db.exec("ALTER TABLE export_jobs ADD COLUMN error TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('upstream_task_id')) db.exec("ALTER TABLE export_jobs ADD COLUMN upstream_task_id TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('upstream_provider')) db.exec("ALTER TABLE export_jobs ADD COLUMN upstream_provider TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('charged_credits')) db.exec('ALTER TABLE export_jobs ADD COLUMN charged_credits INTEGER NOT NULL DEFAULT 0');
    if (!colNames.has('updated_at')) db.exec('ALTER TABLE export_jobs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    if (!colNames.has('source_fingerprint')) db.exec("ALTER TABLE export_jobs ADD COLUMN source_fingerprint TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('source_path')) db.exec("ALTER TABLE export_jobs ADD COLUMN source_path TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('source_name')) db.exec("ALTER TABLE export_jobs ADD COLUMN source_name TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('source_mime')) db.exec("ALTER TABLE export_jobs ADD COLUMN source_mime TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('progress')) db.exec('ALTER TABLE export_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0');
    if (!colNames.has('completed_pages')) db.exec('ALTER TABLE export_jobs ADD COLUMN completed_pages INTEGER NOT NULL DEFAULT 0');
    if (!colNames.has('stage')) db.exec("ALTER TABLE export_jobs ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
    if (!colNames.has('started_at')) db.exec('ALTER TABLE export_jobs ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0');
    if (!colNames.has('completed_at')) db.exec('ALTER TABLE export_jobs ADD COLUMN completed_at INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_export_jobs_ref ON export_jobs(user_id, ref_type, ref_id, kind, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_generation_jobs_user ON generation_jobs(user_id, created_at DESC)');
    // decks 补风格锚点列（set-reference 工具；新库 CREATE TABLE 已含）
    const deckCols = db.prepare("SELECT name FROM pragma_table_info('decks')").all() as Array<{ name: string }>;
    const deckColNames = new Set(deckCols.map((c) => c.name));
    if (!deckColNames.has('anchor_slide_id')) db.exec("ALTER TABLE decks ADD COLUMN anchor_slide_id TEXT NOT NULL DEFAULT ''");
    if (!deckColNames.has('anchor_image_path')) db.exec("ALTER TABLE decks ADD COLUMN anchor_image_path TEXT NOT NULL DEFAULT ''");
    // 单页版本表补 charge_key（崩溃恢复按它找孤儿扣费；新库 CREATE TABLE 已含）
    const singleVerCols = db.prepare("SELECT name FROM pragma_table_info('single_page_versions')").all() as Array<{ name: string }>;
    if (!singleVerCols.some((c) => c.name === 'charge_key')) {
      db.exec("ALTER TABLE single_page_versions ADD COLUMN charge_key TEXT NOT NULL DEFAULT ''");
    }
    const projectCols = db.prepare("SELECT name FROM pragma_table_info('single_page_projects')").all() as Array<{ name: string }>;
    if (!projectCols.some((c) => c.name === 'source')) {
      db.exec("ALTER TABLE single_page_projects ADD COLUMN source TEXT NOT NULL DEFAULT 'single'");
    }
    const singlePageCols = db.prepare("SELECT name FROM pragma_table_info('single_pages')").all() as Array<{ name: string }>;
    if (!singlePageCols.some((c) => c.name === 'shell_path')) {
      db.exec("ALTER TABLE single_pages ADD COLUMN shell_path TEXT NOT NULL DEFAULT ''");
    }
    const batchCols = db.prepare("SELECT name FROM pragma_table_info('single_page_batches')").all() as Array<{ name: string }>;
    if (!batchCols.some((c) => c.name === 'start_versions')) {
      db.exec("ALTER TABLE single_page_batches ADD COLUMN start_versions TEXT NOT NULL DEFAULT '{}'");
    }
    migrated.add(db);
  }
  return db;
}

export function genId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function nowMs(): number {
  return Date.now();
}
