#!/usr/bin/env node
// 门命令：顺序固定、失败即停。--fast 供提交前钩子（跳过两套测试与 build），--steps 供夹具自测。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const STEP_DEFS = [
  { name: 'branch', handler: runBranchStep },
  { name: 'markers', handler: runMarkersStep },
  { name: 'lint', command: 'npm', args: ['run', 'lint', '--', '--max-warnings=0'] },
  { name: 'typegen', command: 'npx', args: ['next', 'typegen'] },
  { name: 'tsc', command: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'test-backend', command: 'node', args: ['scripts/test-backend.mjs'] },
  { name: 'test-generation', command: 'node', args: ['scripts/test-generation.mjs'] },
  { name: 'build', command: 'npm', args: ['run', 'build'] },
];

const FAST_STEP_NAMES = ['branch', 'markers', 'lint', 'typegen', 'tsc'];

// 覆盖 agent 会手写/合并的全部文本类型：规范要求 md/ts/tsx/mjs，外加 yml/sh/json（CI 与钩子本身就是这些后缀）。
const MARKER_EXT_RE = /\.(md|ts|tsx|mjs|js|yml|yaml|sh|json)$/i;
const MARKER_RE = /^<<<<<<< /;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }

  const root = gitText(['rev-parse', '--show-toplevel']);
  if (!root) {
    console.error('✗ 不在 git 仓库内，无法跑门');
    return 1;
  }
  if (process.cwd() !== root) {
    console.log(`仓库根：${root}`);
    process.chdir(root);
  }

  const names = new Set(options.steps ?? (options.fast ? FAST_STEP_NAMES : STEP_DEFS.map((step) => step.name)));
  const steps = STEP_DEFS.filter((step) => names.has(step.name));
  const startedAt = Date.now();

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    console.log(`==> [${index + 1}/${steps.length}] ${step.name}`);
    const code = step.handler ? step.handler(options) : runCommand(step.command, step.args);
    if (code !== 0) {
      console.error(`✗ 步骤失败：${step.name} (exit ${code})`);
      return 1;
    }
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✔ 门通过：${steps.length} 步全绿，耗时 ${seconds}s`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    fast: false,
    help: false,
    steps: null,
    base: process.env.GATE_BASE ? { rev: process.env.GATE_BASE, source: 'GATE_BASE' } : null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fast') options.fast = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--base') options.base = { rev: nextValue(argv, ++index, '--base'), source: '--base' };
    else if (arg.startsWith('--base=')) options.base = { rev: arg.slice('--base='.length), source: '--base' };
    else if (arg === '--steps') options.steps = parseSteps(nextValue(argv, ++index, '--steps'));
    else if (arg.startsWith('--steps=')) options.steps = parseSteps(arg.slice('--steps='.length));
    else usageError(`未知参数：${arg}`);
  }

  if (options.base && !options.base.rev) usageError('--base 不能为空');
  return options;
}

function nextValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) usageError(`${flag} 缺少参数值`);
  return value;
}

function parseSteps(raw) {
  const names = raw.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !STEP_DEFS.some((step) => step.name === name));
  if (names.length === 0 || unknown.length > 0) {
    usageError(`--steps 取值无效：${unknown.join(',') || '(空)'}；可选 ${STEP_DEFS.map((step) => step.name).join(',')}`);
  }
  return [...new Set(names)];
}

function usageError(message) {
  console.error(`✗ ${message}`);
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.log(`用法：node scripts/gate.mjs [--fast] [--base <rev>] [--steps <csv>]

步骤（固定顺序）：${STEP_DEFS.map((step) => step.name).join(' → ')}
--fast   只跑 ${FAST_STEP_NAMES.join(',')}（提交前钩子用，完整门由 CI 兜底）
--base   分支范围基线；缺省按 GATE_BASE → merge-base HEAD origin/production → origin/main
         → production → main → master → 根提交 解析，全部失败时回退 HEAD 并告警
