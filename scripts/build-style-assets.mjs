#!/usr/bin/env node
// 生成 public/assets 的两档图片产物，把仓库静态资源压到 20MB 以内（issue #58）。
//
//   详情/大图位：<stem>.webp        宽 ≤1600，体积目标自适应
//   列表缩略图：<stem>.thumb.webp  宽 480，只给 src/data/style-packs.ts 的 previewUrl 生成
//
// 原始 png/jpg 只在「换成 webp 且新路径已被 src/ 引用」之后才删除——删的是确认无引用的文件，
// 且字节仍在 git 历史里。已经达标的文件不碰，所以重复运行是幂等的；--force 才重建。
// 产物入库，不进 .gitignore。
//
// 编码器降级路径：sharp（next 的依赖，落在 node_modules/sharp）→ cwebp（brew install webp）
// → sips（仅当 macOS 的 sips 能写 webp；部分版本会直接报 help 且不落盘）。
// 三者都没有就报错退出，不产出半成品。
//
// 用法：node scripts/build-style-assets.mjs [--force] [--dry-run]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const STYLE_PACKS_DATA = path.join(ROOT, 'src', 'data', 'style-packs.ts');
const SRC_DIR = path.join(ROOT, 'src');

/** 详情图：宽度上限 + 体积目标。200KB 是断言阈值，这里留余量。 */
const FULL = { maxWidth: 1600, targetBytes: 72 * 1024, ladder: [80, 74, 68, 62, 56, 50] };
/** 列表缩略图：卡片最大 280 CSS px，480 宽覆盖高 DPR。 */
const THUMB = { maxWidth: 480, targetBytes: 14 * 1024, ladder: [70, 64, 58, 52] };
/** 与 scripts/check-assets.mjs 对齐的硬上限：达标文件不重编码。 */
const FILE_LIMIT = 200 * 1024;

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const TEXT_RE = /\.(ts|tsx|js|jsx|mjs|json)$/;
const flags = new Set(process.argv.slice(2));
const force = flags.has('--force');
const dryRun = flags.has('--dry-run');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function hasBin(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sipsWidth(source) {
  const text = execFileSync('sips', ['-g', 'pixelWidth', source], { encoding: 'utf8' });
  return Number(text.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0) || null;
}

/** sharp 提升在仓库顶层 node_modules；按 package.json 解析，避免依赖脚本自身位置。 */
function loadSharp() {
  try {
    return createRequire(path.join(ROOT, 'package.json'))('sharp');
  } catch {
    return null;
  }
}

function sharpEncoder(sharp) {
  return {
    async widthOf(source) {
      return (await sharp(source).metadata()).width ?? 0;
    },
    async encode(source, quality, maxWidth) {
      return sharp(source)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality, effort: 5 })
        .toBuffer();
    },
    async sizeOf(buffer) {
      const meta = await sharp(buffer).metadata();
      return { width: meta.width, height: meta.height };
    },
  };
}

function cliEncoder(kind, tmpOut) {
  // cwebp 的 -resize 会放大，得先知道源宽度；非 macOS 拿不到就按目标宽度编码。
  const readableWidth = kind === 'cwebp' && process.platform === 'darwin' && hasBin('sips');
  return {
    async widthOf(source) {
      return readableWidth ? sipsWidth(source) : Number.POSITIVE_INFINITY;
    },
    async encode(source, quality, maxWidth) {
      const cap = readableWidth ? Math.min(maxWidth, sipsWidth(source)) : maxWidth;
      if (kind === 'cwebp') {
        execFileSync('cwebp', ['-quiet', '-q', String(quality), '-resize', String(cap), '0', '-o', tmpOut, source]);
      } else {
        execFileSync('sips', ['-s', 'format', 'webp', '--resampleWidth', String(cap), source, '--out', tmpOut], {
          stdio: 'ignore',
        });
      }
      return readFileSync(tmpOut);
    },
    async sizeOf() {
      return null;
    },
  };
}

async function resolveEncoder(tmpOut) {
  const sharp = loadSharp();
  if (sharp) return sharpEncoder(sharp);
  if (hasBin('cwebp')) return cliEncoder('cwebp', tmpOut);
  let sipsWebp = false;
  if (process.platform === 'darwin' && hasBin('sips')) {
    try {
      sipsWebp = execFileSync('sips', ['--formats'], { encoding: 'utf8' }).includes('webp');
    } catch {
      sipsWebp = false;
    }
  }
  if (sipsWebp) return cliEncoder('sips', tmpOut);
  console.error('✗ 没有可用的 webp 编码器，按顺序装一个：');
  console.error('  1) npm install             # 恢复 next 依赖树里的 sharp');
  console.error('  2) brew install webp       # 提供 cwebp');
  console.error('  3) 用支持 webp 输出的 macOS sips：sips --formats | grep webp');
  process.exit(1);
}

/** 按质量阶梯逼近体积目标；阶梯走完仍超标就缩窄重来（满屏摄影图常见）。 */
async function encodeImage(encoder, source, tier) {
  let maxWidth = Math.min(tier.maxWidth, (await encoder.widthOf(source)) || tier.maxWidth);
  let best = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const quality of tier.ladder) {
      const buffer = await encoder.encode(source, quality, maxWidth);
      if (!best || buffer.length < best.buffer.length) best = { buffer, width: maxWidth, quality };
      if (buffer.length <= tier.targetBytes) return { buffer, width: maxWidth, quality };
    }
    if (maxWidth <= 640) break;
    maxWidth = Math.max(640, Math.round(maxWidth * 0.85));
  }
  return best;
}

function publicUrl(abs) {
  return '/' + path.relative(PUBLIC_DIR, abs).split(path.sep).join('/');
}

