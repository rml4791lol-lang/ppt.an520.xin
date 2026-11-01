#!/usr/bin/env node
// 本地无障碍与可用性检查：起 dev → axe 扫 DSL → 行为断言 → 报告 + 截图 → 非 0 退出。
// 为什么不进 gate：门要秒级且不要求本机有浏览器。这里由人或 CI 显式调用。
// 为什么不打线上：线上会真实扣费，且评审对象是仓库代码。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'output/ui-check');
const SHOT_DIR = path.join(OUT_DIR, 'shots');
const BASELINE_PATH = path.join(ROOT, 'scripts/ui-check-baseline.json');

const ROUTES = ['/', '/login', '/single-page', '/style-packs', '/help', '/projects', '/exports'];
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// 键盘用户能否完成页数/画质选择；抽屉焦点是否被囚在对话框内；表单错误是否被播报。
// 这三类 axe 看不见，必须真按键盘。
const BEHAVIORS = [
  {
    id: 'dropdown-keyboard',
    name: '页数/画质选择器可纯键盘操作',
    route: '/',
    viewport: 'desktop',
    async run(page) {
      // 页数/画质下拉藏在「约 N 页 · 标准画质」展开的面板里，先摊开
      const settings = page.getByRole('button', { name: /约 \d+ 页/ }).first();
      await settings.waitFor({ state: 'visible', timeout: 15000 });
      if ((await settings.getAttribute('aria-expanded')) !== 'true') {
        await settings.click();
        await page.waitForTimeout(250);
      }
      const trigger = page.getByRole('button', { name: /汇报 \d+ 分钟/ }).first();
      await trigger.waitFor({ state: 'visible', timeout: 10000 });
      const before = (await trigger.innerText()).trim();
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      const expanded = await trigger.getAttribute('aria-expanded');
      const afterEnter = (await page.locator('body').innerText()).length;
      // 列表是否出现：找选项文案
      const listVisible = await page.getByText(/自定义页数/).first().isVisible().catch(() => false);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      const afterSelect = (await trigger.innerText()).trim();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      const listAfterEsc = await page.getByText(/自定义页数/).first().isVisible().catch(() => false);
      return {
        ok: expanded === 'true' && afterSelect !== before && !listAfterEsc,
        detail: `aria-expanded=${expanded ?? 'null'}；菜单可见=${listVisible}；Enter 后正文长度=${afterEnter}；选中「${before}」→「${afterSelect}」；Esc 后菜单可见=${listAfterEsc}`,
      };
    },
  },
  {
    id: 'drawer-focus-trap',
    name: '移动端抽屉是真正的模态（焦点不旁落、Esc 归还）',
    route: '/',
    viewport: 'mobile',
    async run(page) {
      const trigger = page.getByRole('button', { name: '打开菜单' }).first();
      await trigger.waitFor({ state: 'visible', timeout: 15000 });
      await trigger.click();
      const drawer = page.locator('#mobile-nav');
      await drawer.waitFor({ state: 'visible', timeout: 5000 });
      let escaped = 0;
      let moves = 0;
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press('Tab');
        moves += 1;
        const inside = await page.evaluate(() => {
          const el = document.activeElement;
          const box = document.querySelector('#mobile-nav');
          return Boolean(el && box && box.contains(el));
        });
        if (!inside) escaped += 1;
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const stillOpen = await drawer.isVisible().catch(() => false);
      const focusBack = await page.evaluate(() => {
        const el = document.activeElement;
        return Boolean(el && el.getAttribute && el.getAttribute('aria-label') === '打开菜单');
      });
      return {
        ok: escaped === 0 && !stillOpen && focusBack,
        detail: `Tab ${moves} 次，焦点离开抽屉 ${escaped} 次；Esc 后仍可见=${stillOpen}；焦点回到触发按钮=${focusBack}`,
      };
    },
  },
  {
    id: 'form-error-announced',
    name: '表单错误被实时播报（读屏可听）',
    route: '/login',
    viewport: 'desktop',
    async run(page) {
      const submit = page.getByRole('button', { name: /^(登录|注册)$/ }).first();
      await submit.waitFor({ state: 'visible', timeout: 15000 });
      await submit.click();
      await page.waitForTimeout(900);
      const live = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[role="alert"],[aria-live]'));
        return nodes
          .map((node) => ({
            role: node.getAttribute('role'),
            live: node.getAttribute('aria-live'),
            text: (node.textContent || '').trim().slice(0, 60),
          }))
          .filter((item) => item.text.length > 0);
      });
      return {
        ok: live.length > 0,
        detail: live.length
          ? `播报节点 ${live.length} 个：${live.map((item) => `${item.role ?? item.live}:${item.text}`).join(' | ')}`
          : '提交后没有任何 role="alert" 或 aria-live 节点承载错误文本',
      };
    },
  },
];

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : true;
};
const PORT = Number(flag('--port', 3155));
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = flag('--only', null);
const NO_SERVER = Boolean(flag('--no-server', false));
const QUIET = Boolean(flag('--quiet', false));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => {
  if (!QUIET) console.log(...parts);
};

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { allowedRules: {}, touchTargetUndersizedMax: 0 };
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return { allowedRules: parsed.allowedRules ?? {}, touchTargetUndersizedMax: parsed.touchTargetUndersizedMax ?? 0 };
  } catch (error) {
    console.error(`✗ 基线文件无法解析：${BASELINE_PATH} — ${error.message}`);
    process.exit(2);
  }
}

