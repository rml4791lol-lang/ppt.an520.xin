import { buildSessionCookie, requireUser } from './auth';
import { ApiError, jsonOk, toErrorResponse } from './http';
import { hasEverPaid } from './recharge';

export type OnlyOfficeArch = 'x64' | 'x86' | 'arm64';

export interface OnlyOfficeAsset {
  arch: OnlyOfficeArch;
  filename: string;
  size: number;
  sha256: string;
  url: string;
}

export interface OnlyOfficeRelease {
  version: string;
  publishedAt: string;
  assets: Record<OnlyOfficeArch, OnlyOfficeAsset>;
  source: 'github' | 'fallback';
}

interface GitHubAsset {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

interface ResolveOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  useCache?: boolean;
}

type DownloadOptions = ResolveOptions;

const RELEASE_API = 'https://api.github.com/repos/ONLYOFFICE/DesktopEditors/releases/latest';
const RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;
const RELEASE_TIMEOUT_MS = 8_000;
const ALLOWED_ARCHES = new Set<OnlyOfficeArch>(['x64', 'x86', 'arm64']);

const ASSET_FILENAMES: Record<OnlyOfficeArch, string> = {
  x64: 'DesktopEditors_x64.exe',
  x86: 'DesktopEditors_x86.exe',
  arm64: 'DesktopEditors_arm64.exe',
};

const FALLBACK_RELEASE: OnlyOfficeRelease = {
  version: '9.4.0',
  publishedAt: '2026-05-19T09:55:56Z',
  source: 'fallback',
  assets: {
    x64: {
      arch: 'x64',
      filename: 'DesktopEditors_x64.exe',
      size: 373_575_296,
      sha256: 'a3b4a7353946a2d836eadfb8f59799f98b906ab961421c05c0bee00be9307a9f',
      url: 'https://github.com/ONLYOFFICE/DesktopEditors/releases/download/v9.4.0/DesktopEditors_x64.exe',
    },
    x86: {
      arch: 'x86',
      filename: 'DesktopEditors_x86.exe',
      size: 351_950_968,
      sha256: '9c555431bf1dd5c68f0c6a2bf213027bb936e50752175120373a54565b56020f',
      url: 'https://github.com/ONLYOFFICE/DesktopEditors/releases/download/v9.4.0/DesktopEditors_x86.exe',
    },
    arm64: {
      arch: 'arm64',
      filename: 'DesktopEditors_arm64.exe',
      size: 339_981_432,
      sha256: '52c5650d516901265585a960aca5326599defdaa947092e8181779da570e9d34',
      url: 'https://github.com/ONLYOFFICE/DesktopEditors/releases/download/v9.4.0/DesktopEditors_arm64.exe',
    },
  },
};

let cachedRelease: { expiresAt: number; value: OnlyOfficeRelease } | null = null;
let inFlightRelease: Promise<OnlyOfficeRelease> | null = null;

function cloneRelease(release: OnlyOfficeRelease): OnlyOfficeRelease {
  return {
    ...release,
    assets: {
      x64: { ...release.assets.x64 },
      x86: { ...release.assets.x86 },
      arm64: { ...release.assets.arm64 },
    },
  };
}

function fallbackRelease(): OnlyOfficeRelease {
  return cloneRelease(FALLBACK_RELEASE);
}

export function parseOnlyOfficeArch(value: unknown): OnlyOfficeArch {
  const arch = String(value ?? '').trim().toLowerCase() as OnlyOfficeArch;
  if (!ALLOWED_ARCHES.has(arch)) {
    throw new ApiError('ONLYOFFICE_ARCH_INVALID', '不支持的 Windows 安装包版本', 400, false);
  }
  return arch;
}

export function isAllowedOnlyOfficeAssetUrl(value: unknown, expectedFilename: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return false;
    }
    const escapedFilename = expectedFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `^/ONLYOFFICE/DesktopEditors/releases/download/[^/]+/${escapedFilename}$`,
    ).test(url.pathname);
  } catch {
    return false;
  }
}

function parseVersion(value: unknown): string | null {
  const tag = typeof value === 'string' ? value.trim() : '';
  if (!/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(tag)) return null;
  return tag.replace(/^v/, '');
}

function parsePublishedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseAsset(raw: GitHubAsset, arch: OnlyOfficeArch): OnlyOfficeAsset | null {
  const filename = ASSET_FILENAMES[arch];
  if (raw.name !== filename) return null;
  const size = Number(raw.size);
  if (!Number.isSafeInteger(size) || size < 1_000_000 || size > 1_000_000_000) return null;
  if (!isAllowedOnlyOfficeAssetUrl(raw.browser_download_url, filename)) return null;
  const digest = typeof raw.digest === 'string' ? raw.digest.trim().toLowerCase() : '';
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return null;
  return {
    arch,
    filename,
    size,
    sha256: digest.slice('sha256:'.length),
    url: raw.browser_download_url,
  };
}

function parseGitHubRelease(raw: unknown): OnlyOfficeRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const release = raw as GitHubRelease;
  const version = parseVersion(release.tag_name);
  const publishedAt = parsePublishedAt(release.published_at);
  if (!version || !publishedAt || !Array.isArray(release.assets)) return null;

  const assets = release.assets.filter((asset): asset is GitHubAsset => Boolean(asset && typeof asset === 'object'));
  const x64 = assets.map((asset) => parseAsset(asset, 'x64')).find(Boolean);
  const x86 = assets.map((asset) => parseAsset(asset, 'x86')).find(Boolean);
  const arm64 = assets.map((asset) => parseAsset(asset, 'arm64')).find(Boolean);
  if (!x64 || !x86 || !arm64) return null;

  return { version, publishedAt, assets: { x64, x86, arm64 }, source: 'github' };
}

async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<OnlyOfficeRelease> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(RELEASE_API, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AnPPT-ONLYOFFICE-release-resolver',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return fallbackRelease();
    const parsed = parseGitHubRelease(await response.json().catch(() => null));
    return parsed ?? fallbackRelease();
  } catch {
    return fallbackRelease();
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveOnlyOfficeRelease(options: ResolveOptions = {}): Promise<OnlyOfficeRelease> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const useCache = options.useCache ?? options.fetchImpl == null;
  const timestamp = now();

  if (useCache && cachedRelease && cachedRelease.expiresAt > timestamp) {
    return cloneRelease(cachedRelease.value);
  }
  if (useCache && inFlightRelease) return cloneRelease(await inFlightRelease);

  const task = fetchLatestRelease(fetchImpl);
  if (useCache) inFlightRelease = task;
  try {
    const release = await task;
    if (useCache) cachedRelease = { expiresAt: timestamp + RELEASE_CACHE_MS, value: cloneRelease(release) };
    return cloneRelease(release);
  } finally {
    if (useCache) inFlightRelease = null;
  }
}

export async function getOnlyOfficeReleaseResponse(options: ResolveOptions = {}): Promise<Response> {
  try {
    const release = await resolveOnlyOfficeRelease(options);
    return jsonOk({
      version: release.version,
      publishedAt: release.publishedAt,
      assets: Object.fromEntries(
        Object.entries(release.assets).map(([arch, asset]) => [
          arch,
          { filename: asset.filename, size: asset.size, sha256: asset.sha256 },
        ]),
      ),
    }, { headers: { 'Cache-Control': 'public, max-age=900, stale-while-revalidate=21600' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function getOnlyOfficeDownloadResponse(
  request: Request,
  rawArch: unknown,
  options: DownloadOptions = {},
): Promise<Response> {
  try {
    const session = requireUser(request);
    if (!hasEverPaid(session.user.id)) {
      throw new ApiError(
        'MEMBER_BENEFIT_REQUIRED',
        '充值任意套餐后，可永久解锁三个 Windows 安装包与兼容服务',
        403,
        false,
      );
    }
    const arch = parseOnlyOfficeArch(rawArch);
    const release = await resolveOnlyOfficeRelease(options);
    const asset = release.assets[arch];
    if (!asset || !isAllowedOnlyOfficeAssetUrl(asset.url, ASSET_FILENAMES[arch])) {
      throw new ApiError('ONLYOFFICE_DOWNLOAD_UNAVAILABLE', '安装包暂时不可用，请稍后重试', 503, true);
    }
    return new Response(null, {
      status: 307,
      headers: {
        Location: asset.url,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-AnPPT-ONLYOFFICE-Version': release.version,
        ...(session.refreshed ? { 'Set-Cookie': buildSessionCookie(request, session.token) } : {}),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