/**
 * 卡片实际取哪张封面由数据里的 previewImageUrls[coverIndex] 决定（见 STYLE_PACKS 的 map），
 * 这里把两个字段的候选全算进来——多生成几张没用到的缩略图，好过线上 card 404。
 * 正则读 TS 数据，省掉在 node 里加载 TS 的构建链。
 */
function thumbTargets() {
  const source = readFileSync(STYLE_PACKS_DATA, 'utf8');
  const urls = [
    ...[...source.matchAll(/previewUrl:\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/previewImageUrls:\s*\[([^\]]*)\]/g)].flatMap((block) =>
      [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ),
  ];
  return new Set(urls.filter((url) => url.startsWith('/assets/')));
}

/** 源码全文，用来判断「新路径已被引用」——删旧图的前提。 */
function sourceCorpus() {
  return walk(SRC_DIR)
    .filter((file) => TEXT_RE.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

function isReferenced(webpAbs, corpus) {
  const url = publicUrl(webpAbs);
  return corpus.includes(url) || corpus.includes(url.replace(/\.webp$/, '.thumb.webp'));
}

function webpPathFor(abs) {
  return path.join(path.dirname(abs), `${path.basename(abs, path.extname(abs))}.webp`);
}

/** 3 个原创赛事包的 manifest 记了 sha256；重编码后把摘要/尺寸换成新字节，不留假记录。 */
function syncManifest(dir, fileName, buffer, size) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return;
  }
  const entry = (manifest.files ?? []).find((item) => item.file === fileName);
  if (!entry) return;
  entry.sha256 = createHash('sha256').update(buffer).digest('hex');
  if (size?.width) entry.width = size.width;
  if (size?.height) entry.height = size.height;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const tmpOut = path.join(ROOT, 'node_modules', '.style-asset-tmp.webp');
  const encoder = await resolveEncoder(tmpOut);
  const before = walk(ASSETS_DIR).reduce((sum, file) => sum + statSync(file).size, 0);
  const thumbsWanted = thumbTargets();
  const corpus = sourceCorpus();
  const stats = { converted: 0, recompressed: 0, kept: 0, thumbs: 0, removed: 0, failures: [] };
  const keptSources = [];

  const images = walk(ASSETS_DIR).filter((file) => IMAGE_RE.test(file) && !file.endsWith('.thumb.webp'));
  const written = new Set();

  for (const file of images) {
    if (written.has(file)) continue;
    const ext = path.extname(file).toLowerCase();
    const fullOut = ext === '.webp' ? file : webpPathFor(file);
    if (written.has(fullOut)) continue;
    written.add(fullOut);

    const sourceBytes = statSync(file).size;
    const fullStale = force || ext !== '.webp' || sourceBytes > FILE_LIMIT;

    if (fullStale) {
      const { buffer, quality } = await encodeImage(encoder, file, FULL);
      const size = await encoder.sizeOf(buffer);
      if (buffer.length > FILE_LIMIT) stats.failures.push(`${publicUrl(fullOut)} ${(buffer.length / 1024) | 0}KB`);
      if (!dryRun) {
        writeFileSync(fullOut, buffer);
        syncManifest(path.dirname(fullOut), path.basename(fullOut), buffer, size);
      }
      stats[ext === '.webp' ? 'recompressed' : 'converted'] += 1;
      console.log(
        `  full  ${publicUrl(fullOut)} ${(sourceBytes / 1024) | 0}KB → ${(buffer.length / 1024) | 0}KB` +
          ` (${size ? `${size.width}x${size.height}` : 'w'} q${quality})`,
      );
      // 删旧图的前提：新文件已落盘，且新路径已被源码引用。
      if (ext !== '.webp') {
        if (!dryRun && existsSync(fullOut) && isReferenced(fullOut, corpus)) {
          unlinkSync(file);
          stats.removed += 1;
        } else {
          keptSources.push(`${path.relative(ROOT, file)}（新路径未被 src 引用，保留）`);
        }
      }
    } else {
      stats.kept += 1;
    }

    const thumbOut = fullOut.replace(/\.webp$/, '.thumb.webp');
    if (!thumbsWanted.has(publicUrl(fullOut))) continue;
    // 缩略图比原图新就算新鲜，重跑不重复编码。
    const thumbFresh = existsSync(thumbOut) && statSync(thumbOut).mtimeMs >= statSync(fullOut).mtimeMs;
    if (!force && thumbFresh) continue;
    const { buffer, quality } = await encodeImage(encoder, fullOut, THUMB);
    if (!dryRun) writeFileSync(thumbOut, buffer);
    stats.thumbs += 1;
    console.log(`  thumb ${publicUrl(thumbOut)} ${(buffer.length / 1024) | 0}KB (480w q${quality})`);
  }

  if (existsSync(tmpOut)) rmSync(tmpOut);

  const after = walk(ASSETS_DIR).reduce((sum, file) => sum + statSync(file).size, 0);
  const mb = (bytes) => `${(bytes / 1048576).toFixed(2)}MB`;
  console.log(
    `\n[done] 转换 ${stats.converted} · 重编码 ${stats.recompressed} · 跳过 ${stats.kept} · ` +
      `缩略图 ${stats.thumbs} · 删源 ${stats.removed}${dryRun ? ' · dry-run 未落盘' : ''}`,
  );
  console.log(`[done] public/assets ${mb(before)} → ${mb(after)}`);
  for (const kept of keptSources) console.warn(`  保留源文件 ${kept}`);
  if (stats.failures.length > 0) {
    console.error(`✗ ${stats.failures.length} 个文件超过单文件上限 ${FILE_LIMIT / 1024}KB：`);
    for (const failure of stats.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
