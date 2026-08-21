// 文件落盘与 /api/files 读取的安全解析。
// 目录约定：{root}/{userId}/...，读取路由强制第二段 == session 用户 id，天然隔离。
import { mkdirSync } from 'node:fs';
import { writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../http';
import { getGenerationConfig, type GenerationConfig } from './config';
import { genId } from './db';

export const FILE_ROOTS = ['uploads', 'generated', 'exports'] as const;
export type FileRoot = (typeof FILE_ROOTS)[number];

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

export function rootDir(root: FileRoot, config: GenerationConfig = getGenerationConfig()): string {
  if (root === 'uploads') return config.uploadsDir;
  if (root === 'generated') return config.generatedDir;
  return config.exportsDir;
}

function cleanSegment(value: unknown, label: string): string {
  const segment = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(segment)) {
    throw new ApiError('VALIDATION_ERROR', `${label} 不合法`, 400, false);
  }
  return segment;
}

export function extForFile(name: string, mime: string): string {
  const fromMime = EXT_BY_MIME[String(mime || '').toLowerCase()];
  if (fromMime) return fromMime;
  const ext = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
}

export function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 落盘并返回 { relPath, url, absPath }。relPath 形如 uploads/{userId}/{kind}/{id}.png */
export async function saveFile(
  root: FileRoot,
  userId: string,
  data: Buffer,
  opts: { kind?: string; ext?: string; id?: string } = {},
  config: GenerationConfig = getGenerationConfig(),
): Promise<{ relPath: string; url: string; absPath: string }> {
  const uid = cleanSegment(userId, '用户标识');
  const kind = opts.kind ? cleanSegment(opts.kind, 'kind') : '';
  const id = opts.id ? cleanSegment(opts.id, '文件 id') : genId('file');
  const ext = (opts.ext || '.bin').toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) throw new ApiError('VALIDATION_ERROR', '文件扩展名不合法', 400, false);
  const relParts = [root, uid, ...(kind ? [kind] : []), `${id}${ext}`];
  const absPath = path.join(rootDir(root, config), ...relParts.slice(1));
  await mkdirSync(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, data);
  const relPath = relParts.join('/');
  return { relPath, url: `/api/files/${relPath}`, absPath };
}

/**
 * 解析 /api/files/{path...} 为安全的绝对路径。
 * 强制：首段为合法 root、第二段 == ownerUserId、无越界（..）。
 */
export function resolveFilePath(
  segments: string[],
  ownerUserId: string,
  config: GenerationConfig = getGenerationConfig(),
): { absPath: string; root: FileRoot } {
  const decoded = segments.map((segment) => {
    let value = segment;
    try {
      value = decodeURIComponent(segment);
    } catch {
      // keep raw
    }
    return value;
  });
  if (decoded.length < 2) throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);
  const root = decoded[0] as FileRoot;
  if (!(FILE_ROOTS as readonly string[]).includes(root)) {
    throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);
  }
  if (decoded[1] !== ownerUserId) throw new ApiError('FILE_FORBIDDEN', '无权访问该文件', 403, false);
  if (decoded.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);
  }
  const base = path.resolve(rootDir(root, config));
  const absPath = path.resolve(base, ...decoded.slice(1));
  if (absPath !== base && !absPath.startsWith(base + path.sep)) {
    throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);
  }
  return { absPath, root };
}

export async function readResolvedFile(absPath: string): Promise<{ data: Buffer; size: number }> {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);
  }
  if (!info.isFile()) throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);
  const data = await readFile(absPath);
  return { data, size: info.size };
}

/** 相对路径（/api/files/URL 或裸 rel）→ 安全绝对路径；不合法返回 null（不读盘） */
export function absPathForRelPath(
  relPathOrUrl: string,
  config: GenerationConfig = getGenerationConfig(),
): string | null {
  const rel = String(relPathOrUrl || '').replace(/^\/api\/files\//, '').replace(/^\/+/, '');
  const segments = rel.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const root = segments[0] as FileRoot;
  if (!(FILE_ROOTS as readonly string[]).includes(root)) return null;
  const base = path.resolve(rootDir(root, config));
  const absPath = path.resolve(base, ...segments.slice(1));
  return absPath.startsWith(base + path.sep) ? absPath : null;
}

/** 读取站内文件（/api/files/... 或裸相对路径）为 Buffer；不存在返回 null */
export async function readSiteFile(
  relPathOrUrl: string,
  config: GenerationConfig = getGenerationConfig(),
): Promise<Buffer | null> {
  const absPath = absPathForRelPath(relPathOrUrl, config);
  if (!absPath) return null;
  try {
    return await readFile(/* turbopackIgnore: true */ absPath);
  } catch {
    return null;
  }
}