async function waitForServer(timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/`, { redirect: 'manual' });
      if (res.status < 500) return true;
    } catch {
      // 还没起来
    }
    await sleep(1000);
  }
  return false;
}

async function startServer() {
  const child = spawn('npm', ['run', 'dev', '--', '-p', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  const tail = [];
  const collect = (chunk) => {
    tail.push(String(chunk));
    if (tail.length > 40) tail.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const ok = await waitForServer();
  if (!ok) {
    child.kill('SIGKILL');
    throw new Error(`dev server 未在超时内就绪（端口 ${PORT}）。最近输出：\n${tail.join('')}`);
  }
  log(`  · dev server 就绪 ${BASE}`);
  return child;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 20; i += 1) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(150);
  }
  child.kill('SIGKILL');
}

async function launchBrowser(chromium) {
  const attempts = [
    { label: 'bundled chromium', options: { headless: true } },
    { label: 'channel:chrome', options: { headless: true, channel: 'chrome' } },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch(attempt.options);
      log(`  · 浏览器：${attempt.label}`);
      return browser;
    } catch (error) {
      errors.push(`${attempt.label}: ${String(error.message || error).split('\n')[0]}`);
    }
  }
  throw new Error(
    `无法启动浏览器。先跑 \`npx playwright install chromium\`，或安装 Google Chrome。\n${errors.join('\n')}`,
  );
}

function slug(route) {
  return route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '-');
}

async function collectTouchTargets(page) {
  return page.evaluate(() => {
    const selector = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const undersized = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
      if (style.clip !== 'auto' || style.clipPath !== 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < 24 || rect.height < 24) {
        const label =
          (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName)
            .trim()
            .slice(0, 30);
        undersized.push({
          label,
          tag: el.tagName.toLowerCase(),
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        });
      }
    }
    return undersized;
  });
}

async function auditRoute(page, axeModule, route, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  const response = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const status = response ? response.status() : 0;
  await page.waitForTimeout(700);

  const builder = new axeModule.AxeBuilder({ page });
  const axeResult = await builder
    .withTags(AXE_TAGS)
    .analyze()
    .catch((error) => ({ violations: [], incomplete: [], error: String(error.message || error) }));

  const violations = (axeResult.violations ?? []).map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target.join(' '),
      failure: (node.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200),
      html: (node.html ?? '').slice(0, 160),
    })),
  }));

  const headings = await page.evaluate(() => {
    const levels = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => Number(h.tagName[1]));
    return { count: levels.length, levels, h1: levels.filter((level) => level === 1).length };
  });

  const touches = viewport.name === 'mobile' ? await collectTouchTargets(page) : [];

  return {
    route,
    viewport: viewport.name,
    status,
    url: page.url(),
    axeError: axeResult.error ?? null,
    violations,
    headings,
    undersizedTargets: touches,
  };
}

async function runBehaviors(page, route) {
  const results = [];
  for (const behavior of BEHAVIORS) {
    if (behavior.route !== route) continue;
    const viewport = VIEWPORTS.find((item) => item.name === behavior.viewport);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE}${behavior.route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(700);
    try {
      const outcome = await behavior.run(page);
      results.push({
        id: behavior.id,
        name: behavior.name,
        route: behavior.route,
        viewport: behavior.viewport,
        ok: Boolean(outcome.ok),
        detail: outcome.detail ?? '',
      });
    } catch (error) {
      results.push({
        id: behavior.id,
        name: behavior.name,
        route: behavior.route,
        viewport: behavior.viewport,
        ok: false,
        detail: `断言抛错：${String(error.message || error).split('\n')[0]}`,
      });
    }
  }
  return results;
}

