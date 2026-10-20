#!/usr/bin/env node
// Verify the production health contract after deployment. Accepts a URL or JSON on stdin.
import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(`health verification failed: ${message}`);
  process.exit(1);
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    fail('response is not valid JSON');
  }
}

const [url, releaseArg] = process.argv.slice(2);
const expectedRelease = (process.env.EXPECTED_RELEASE || releaseArg || '').trim();
let payload;

if (url) {
  let response;
  try {
    response = await fetch(url, { headers: { 'user-agent': 'anppt-deploy-verifier' } });
  } catch (error) {
    fail(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`HTTP ${response.status}`);
  payload = parseJson(await response.text());
} else {
  payload = parseJson(readFileSync(0, 'utf8'));
}

if (!payload || typeof payload !== 'object') fail('empty response');
if (payload.ok !== true) fail('ok !== true');
if (payload.service !== 'anppt-v2') fail(`unexpected service: ${payload.service || 'missing'}`);
if (payload.db !== true) fail('db !== true');
if (payload.logging?.ok !== true) fail('logging.ok !== true');
if (!payload.logging?.writable) fail('logging.writable !== true');
if (expectedRelease && payload.release !== expectedRelease) {
  fail(`release mismatch: expected ${expectedRelease}, got ${payload.release || 'missing'}`);
}

console.log(`health ok release=${payload.release || 'unknown'} loggingFiles=${payload.logging.fileCount ?? '?'}`);
