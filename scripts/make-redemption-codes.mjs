#!/usr/bin/env node
// Generate redemption codes. Plaintext codes are printed once; only hashes are stored.
// Usage: node scripts/make-redemption-codes.mjs --credits 100 --count 10 --batch launch [--expires-days 90]
import { registerTsHooks } from './ts-hooks.mjs';

function parseArgs(argv) {
  const args = { credits: NaN, count: NaN, batch: '', expiresDays: NaN };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--credits') { args.credits = Number(value); i += 1; }
    else if (key === '--count') { args.count = Number(value); i += 1; }
    else if (key === '--batch') { args.batch = String(value || ''); i += 1; }
    else if (key === '--expires-days') { args.expiresDays = Number(value); i += 1; }
    else if (key === '--help' || key === '-h') { args.help = true; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !Number.isSafeInteger(args.credits) || args.credits <= 0 || !Number.isSafeInteger(args.count) || args.count <= 0) {
  console.error('用法: node scripts/make-redemption-codes.mjs --credits <数量> --count <张数> [--batch <批次名>] [--expires-days <天数>]');
  process.exit(args.help ? 0 : 1);
}

registerTsHooks();
const { generateRedemptionCodes } = await import('../src/lib/server/redemption.ts');

const expiresAt = Number.isSafeInteger(args.expiresDays) && args.expiresDays > 0
  ? Date.now() + args.expiresDays * 24 * 60 * 60 * 1000
  : null;

const codes = generateRedemptionCodes({
  credits: args.credits,
  count: args.count,
  batch: args.batch,
  expiresAt,
});

console.log(`已生成 ${codes.length} 张兑换码（每张 ${args.credits} 🌟${args.batch ? `，批次 ${args.batch}` : ''}${expiresAt ? `，${args.expiresDays} 天后过期` : ''}）。明文仅显示这一次：`);
for (const code of codes) console.log(code);
