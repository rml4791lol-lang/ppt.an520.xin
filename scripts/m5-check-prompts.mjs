#!/usr/bin/env node
// 模块 5 实测核验：从本地 dev 库读某 deck 的 slide_versions.prompt，
// 检查蓝图段/页型协议段/防幻觉段/双路线参考图提示是否真实进入生图 prompt。
// 用法：node scripts/m5-check-prompts.mjs <deckId> [template|style]
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const deckId = process.argv[2];
const route = process.argv[3] || 'style';
if (!deckId) {
  console.error('用法：node scripts/m5-check-prompts.mjs <deckId> [template|style]');
  process.exit(2);
}

const dbPath = process.env.ANPPT_V2_DB_PATH || path.resolve(process.cwd(), 'data', 'anppt-v2.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare(
    `SELECT sv.prompt, sv.status, ds.page_index, ds.page_type, ds.role
     FROM slide_versions sv JOIN deck_slides ds ON ds.id = sv.slide_id
     WHERE sv.deck_id = ? ORDER BY ds.page_index, sv.version_no`,
  )
  .all(deckId);

if (rows.length === 0) {
  console.error(`deck ${deckId} 无版本记录`);
  process.exit(1);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const prompts = rows.filter((r) => r.prompt).map((r) => r.prompt);
check('有 prompt 记录', prompts.length > 0);
check('每页含全局视觉规范段', prompts.every((p) => p.includes('全套全局视觉规范')), `${prompts.filter((p) => !p.includes('全套全局视觉规范')).length} 页缺失`);
check('每页含页型协议段', prompts.every((p) => p.includes('页型协议 · ')));
check('每页含防幻觉约束', prompts.every((p) => p.includes('防幻觉约束')));
if (route === 'template') {
  check('每页为真模板参考页提示（版式高保真）', prompts.every((p) => p.includes('真模板参考页') && p.includes('复刻它的版式骨架')));
  check('无风格路线提示串', prompts.every((p) => !p.includes('同风格参考样张')));
} else {
  check('每页为风格参考样张提示', prompts.every((p) => p.includes('同风格参考样张')));
}
const competitorFingerprints = ['花卷', '抖研', 'MANDATORY TEXT CONTENT', 'PPT COVER MASTER', 'SMART TEMPLATE'];
check('无竞品原文案残留', prompts.every((p) => competitorFingerprints.every((s) => !p.includes(s))));

console.log('\n首页 prompt 片段（前 500 字）：');
console.log(prompts[0]?.slice(0, 500));
console.log(`\n${failed} 个失败`);
process.exit(failed ? 1 : 0);
