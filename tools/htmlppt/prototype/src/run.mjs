/**
 * run.mjs — `npm run build`: the whole pipeline in one command, fail-fast.
 *
 *   HTML → measure → PPTX → postprocess → inspect → LibreOffice render → python-pptx
 *        → pixel diff/contact sheet → font probe → metrics.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HTMLPPT_OUT ? path.resolve(process.env.HTMLPPT_OUT) : path.join(ROOT, 'out');

const DEFAULT_PY = '/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python';
const PYTHON =
  process.env.PYTHON || (fs.existsSync(DEFAULT_PY) ? DEFAULT_PY : 'python3');

function run(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  console.log(`\n▶ ${label}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${label} failed with exit code ${res.status}`);
  }
  console.log(`  ↳ ${label} ok (${Date.now() - t0}ms)`);
}

function main() {
  fs.mkdirSync(path.join(OUT, 'html'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'pptx'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'diff'), { recursive: true });
  const t0 = Date.now();

  // 0/9 入口 lint：按 HTMLPPT 契约检查（尺寸/裸文本/溢出/禁用单位/字体…）
  {
    const deck = process.env.HTMLPPT_DECK ? path.resolve(process.env.HTMLPPT_DECK) : path.join(ROOT, 'samples', 'deck.html');
    const res = spawnSync('node', ['src/lint.mjs', deck, '--json'], { cwd: ROOT, encoding: 'utf8' });
    let rep = null;
    try { rep = JSON.parse(res.stdout || '{}'); } catch { /* ignore */ }
    if (rep && rep.counts) {
      console.log(`\n▶ 0/9 lint HTML (contract)  ${rep.counts.error} error / ${rep.counts.warning} warning / ${rep.counts.info} info`);
      if (rep.counts.error) {
        for (const it of (rep.issues || []).filter((i) => i.level === 'error').slice(0, 10)) {
          console.log(`   ✘ ${it.rule}: ${it.message}`);
        }
      }
      const strict = process.env.LINT_STRICT === '1';
      if (strict && (rep.counts.error > 0 || rep.counts.warning > 0)) {
        throw new Error(`lint 未通过（LINT_STRICT=1）：${rep.counts.error} error / ${rep.counts.warning} warning`);
      }
      if (!strict && rep.counts.error > 0) {
        console.log('   ⚠ 有 lint error，继续构建（设 LINT_STRICT=1 可强制失败）');
      }
    }
  }
  run('1/9 measure HTML (headless Chrome)', 'node', ['src/measure.mjs']);
  run('2/9 convert to native PPTX objects (PptxGenJS)', 'node', ['src/convert.mjs']);
  run('3/9 postprocess gradFill + custGeom + DEFLATE repack', 'node', ['src/postprocess.mjs']);
  // 3c: 结构修复（ECMA-376 子元素顺序 / a:lin 角度越界 / 重复 a:pPr）。
  // 不修的话 xmllint 与 Open XML SDK 都会报错，PowerPoint 可能提示"需要修复"。
  run('3c/9 fix OOXML structure (ECMA-376)', 'python3', [
    path.join(ROOT, '..', 'tools', 'fix-pptx-structure.py'),
    path.join(OUT, 'deck.pptx'),
    path.join(OUT, 'deck.pptx'),
  ]);
  // 可选：字体嵌入（EOT/fntdata）。EMBED_FONTS=1 开启；EMBED_FONT_SPEC / EMBED_FONT_MAP 可配。
  if (process.env.EMBED_FONTS === '1') {
    const spec = process.env.EMBED_FONT_SPEC || 'Noto Sans SC';
    const map = process.env.EMBED_FONT_MAP || 'PingFang SC=Noto Sans SC';
    fs.copyFileSync(path.join(OUT, 'deck.pptx'), path.join(OUT, 'deck.noembed.pptx'));
    run('3b/9 embed fonts (EOT/fntdata)',
      'node', ['tools/font-embed.mjs', path.join(OUT, 'deck.noembed.pptx'), path.join(OUT, 'deck.pptx'),
               '--font', spec, '--map', map, '--json', path.join(OUT, 'font_embed.json')]);
  }
  run('4/9 inspect editability / zip / content-types / sldSz', 'node', ['src/inspect.mjs']);
  run('5/9 render PPTX (LibreOffice -> PDF -> PNG)', 'node', ['src/render.mjs']);
  run('6/9 validate deck with python-pptx', PYTHON, ['src/validate_pptx.py']);
  run('7/9 pixel diff + contact sheet', PYTHON, ['src/diffstat.py']);
  run('8/9 font availability control experiment', 'node', ['src/fontprobe.mjs']);
  run('9/9 merge metrics + gates', 'node', ['src/report.mjs']);

  console.log(`\n✔ build finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  deck:   out/deck.pptx');
  console.log('  metrics: out/metrics.json');
  console.log('  sheet:  out/diff/contact-sheet.png');
}

try {
  main();
} catch (err) {
  console.error('\n✘ BUILD FAILED:', err.message);
  process.exit(1);
}
