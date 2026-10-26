#!/usr/bin/env node
// 模块 2 验收：模板数据模型 listTemplates/getTemplate/resolveTemplateKind/getTemplatePages。node 直跑：
//   node scripts/test-templates.mjs
import { registerTsHooks } from './ts-hooks.mjs';

registerTsHooks();

const { listTemplates, getTemplate, resolveTemplateKind, getTemplatePages, listTemplateTracks } = await import('../src/lib/server/templates.ts');
const { STYLE_PACKS } = await import('../src/data/style-packs.ts');

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
}

check('公开包总数', STYLE_PACKS.length, 29);
check('kind=template 数量', listTemplates({ kind: 'template' }).length, 15);
check('kind=style 数量', listTemplates({ kind: 'style' }).length, 14);
check('domain=wvcsc 数量', listTemplates({ domain: 'wvcsc' }).length, 4);
check('domain=wvcsc&color=蓝 数量', listTemplates({ domain: 'wvcsc', color: '蓝' }).length, 3);
check('theme=医疗健康 数量', listTemplates({ theme: '医疗健康' }).length, 7);
check('style=赛事/竞赛 数量', listTemplates({ style: '赛事/竞赛' }).length, 4);
check('wvcsc 赛道清单', listTemplateTracks('wvcsc').join(','), '信息技术,装备制造,教育与成长,现代农业');

const recommended = listTemplates({ sort: 'recommended' });
check('recommended 首包', recommended[0].id, 'anppt-template-wvcsc-aiot-20260822');
const latest = listTemplates({ sort: 'latest' });
check('latest 首包=最后录入', latest[0].id, STYLE_PACKS[STYLE_PACKS.length - 1].id);

const pack = getTemplate('anppt-original-innovation-20260822');
check('getTemplate by id 命中', pack?.name, '深海蓝创新赛事答辩风');
check('getTemplate by slug 命中', getTemplate('深海蓝创新赛事答辩风')?.id, 'anppt-original-innovation-20260822');
check('resolveTemplateKind(template)', resolveTemplateKind(pack), 'template');
check('resolveTemplateKind(缺省)', resolveTemplateKind('cmrk8asi10033v7fx2zbu1y2o'), 'style');

const pages = getTemplatePages(pack);
check('推导模板页数量>0', pages.length > 0, true);
check('推导模板页含 cover 桶', pages.some((p) => p.pageType === 'cover'), true);
check('推导模板页含 process 桶', pages.some((p) => p.pageType === 'process'), true);
check('推导模板页图片非空', pages.every((p) => p.imageUrl.startsWith('/assets/')), true);

// M5 实测晋升的真模板：手工标注 9 页逻辑页型，优先于 DNA 推导
const promoted = getTemplate('anppt-template-wvcsc-aiot-20260822');
check('实测模板 by id 命中', promoted?.name, '深蓝AIoT世校赛实测模板');
check('实测模板 kind=template', resolveTemplateKind(promoted), 'template');
const promotedPages = getTemplatePages(promoted);
check('实测模板 9 页', promotedPages.length, 9);
check('实测模板首页 cover', promotedPages[0]?.pageType, 'cover');
check('实测模板含世校赛语义页型', ['pain-analysis', 'process', 'skills-showcase', 'innovation', 'outcomes', 'social-impact'].every((k) => promotedPages.some((p) => p.pageType === k)), true);
check('实测模板图片全部存在', promotedPages.every((p) => p.imageUrl.startsWith('/assets/style-packs/wvcsc-aiot-skeleton/')), true);

console.log(`\n${failed} 个失败`);
process.exit(failed ? 1 : 0);
