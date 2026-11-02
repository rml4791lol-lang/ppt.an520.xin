#!/usr/bin/env node
// 静态资源体积门（issue #58）：public/assets 总量 ≤20MB、单文件 ≤200KB。
// 超限就打印违规项并 exit 1，让 CI / gate 直接红。

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ASSETS_DIR = path.join(process.cwd(), 'public', 'assets');
const TOTAL_LIMIT = 20 * 1024 * 1024;
const FILE_LIMIT = 200 * 1024;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)}MB`;

const files = walk(ASSETS_DIR).map((file) => ({ file, size: statSync(file).size }));
const total = files.reduce((sum, item) => sum + item.size, 0);
const oversize = files.filter((item) => item.size > FILE_LIMIT).sort((a, b) => b.size - a.size);

for (const item of oversize) {
  console.error(`✗ 单文件超限 ${path.relative(process.cwd(), item.file)} ${kb(item.size)} > ${kb(FILE_LIMIT)}`);
}
console.log(
  `public/assets: ${files.length} 个文件 · ${mb(total)} / ${mb(TOTAL_LIMIT)} · ` +
    `最大 ${kb(Math.max(...files.map((item) => item.size)))} / ${kb(FILE_LIMIT)}`,
);

if (oversize.length > 0 || total > TOTAL_LIMIT) {
  if (total > TOTAL_LIMIT) console.error(`✗ 总量超限 ${mb(total)} > ${mb(TOTAL_LIMIT)}`);
  process.exit(1);
}
console.log('✓ 体积门通过');
