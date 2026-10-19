#!/usr/bin/env node
// 把 pdfjs-dist 自带的 worker 放到 public/，供浏览器端固定路径加载。
// 不依赖打包器的 ?url 资源语义（Next/Turbopack 下可能返回非字符串）。
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const source = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
const target = path.join(process.cwd(), 'public', 'pdf.worker.min.mjs');
mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[pdf-worker] ${path.relative(process.cwd(), source)} -> ${path.relative(process.cwd(), target)}`);
