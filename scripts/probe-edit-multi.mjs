#!/usr/bin/env node
// 实测 an520 /images/edits 多图输入（原图+标记图）：gpt-image-2 是否接受第二个 image 字段。
// 用法：node scripts/probe-edit-multi.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

process.env.ALLOW_REAL_UPSTREAM = '1';

const env = Object.fromEntries(
  readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)]),
);
const BASE = env.ANPPT_V2_IMAGE_BASE_URL;
const KEY = env.ANPPT_V2_IMAGE_API_KEY;

const srcPath = path.resolve(process.cwd(), 'output/gold-beta-test/gen-02.png');
const src = readFileSync(srcPath);
const meta = await sharp(src).metadata();

// 标记图：原图复制品，在右侧中部卡片区（约 x 62%-72%, y 22%-40%）涂半透明红块表示「要擦除的区域」
const mark = await sharp(src)
  .composite([{
    input: Buffer.from(`<svg width="${meta.width}" height="${meta.height}">
      <rect x="${Math.round(meta.width * 0.60)}" y="${Math.round(meta.height * 0.20)}"
            width="${Math.round(meta.width * 0.14)}" height="${Math.round(meta.height * 0.22)}"
            fill="red" fill-opacity="0.6" stroke="red" stroke-width="6"/>
    </svg>`),
    top: 0, left: 0,
  }])
  .png()
  .toBuffer();

async function tryEdits(label, form) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  console.log(`\n== ${label} == HTTP ${res.status} ${ms}ms`);
  console.log(text.slice(0, 400));
  if (res.ok) {
    try {
      const json = JSON.parse(text);
      const b64 = json?.data?.[0]?.b64_json;
      if (b64) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(path.resolve(process.cwd(), `output/gold-beta-test/probe-${label}.png`), Buffer.from(b64, 'base64'));
        console.log(`已存 output/gold-beta-test/probe-${label}.png`);
      }
    } catch { /* 忽略 */ }
  }
}

// A：单图 + 文字指令（现状通路，作为对照）
const formA = new FormData();
formA.append('model', 'gpt-image-2');
formA.append('prompt', '移除画面右侧中部「人工清扫效率低下」整张卡片，用与周围一致的白底和留白自然填充，其余所有元素、文字、配色、版式保持不变');
formA.append('size', '1536x864');
formA.append('image', new Blob([src], { type: 'image/png' }), 'source.png');
await tryEdits('single', formA);

// B：原图+标记图（用户裁定方案：双 image 字段 + 标记说明）
const formB = new FormData();
formB.append('model', 'gpt-image-2');
formB.append('prompt', '第二张图是第一张图的标记版，红色涂抹块标出要擦除的区域。请移除第一张图中对应区域里的卡片内容，用与周围一致的白底和留白自然填充，其余所有元素、文字、配色、版式保持不变，不要出现红色标记');
formB.append('size', '1536x864');
formB.append('image', new Blob([src], { type: 'image/png' }), 'source.png');
formB.append('image', new Blob([mark], { type: 'image/png' }), 'mark.png');
await tryEdits('multi', formB);
