#!/usr/bin/env node
// 模块 5 验收（单元级）：outline_page_mapping 对齐规则 + 真模板参考图选取 + 双路线 prompt 提示词。
// node 直跑：node scripts/test-mapping.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerTsHooks } from './ts-hooks.mjs';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'anppt-v2-mapping-test-'));
process.env.ANPPT_V2_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ANPPT_V2_DATA_DIR = path.join(tmpDir, 'data');
process.env.NODE_ENV = 'test';

registerTsHooks();

const { buildOutlinePageMapping, resolveTemplateReferenceImage } = await import('../src/lib/server/generation/mapping.ts');
const { getTemplate, getTemplatePages, resolveTemplateKind } = await import('../src/lib/server/templates.ts');
const { buildSlideImagePrompt, resolveStylePack } = await import('../src/lib/server/generation/style-packs.ts');

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail}`}`);
}

// 世校赛 9 页骨架真模板（手工标注逻辑页型）
const skeletonPages = ['cover', 'team', 'design', 'workflow', 'skill', 'outcomes', 'innovation', 'value', 'ending']
  .map((pageType, i) => ({ pageType, imageUrl: `/assets/tpl/${String(i + 1).padStart(2, '0')}-${pageType}.png` }));

const slides = [
  { pageIndex: 0, pageType: '封面', role: 'cover', title: '封面' },
  { pageIndex: 1, pageType: '团队介绍', role: 'content', title: '团队' },
  { pageIndex: 2, pageType: '项目设计', role: 'content', title: '设计' },
  { pageIndex: 3, pageType: '工作流程', role: 'content', title: '流程' },
  { pageIndex: 4, pageType: '技能要点', role: 'content', title: '技能' },
  { pageIndex: 5, pageType: '项目成果', role: 'content', title: '成果' },
  { pageIndex: 6, pageType: '创新点', role: 'content', title: '创新' },
  { pageIndex: 7, pageType: '应用价值', role: 'content', title: '价值' },
  { pageIndex: 8, pageType: '谢谢', role: 'ending', title: '结尾' },
  // 未覆盖页型：痛点分析（content 桶）→ 应落到骨架中的 content 类页（design/workflow/skill/value 同为 content 桶）
  { pageIndex: 9, pageType: '痛点分析', role: 'content', title: '痛点' },
  // 数据页：data 桶 → outcomes（data 桶）
  { pageIndex: 10, pageType: '大数字指标', role: 'content', title: '数据' },
];

const mapping = buildOutlinePageMapping(slides, skeletonPages);
check('映射覆盖全部大纲页', mapping.length === slides.length);
check('封面→cover 模板页', mapping[0].templatePageIndex === 0);
check('团队→team', mapping[1].templatePageIndex === 1);
check('项目设计→design', mapping[2].templatePageIndex === 2);
check('工作流程→workflow', mapping[3].templatePageIndex === 3);
check('技能要点→skill', mapping[4].templatePageIndex === 4);
check('项目成果→outcomes', mapping[5].templatePageIndex === 5);
check('创新点→innovation', mapping[6].templatePageIndex === 6);
check('应用价值→value', mapping[7].templatePageIndex === 7);
check('结尾→ending', mapping[8].templatePageIndex === 8);
check('痛点分析→同 content 桶页（非封面）', mapping[9].templatePageIndex > 0 && mapping[9].templatePageIndex !== 8, `实际 ${mapping[9].templatePageIndex}`);
check('大数字指标→outcomes（data 桶）', mapping[10].templatePageIndex === 5, `实际 ${mapping[10].templatePageIndex}`);
check('logicalPageType 归一', mapping[9].logicalPageType === 'pain-analysis');

check('resolveTemplateReferenceImage 取图', resolveTemplateReferenceImage(skeletonPages, mapping, 3) === '/assets/tpl/04-workflow.png');
check('空映射取图为 null', resolveTemplateReferenceImage(skeletonPages, [], 0) === null);

// 推导型参考图模板（DNA 桶 pageType）
const derivedPack = getTemplate('anppt-original-innovation-20260822');
const derivedPages = getTemplatePages(derivedPack);
const derivedMapping = buildOutlinePageMapping(slides, derivedPages);
check('推导模板映射无 -1', derivedMapping.every((m) => m.templatePageIndex >= 0));
check('推导模板封面命中 cover 桶', derivedPages[derivedMapping[0].templatePageIndex].pageType === 'cover');
check('推导模板数据页命中 data 桶', derivedPages[derivedMapping[10].templatePageIndex].pageType === 'data');

// 双路线 prompt 提示词
const pack = resolveStylePack(derivedPack.id);
const slideInput = { role: 'content', pageType: '工作流程', title: 'T', goal: '', copyLines: ['一步', '二步'], visualNote: '' };
const tplPrompt = buildSlideImagePrompt(slideInput, pack, { withStyleReferenceHint: true, referenceMode: 'template' });
const styPrompt = buildSlideImagePrompt(slideInput, pack, { withStyleReferenceHint: true, referenceMode: 'style' });
check('template 路线提示=版式高保真灌内容', tplPrompt.includes('真模板参考页') && tplPrompt.includes('复刻它的版式骨架') && tplPrompt.includes('把本页文案准确填入'));
check('style 路线提示=只借风格', styPrompt.includes('同风格参考样张') && styPrompt.includes('只提取它的色板'));
check('两路线提示词确实不同', tplPrompt !== styPrompt);
check('kind 判断', resolveTemplateKind(derivedPack) === 'template' && resolveTemplateKind('cmrk8asi10033v7fx2zbu1y2o') === 'style');

console.log(`\n${failed} 个失败`);
process.exit(failed ? 1 : 0);
