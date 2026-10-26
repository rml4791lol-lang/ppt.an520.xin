#!/usr/bin/env node
/**
 * lint.mjs —— HTMLPPT 的「入口校验器」
 *
 * 设计来源：Anthropic html2pptx 的方法论（先约束、再测量、后转换；
 * 转换前把违规一次报全，带精确测量）。详见 research/anthropic-methodology/01-notes.md
 *
 * 用法：
 *   node src/lint.mjs <deck.html> [--json] [--strict] [--width 1280] [--height 720]
 *
 * 退出码：0 = 无 error；1 = 有 error（--strict 时 warning 也算）；2 = 运行失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function argOf(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
}
const HTML = process.argv[2];
const JSON_MODE = process.argv.includes('--json');
const STRICT = process.argv.includes('--strict');
const W = parseInt(argOf('--width', '1280'), 10);
const H = parseInt(argOf('--height', '720'), 10);

if (!HTML || HTML.startsWith('--')) {
  console.error('usage: node src/lint.mjs <deck.html> [--json] [--strict] [--width 1280] [--height 720]');
  process.exit(2);
}

/** 在页面上下文里执行的检查逻辑（必须自包含，不能引用 Node 变量） */
function audit({ canvasW, canvasH }) {
  const issues = [];
  const TEXT_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION', 'UL', 'OL']);
  const INLINE_OK = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'BR', 'SMALL', 'SUP', 'SUB', 'A']);
  // 可嵌入字体：不需要告警（OFL / 系统自带 CJK 常见字体）
  const EMBEDDABLE = new Set([
    'noto sans sc', 'noto serif sc', 'noto sans', 'noto serif', 'source han sans', 'source han serif',
    '思源黑体', '思源宋体', 'noto sans cjk sc', 'noto serif cjk sc',
  ]);
  // 已知系统字体：不告警，但标记为"不可嵌入 → 需要机器的字体"
  const SYSTEM_CJK = new Set([
    '微软雅黑', 'microsoft yahei', '苹方', 'pingfang', 'pingfang sc', '黑体', 'simhei', '宋体', 'simsun',
    '楷体', 'kaiti', '华文行楷', 'stxingkai', '方正粗黑宋简体', '方正黑体', '微软雅黑 light',
    'heiti sc', 'songti sc', 'hiragino sans gb', 'hiragino sans', 'stheiti', 'arial', 'helvetica',
    'times new roman', 'georgia', 'courier new', 'verdana', 'tahoma', 'trebuchet ms', 'impact',
    'helvetica neue', 'segoe ui', 'calibri', 'cambria', 'consolas', 'menlo', 'monaco',
  ]);
  const BULLET_RE = /^(?:[•·●○◦▪▫]\s*|[-*]\s+)/;

  const add = (level, rule, msg, el, extra) => {
    const item = { level, rule, message: msg };
    if (el) item.selector = describe(el);
    if (extra) Object.assign(item, extra);
    issues.push(item);
    if (issues.length > 5000) throw new Error('too many issues');
  };

  function describe(el) {
    if (!el || !el.tagName) return '?';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }

  const roots = [...document.querySelectorAll('section.slide, .slide, section')];
  const slideRoots = roots.filter((r) => {
    const cs = getComputedStyle(r);
    return cs.position === 'absolute' || cs.position === 'relative' || r.tagName === 'SECTION';
  });
  const actualRoots = slideRoots.length ? slideRoots : [document.body];

  // ---------- R1 画布尺寸 ----------
  for (const root of actualRoots) {
    const r = root.getBoundingClientRect();
    if (Math.abs(r.width - canvasW) > 1 || Math.abs(r.height - canvasH) > 1) {
      add('error', 'dimensions', `画布 ${Math.round(r.width)}×${Math.round(r.height)}，应为 ${canvasW}×${canvasH}`, root);
    }
  }

  // ---------- R2 裸文本 ----------
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  const seenParents = new Set();
  while ((node = walker.nextNode())) {
    const txt = (node.nodeValue || '').trim();
    if (!txt) continue;
    const p = node.parentElement;
    if (!p || seenParents.has(p)) continue;
    if (TEXT_TAGS.has(p.tagName) || INLINE_OK.has(p.tagName)) continue;
    if (p.closest('[data-ppt-ignore]')) continue;
    seenParents.add(p);
    add('info', 'bare-text', `裸文本（本方言支持隐式处理，但用 p/h* 更稳）：「${txt.slice(0, 24)}」`, p);
  }

  // ---------- 逐元素检查 ----------
  const all = [...document.querySelectorAll('body *')];
  for (const el of all) {
    if (el.closest('[data-ppt-ignore]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const text = (el.textContent || '').trim();
    const isText = TEXT_TAGS.has(el.tagName) || (text && el.children.length === 0 && !el.querySelector('img,svg,canvas'));

    // R3 越出画布
    const root = actualRoots.find((r) => r.contains(el)) || actualRoots[0];
    const rb = root.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) {
      const over = {
        left: b.left - rb.left, top: b.top - rb.top, right: b.right - rb.left, bottom: b.bottom - rb.top,
      };
      if (over.left < -2 || over.top < -2 || over.right > rb.width + 2 || over.bottom > rb.height + 2) {
        add('warning', 'overflow-canvas',
          `元素越出画布 [${Math.round(over.left)},${Math.round(over.top)},${Math.round(over.right)},${Math.round(over.bottom)}]`,
          el, { rect: [Math.round(over.left), Math.round(over.top), Math.round(over.right), Math.round(over.bottom)],
                detail: `bleed:${Math.round(over.left)},${Math.round(over.top)}` });
      }
    }

    // R4 文本被裁（scrollHeight > clientHeight）
    if (text && (cs.overflow === 'hidden' || cs.overflowY === 'hidden' || cs.overflow === 'clip')) {
      if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
        add('error', 'overflow-text', `文本被裁：内容 ${el.scrollHeight}px > 框 ${el.clientHeight}px`, el);
      }
    }

    // R4b 混合内容：元素既有直接文本子节点、又有元素子节点 → 转换语义不确定
    if (el.children.length > 0) {
      const directText = [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim()).length;
      if (directText && !INLINE_OK.has(el.tagName)) {
        add('warning', 'mixed-content', '元素同时有直接文本和子元素，转换语义不确定（建议拆开）', el);
      }
    }

    // R5 手打 bullet
    if (/^(P|LI|H[1-6])$/.test(el.tagName) && BULLET_RE.test(text)) {
      add('error', 'manual-bullets', `手打 bullet 会与 PPT 原生 bullet 重复：「${text.slice(0, 20)}」`, el);
    }

    // R6 禁用单位（只查内联样式，避免误报）
    const inline = el.getAttribute('style') || '';
    if (inline && /\b(?:width|height|font-size|margin|padding|letter-spacing|line-height|top|left|right|bottom)\s*:\s*[^;]*\b\d+(?:\.\d+)?(?:vw|vh|em|rem)\b/.test(inline)) {
      add('error', 'unit-banned', '尺寸/字号用了 vw/vh/em/rem，量测不可复现', el);
    }

    if (!isText) continue;

    // R7 line-height: normal（表格单元格由转换器统一按 1.2 归一，不告警）
    if (cs.lineHeight === 'normal' && !/^(TD|TH)$/.test(el.tagName)) {
      add('info', 'line-height-normal', 'line-height: normal 会按 1.2 归一；建议写确定值', el);
    }
    // R8 负字距
    if (cs.letterSpacing && parseFloat(cs.letterSpacing) < 0) {
      add('warning', 'letter-spacing-negative', `负字距 ${cs.letterSpacing} 会让中文粘连`, el);
    }
    // R9 字体白名单
    const fam = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    if (fam && !EMBEDDABLE.has(fam) && !SYSTEM_CJK.has(fam)) {
      add('warning', 'font-not-allowed', `字体「${fam}」未知，需确认可嵌入或接受 fallback`, el, { detail: fam });
    }
    // R10 文本元素带装饰（我们的方言支持，仅提示）
    const hasBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    const hasBorder = parseFloat(cs.borderTopWidth || '0') > 0 || parseFloat(cs.borderLeftWidth || '0') > 0;
    const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    if ((hasBg || hasBorder || hasShadow) && /^(P|H[1-6]|LI)$/.test(el.tagName)) {
      add('info', 'text-decoration', '文本元素带背景/边框/阴影（本方言支持，PPT 中会变成形状+文本）', el);
    }
  }

  // R11 不支持的效果
  for (const el of all) {
    if (el.closest('[data-ppt-ignore]') || el.closest('[data-ppt-raster]')) continue;
    const cs = getComputedStyle(el);
    const bad = [];
    if (cs.filter && cs.filter !== 'none') bad.push('filter');
    if (cs.backdropFilter && cs.backdropFilter !== 'none') bad.push('backdrop-filter');
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') bad.push('mix-blend-mode');
    if (cs.clipPath && cs.clipPath !== 'none') bad.push('clip-path');
    if (bad.length) {
      add('warning', 'unsupported-effect', `${bad.join('/')} 无 OOXML 原语，需加 data-ppt-raster`, el);
    }
  }

  // ---------- 样式表里的禁用单位 ----------
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules || []) {
      if (!rule.cssText) continue;
      if (/\b\d+(?:\.\d+)?(?:vw|vh|em|rem)\b/.test(rule.cssText) && /width|height|font-size|margin|padding/.test(rule.cssText)) {
        add('warning', 'unit-banned', `<style> 里出现 vw/vh/em/rem：${rule.cssText.slice(0, 90)}`);
      }
    }
  }

  return {
    slides: actualRoots.length,
    canvas: `${canvasW}x${canvasH}`,
    issues,
  };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let result;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const t0 = Date.now();
  await page.goto('file://' + path.resolve(HTML), { waitUntil: 'load' });
  await page.waitForTimeout(300);
  result = await page.evaluate(audit, { canvasW: W, canvasH: H });
  result.elapsedMs = Date.now() - t0;
} finally {
  await browser.close();
}

