import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getEnv } from './env';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  phone TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_otp_challenges (
  id TEXT PRIMARY KEY,
  identifier_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  client_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  consumed_at INTEGER,
  delivery_status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_identifier_created ON auth_otp_challenges(identifier_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_client_created ON auth_otp_challenges(client_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_expiry ON auth_otp_challenges(expires_at);

CREATE TABLE IF NOT EXISTS credit_wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  bucket TEXT NOT NULL DEFAULT 'purchased',
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_at ON credit_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recharge_orders (
  id TEXT PRIMARY KEY,
  out_trade_no TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  credits INTEGER NOT NULL CHECK (credits > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  provider TEXT NOT NULL CHECK (provider IN ('wechat', 'epay', 'mock')),
  code_url TEXT NOT NULL DEFAULT '',
  checkout_url TEXT NOT NULL DEFAULT '',
  transaction_id TEXT NOT NULL DEFAULT '',
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_created ON recharge_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_status_created ON recharge_orders(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recharge_orders_provider_transaction
  ON recharge_orders(provider, transaction_id) WHERE transaction_id != '';

CREATE TABLE IF NOT EXISTS redemption_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  batch TEXT NOT NULL DEFAULT '',
  credits INTEGER NOT NULL CHECK (credits > 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at INTEGER,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redemption_records (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES redemption_codes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemption_records_once ON redemption_records(code_id, user_id);
CREATE INDEX IF NOT EXISTS idx_redemption_records_user ON redemption_records(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_runtime_config (
  key TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS upstream_balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  balance_num REAL,
  currency TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upstream_snapshots_provider_at ON upstream_balance_snapshots(provider, fetched_at DESC);

CREATE TABLE IF NOT EXISTS upstream_usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  cost_fen INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upstream_usage_created ON upstream_usage_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upstream_usage_provider ON upstream_usage_records(provider, created_at DESC);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);
`;

const globalRef = globalThis as { __anpptV2Db?: DatabaseSync };
const txDepth = new WeakMap<DatabaseSync, number>();

export function getDb(): DatabaseSync {
  if (!globalRef.__anpptV2Db) {
    const { dbPath } = getEnv();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA cache_size = -64000');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA mmap_size = 134217728');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    // 幂等迁移：老库补 users.phone 列（新库 CREATE TABLE 已含）
    const userCols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as Array<{ name: string }>;
    if (!userCols.some((c) => c.name === 'phone')) {
      db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL');
    // 多用户长期运行：进程启动时清理过期会话与验证码，避免表无限增长。
    const housekeepingCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(housekeepingCutoff);
    db.prepare('DELETE FROM auth_otp_challenges WHERE expires_at < ?').run(housekeepingCutoff);
    globalRef.__anpptV2Db = db;
  }
  return globalRef.__anpptV2Db;
}

// Re-entrant: nested calls join the outer transaction instead of failing.
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(db) || 0;
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // keep the original error
    }
    throw error;
  } finally {
    txDepth.set(db, 0);
  }
}

export function isUniqueViolation(error: unknown, columnFragment?: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/unique constraint failed/i.test(message)) return false;
  return columnFragment ? message.toLowerCase().includes(columnFragment.toLowerCase()) : true;
}
