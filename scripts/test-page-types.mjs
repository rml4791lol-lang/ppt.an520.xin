#!/usr/bin/env node
// 模块 1 验收：页型归一 resolvePageType 用例（10 个指令包用例 + 回归抽查）。node 直跑：
//   node scripts/test-page-types.mjs
import { registerTsHooks } from './ts-hooks.mjs';

registerTsHooks();

const { resolvePageType, PAGE_TYPES } = await import('../src/lib/server/generation/page-types.ts');

const cases = [
  // 指令包指定
  ['市场痛点', '', 'pain-analysis'],
  ['bp_skill_demo', '', 'skills-showcase'],
  // 自抖研 52 页型高频别名（E11 裁定：自选 8 个）
  ['bp_cover', '', 'cover'],
  ['工作流程', '', 'workflow'],
  ['技能要点', '', 'skill'],
  ['项目成果', '', 'outcomes'],
  ['项目设计', '', 'design'],
  ['应用价值', '', 'value'],
  ['创新点', '', 'innovation'],
  ['股权结构', '', 'funding-plan'],
  // 回归抽查：老行为不能变
  ['封面', '', 'cover'],
  ['目录', '', 'toc'],
  ['痛点分析', '', 'pain-analysis'],
  ['技术路线', '', 'technical-route'],
  ['产教融合', '', 'education-impact'],
  ['流程', '', 'process'],
  ['团队介绍', '', 'team'],
  ['解决方案', '', 'solution'],
  ['', 'cover', 'cover'],
  ['完全未知的页型xyz', '', 'content'],
];

let failed = 0;
for (const [pageType, role, expected] of cases) {
  const got = resolvePageType(pageType, role).key;
  const ok = got === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  resolvePageType(${JSON.stringify(pageType)}, ${JSON.stringify(role)}) -> ${got}${ok ? '' : ` (期望 ${expected})`}`);
}

console.log(`\n共 ${PAGE_TYPES.length} 个页型注册，${cases.length} 个用例，${failed} 个失败`);
process.exit(failed ? 1 : 0);
