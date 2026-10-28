#!/usr/bin/env node
// 护栏自检：只断言命令的对外行为（退出码 + 关键输出），不测脚本内部函数。
// 独立于两套主套件（不注入 ctx），用临时夹具证明每条护栏真的会红——
// 2026-10-28 的事故是「命令退出码 0，但内容不对」，所以这里既要有会红的夹具，也要有干净对照。
// 故意不并入门（避免门测门递归），由 CI 在完整门之后单独跑。
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const GATE = path.join(REPO_ROOT, 'scripts/gate.mjs');
const WORKTREE = path.join(REPO_ROOT, 'scripts/worktree.mjs');
const RELEASE = path.join(REPO_ROOT, 'scripts/release.mjs');
const VERIFY_HEALTH = path.join(REPO_ROOT, 'scripts/verify-health.mjs');
const TEST_LOCK = path.join(REPO_ROOT, 'scripts/test-lock.mjs');
const LOCK_DIR = path.join(tmpdir(), 'anppt-v2-test-suite.lock');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function node(args, options = {}) {
  return run(NODE, args, options);
}

function git(args, cwd) {
  return run('git', args, { cwd });
}

function gitOk(args, cwd) {
  const result = git(args, cwd);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr.trim()}`);
  return result.stdout.trim();
}

function writeFixture(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const cleanupFns = [];

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(dir, branch = 'main') {
  gitOk(['init', '-q', '-b', branch], dir);
  gitOk(['config', 'user.email', 'guardrails@test.local'], dir);
  gitOk(['config', 'user.name', 'Guardrails Test'], dir);
  return dir;
}

function commitAll(dir, message) {
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', message], dir);
  return gitOk(['rev-parse', 'HEAD'], dir);
}

// 复用主仓依赖、但完全活在临时目录里的最小仓库：lint/tsc 夹具不该污染主仓。
function scaffoldRepo(prefix) {
  const dir = initRepo(tempDir(prefix));
  writeFixture(path.join(dir, 'package.json'), JSON.stringify({ name: 'guardrails-fixture', private: true, scripts: { lint: 'eslint' } }, null, 2) + '\n');
  writeFixture(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['esnext'],
          strict: true,
          noEmit: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          skipLibCheck: true,
          allowJs: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  copyFileSync(path.join(REPO_ROOT, 'eslint.config.mjs'), path.join(dir, 'eslint.config.mjs'));
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

function cleanupAll() {
  for (const fn of cleanupFns.splice(0).reverse()) {
    try {
      fn();
    } catch {
      // 清理尽力而为；残留会在检查项里暴露。
    }
  }
}

process.on('exit', cleanupAll);

// ---------------------------------------------------------------- 门：分支范围空白
{
  console.log('\n[1] 门：分支范围空白（文件末多余空行 / 行尾空格）');
  const repo = initRepo(tempDir('guardrails-branch-'));
  writeFixture(path.join(repo, 'README.md'), '# base\n');
  commitAll(repo, 'base');
  gitOk(['switch', '-q', '-c', 'feat'], repo);

  const clean = node([GATE, '--steps', 'branch', '--base', 'main'], { cwd: repo });
  check('干净分支：branch 步骤退出码 0（无假红）', clean.status === 0, `${clean.status} ${clean.stderr}`);

  writeFixture(path.join(repo, 'notes.md'), 'line\n\n');
  writeFixture(path.join(repo, 'trail.txt'), 'value  \n');
  commitAll(repo, 'dirty whitespace');

  const dirty = node([GATE, '--steps', 'branch', '--base', 'main'], { cwd: repo });
  const dirtyOutput = `${dirty.stdout}\n${dirty.stderr}`;
  check('分支上文件末多余空行：门必须失败', dirty.status !== 0, `exit ${dirty.status}`);
  check('失败信息指出文件与行号（notes.md）', /notes\.md:\d+/.test(dirtyOutput), dirtyOutput.slice(0, 300));
  check('失败信息指出行尾空格（trail.txt）', /trail\.txt:\d+/.test(dirtyOutput), dirtyOutput.slice(0, 300));
}

// ---------------------------------------------------------------- 门：冲突标记
{
  console.log('\n[2] 门：冲突标记扫描（tracked + untracked）');
  const conflict = [
    'export const a = 1;',
    '<<<<<<< HEAD',
    'const b = 2;',
    '=======',
    'const c = 3;',
    '>>>>>>> other',
    '',
  ].join('\n');
  const tracked = initRepo(tempDir('guardrails-markers-'));
  writeFixture(path.join(tracked, 'docs/conflict.ts'), conflict);
  commitAll(tracked, 'conflict');
  const trackedRun = node([GATE, '--steps', 'markers'], { cwd: tracked });
  check('已跟踪文件里的冲突标记：门必须失败', trackedRun.status !== 0, `exit ${trackedRun.status}`);
  check(
    '失败信息指出文件与行号',
    /docs\/conflict\.ts:2/.test(`${trackedRun.stdout}\n${trackedRun.stderr}`),
    trackedRun.stderr.slice(0, 300),
  );

  const untracked = initRepo(tempDir('guardrails-markers-untracked-'));
  writeFixture(path.join(untracked, 'README.md'), '# base\n');
  commitAll(untracked, 'base');
  writeFixture(path.join(untracked, 'docs/pending.md'), 'hi\n<<<<<<< HEAD\n');
  const untrackedRun = node([GATE, '--steps', 'markers'], { cwd: untracked });
  check('未跟踪新文件里的冲突标记也要被抓到', untrackedRun.status !== 0, `exit ${untrackedRun.status}`);

  const yml = initRepo(tempDir('guardrails-markers-yml-'));
  writeFixture(path.join(yml, 'README.md'), '# base\n');
  commitAll(yml, 'base');
  writeFixture(path.join(yml, '.github/workflows/ci.yml'), 'on: push\n<<<<<<< HEAD\njobs: {}\n');
  const ymlRun = node([GATE, '--steps', 'markers'], { cwd: yml });
  check('CI/钩子这类 yml/sh 文件也在扫描范围', ymlRun.status !== 0, `exit ${ymlRun.status}`);

  const clean = initRepo(tempDir('guardrails-markers-clean-'));
  writeFixture(path.join(clean, 'README.md'), '# base\n');
  commitAll(clean, 'base');
  const cleanRun = node([GATE, '--steps', 'markers'], { cwd: clean });
  check('干净仓库：markers 步骤退出码 0', cleanRun.status === 0, `exit ${cleanRun.status}`);
}

// ---------------------------------------------------------------- 门：lint / tsc
{
  console.log('\n[3] 门：lint 错与类型错必须让门失败（临时目录夹具，不污染主仓）');
  const lintRepo = scaffoldRepo('guardrails-lint-');
  writeFixture(path.join(lintRepo, 'src/lint-error.ts'), 'const unusedGuardrailFixture = 1;\nexport {};\n');
  const lintRun = node([GATE, '--steps', 'lint'], { cwd: lintRepo });
  check('lint 错：门必须失败', lintRun.status !== 0, `exit ${lintRun.status} ${lintRun.stderr.slice(0, 200)}`);
  check(
    '失败信息指向 lint 规则或文件',
    /lint-error|@typescript-eslint|eslint/i.test(`${lintRun.stdout}\n${lintRun.stderr}`),
    lintRun.stderr.slice(0, 300),
  );

  const tscRepo = scaffoldRepo('guardrails-tsc-');
  writeFixture(path.join(tscRepo, 'src/type-error.ts'), 'export const badGuardrailFixture: number = "not a number";\n');
  const tscRun = node([GATE, '--steps', 'tsc'], { cwd: tscRepo });
  check('类型错：门必须失败', tscRun.status !== 0, `exit ${tscRun.status} ${tscRun.stderr.slice(0, 200)}`);
  check(
    '失败信息是 tsc 诊断（含文件名）',
    /type-error\.ts.*error TS\d+/s.test(`${tscRun.stdout}\n${tscRun.stderr}`),
    tscRun.stderr.slice(0, 300),
  );
}

// ---------------------------------------------------------------- 工作树脚本
{
  console.log('\n[4] 工作树脚本：产物 node_modules 是实体目录，不是符号链接');
  const name = 'guardrails-fixture';
  const target = path.join(REPO_ROOT, '.worktrees', name);
  // 只清自己名下的夹具；不碰并行 agent 的工作树。
  const registered = git(['worktree', 'list', '--porcelain'], REPO_ROOT)
    .stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  if (registered.includes(target)) git(['worktree', 'remove', '--force', target], REPO_ROOT);
  if (git(['branch', '--list', name], REPO_ROOT).stdout.trim()) git(['branch', '-D', name], REPO_ROOT);

  const created = node([WORKTREE, name], { cwd: REPO_ROOT });
  cleanupFns.push(() => {
    git(['worktree', 'remove', '--force', target], REPO_ROOT);
    git(['branch', '-D', name], REPO_ROOT);
    git(['worktree', 'prune'], REPO_ROOT);
    rmSync(target, { recursive: true, force: true });
  });
  check('一条命令创建工作树成功', created.status === 0, created.stderr.slice(0, 400));

  const modules = path.join(target, 'node_modules');
  let modulesStat = null;
  try {
    modulesStat = lstatSync(modules);
  } catch {
    modulesStat = null;
  }
  check('产物 node_modules 存在', Boolean(modulesStat));
  check('产物 node_modules 不是符号链接', Boolean(modulesStat) && !modulesStat.isSymbolicLink());
  check('产物 node_modules 是实体目录', Boolean(modulesStat) && modulesStat.isDirectory());
  check(
    '输出写明 build 只在主仓跑（含原因）',
    /build 只在主仓跑/.test(created.stdout) && /Turbopack/.test(created.stdout),
    created.stdout.slice(-300),
  );
}

// ---------------------------------------------------------------- 发布脚本
{
  console.log('\n[5] 发布脚本：截断的二进制补丁与树哈希不等都必须中止且不留半成品');
  const dir = tempDir('guardrails-release-');
  const source = path.join(dir, 'source');
  mkdirSync(source);
  initRepo(source, 'production');
  writeFixture(path.join(source, 'app.txt'), 'A\n');
  const shaA = commitAll(source, 'base');

  const bare = path.join(dir, 'origin.git');
  gitOk(['init', '--bare', '-q', bare], dir);
  gitOk(['remote', 'add', 'origin', bare], source);
  gitOk(['push', '-q', '-u', 'origin', 'production'], source);

  const remote = path.join(dir, 'remote');
  gitOk(['clone', '-q', '-b', 'production', bare, remote], dir);

  writeFixture(path.join(source, 'app.txt'), 'B\n');
  writeFixture(path.join(source, 'added.txt'), 'new file\n');
  writeFixture(path.join(source, 'blob.bin'), randomBytes(128 * 1024)); // 二进制 hunk：复刻 5.2MB 补丁事故形态
  commitAll(source, 'second');
  const treeB = gitOk(['rev-parse', 'HEAD^{tree}'], source);

  const patch = path.join(dir, 'release.patch');
  const diff = spawnSync('git', ['diff', '--binary', shaA, 'HEAD'], {
    cwd: source,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Error(`生成夹具补丁失败：${diff.stderr}`);
  writeFileSync(patch, diff.stdout);

  const bytes = readFileSync(patch);
  const binaryAt = bytes.indexOf(Buffer.from('GIT binary patch'));
  if (binaryAt < 0) throw new Error('夹具补丁里没有二进制 hunk，无法复刻截断事故');
  const truncated = path.join(dir, 'truncated.patch');
  // 从二进制 hunk 中间截断：git 2.56 对这类补丁会 exit 0 只在 stderr 报 corrupt，
  // 所以这里同时为「退出码 0 但内容不对」守卫提供回归。
  writeFileSync(truncated, bytes.subarray(0, binaryAt + Math.max(64, Math.floor((bytes.length - binaryAt) * 0.5))));

  const remoteHead = () => gitOk(['rev-parse', 'HEAD'], remote);
  const remoteClean = () => gitOk(['status', '--porcelain'], remote) === '';

  const truncatedRun = node(
    [RELEASE, '--target', `local:${remote}`, '--patch', truncated, '--expected-tree', treeB],
    { cwd: source },
  );
  check('截断二进制补丁：发布必须被拒绝（exit 非 0）', truncatedRun.status !== 0, `exit ${truncatedRun.status}`);
  check(
    '拒绝发生在 apply/tree 校验（不是提交之后）',
    /\[release\] (apply|tree):/.test(truncatedRun.stderr),
    truncatedRun.stderr.slice(0, 400),
  );
  check(
    'stderr 保留 git 的 corrupt 诊断（审计用）',
    /corrupt|apply --check|does not match/i.test(`${truncatedRun.stdout}\n${truncatedRun.stderr}`),
    truncatedRun.stderr.slice(0, 300),
  );
  check('截断补丁后远端 HEAD 未变', remoteHead() === shaA, remoteHead());
  check('截断补丁后远端工作树干净', remoteClean());

  const mismatchRun = node(
    [RELEASE, '--target', `local:${remote}`, '--patch', patch, '--expected-tree', '1111111111111111111111111111111111111111'],
    { cwd: source },
  );
  check('树哈希不等：发布必须被拒绝', mismatchRun.status !== 0, `exit ${mismatchRun.status}`);
  check(
    '拒绝信息指向 tree 步骤',
    /\[release\] tree:/.test(mismatchRun.stderr),
    mismatchRun.stderr.slice(0, 400),
  );
  check('树哈希不等后远端 HEAD 未变（没有半成品提交）', remoteHead() === shaA, remoteHead());
  check('树哈希不等后远端工作树干净', remoteClean());

  const successRun = node(
    [RELEASE, '--target', `local:${remote}`, '--patch', patch, '--expected-tree', treeB],
    { cwd: source },
  );
  check('正确补丁 + 期望树：发布成功', successRun.status === 0, successRun.stderr.slice(0, 400));
  check('成功信息含新提交与树', /released [0-9a-f]{40} tree=/.test(successRun.stdout), successRun.stdout.slice(-200));
  check('本地模式跳过部署（不触发真实部署）', /deploy skipped/.test(successRun.stdout));
  const releasedHead = remoteHead();
  check('远端 HEAD 已推进', releasedHead !== shaA, releasedHead);
  check('远端新提交的树等于期望树', gitOk(['rev-parse', 'HEAD^{tree}'], remote) === treeB);
  check('origin 收到新提交（已推送）', gitOk(['rev-parse', 'production'], bare) === releasedHead);
  check('远端工作树干净', remoteClean());
}

// ---------------------------------------------------------------- 健康契约
{
  console.log('\n[6] 健康校验脚本：标准输入坏载荷必须判失败');
  const good = {
    ok: true,
    service: 'anppt-v2',
    release: 'rev-good',
    db: true,
    plugins: { profile: 'default', plugins: [], services: [] },
    logging: { ok: true, writable: true, fileCount: 1 },
  };
  const health = (payload, env = {}) =>
    spawnSync(NODE, [VERIFY_HEALTH], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  const goodRun = health(good);
  check('正常载荷：exit 0', goodRun.status === 0, `${goodRun.status} ${goodRun.stderr}`);

  const errored = structuredClone(good);
  errored.plugins = { error: 'pricing plugin failed' };
  const erroredRun = health(errored);
  check('显式 plugins.error：必须失败', erroredRun.status !== 0, `exit ${erroredRun.status}`);

  const missing = structuredClone(good);
  delete missing.logging;
  const missingRun = health(missing);
  check('缺 logging 字段：必须失败', missingRun.status !== 0, `exit ${missingRun.status}`);
  check('缺字段原因可读', /logging\.ok/.test(missingRun.stderr), missingRun.stderr.slice(0, 200));

  const stale = structuredClone(good);
  const staleRun = health(stale, { EXPECTED_RELEASE: 'rev-new' });
  check('旧 release（与期望不一致）：必须失败', staleRun.status !== 0, `exit ${staleRun.status}`);
  check('失败信息含 release mismatch', /release mismatch/.test(staleRun.stderr), staleRun.stderr.slice(0, 200));
}

// ---------------------------------------------------------------- 提交前钩子
{
  console.log('\n[7] 提交前钩子：接线生效，--no-verify 可绕过');
  const repo = initRepo(tempDir('guardrails-hook-'));
  const hookSource = path.join(REPO_ROOT, '.githooks/pre-commit');
  const hookTarget = path.join(repo, '.githooks/pre-commit');
  writeFixture(hookTarget, readFileSync(hookSource));
  chmodSync(hookTarget, 0o755);
  writeFixture(path.join(repo, 'scripts/gate.mjs'), "process.exit(process.env.STUB_GATE === 'fail' ? 1 : 0);\n");
  gitOk(['config', 'core.hooksPath', '.githooks'], repo);
  writeFixture(path.join(repo, 'a.txt'), '1\n');
  commitAll(repo, 'base');

  const blocked = run('git', ['commit', '-q', '-m', 'blocked', '--allow-empty'], {
    cwd: repo,
    env: { ...process.env, STUB_GATE: 'fail' },
  });
  check('门失败时提交被钩子拒绝', blocked.status !== 0, `exit ${blocked.status}`);
  check('钩子脚本可执行', (lstatSync(hookTarget).mode & 0o111) !== 0);
  const bypass = run('git', ['commit', '-q', '-m', 'bypass', '--allow-empty', '--no-verify'], { cwd: repo });
  check('--no-verify 可绕过（紧急操作不被堵死）', bypass.status === 0, bypass.stderr);
  check('绕过只产生一个提交，未重复执行门', gitOk(['rev-list', '--count', 'HEAD'], repo) === '2');
  check(
    '钩子脚本调用的是门快集',
    /node scripts\/gate\.mjs --fast/.test(readFileSync(hookSource, 'utf8')),
    readFileSync(hookSource, 'utf8'),
  );
}

// ---------------------------------------------------------------- 测试锁
{
  console.log('\n[8] 测试锁：等待提示、陈旧锁回收（不再双持锁）');
  const lockUrl = pathToFileURL(TEST_LOCK).href;
  const acquirer = () =>
    node(
      [
        '--input-type=module',
        '-e',
        `const lock = await import(${JSON.stringify(lockUrl)});\nlock.acquireTestLock('guardrails');\nlock.releaseTestLock();\nconsole.log('acquired');`,
      ],
      { cwd: REPO_ROOT, timeout: 20000 },
    );

  rmSync(LOCK_DIR, { recursive: true, force: true });
  cleanupFns.push(() => rmSync(LOCK_DIR, { recursive: true, force: true }));
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(
    path.join(LOCK_DIR, 'owner.json'),
    JSON.stringify({ pid: 999999, hostname: hostname(), label: 'ghost', startedAt: new Date().toISOString() }) + '\n',
  );
  const dead = acquirer();
  check('过期锁（持有者 pid 已退出）被回收后取得锁', dead.status === 0 && /acquired/.test(dead.stdout), `${dead.status} ${dead.stderr.slice(0, 200)}`);
  check('回收时打印陈旧锁原因', /清理陈旧测试锁/.test(dead.stdout), dead.stdout);
  check('取得并释放后锁目录消失', !existsSync(LOCK_DIR));

  // 持有者用「孤儿 sleep」：父 shell 立刻退出，sleep 被 init 收养，退出后会被真正回收。
  // 直接 spawn 成子进程不行——父进程阻塞在 spawnSync 时收不到 SIGCHLD，子进程变僵尸，
  // kill(pid, 0) 会一直成功，等待方永远等不到陈旧判定（2026-10-28 实测踩过）。
  const holderStart = spawnSync('sh', ['-c', 'sleep 3 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const holderPid = Number((holderStart.stdout || '').trim());
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(
    path.join(LOCK_DIR, 'owner.json'),
    JSON.stringify({ pid: holderPid, hostname: hostname(), label: 'holder', startedAt: new Date().toISOString() }) + '\n',
  );
  const startedAt = Date.now();
  const waited = acquirer();
  const elapsed = Date.now() - startedAt;
  check('持有者存活时打印等待提示', waited.status === 0 && /等待测试锁/.test(waited.stdout), waited.stdout.slice(0, 300));
  check('等待至少 1s 才取得锁（没有直接跑）', elapsed >= 1000, `${elapsed}ms`);
  check('等待结束后锁被释放', !existsSync(LOCK_DIR));
}

// ---------------------------------------------------------------- 收尾
cleanupAll();
{
  console.log('\n[9] 夹具清理');
  check('工作树夹具已删除', !existsSync(path.join(REPO_ROOT, '.worktrees/guardrails-fixture')));
  check('测试锁已释放', !existsSync(LOCK_DIR));
  const leftovers = git(['status', '--porcelain'], REPO_ROOT).stdout
    .split('\n')
    .filter((line) => /guardrails-fixture|guardrails-(lint|tsc)/.test(line));
  check('主仓没有夹具留下的未跟踪文件', leftovers.length === 0, leftovers.join(' | '));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
