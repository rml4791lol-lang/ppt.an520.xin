// 问题日志：结构化落盘（JSONL，按天一个文件，超大时按序号滚动）+ 管理后台读取。
// 写入端全函数 try/catch 兜底——日志失败绝不影响业务；同时保留一行 console 输出，
// 让 journalctl 运维视角仍然可见（前缀 [anppt-v2][problem][category]）。
// 文件位置：<ANPPT_V2_DATA_DIR>/logs/problems-YYYY-MM-DD[.N].jsonl（可用 ANPPT_V2_PROBLEM_LOG_DIR 覆盖整个目录）。
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { releaseId } from './release-info';
import { getRequestContext } from './request-context';

export type ProblemLevel = 'error' | 'warn';

export interface ProblemEntry {
  category: string;
  level: ProblemLevel;
  message: string;
  detail?: unknown;
  userId?: string;
  refType?: string;
  refId?: string;
}

/** JSONL 行结构；旧文件缺少的新字段读取时回退为空串，保证滚动发布可混读。 */
export interface ProblemRecord {
  ts: number;
  level: ProblemLevel;
  category: string;
  message: string;
  detail: string;
  userId: string;
  refType: string;
  refId: string;
  eventId: string;
  requestId: string;
  method: string;
  route: string;
  release: string;
}

// 选项来自 query string（不可信输入），一律接收 unknown 后内部归一
export interface ReadProblemsOptions {
  /** 读取最近若干天（含今天），默认 3，上限 14 */
  days?: unknown;
  category?: unknown;
  level?: unknown;
  /** 默认 200，上限 500 */
  limit?: unknown;
  offset?: unknown;
}

