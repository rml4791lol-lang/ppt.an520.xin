import { readFileSync } from 'node:fs';
import path from 'node:path';

let cachedRelease: string | undefined;

function clean(value: string | undefined): string {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80);
}

export function releaseId(): string {
  if (cachedRelease !== undefined) return cachedRelease;
  const configured = clean(process.env.ANPPT_V2_RELEASE);
  if (configured) return (cachedRelease = configured);
  if (process.env.NODE_ENV !== 'production') return (cachedRelease = 'dev');
  try {
    const commit = clean(readFileSync(path.join(process.cwd(), '.deploy-commit'), 'utf8'));
    if (commit) return (cachedRelease = commit);
  } catch {
    // Local production builds have no .deploy-commit; use the generated build id below.
  }
  try {
    const buildId = clean(readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8'));
    if (buildId) return (cachedRelease = `build:${buildId}`);
  } catch {
    // Release metadata is diagnostic only; never block startup when it is unavailable.
  }
  return (cachedRelease = 'unknown');
}