const byRule = {};
for (const it of result.issues) byRule[it.rule] = (byRule[it.rule] || 0) + 1;

// 重复项聚合：同规则同原因只留 3 条示例 + 计数（1253 条"字体告警"其实只有 6 个字体）
const GROUPED_RULES = new Set(['font-not-allowed', 'unsupported-effect', 'line-height-normal',
  'text-decoration', 'bare-text', 'mixed-content', 'unit-banned', 'overflow-canvas']);
const groups = new Map();
for (const it of result.issues) {
  if (!GROUPED_RULES.has(it.rule)) continue;
  const key = it.rule + '|' + (it.detail || it.message.replace(/「[^」]*」/, '「…」'));
  if (!groups.has(key)) groups.set(key, { rule: it.rule, message: it.message, count: 0, examples: [] });
  const g = groups.get(key);
  g.count += 1;
  if (g.examples.length < 3) g.examples.push(it);
}

const errors = result.issues.filter((i) => i.level === 'error');
const warnings = result.issues.filter((i) => i.level === 'warning');
const infos = result.issues.filter((i) => i.level === 'info');
const report = {
  ok: errors.length === 0,
  file: path.relative(ROOT, path.resolve(HTML)),
  slides: result.slides,
  canvas: result.canvas,
  elapsedMs: result.elapsedMs,
  counts: { error: errors.length, warning: warnings.length, info: infos.length },
  byRule,
  groups: [...groups.values()].sort((a, b) => b.count - a.count),
  issues: result.issues,
};