export interface ReadProblemsResult {
  items: ProblemRecord[];
  categories: string[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  scanLimited: boolean;
}

export interface ProblemLogHealth {
  ok: boolean;
  writable: boolean;
  directoryReady: boolean;
  fileCount: number;
  totalBytes: number;
  retentionDays: number;
  maxTotalBytes: number;
  writeFailures: number;
  lastWriteAt: number;
  lastFailureAt: number;
  recentFailure: boolean;
  lastProbeAt: number;
}

interface ProblemFile {
  name: string;
  path: string;
  day: string;
  dayTime: number;
  segment: number;
  size: number;
}

const RETENTION_DAYS = 14;
const MAX_READ_DAYS = 14;
const DEFAULT_READ_DAYS = 3;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
// 单次读取最多解析的行数（跨文件累计，从最新一天往前），防日志文件异常膨胀拖垮后台查询
const MAX_PARSE_LINES = 3000;
const MAX_MESSAGE_CHARS = 500;
const MAX_DETAIL_CHARS = 4000;
const MAX_ID_CHARS = 120;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const CLEANUP_TARGET_BYTES = 80 * 1024 * 1024;
const MAX_DAILY_SEGMENTS = 100;
const PROBE_INTERVAL_MS = 60_000;
const FILE_RE = /^problems-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;
// 上游错误体可能回显令牌、Cookie 或请求参数；落盘前统一打码
const SENSITIVE_KEY = /(secret|password|passwd|token|api.?key|authorization|cookie|credential|private.?key|session(?:id|token)?|otp|verification.?code)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|private[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SECRET_QUERY = /([?&](?:token|key|secret|password|code|otp)=)[^&\s]+/gi;

let lastWriteAt = 0;
let writeFailures = 0;
let lastFailureAt = 0;
let lastProbeAt = 0;
let lastProbeDir = '';
let probeOk = false;
let probeWritable = false;
let probeDirectoryReady = false;

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function problemLogDir(): string {
  const override = trim(process.env.ANPPT_V2_PROBLEM_LOG_DIR);
  if (override) return override;
  const dataDir = trim(process.env.ANPPT_V2_DATA_DIR) || path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'logs');
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function redactText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(AUTH_HEADER, '$1: [REDACTED]')
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`)
    .replace(SECRET_QUERY, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value, 8000);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message, 2000),
      stack: redactText(value.stack || '', 8000),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1);
    }
    return output;
  }
  return redactText(value, 200);
}

function normalizeText(value: unknown, max: number): string {
  if (typeof value === 'string') return redactText(value, max);
  if (value instanceof Error) return redactText(value.stack || value.message || String(value), max);
  try {
    return redactText(JSON.stringify(sanitizeValue(value)), max);
  } catch {
    return redactText(value, max);
  }
}

function optionalId(value: unknown): string {
  return trim(value).replace(/[\r\n\0]/g, '').slice(0, MAX_ID_CHARS);
}

function parseProblemFile(name: string, dir: string): ProblemFile | null {
  const match = FILE_RE.exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const filePath = path.join(dir, name);
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      name,
      path: filePath,
      day: `${match[1]}-${match[2]}-${match[3]}`,
      dayTime: startOfDay(date).getTime(),
      segment: Number(match[4] || 0),
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function listProblemFiles(dir: string): ProblemFile[] {
  try {
    return readdirSync(dir)
      .map((name) => parseProblemFile(name, dir))
      .filter((file): file is ProblemFile => Boolean(file))
      .sort((a, b) => a.dayTime - b.dayTime || a.segment - b.segment);
  } catch {
    return [];
  }
}

function recordFailure(context: string, error: unknown): void {
  writeFailures += 1;
  lastFailureAt = Date.now();
  const message = redactText(error instanceof Error ? error.message : error, 240) || 'unknown error';
  try {
    console.error(`[anppt-v2][problem-log] ${context}: ${message}`);
  } catch {
    // stderr failure must not escape the logging path
  }
}

function appendProblemLine(dir: string, now: Date, line: string): void {
  const key = dayKey(now);
  const lineBytes = Buffer.byteLength(line, 'utf8');
  const todayBytes = listProblemFiles(dir)
    .filter((file) => file.day === key)
    .reduce((sum, file) => sum + file.size, 0);
  if (todayBytes + lineBytes > MAX_TOTAL_BYTES) {
    throw new Error('problem log daily byte limit reached');
  }
  for (let segment = 0; segment < MAX_DAILY_SEGMENTS; segment += 1) {
    const name = segment === 0 ? `problems-${key}.jsonl` : `problems-${key}.${segment}.jsonl`;
    const filePath = path.join(dir, name);
    try {
      if (statSync(filePath).size >= MAX_FILE_BYTES) continue;
    } catch {
      // Missing file is the normal first-write path.
    }
    appendFileSync(filePath, line, 'utf8');
    return;
  }
  throw new Error('problem log daily segment limit reached');
}

/** 机会式清理：保留 14 天，并在总量超 100MiB 时从最旧文件删到 80MiB 以下。 */
function cleanupOldFiles(dir: string, now: Date): void {
  const cutoff = startOfDay(now);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  let files = listProblemFiles(dir);
  for (const file of files) {
    if (file.dayTime < cutoff.getTime()) rmSync(file.path, { force: true });
  }
  files = listProblemFiles(dir);
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= MAX_TOTAL_BYTES) return;
  const today = startOfDay(now).getTime();
  for (const file of files) {
    if (totalBytes <= CLEANUP_TARGET_BYTES) break;
    if (file.dayTime >= today) continue;
    rmSync(file.path, { force: true });
    totalBytes -= file.size;
  }
}

function probeProblemLogStorage(dir: string, now: number, force: boolean): void {
  if (!force && dir === lastProbeDir && now - lastProbeAt < PROBE_INTERVAL_MS) return;
  lastProbeDir = dir;
  lastProbeAt = now;
  probeDirectoryReady = false;
  probeWritable = false;
  probeOk = false;
  try {
    mkdirSync(dir, { recursive: true });
    probeDirectoryReady = true;
    const probePath = path.join(dir, `.health-${process.pid}-${now}.tmp`);
    writeFileSync(probePath, 'ok', 'utf8');
    probeWritable = true;
    probeOk = true;
    try {
      rmSync(probePath, { force: true });
    } catch {
      // Leftover probe files are hidden from the dashboard and harmless; writability is proven.
    }
  } catch (error) {
    recordFailure('health probe failed', error);
  }
}

/** 写入一条问题记录；绝不抛出。 */
export function logProblem(entry: ProblemEntry): void {
  try {
    const now = new Date();
    const context = getRequestContext();
    const level: ProblemLevel = entry?.level === 'warn' ? 'warn' : 'error';
    const category = normalizeText(entry?.category, 40) || 'general';
    const message = normalizeText(entry?.message, MAX_MESSAGE_CHARS) || '(无消息)';
    const record: ProblemRecord = {
      ts: now.getTime(),
      level,
      category,
      message,
      detail: normalizeText(entry?.detail, MAX_DETAIL_CHARS),
      userId: optionalId(entry?.userId),
      refType: optionalId(entry?.refType),
      refId: optionalId(entry?.refId),
      eventId: `evt_${now.getTime().toString(36)}_${randomBytes(5).toString('hex')}`,
      requestId: optionalId(context?.requestId),
      method: optionalId(context?.method),
      route: optionalId(context?.route),
      release: releaseId(),
    };
    const line = `[anppt-v2][problem][${category}] ${message}${record.requestId ? ` requestId=${record.requestId}` : ''}`;
    if (level === 'warn') console.warn(line);
    else console.error(line);
    const dir = problemLogDir();
    mkdirSync(dir, { recursive: true });
    cleanupOldFiles(dir, now);
    appendProblemLine(dir, now, `${JSON.stringify(record)}\n`);
    lastWriteAt = Date.now();
  } catch (error) {
    recordFailure('write failed', error);
  }
}

/** 当前日志落盘状态；60 秒内复用探测结果，force 可绕过缓存。 */
export function getProblemLogHealth(options: { force?: boolean } = {}): ProblemLogHealth {
  const dir = problemLogDir();
  const now = Date.now();
  probeProblemLogStorage(dir, now, options.force === true);
  const files = listProblemFiles(dir);
  return {
    ok: probeOk,
    writable: probeWritable,
    directoryReady: probeDirectoryReady,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    retentionDays: RETENTION_DAYS,
    maxTotalBytes: MAX_TOTAL_BYTES,
    writeFailures,
    lastWriteAt,
    lastFailureAt,
    recentFailure: lastFailureAt > 0 && now - lastFailureAt < 3_600_000,
    lastProbeAt,
  };
}

function parseLine(raw: string): ProblemRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const ts = Number(row.ts);
  const category = trim(row.category);
  const message = trim(row.message);
  if (!Number.isFinite(ts) || ts <= 0 || !category || !message) return null;
  return {
    ts,
    level: row.level === 'warn' ? 'warn' : 'error',
    category,
    message,
    detail: trim(row.detail),
    userId: trim(row.userId),
    refType: trim(row.refType),
    refId: trim(row.refId),
    eventId: trim(row.eventId),
    requestId: trim(row.requestId),
    method: trim(row.method),
    route: trim(row.route),
    release: trim(row.release),
  };
}

/** 读取最近若干天的问题（含今天），倒序返回；坏行跳过，单次最多解析 3000 行。 */
export function readProblems(options: ReadProblemsOptions = {}): ReadProblemsResult {
  const days = clampInt(options.days, 1, MAX_READ_DAYS, DEFAULT_READ_DAYS);
  const limit = clampInt(options.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = clampInt(options.offset, 0, 1_000_000, 0);
  const category = trim(options.category);
  const level = options.level === 'warn' || options.level === 'error' ? options.level : '';
  const items: ProblemRecord[] = [];
  const categoryCounts = new Map<string, number>();
  const dir = problemLogDir();
  let parsedLines = 0;
  let matched = 0;
  let scanLimited = false;
  const allFiles = listProblemFiles(dir);
  const today = startOfDay(new Date());
  outer: for (let i = 0; i < days; i += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = dayKey(day);
    const files = allFiles
      .filter((file) => file.day === key)
      .sort((a, b) => b.segment - a.segment);
    for (const file of files) {
      let content = '';
      try {
        content = readFileSync(file.path, 'utf8');
      } catch {
        continue; // A file can disappear between readdir and read during cleanup.
      }
      const lines = content.split('\n');
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const raw = lines[j].trim();
        if (!raw) continue;
        if (parsedLines >= MAX_PARSE_LINES) {
          scanLimited = true;
          break outer;
        }
        parsedLines += 1;
        const item = parseLine(raw);
        if (!item) continue;
        categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
        if (category && item.category !== category) continue;
        if (level && item.level !== level) continue;
        matched += 1;
        items.push(item);
      }
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  const page = items.slice(offset, offset + limit);
  const categories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  return {
    items: page,
    categories,
    total: matched,
    hasMore: matched > offset + page.length,
    nextOffset: offset + page.length,
    scanLimited,
  };
}
