#!/usr/bin/env node
// Publish a local commit to the server without sharing Git ancestry: upload a binary
// patch, verify its checksum, apply it, and commit only when the resulting tree equals
// the local tree. A truncated 5.2MB patch once slipped into a commit whose tree was
// wrong. Git can apply a truncated binary patch partially and still exit 0, so only
// comparing the resulting tree against the local tree proves the payload is exact.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const USAGE = `Usage: node scripts/release.mjs [options]

Options:
  --target <ssh-alias|local:<path>>  Remote target (default: hk-hermes).
                                     local:<path> runs remote commands with
                                     git -C <path> and skips deployment.
  --remote-repo <path>               Server checkout (default: /opt/anppt-v2/source).
                                     Must be absolute; ignored for local targets.
  --branch <name>                    Branch to release (default: production).
  --base <rev>                       Base commit for the generated patch
                                     (default: the remote HEAD).
  --patch <file>                     Use an existing patch instead of generating one.
  --expected-tree <sha>              Tree the patch must produce
                                     (default: HEAD^{tree} of the local repo).
  --dry-run                          Resolve, generate and hash, then stop.
  -h, --help                         Print this help.

The remote checkout must be clean before anything runs. Exit status is 0 only
when the resulting tree matches; on failure the remote checkout is restored to
the commit it started from and the temporary patch is removed.`;

const DEFAULTS = {
  target: 'hk-hermes',
  remoteRepo: '/opt/anppt-v2/source',
  branch: 'production',
};
const DEPLOY_HELPER = '/opt/anppt-v2/bin/deploy-production';
const MAX_UPLOAD_ATTEMPTS = 3;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

function parseArgs(argv) {
  const opts = {
    target: DEFAULTS.target,
    remoteRepo: DEFAULTS.remoteRepo,
    branch: DEFAULTS.branch,
    base: null,
    patch: null,
    expectedTree: null,
    dryRun: false,
    help: false,
    localPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      index += 1;
      return argv[index];
    };
    if (arg === '--target') opts.target = readValue();
    else if (arg === '--remote-repo') opts.remoteRepo = readValue();
    else if (arg === '--branch') opts.branch = readValue();
    else if (arg === '--base') opts.base = readValue();
    else if (arg === '--patch') opts.patch = readValue();
    else if (arg === '--expected-tree') opts.expectedTree = readValue();
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (opts.help) return opts;

  if (opts.expectedTree !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(opts.expectedTree)) {
    throw new Error('--expected-tree must be a 40 or 64 character hex object name');
  }
  opts.expectedTree = opts.expectedTree === null ? null : opts.expectedTree.toLowerCase();

  if (!opts.branch.trim()) throw new Error('--branch must not be empty');
  if (opts.base !== null && (!opts.base.trim() || opts.base.startsWith('-'))) {
    throw new Error('--base must be a revision, not an option-looking value');
  }
  if (opts.patch !== null && !opts.patch.trim()) throw new Error('--patch must be a file path');

  if (opts.target.startsWith('local:')) {
    const localTarget = opts.target.slice('local:'.length);
    if (!localTarget.trim()) throw new Error('--target local: requires a path');
    opts.localPath = path.resolve(localTarget);
  } else {
    if (!/^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/.test(opts.target)) {
      throw new Error(`invalid ssh target: ${opts.target}`);
    }
    opts.remoteRepo = opts.remoteRepo.replace(/\/+$/, '');
    if (!/^\/[A-Za-z0-9._/-]+$/.test(opts.remoteRepo)) {
      throw new Error('--remote-repo must be an absolute path without spaces or shell metacharacters');
    }
  }

  if (opts.patch !== null) opts.patch = path.resolve(process.cwd(), opts.patch);
  return opts;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function redact(text) {
  return String(text).replace(/\/\/[^\s/@]+@/g, '//***@');
}

function failureText(result) {
  const stderr = redact((result.stderr || '').trim());
  if (!stderr) return `exit code ${result.status}`;
  return stderr.length > 4000 ? `${stderr.slice(0, 4000)}...` : stderr;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// git 2.56 can print "error: corrupt binary patch" and still exit 0 after a partial
// apply, which is how a truncated patch once produced a wrong tree (ticket #22).
function reportedErrors(stderr) {
  const lines = (stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:error|fatal):/i.test(line))
    .map((line) => (line.length > 240 ? `${line.slice(0, 240)}...` : line));
  if (!lines.length) return '';
  const text = redact(lines.join('\n'));
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function randomToken() {
  return randomBytes(6).toString('hex');
}

function localGit(args, step) {
  const result = run('git', args);
  if (result.error) throw new StepError(step, `git: ${result.error.message}`);
  if (result.status !== 0) throw new StepError(step, `git ${args.join(' ')}: ${failureText(result)}`);
  return result.stdout;
}

function sha256File(file) {
  let result = run('shasum', ['-a', '256', file]);
  if (result.error && result.error.code === 'ENOENT') result = run('sha256sum', [file]);
  if (result.error) throw new StepError('checksum', `sha256: ${result.error.message}`);
  if (result.status !== 0) throw new StepError('checksum', `sha256 ${file}: ${failureText(result)}`);
  const value = (result.stdout || '').trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new StepError('checksum', `unexpected sha256 output for ${file}`);
  return value.toLowerCase();
}

function statFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new StepError('patch', `patch file not found: ${file}`);
  }
  if (!stat.isFile()) throw new StepError('patch', `patch path is not a file: ${file}`);
  return stat;
}

function stepHeader(step, title) {
  console.log(`==> [${step}/7] ${title}`);
}

function detail(line) {
  console.log(`    ${line}`);
}

class Remote {
  constructor(opts) {
    this.localMode = opts.localPath !== null;
    this.target = opts.target;
    this.repo = this.localMode ? opts.localPath : opts.remoteRepo;
  }

  invocation(argv) {
    if (this.localMode) return { command: argv[0], args: argv.slice(1) };
    return { command: 'ssh', args: [...SSH_OPTIONS, this.target, argv.map(shellQuote).join(' ')] };
  }

  execute(argv, step) {
    const { command, args } = this.invocation(argv);
    const result = run(command, args);
    if (result.error) throw new StepError(step, `${command}: ${result.error.message}`);
    if (result.status !== 0) throw new StepError(step, `${argv.join(' ')}: ${failureText(result)}`);
    return result.stdout;
  }

  git(args, step) {
    return this.execute(['git', '-C', this.repo, ...args], step);
  }

  // Like git(), but returns the raw spawn result so the caller can inspect stderr
  // when git exits 0 despite reporting errors.
  gitResult(args) {
    const { command, args: commandArgs } = this.invocation(['git', '-C', this.repo, ...args]);
    return run(command, commandArgs);
  }

  hash(remoteFile) {
    if (this.localMode) return sha256File(remoteFile);
    const command = `shasum -a 256 ${shellQuote(remoteFile)} 2>/dev/null || sha256sum ${shellQuote(remoteFile)}`;
    const result = run('ssh', [...SSH_OPTIONS, this.target, command]);
    if (result.error) throw new StepError('checksum', `ssh ${this.target}: ${result.error.message}`);
    if (result.status !== 0) throw new StepError('checksum', `remote sha256 (${remoteFile}): ${failureText(result)}`);
    const value = (result.stdout || '').trim().split(/\s+/)[0] || '';
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new StepError('checksum', `unexpected remote sha256 output for ${remoteFile}`);
    return value.toLowerCase();
  }

  upload(localFile, remoteFile) {
    if (this.localMode) {
      fs.copyFileSync(localFile, remoteFile);
      return;
    }
    const result = run('scp', [...SSH_OPTIONS, '-q', localFile, `${this.target}:${remoteFile}`]);
    if (result.error) throw new StepError('upload', `scp: ${result.error.message}`);
    if (result.status !== 0) throw new StepError('upload', `scp ${this.target}:${remoteFile}: ${failureText(result)}`);
  }

  remove(remoteFile) {
    if (this.localMode) {
      fs.rmSync(remoteFile, { force: true });
      return;
    }
    const result = run('ssh', [...SSH_OPTIONS, this.target, `rm -f ${shellQuote(remoteFile)}`]);
    if (result.error) throw new StepError('cleanup', `ssh ${this.target}: ${result.error.message}`);
    if (result.status !== 0) throw new StepError('cleanup', `rm -f ${remoteFile}: ${failureText(result)}`);
  }
}

function release(context) {
  const { opts } = context;

  if (opts.localPath !== null) {
    let targetStat = null;
    try {
      targetStat = fs.statSync(opts.localPath);
    } catch {
      targetStat = null;
    }
    if (!targetStat || !targetStat.isDirectory()) {
      throw new StepError('args', `local target is not a directory: ${opts.localPath}`);
    }
  }

  stepHeader(1, 'resolve refs');
  const repoCheck = run('git', ['rev-parse', '--show-toplevel']);
  if (repoCheck.error) throw new StepError('refs', `git: ${repoCheck.error.message}`);
  if (repoCheck.status !== 0) {
    throw new StepError('refs', `not a git repository: ${process.cwd()}`);
  }
  const branchCheck = run('git', ['check-ref-format', '--branch', opts.branch]);
  if (branchCheck.error) throw new StepError('refs', `git: ${branchCheck.error.message}`);
  if (branchCheck.status !== 0) {
    throw new StepError('args', `invalid branch name: ${opts.branch}`);
  }
  opts.branch = (branchCheck.stdout || '').trim() || opts.branch;

  const localHead = localGit(['rev-parse', '--verify', 'HEAD'], 'refs').trim();
  const localTree = localGit(['rev-parse', '--verify', 'HEAD^{tree}'], 'refs').trim();
  const localSubject = localGit(['log', '-1', '--format=%s', localHead], 'refs').trim() || `tree ${localTree.slice(0, 12)}`;
  const expectedTree = opts.expectedTree || localTree;

  context.remote = new Remote(opts);
  const remote = context.remote;

  context.remoteHead = remote.git(['rev-parse', '--verify', 'HEAD'], 'refs').trim();
  const remoteHead = context.remoteHead;
  const remoteTree = remote.git(['rev-parse', '--verify', 'HEAD^{tree}'], 'refs').trim();

  const dirty = remote.git(['status', '--porcelain'], 'refs');
  if (dirty.trim()) {
    const preview = dirty.trim().split('\n').slice(0, 20).join('\n');
    throw new StepError('refs', `remote working tree is not clean (${remote.repo}); refusing to continue:\n${preview}`);
  }

  const branchRef = `refs/heads/${opts.branch}`;
  const branchProbe = remote.gitResult(['rev-parse', '--verify', '--quiet', branchRef]);
  if (branchProbe.status === 0) {
    context.branchExisted = true;
    context.branchTipBefore = remote.git(['rev-parse', '--verify', `${branchRef}^{commit}`], 'refs').trim();
  } else if (branchProbe.status !== 1) {
    throw new StepError('refs', `cannot inspect ${branchRef}: ${failureText(branchProbe)}`);
  }

  detail(`local  ${localHead} tree ${localTree}`);
  detail(`remote ${remoteHead} tree ${remoteTree} (${remote.localMode ? opts.localPath : `${opts.target}:${remote.repo}`})`);
  if (expectedTree !== localTree) detail(`expected tree ${expectedTree}`);

  stepHeader(2, 'build patch');
  let patchPath;
  if (opts.patch !== null) {
    statFile(opts.patch);
    patchPath = opts.patch;
    detail(`using provided patch ${patchPath}`);
  } else {
    const base = opts.base || remoteHead;
    if (run('git', ['cat-file', '-e', `${base}^{commit}`]).status !== 0) {
      throw new StepError('patch', `base ${base} is not present locally; run \`git fetch origin\` or pass --base <rev>`);
    }
    patchPath = path.join(os.tmpdir(), `anppt-release-${randomToken()}.patch`);
    context.generatedPatch = patchPath;
    const descriptor = fs.openSync(patchPath, 'w');
    let diffResult;
    try {
      diffResult = run('git', ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, localHead], {
        stdio: ['ignore', descriptor, 'pipe'],
      });
    } finally {
      fs.closeSync(descriptor);
    }
    if (diffResult.error) throw new StepError('patch', `git diff: ${diffResult.error.message}`);
    if (diffResult.status !== 0) throw new StepError('patch', `git diff ${base}..${localHead}: ${failureText(diffResult)}`);
    detail(`generated from base ${base}`);
  }

  const patchSize = statFile(patchPath).size;
  detail(`patch ${patchPath} bytes=${patchSize}`);

  if (patchSize === 0) {
    if (remoteTree === expectedTree) return { status: 'up-to-date' };
    throw new StepError('patch', `patch is empty but remote tree ${remoteTree} does not match expected tree ${expectedTree}`);
  }

  const patchSha = sha256File(patchPath);

  if (opts.dryRun) {
    stepHeader(3, 'checksum and upload');
    detail(`dry-run: skip upload (${patchPath} sha256 ${patchSha})`);
    stepHeader(4, 'apply patch and verify tree');
    detail('dry-run: skip apply');
    stepHeader(5, 'commit on remote history');
    detail('dry-run: skip commit');
    stepHeader(6, 'push to origin');
    detail('dry-run: skip push');
    stepHeader(7, 'deploy');
    detail('dry-run: skip deploy');
    return { status: 'dry-run', localHead, expectedTree };
  }

  stepHeader(3, 'checksum and upload');
  detail(`local sha256 ${patchSha}`);
  const patchName = `anppt-release-${randomToken()}.patch`;
  context.remotePatchPath = remote.localMode
    ? path.join(remote.repo, '.git', patchName)
    : `${remote.repo}/.git/${patchName}`;
  const remotePatchPath = context.remotePatchPath;

  let uploadVerified = false;
  let uploadProblem = '';
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      remote.upload(patchPath, remotePatchPath);
      const remoteSha = remote.hash(remotePatchPath);
      if (remoteSha === patchSha) {
        uploadVerified = true;
        break;
      }
      uploadProblem = `sha256 mismatch (local ${patchSha}, remote ${remoteSha})`;
    } catch (error) {
      uploadProblem = error instanceof Error ? error.message : String(error);
    }
    if (attempt < MAX_UPLOAD_ATTEMPTS) {
      console.error(`[release] upload: ${uploadProblem}; retrying (${attempt + 1}/${MAX_UPLOAD_ATTEMPTS})`);
      // Retries overwrite the same path, so a half-written copy is never reused.
      try {
        remote.remove(remotePatchPath);
      } catch {
        // The next upload replaces the file anyway.
      }
    }
  }
  if (!uploadVerified) {
    throw new StepError('upload', `patch did not verify after ${MAX_UPLOAD_ATTEMPTS} attempts: ${uploadProblem}`);
  }
  detail(`uploaded ${remotePatchPath} (sha256 verified)`);

  stepHeader(4, 'apply patch and verify tree');
  const checkResult = remote.gitResult(['apply', '--check', '--binary', remotePatchPath]);
  if (checkResult.error) throw new StepError('apply', `git apply --check: ${checkResult.error.message}`);
  if (checkResult.status !== 0) {
    throw new StepError('apply', `git apply --check failed: ${failureText(checkResult)}`);
  }
  const checkReported = reportedErrors(checkResult.stderr);
  if (checkReported) {
    throw new StepError('apply', `git apply --check reported errors without failing:\n${checkReported}`);
  }
  context.remoteMutated = true;
  const applyResult = remote.gitResult(['apply', '--binary', remotePatchPath]);
  if (applyResult.error) throw new StepError('apply', `git apply: ${applyResult.error.message}`);
  if (applyResult.status !== 0) {
    throw new StepError('apply', `git apply failed: ${failureText(applyResult)}`);
  }
  const applyReported = reportedErrors(applyResult.stderr);
  if (applyReported) {
    throw new StepError('apply', `git apply reported errors without failing:\n${applyReported}`);
  }
  remote.git(['add', '-A'], 'apply');
  const actualTree = remote.git(['write-tree'], 'tree').trim();
  if (actualTree !== expectedTree) {
    throw new StepError('tree', `resulting tree ${actualTree} does not match expected tree ${expectedTree}; refusing to commit and restoring the remote`);
  }
  detail(`tree ${actualTree} matches expected tree`);

  stepHeader(5, 'commit on remote history');
  let newSha = remoteHead;
  if (remoteHead === localHead) {
    detail('remote HEAD already equals local HEAD; skipping commit');
    remote.git(['reset', '--hard', remoteHead], 'commit');
  } else {
    const message = `release: ${localSubject.replace(/\s+/g, ' ').trim()}`;
    newSha = remote.git(['commit-tree', actualTree, '-p', remoteHead, '-m', message], 'commit').trim();
    if (context.branchExisted) {
      remote.git(['update-ref', branchRef, newSha, context.branchTipBefore], 'commit');
    } else {
      remote.git(['update-ref', branchRef, newSha], 'commit');
    }
    context.branchMoved = true;
    remote.git(['reset', '--hard', newSha], 'commit');
    const headAfter = remote.git(['rev-parse', '--verify', 'HEAD'], 'commit').trim();
    if (headAfter !== newSha) {
      throw new StepError('commit', `remote HEAD is ${headAfter} but expected ${newSha}`);
    }
    detail(`commit ${newSha} parent ${remoteHead}`);
  }

  stepHeader(6, 'push to origin');
  remote.git(['push', 'origin', opts.branch], 'push');
  detail(`pushed ${opts.branch} to origin`);

  stepHeader(7, 'deploy');
  if (remote.localMode) {
    detail('local target: deploy skipped');
  } else {
    const deployCommand = `sudo -n -u ubuntu ${DEPLOY_HELPER} ${shellQuote(opts.branch)}`;
    const deployResult = run('ssh', [...SSH_OPTIONS, opts.target, deployCommand], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (deployResult.error) throw new StepError('deploy', `ssh ${opts.target}: ${deployResult.error.message}`);
    if (deployResult.status !== 0) {
      throw new StepError('deploy', `${DEPLOY_HELPER} exited with code ${deployResult.status}`);
    }
    detail(`deployed ${opts.branch}`);
  }

  return { status: 'released', newSha, tree: actualTree, localHead, expectedTree };
}