if (JSON_MODE) {
  console.log(JSON.stringify(report, null, 1));
} else {
  const rel = report.file;
  console.log(`\nHTML LINT  ${rel}`);
  console.log(`画布 ${report.canvas} · 页数 ${report.slides} · 用时 ${report.elapsedMs}ms`);
  const show = (list, label) => {
    if (!list.length) return;
    console.log(`\n${label} ${list.length}`);
    for (const it of list.slice(0, 40)) {
      const where = it.selector ? `  [${it.selector}]` : '';
      console.log(`  ${it.rule.padEnd(22)} ${it.message}${where}`);
    }
    if (list.length > 40) console.log(`  … 其余 ${list.length - 40} 条见 --json`);
  };
  const groupedRules = new Set(groups.keys().map((k) => k.split('|')[0]));
  const ungroupedWarnings = warnings.filter((w) => !groupedRules.has(w.rule));
  show(errors, 'ERROR');
  show(ungroupedWarnings, 'WARNING');
  show(infos.filter((i) => !groupedRules.has(i.rule)), 'INFO');
  const grouped = [...groups.values()].filter((g) => g.count >= 1);
  if (grouped.length) {
    console.log(`\n同类聚合（共 ${grouped.length} 组）`);
    for (const g of grouped.slice(0, 20)) {
      console.log(`  ${(g.rule + ' ×' + g.count).padEnd(26)} ${g.message.slice(0, 80)}`);
    }
  }
  console.log(errors.length ? `\n✘ 未通过：${errors.length} error / ${warnings.length} warning` : `\n✔ 通过：0 error / ${warnings.length} warning`);
}

const fail = errors.length > 0 || (STRICT && warnings.length > 0);
process.exit(fail ? 1 : 0);
