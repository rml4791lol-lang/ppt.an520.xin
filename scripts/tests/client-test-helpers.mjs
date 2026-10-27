// 纯客户端测试的共享夹具：信封响应、mock fetch、源码读取。
// 只被 scripts/test-*.mjs 显式 import，不是独立测试文件。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(status, error) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function captureFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function walkSourceFiles(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSourceFiles(full, output);
    else if (/\.(ts|tsx)$/.test(entry)) output.push(full);
  }
  return output;
}

export function source(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}