function rollback(context) {
  const { remote } = context;
  console.error(`[release] rollback: restoring ${remote.repo} to ${context.remoteHead}`);
  let restored = true;
  const attempt = (action) => {
    try {
      action();
    } catch (error) {
      restored = false;
      console.error(`[release] rollback: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (context.branchMoved) {
    const branchRef = `refs/heads/${context.opts.branch}`;
    attempt(() => {
      if (context.branchExisted) remote.git(['update-ref', branchRef, context.branchTipBefore], 'rollback');
      else remote.git(['update-ref', '-d', branchRef], 'rollback');
    });
  }
  attempt(() => remote.git(['reset', '--hard', context.remoteHead], 'rollback'));
  attempt(() => remote.git(['clean', '-fd'], 'rollback'));
  if (restored) console.error(`[release] rollback: remote is at ${context.remoteHead} with a clean working tree`);
}

function cleanup(context) {
  const { remote, remotePatchPath, generatedPatch } = context;
  if (remote && remotePatchPath) {
    try {
      remote.remove(remotePatchPath);
    } catch (error) {
      console.error(`[release] cleanup: could not remove remote patch ${remotePatchPath}: ${error.message}`);
    }
  }
  if (generatedPatch) {
    try {
      fs.rmSync(generatedPatch, { force: true });
    } catch (error) {
      console.error(`[release] cleanup: could not remove ${generatedPatch}: ${error.message}`);
    }
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[release] args: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const context = {
    opts,
    remote: null,
    remoteHead: null,
    remotePatchPath: null,
    generatedPatch: null,
    remoteMutated: false,
    branchMoved: false,
    branchExisted: false,
    branchTipBefore: null,
  };

  try {
    const result = release(context);
    cleanup(context);
    if (result.status === 'up-to-date') {
      console.log('already up to date');
      return;
    }
    if (result.status === 'dry-run') {
      console.log(`dry-run ok: would release local ${result.localHead} (tree ${result.expectedTree})`);
      return;
    }
    console.log(`released ${result.newSha} tree=${result.tree}`);
  } catch (error) {
    const step = error instanceof StepError ? error.step : 'internal';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release] ${step}: ${message}`);
    if (context.remoteMutated) rollback(context);
    cleanup(context);
    process.exitCode = 1;
  }
}

main();