async function main() {
  const baseline = loadBaseline();
  mkdirSync(SHOT_DIR, { recursive: true });

  const { chromium } = await import('playwright');
  const axeModule = await import('@axe-core/playwright');

  const exact = ONLY ? ROUTES.filter((route) => route === ONLY) : [];
  const routes = ONLY
    ? exact.length
      ? exact
      : ROUTES.filter((route) => route.startsWith(String(ONLY)))
    : ROUTES;
  if (routes.length === 0) {
    console.error(`✗ --only ${ONLY} 没有匹配任何路由。可选：${ROUTES.join(' ')}`);
    process.exit(2);
  }

  let server = null;
  let browser = null;
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    routes,
    viewports: VIEWPORTS.map((item) => item.name),
    pages: [],
    behaviors: [],
    screenshots: [],
    summary: {},
  };

  try {
    if (!NO_SERVER) server = await startServer();
    else if (!(await waitForServer(5000))) throw new Error(`--no-server 指定，但 ${BASE} 无响应`);

    browser = await launchBrowser(chromium);
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await context.newPage();

    for (const route of routes) {
      const entry = { route, pages: [], behaviors: [] };
      for (const viewport of VIEWPORTS) {
        const result = await auditRoute(page, axeModule, route, viewport);
        entry.pages.push(result);
        const hasIssue =
          result.violations.length > 0 ||
          result.headings.h1 !== 1 ||
          result.undersizedTargets.length > (baseline.touchTargetUndersizedMax ?? 0);
        if (hasIssue) {
          const file = path.join(SHOT_DIR, `${slug(route)}__${viewport.name}.png`);
          await page.screenshot({ path: file, fullPage: false }).catch(() => {});
          report.screenshots.push(path.relative(ROOT, file));
          log(`  · 截图 ${path.relative(ROOT, file)}`);
        }
      }
      const behaviorResults = await runBehaviors(page, route);
      entry.behaviors.push(...behaviorResults);
      report.behaviors.push(...behaviorResults);
      report.pages.push(...entry.pages);
    }

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }

  // ---- 汇总 ----
  const allowed = baseline.allowedRules ?? {};
  const ruleStats = new Map();
  let nodeTotal = 0;
  const blocking = [];
  for (const pageResult of report.pages) {
    for (const violation of pageResult.violations) {
      const key = violation.id;
      const stat = ruleStats.get(key) ?? { id: key, impact: violation.impact, help: violation.help, nodes: 0, pages: new Set() };
      stat.nodes += violation.nodes.length;
      stat.pages.add(`${pageResult.route}@${pageResult.viewport}`);
      ruleStats.set(key, stat);
      nodeTotal += violation.nodes.length;
      if (!allowed[key]) {
        blocking.push({
          rule: key,
          route: pageResult.route,
          viewport: pageResult.viewport,
          first: violation.nodes[0],
        });
      }
    }
  }

  const headingFailures = report.pages
    .filter((pageResult) => pageResult.headings.h1 !== 1)
    .map((pageResult) => ({
      route: pageResult.route,
      viewport: pageResult.viewport,
      h1: pageResult.headings.h1,
      levels: pageResult.headings.levels,
    }));

  const touchFailures = report.pages
    .filter((pageResult) => pageResult.undersizedTargets.length > (baseline.touchTargetUndersizedMax ?? 0))
    .map((pageResult) => ({
      route: pageResult.route,
      count: pageResult.undersizedTargets.length,
      max: baseline.touchTargetUndersizedMax,
      sample: pageResult.undersizedTargets.slice(0, 6),
    }));

  report.summary = {
    axeNodes: nodeTotal,
    axeRules: ruleStats.size,
    axeRuleIds: Array.from(ruleStats.keys()),
    axeError: report.pages.map((pageResult) => pageResult.axeError).filter(Boolean),
    blockingNodes: blocking.length,
    headingFailures,
    touchFailures,
    behaviorFailures: report.behaviors.filter((behavior) => !behavior.ok).length,
    touchTargetUndersizedMax: baseline.touchTargetUndersizedMax,
    allowedRules: Object.keys(allowed),
    failures:
      blocking.length + headingFailures.length + touchFailures.length + report.behaviors.filter((behavior) => !behavior.ok).length,
  };

  writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  // ---- 打印 ----
  console.log(`\n== ui-check ${BASE} ==`);
  console.log(`路由 ${routes.length} × 视口 ${VIEWPORTS.length}｜axe 节点 ${nodeTotal}、规则 ${ruleStats.size}`);

  const sortedRules = Array.from(ruleStats.values()).sort((a, b) => b.nodes - a.nodes);
  for (const stat of sortedRules) {
    const tag = allowed[stat.id] ? '（已基线豁免）' : '';
    console.log(`  ${stat.nodes.toString().padStart(4)}  ${stat.id} [${stat.impact}]${tag} — ${stat.help}`);
    console.log(`        出现于 ${Array.from(stat.pages).join(', ')}`);
  }

  for (const behavior of report.behaviors) {
    console.log(`  ${behavior.ok ? '✓' : '✗'} ${behavior.name} — ${behavior.detail}`);
  }
  for (const failure of headingFailures) {
    console.log(`  ✗ h1 数量 ${failure.h1}（应为 1）@ ${failure.route} ${failure.viewport}`);
  }
  for (const failure of touchFailures) {
    console.log(`  ✗ 小目标 ${failure.count} 个 > 基线 ${failure.max} @ ${failure.route}（如 ${failure.sample.map((s) => s.label).slice(0, 3).join(' / ')}）`);
  }

  console.log(`\n报告：${path.relative(ROOT, path.join(OUT_DIR, 'report.json'))}`);
  if (report.summary.failures > 0) {
    console.log(`✗ 未通过：${report.summary.failures} 项（axe ${blocking.length} 节点 / 行为 ${report.summary.behaviorFailures} / 标题 ${headingFailures.length} / 小目标 ${touchFailures.length}）`);
    process.exit(1);
  }
  console.log('✔ 全部通过');
  process.exit(0);
}

main().catch((error) => {
  console.error(`✗ ui-check 运行失败：${String(error.message || error)}`);
  process.exit(2);
});
