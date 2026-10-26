#!/usr/bin/env node
// 老站（slideflow-studio）用户迁移到 AnPPT v2。
// 用法：node scripts/migrate-slideflow-users.mjs --from <老库路径> --to <v2库路径> [--dry-run]
// 口径（用户 2026-08-26 拍板）：只迁 4 个真实账号；余额 = 老 purchased_credits + 100🌟 迁移礼；
// 密码哈希与老站同构（scrypt:v1），直接搬即可登录。幂等：username 冲突跳过，
// ledger 幂等键 migrate-slideflow:<old_user_id>:<part> 防重，可重复执行。
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const MIGRATION_GIFT = 100;
const PLAN = [
  { account: 'kele_88', role: 'user' },
  { account: 'admin', role: 'admin' },
  { account: 'an', role: 'admin' },
  { account: 'qa_v65_0814205915', role: 'user' },
];

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : null;
}
const fromPath = argValue('from');
const toPath = argValue('to');
const dryRun = process.argv.includes('--dry-run');
if (!fromPath || !toPath) {
  console.error('用法: node scripts/migrate-slideflow-users.mjs --from <老库> --to <v2库> [--dry-run]');
  process.exit(1);
}

const oldDb = new DatabaseSync(fromPath, { readOnly: true });
const newDb = new DatabaseSync(toPath);
newDb.exec('PRAGMA busy_timeout = 5000');

const findOldUser = oldDb.prepare('SELECT * FROM users WHERE account = ?');
const findOldBalance = oldDb.prepare('SELECT purchased_credits FROM billing_accounts WHERE scope_key = ?');
const findNewUser = newDb.prepare('SELECT id FROM users WHERE username = ?');
const insertUser = newDb.prepare(
  `INSERT INTO users (id, username, email, phone, display_name, password_hash, role, plan, created_at, last_login_at)
   VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
);
const insertWallet = newDb.prepare('INSERT INTO credit_wallets (user_id, balance, updated_at) VALUES (?, ?, ?)');
const findLedger = newDb.prepare('SELECT id FROM credit_ledger WHERE idempotency_key = ?');
const insertLedger = newDb.prepare(
  `INSERT INTO credit_ledger (id, user_id, delta, balance_after, bucket, reason, idempotency_key, event_type, ref_type, ref_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'migration', 'slideflow-migration', ?, ?)`,
);

const now = Date.now();
const results = [];
for (const item of PLAN) {
  const old = findOldUser.get(item.account);
  if (!old) {
    results.push({ account: item.account, action: 'skip', reason: '老站不存在该账号' });
    continue;
  }
  if (old.disabled_at) {
    results.push({ account: item.account, action: 'skip', reason: '老站账号已禁用' });
    continue;
  }
  if (findNewUser.get(item.account)) {
    results.push({ account: item.account, action: 'skip', reason: 'v2 用户名已存在' });
    continue;
  }
  const purchased = Number(findOldBalance.get(old.id)?.purchased_credits) || 0;
  const balance = purchased + MIGRATION_GIFT;
  results.push({ account: item.account, action: dryRun ? 'dry-run' : 'migrate', oldId: old.id, role: item.role, purchased, gift: MIGRATION_GIFT, balance });

  if (dryRun) continue;
  const newId = `user_${randomBytes(12).toString('hex')}`;
  newDb.exec('BEGIN IMMEDIATE');
  try {
    insertUser.run(newId, item.account, old.display_name || '', old.password_hash, item.role, old.plan || 'free', Number(old.created_at) || now);
    insertWallet.run(newId, balance, now);
    let balanceAfter = 0;
    if (purchased > 0) {
      balanceAfter = purchased;
      const key = `migrate-slideflow:${old.id}:purchased`;
      if (!findLedger.get(key)) {
        insertLedger.run(`ledger_${randomBytes(12).toString('hex')}`, newId, purchased, balanceAfter, 'purchased', '老站迁移（原站购入额度）', key, old.id, now);
      }
    }
    balanceAfter += MIGRATION_GIFT;
    const giftKey = `migrate-slideflow:${old.id}:gift`;
    if (!findLedger.get(giftKey)) {
      insertLedger.run(`ledger_${randomBytes(12).toString('hex')}`, newId, MIGRATION_GIFT, balanceAfter, 'bonus', '老站迁移礼', giftKey, old.id, now);
    }
    newDb.exec('COMMIT');
  } catch (error) {
    newDb.exec('ROLLBACK');
    throw error;
  }
}

console.log(JSON.stringify({ dryRun, results }, null, 2));
oldDb.close();
newDb.close();
