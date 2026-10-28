// 两套测试套件共用一把跨工作树的文件锁。
// 背景：2026-10-27 四个工作树并发跑测试时出现过一次假红（重复上传相同内容复用成功结果且不扣星），
// 单独重跑三次全绿。锁放在 os.tmpdir()，所以不同 worktree / 会话也会排队，而不是互相干扰。
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

const LOCK_DIR = path.join(tmpdir(), 'anppt-v2-test-suite.lock');
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json');
const OWNERLESS_STALE_MS = 30_000;
const RUN_STALE_MS = 2 * 60 * 60 * 1000;
const WAIT_NOTICE_MS = 5_000;

let held = false;
let listenersInstalled = false;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner() {
  try {
    return JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function staleReason(owner) {
  if (!owner) {
    try {
      const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
      return age > OWNERLESS_STALE_MS ? `锁目录无 owner 信息已 ${Math.round(age / 1000)}s` : '';
    } catch {
      return '锁目录已不存在';
    }
  }
  if (owner.hostname === hostname() && !pidAlive(owner.pid)) {
    return `持有者 pid ${owner.pid} 已退出`;
  }
  const started = Date.parse(owner.startedAt || '');
  if (Number.isFinite(started) && Date.now() - started > RUN_STALE_MS) {
    return `持有者已运行 ${Math.round((Date.now() - started) / 60000)} 分钟（疑似挂死）`;
  }
  return '';
}

function installCleanup() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  process.on('exit', releaseTestLock);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(signal, () => {
      releaseTestLock();
      process.exit(code);
    });
  }
}

export function acquireTestLock(label) {
  const startedAt = Date.now();
  let nextNotice = startedAt;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner();
    const stale = staleReason(owner);
    if (stale) {
      console.log(`⚠ 清理陈旧测试锁：${stale}`);
      rmSync(LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= nextNotice) {
      nextNotice = Date.now() + WAIT_NOTICE_MS;
      const who = owner
        ? `${owner.label || '未知套件'} (pid ${owner.pid}${owner.cwd ? `, ${owner.cwd}` : ''})`
        : '另一个测试进程';
      console.log(`⏳ ${label} 等待测试锁：${who} 正在跑，已等 ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
    sleepSync(250);
  }
  held = true;
  writeFileSync(
    OWNER_FILE,
    `${JSON.stringify({ pid: process.pid, hostname: hostname(), label, cwd: process.cwd(), startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  installCleanup();
  const waited = Date.now() - startedAt;
  if (waited > 500) console.log(`🔒 ${label} 取得测试锁（等待 ${(waited / 1000).toFixed(1)}s）`);
}

export function releaseTestLock() {
  if (!held) return;
  held = false;
  rmSync(LOCK_DIR, { recursive: true, force: true });
}
