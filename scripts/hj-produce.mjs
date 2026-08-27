// 花卷 G0 风格量产：8 套风格 × 6 类参考页（cover/toc/section/content/data/process）。
// 直接用生图上游（prompt 与生产线同构：buildSlideImagePrompt + visualSpec 充当蓝图）。
// 可断点续跑（已存在的 PNG 跳过）。用法：
//   node --env-file=.env.local scripts/hj-produce.mjs [onlyKey1,onlyKey2]
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerTsHooks } from './ts-hooks.mjs';
import { STYLES, TOPICS, ARCHETYPES } from './hj-style-specs.mjs';

registerTsHooks();

const { buildSlideImagePrompt } = await import('../src/lib/server/generation/style-packs.ts');
const { getStyleDesignDna } = await import('../src/data/style-design-dna.ts');

const BASE = (process.env.ANPPT_V2_IMAGE_BASE_URL || 'http://127.0.0.1:6800/v1').replace(/\/+$/, '');
const KEY = process.env.ANPPT_V2_IMAGE_API_KEY || '';
const MODEL = process.env.ANPPT_V2_IMAGE_MODEL || 'gpt-image-2';
const SIZE = process.env.ANPPT_V2_IMAGE_SIZE || '1536x864';
if (!KEY) { console.error('缺少 ANPPT_V2_IMAGE_API_KEY'); process.exit(1); }

const OUT_ROOT = path.resolve(process.cwd(), 'public', 'assets', 'style-packs');
const MANIFEST = path.resolve(process.cwd(), 'output', 'hj-produce-manifest.json');
const only = process.argv[2] ? process.argv[2].split(',') : null;

const ARCHETYPE_SLIDE = {
  cover: { key: 'cover', role: 'cover' },
  toc: { key: 'toc', role: 'toc' },
  section: { key: 'section', role: 'section' },
  content: { key: 'content', role: 'content' },
  data: { key: 'data-chart', role: 'content' },
  process: { key: 'process', role: 'content' },
};

function buildCopy(style, topic, archetype) {
  switch (archetype) {
    case 'cover':
      return { title: topic.title, goal: '建立第一印象，传达项目主题与参赛身份', copy: [topic.subtitle] };
    case 'toc':
      return { title: '目录', goal: '呈现全套汇报的四个章节脉络', copy: topic.toc.map((t, i) => `${String(i + 1).padStart(2, '0')} ${t}`) };
    case 'section':
      return { title: topic.section.name, goal: '章节过渡，收束上文并引出本章主题', copy: [`第 ${topic.section.no} 章`, topic.section.lead] };
    case 'content':
      return { title: topic.contentTitle, goal: '并列呈现本页的核心要点及其说明', copy: topic.bullets.map(([h, d]) => `${h}：${d}`) };
    case 'data':
      return { title: topic.dataTitle, goal: '用大字指标卡呈现三项关键数据及其口径', copy: topic.data.map(([v, l, n]) => `${v}｜${l}｜${n}`) };
    case 'process':
      return { title: topic.processTitle, goal: '按真实流向呈现步骤链路', copy: topic.process.map(([n, d], i) => `第${'一二三四五'[i]}步 ${n}：${d}`) };
    default:
      throw new Error(`未知参考页类型 ${archetype}`);
  }
}

async function generateOne(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const res = await fetch(`${BASE}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, prompt, size: SIZE, n: 1 }),
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = {};
    try { payload = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 非 JSON 响应`); }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(payload?.error?.message || '').slice(0, 160)}`);
    const item = payload.data?.[0];
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item?.url) {
      const img = await fetch(item.url, { signal: controller.signal });
      if (!img.ok) throw new Error(`图片下载失败 HTTP ${img.status}`);
      return Buffer.from(await img.arrayBuffer());
    }
    throw new Error('上游未返回图片数据');
  } finally {
    clearTimeout(timer);
  }
}

const tasks = [];
for (const style of STYLES) {
  if (only && !only.includes(style.key)) continue;
  const topic = TOPICS[style.key];
  if (!topic) throw new Error(`风格 ${style.key} 未配主题`);
  const dir = path.join(OUT_ROOT, `hj-${style.key}`);
  mkdirSync(dir, { recursive: true });
  ARCHETYPES.forEach((archetype, pageIndex) => {
    const file = path.join(dir, `${archetype}.png`);
    if (existsSync(file) && statSync(file).size > 100_000) return;
    const { title, goal, copy } = buildCopy(style, topic, archetype);
    const pack = {
      id: `hj-${style.key}`, name: style.name, category: style.category,
      description: style.visualSpec, tags: style.themeTags, suitableScenarios: [],
      visualKeywords: style.visualKeywords, palette: style.palette,
      designDna: getStyleDesignDna(''), firstPreviewPath: '', previewPaths: [],
    };
    const prompt = buildSlideImagePrompt(
      { role: ARCHETYPE_SLIDE[archetype].role, pageType: ARCHETYPE_SLIDE[archetype].key, title, goal, copyLines: copy, visualNote: '' },
      pack,
      { deckContext: { totalPages: ARCHETYPES.length, pageIndex, deckTitle: topic.title, blueprint: style.visualSpec } },
    );
    tasks.push({ style: style.key, archetype, file, prompt });
  });
}

console.log(`待生成 ${tasks.length} 张（上游 ${BASE}，模型 ${MODEL}）`);
const manifest = { startedAt: new Date().toISOString(), model: MODEL, results: [] };
let cursor = 0;
const CONCURRENCY = 2;

async function worker() {
  for (;;) {
    const task = tasks[cursor];
    cursor += 1;
    if (!task) return;
    const label = `${task.style}/${task.archetype}`;
    let buffer = null;
    let error = '';
    const t0 = Date.now();
    for (let attempt = 0; attempt <= 2 && !buffer; attempt += 1) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 3000 * attempt));
        buffer = await generateOne(task.prompt);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (buffer) {
      writeFileSync(task.file, buffer);
      console.log(`OK   ${label}  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${(buffer.length / 1024).toFixed(0)}KB`);
      manifest.results.push({ ...task, prompt: undefined, ok: true, bytes: buffer.length, ms: Date.now() - t0 });
    } else {
      console.log(`FAIL ${label}  ${error}`);
      manifest.results.push({ style: task.style, archetype: task.archetype, ok: false, error, ms: Date.now() - t0 });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
manifest.finishedAt = new Date().toISOString();
const okCount = manifest.results.filter((r) => r.ok).length;
console.log(`\n完成 ${okCount}/${manifest.results.length}，manifest → ${MANIFEST}`);
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
process.exit(okCount === manifest.results.length ? 0 : 1);
