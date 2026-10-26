#!/usr/bin/env node
// 模块 3 验收：页型协议/全局视觉规范/防幻觉进入 prompt；蓝图 LLM 生成 + 文件缓存命中。
// 全部走 mock fetch，绝不真实调用付费上游。node 直跑：
//   node scripts/test-prompt.mjs
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerTsHooks } from './ts-hooks.mjs';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'anppt-v2-prompt-test-'));
process.env.ANPPT_V2_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ANPPT_V2_DATA_DIR = path.join(tmpDir, 'data');
process.env.ANPPT_V2_LLM_BASE_URL = 'http://mock.local/v1';
process.env.ANPPT_V2_LLM_API_KEY = 'sk-test';
process.env.ANPPT_V2_LLM_MODEL = 'mock-model';
process.env.NODE_ENV = 'test';

registerTsHooks();

const { buildSlideImagePrompt, resolveStylePack } = await import('../src/lib/server/generation/style-packs.ts');
const { ensureDeckBlueprint } = await import('../src/lib/server/generation/blueprint.ts');

let failed = 0;
function check(name, cond) {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

const pack = resolveStylePack('anppt-original-innovation-20260822');
const slide = {
  role: 'content',
  pageType: '痛点分析',
  title: '传统种植决策依赖经验，损失率高',
  goal: '建立问题链',
  copyLines: ['经验判断导致灌溉时机误差大', '病虫害发现滞后，扩散快'],
  visualNote: '',
};
const blueprintText = '一、画面氛围：冷峻科技感。\n二、色彩与材质：深海蓝底、琥珀橙强调。';

const prompt = buildSlideImagePrompt(slide, pack, {
  withStyleReferenceHint: true,
  deckContext: { totalPages: 9, pageIndex: 2, blueprint: blueprintText, deckTitle: '智慧农业' },
});

check('prompt 含全局视觉规范段', prompt.includes('全套全局视觉规范') && prompt.includes(blueprintText));
check('prompt 含页型协议段', prompt.includes('页型协议 · 痛点分析页'));
check('协议含五层（文字忠实/信息任务/构图/配图基因/禁忌）', ['1. 文字忠实', '2. 信息任务', '3. 构图与版式', '4. 配图基因', '5. 禁忌'].every((s) => prompt.includes(s)));
check('prompt 含防幻觉约束', prompt.includes('防幻觉约束'));
check('旧版式拼接已移除', !prompt.includes('版式要求：'));
check('无 blueprint 时不出现规范段', !buildSlideImagePrompt(slide, pack, { deckContext: { totalPages: 9, pageIndex: 2 } }).includes('全套全局视觉规范'));

const coverPrompt = buildSlideImagePrompt(
  { role: 'cover', pageType: '封面', title: '智慧农业', goal: '', copyLines: ['智慧农业'], visualNote: '' },
  pack,
  { deckContext: { totalPages: 9, pageIndex: 0 } },
);
check('封面协议与正文协议分层不同', coverPrompt.includes('页型协议 · 封面页') && coverPrompt.includes('严禁出现数据图表'));

// 防追责：prompt 不得含竞品提示词原文/内部代号
const competitorFingerprints = ['花卷', '抖研', 'MANDATORY TEXT CONTENT', 'PPT COVER MASTER', 'SMART TEMPLATE', 'flash-lite', 'gemini-3'];
check('无竞品原文案残留', competitorFingerprints.every((s) => !prompt.includes(s) && !coverPrompt.includes(s)));

// 蓝图：mock LLM 生成 + 文件缓存（第二次不再请求）
let fetchCount = 0;
const mockFetch = async () => {
  fetchCount += 1;
  return new Response(JSON.stringify({ choices: [{ message: { content: '一、画面氛围：…\n二、色彩与材质：…' } }] }), { status: 200 });
};
const fakeDeck = { id: 'deck-bp-1', title: '智慧农业——基于 AIoT 的精准种植', stylePackId: pack.id, sourceText: '素材文本' };
const fakeSlides = [
  { pageType: 'cover', role: 'cover', title: '封面' },
  { pageType: '痛点分析', role: 'content', title: '痛点' },
];
const bp1 = await ensureDeckBlueprint(fakeDeck, fakeSlides, { fetchImpl: mockFetch });
check('蓝图 LLM 生成成功', bp1.includes('画面氛围'));
check('蓝图已落盘缓存', existsSync(path.join(tmpDir, 'data', 'blueprints', 'deck-bp-1.json')));
const bp2 = await ensureDeckBlueprint(fakeDeck, fakeSlides, { fetchImpl: mockFetch });
check('缓存命中不再调 LLM', bp2 === bp1 && fetchCount === 1);
const bp3 = await ensureDeckBlueprint(fakeDeck, [{ pageType: 'cover', role: 'cover', title: '改了标题' }], { fetchImpl: mockFetch });
check('大纲变化指纹失效重算', fetchCount === 2 && bp3 === bp1);

console.log(`\n${failed} 个失败`);
process.exit(failed ? 1 : 0);