--steps  只跑指定步骤（逗号分隔，夹具自测用）`);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`✗ 无法执行 ${command}：${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function gitText(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function hasRef(ref) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' }).status === 0;
}

function resolveBase(options) {
  if (options.base) {
    if (!hasRef(options.base.rev)) return { error: `基线不存在：${options.base.rev}（来源 ${options.base.source}）` };
    return { base: options.base.rev, source: options.base.source };
  }

  if (hasRef('origin/production')) {
    const mergeBase = gitText(['merge-base', 'HEAD', 'origin/production']);
    if (mergeBase) return { base: mergeBase, source: 'merge-base HEAD origin/production' };
  }
  if (hasRef('origin/main')) return { base: 'origin/main', source: 'origin/main' };

  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'production' && hasRef('production')) return { base: 'production', source: 'production' };
  if (hasRef('main')) return { base: 'main', source: 'main' };
  if (hasRef('master')) return { base: 'master', source: 'master' };

  const rootCommit = gitText(['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0].trim();
  if (rootCommit) return { base: rootCommit, source: '根提交', rootFallback: true };
  return { base: 'HEAD', source: 'HEAD（回退）', fallback: true };
}

// 部署分支没有可比较的上游时，整段历史审计会把存量空白全部翻出来，这不是门该管的事。
function isProductionHead() {
  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'production') return true;
  if (branch !== 'HEAD') return false;
  return hasRef('production') && gitText(['rev-parse', 'HEAD']) === gitText(['rev-parse', 'production']);
}

function runBranchStep(options) {
  let resolved = resolveBase(options);
  if (resolved.error) {
    console.error(`✗ ${resolved.error}`);
    return 1;
  }
  if (resolved.rootFallback && isProductionHead()) {
    console.warn(
      '⚠ 无共同祖先基线（本地 production 与 origin 历史无关），空白检查退化为工作区；分支评审请在 feature 分支跑',
    );
    resolved = { base: 'HEAD', source: 'HEAD（回退）' };
  }
  if (resolved.fallback) {
    console.warn('⚠ 无法确定门的比较基线，回退到 HEAD：分支范围检查为空，只检查工作区。');
  }

  const shortBase = gitText(['rev-parse', '--short', resolved.base]) || resolved.base;
  console.log(`    基线：${resolved.source} → ${shortBase}`);

  // 干净工作树上 `git diff --check` 什么也查不到，所以必须再查 base..HEAD 的分支范围；
  // pre-commit 时改动通常已在暂存区，故工作区检查以 HEAD 为对照，把暂存内容一起算进来。
  let failed = checkWhitespace([`${resolved.base}..HEAD`], `分支范围 ${shortBase}..HEAD`);
  failed = checkWhitespace(['HEAD'], '工作区与暂存区（相对 HEAD）') || failed;

  if (!failed) console.log('    ✔ 分支范围与工作区/暂存区均无空白错误');
  return failed ? 1 : 0;
}

function checkWhitespace(rangeArgs, label) {
  const result = spawnSync('git', ['diff', '--check', ...rangeArgs], { encoding: 'utf8' });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const findings = parseWhitespaceFindings(output);

  if (findings.length > 0) {
    console.error(`✗ 空白检查失败（${label}）：`);
    for (const finding of findings) console.error(`  ✗ ${finding.file}:${finding.line} — 规则：${finding.rule}`);
    return true;
  }
  if (result.status !== 0) {
    console.error(`✗ 空白检查命令失败（${label}，exit ${result.status ?? 1}）：`);
    console.error(output.trim());
    return true;
  }
  return false;
}

function parseWhitespaceFindings(output) {
  const findings = [];
  for (const line of output.split('\n')) {
    // 跳过 diff 内容行（+/-/空格前缀），只认 git 的 "<file>:<line>: <规则>" 告警行。
    if (!line || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) continue;
    const match = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (match) findings.push({ file: match[1], line: match[2], rule: match[3].trim() });
  }
  return findings;
}

function runMarkersStep() {
  // 带上未跟踪新文件：解冲突后新文件可能还没 add，纯 ls-files 会漏掉。
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
  if (listed.status !== 0) {
    console.error('✗ 冲突标记检查失败：git ls-files 执行失败');
    return 1;
  }

  const files = [...new Set(listed.stdout.split('\0'))]
    .filter((file) => file && MARKER_EXT_RE.test(file) && !file.startsWith('node_modules/'));
  const findings = [];

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('<<<<<<< ')) continue;
    content.split('\n').forEach((line, index) => {
      if (MARKER_RE.test(line)) findings.push(`${file}:${index + 1}`);
    });
  }

  if (findings.length === 0) {
    console.log(`    ✔ 已扫描 ${files.length} 个文件（含未跟踪），无冲突标记`);
    return 0;
  }
  console.error('✗ 冲突标记检查失败：');
  for (const finding of findings) console.error(`  ✗ ${finding} — 规则：冲突标记 <<<<<<<`);
  return 1;
}

process.exitCode = main();
