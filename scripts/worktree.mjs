#!/usr/bin/env node
// 一条命令得到可编译的工作树：.worktrees/<name> + 实体 node_modules（硬链接，非符号链接）
// + next typegen，使树内 npx tsc --noEmit 直接可用。失败自动回滚，主仓工作区零改动。
// 为什么硬链接：Turbopack 拒绝符号链接 node_modules；cp -al 在 macOS APFS 上秒级完成。
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const USAGE = `用法: node scripts/worktree.mjs <name> [base]

  name  工作树目录 .worktrees/<name>，同时用作分支名
        （字母或数字开头，可含 . _ - /）
  base  起点，默认 HEAD（分支、tag、提交号均可）

示例:
  node scripts/worktree.mjs feat-login
  node scripts/worktree.mjs wt-smoke origin/production

工作树用于改码与类型检查；build 只在主仓跑。`;

class UsageError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.hints = hints;
  }
}

// 只在 run() 解析出仓库后填充；回滚用得到。
const state = { repoRoot: '', worktreesRoot: '', targetPath: '', relTarget: '', name: '', mutating: false };

function sh(command, args, { cwd = state.repoRoot || process.cwd(), inherit = false } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function isBranch(branch) {
  return sh('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

function findRegistered(target) {
  const listed = sh('git', ['worktree', 'list', '--porcelain']).stdout || '';
  return (
    listed
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .find((entry) => samePath(entry, target)) || null
  );
}

function assertInsideWorktrees() {
  const rel = path.relative(state.worktreesRoot, state.targetPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`内部错误：目标不在 .worktrees/ 内：${state.targetPath}`);
  }
}

function validateName(name) {
  const invalid =
    !NAME_RE.test(name) ||
    name.includes('..') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock');
  if (invalid) {
    throw new UsageError(`工作树名不合法：${name}`, [
      '要求字母或数字开头，只含 A-Z a-z 0-9 . _ - /，不能含 ..，不能以 / 或 . 结尾。',
    ]);
  }
  if (sh('git', ['check-ref-format', '--branch', name]).status !== 0) {
    throw new UsageError(`不是合法的 git 分支名：${name}`, ['规则见 git check-ref-format。']);
  }
}

function run() {
  const argv = process.argv.slice(2);
  if (argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return;
  }
  if (argv.length === 0) {
    throw new UsageError('缺少工作树名', ['用法: node scripts/worktree.mjs <name> [base]', '完整说明: node scripts/worktree.mjs --help']);
  }
  if (argv.length > 2) {
    throw new UsageError(`参数过多：${argv.slice(2).join(' ')}`, ['用法: node scripts/worktree.mjs <name> [base]']);
  }

  const [name, base = 'HEAD'] = argv;
  validateName(name);

  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
  if (top.status !== 0) {
    throw new UsageError('当前目录不在 git 仓库内', [(top.stderr || '').trim() || '先 cd 到仓库再执行。']);
  }
  const repoRoot = top.stdout.trim();
  const worktreesRoot = path.join(repoRoot, '.worktrees');
  Object.assign(state, {
    repoRoot,
    worktreesRoot,
    targetPath: path.join(worktreesRoot, name),
    relTarget: path.join('.worktrees', name),
    name,
  });
  assertInsideWorktrees();

  // 前置 1：.worktrees/ 必须已被忽略，否则创建工作树会弄脏主仓 status
  // 用子路径探测：目录还不存在时，目录型忽略规则（.worktrees/）匹配不到裸目录名
  if (sh('git', ['check-ignore', '-q', '--', '.worktrees/probe']).status !== 0) {
    throw new UsageError('拒绝：.worktrees/ 没有被 .gitignore 忽略', [
      '否则创建工作树会让主仓 git status 变脏。',
      '请先在 .gitignore 加一行 .worktrees/，再重试。',
    ]);
  }

  // 前置 2：目录 / 分支 / 工作树登记都不得已存在（绝不静默复用）
  const branchTaken = isBranch(name);
  const registered = findRegistered(state.targetPath);
  const dirTaken = lstatOrNull(state.targetPath) !== null;

  if (registered && !dirTaken) {
    throw new UsageError(`拒绝：${state.relTarget} 仍登记在 git worktree 元数据里，但目录已不存在`, [
      '先清掉残留元数据，再重试：',
      '  git worktree prune',
    ]);
  }
  if (dirTaken) {
    throw new UsageError(`拒绝：工作树目录已存在 ${state.relTarget}`, [
      '脚本不会复用或覆盖已有目录。',
      '确认可删后清理，再重试：',
      `  git worktree remove --force ${state.relTarget}`,
      ...(branchTaken ? [`  git branch -D ${name}`] : []),
      `  rm -rf ${state.relTarget}   # 若不是 git 工作树`,
    ]);
  }
  if (branchTaken) {
    throw new UsageError(`拒绝：分支 ${name} 已存在`, [
      '脚本只创建新分支，不把已有分支挂到新工作树（避免两处 checkout 同一分支）。',
      `删除分支后重试：git branch -D ${name}`,
    ]);
  }

  // 前置 3：主仓 node_modules 必须是实体目录且依赖齐全（硬链接源）
  const mainModules = path.join(repoRoot, 'node_modules');
  const modulesStat = lstatOrNull(mainModules);
  if (!modulesStat) {
    throw new UsageError('主仓缺少 node_modules', ['先在主仓执行 npm install，再重试。']);
  }
  if (modulesStat.isSymbolicLink()) {
    throw new UsageError('主仓 node_modules 是符号链接，不能作为硬链接源', [
      'Turbopack 拒绝符号链接 node_modules；请把主仓 node_modules 换成 npm install 产出的实体目录后再试。',
    ]);
  }
  if (!modulesStat.isDirectory()) {
    throw new UsageError('主仓 node_modules 不是目录', [mainModules]);
  }
  for (const bin of ['next', 'tsc']) {
    if (!lstatOrNull(path.join(mainModules, '.bin', bin))) {
      throw new UsageError(`主仓 node_modules 缺少 .bin/${bin}`, ['依赖未装全；先在主仓执行 npm install，再重试。']);
    }
  }

  // 前置 4：base 必须能解析成提交
  const baseRev = sh('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (baseRev.status !== 0) {
    throw new UsageError(`拒绝：base 解析不到提交：${base}`, ['可用 HEAD、分支、tag 或提交号。']);
  }
  const baseSha = sh('git', ['rev-parse', '--short', `${base}^{commit}`]).stdout.trim();

  console.log(`▶ 创建工作树 ${name}`);
  console.log(`  仓库  ${repoRoot}`);
  console.log(`  目录  ${state.relTarget}`);
  console.log(`  分支  ${name}`);
  console.log(`  起点  ${base} (${baseSha})`);

  // [1/4] 新分支 + 独立 checkout
  console.log('\n[1/4] git worktree add');
  mkdirSync(path.dirname(state.targetPath), { recursive: true }); // 支持 feat/xxx 这类嵌套名
  const added = sh('git', ['worktree', 'add', '-b', name, state.targetPath, `${base}^{commit}`], { inherit: true });
  if (added.status !== 0) {
    throw new UsageError('git worktree add 失败', [
      '上面是 git 的原始报错；本脚本未做后续修改。',
      '若留下半成品：git worktree prune，或手动删 .worktrees/ 与同名分支。',
    ]);
  }
  state.mutating = true;

  // [2/4] 硬链接复制（共享数据块，秒级）
  console.log('\n[2/4] 硬链接复制 node_modules（cp -al）');
  const copyStarted = Date.now();
  const copied = spawnSync('cp', ['-al', mainModules, path.join(state.targetPath, 'node_modules')], { stdio: 'inherit' });
  const copySeconds = ((Date.now() - copyStarted) / 1000).toFixed(2);
  if (copied.status !== 0) {
    throw new UsageError(`cp -al 失败（exit ${copied.status ?? copied.error?.message}）`, [
      '检查磁盘空间与 node_modules 权限后重试。',
    ]);
  }
  console.log(`  完成，用时 ${copySeconds}s（数据块未复制）`);

  // [3/4] 校验：必须是实体目录，且与主仓同 inode（真的是硬链接）
  console.log('\n[3/4] 校验 node_modules 是实体目录而非符号链接');
  const wtModules = path.join(state.targetPath, 'node_modules');
  const wtStat = lstatOrNull(wtModules);
  if (!wtStat || wtStat.isSymbolicLink() || !wtStat.isDirectory()) {
    throw new UsageError('校验失败：工作树 node_modules 不是实体目录', [
      'cp -al 应产出目录而不是符号链接；已回滚。',
    ]);
  }
  const mainProbe = statSync(path.join(mainModules, 'next', 'package.json'));
  const wtProbe = statSync(path.join(wtModules, 'next', 'package.json'));
  if (mainProbe.dev !== wtProbe.dev || mainProbe.ino !== wtProbe.ino) {
    throw new UsageError('校验失败：工作树 node_modules 不是主仓的硬链接副本（inode 不一致）', [
      'cp -al 可能退化成了普通复制；已回滚。',
    ]);
  }
  console.log('  ✔ 实体目录、非符号链接；next/package.json 与主仓 inode 一致');

  // [4/4] 路由类型前置（否则 tsc 缺 .next/types）
  console.log('\n[4/4] 生成路由类型（npx next typegen）');
  const typegen = spawnSync('npx', ['next', 'typegen'], { cwd: state.targetPath, stdio: 'inherit' });
  if (typegen.status !== 0) {
    throw new UsageError(`npx next typegen 失败（exit ${typegen.status ?? typegen.error?.message}）`, [
      '错误输出见上；已回滚，修复后可用同名重试。',
    ]);
  }
  console.log('  ✔ .next/types 与 next-env.d.ts 已生成（均被 .gitignore 忽略）');

  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✔ 工作树就绪：${state.relTarget}（总耗时 ${totalSeconds}s）`);
  console.log('');
  console.log('下一步（在树内执行）：');
  console.log(`  cd ${state.relTarget}`);
  console.log('  npx tsc --noEmit    # 工作树内 npx tsc --noEmit 可用（路由类型已生成）');
  console.log('');
  console.log('⚠ build 只在主仓跑：Turbopack 拒绝符号链接 node_modules（所以这里复制成硬链接实体目录），');
  console.log('  且工作树与主仓的 .next 同时构建会互抢缓存与进程；工作树只用来改码与类型检查。');
  console.log('');
  console.log('清理（在主仓执行）：');
  console.log(`  git worktree remove ${state.relTarget} && git branch -D ${name}`);
  console.log('');
  console.log('主仓工作区未改动：只新增 .git/worktrees 元数据与已忽略的 .worktrees/ 目录。');
}

function rollback() {
  console.error('\n↩ 回滚：清理本次创建的工作树');
  let cleaned = false;
  if (findRegistered(state.targetPath)) {
    console.error(`  - git worktree remove --force ${state.relTarget}`);
    if (sh('git', ['worktree', 'remove', '--force', state.targetPath], { inherit: true }).status === 0) cleaned = true;
    else console.error('  ! 工作树注销失败，请手动检查 git worktree list');
  }
  if (lstatOrNull(state.targetPath)) {
    assertInsideWorktrees();
    console.error(`  - rm -rf ${state.relTarget}`);
    rmSync(state.targetPath, { recursive: true, force: true });
    cleaned = true;
  }
  if (isBranch(state.name)) {
    console.error(`  - git branch -D ${state.name}`);
    if (sh('git', ['branch', '-D', state.name], { inherit: true }).status === 0) cleaned = true;
  }
  sh('git', ['worktree', 'prune']);
  console.error(cleaned ? '  已清理，可用同名重试。' : '  没有发现残留，可用同名重试。');
}

const startedAt = Date.now();

try {
  run();
} catch (error) {
  if (state.mutating) rollback();
  if (error instanceof UsageError) {
    console.error(`\n✖ ${error.message}`);
    for (const hint of error.hints) console.error(`  ${hint}`);
  } else {
    console.error(`\n✖ 未预期错误：${error && error.stack ? error.stack : error}`);
  }
  process.exitCode = 1;
}
