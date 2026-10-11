// 问题日志：结构化落盘（JSONL，按天一个文件）+ 管理后台读取。
// 写入端全函数 try/catch 静默兜底——日志失败绝不影响业务；同时保留一行 console 输出，
// 让 journalctl 运维视角仍然可见（前缀 [anppt-v2][problem][category]）。
// 文件位置：<ANPPT_V2_DATA_DIR>/logs/problems-YYYY-MM-DD.jsonl（可用 ANPPT_V2_PROBLEM_LOG_DIR 覆盖整个目录）。
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

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

/** JSONL 行结构；detail/userId/refType/refId 恒为字符串（无值时空串），字段固定便于后台表格展示。 */
export interface ProblemRecord {
  ts: number;
  level: ProblemLevel;
  category: string;
  message: string;
  detail: string;
  userId: string;
  refType: string;
  refId: string;
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
const FILE_RE = /^problems-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
// 上游错误体可能回显 Authorization；落盘前统一打码
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

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

/** Error/对象/任意值 → 单行脱敏文本（越界截断） */
function normalizeText(value: unknown, max: number): string {
  let text = '';
  if (value instanceof Error) {
    text = value.stack || value.message || String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else if (value === undefined || value === null) {
    text = '';
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.replace(BEARER_VALUE, 'Bearer [REDACTED]').replace(/\s+/g, ' ').trim().slice(0, max);
}

function optionalId(value: unknown): string {
  return trim(value).replace(/[\r\n\0]/g, '').slice(0, MAX_ID_CHARS);
}

/** 写入一条问题记录；绝不抛出。 */
export function logProblem(entry: ProblemEntry): void {
  try {
    const level: ProblemLevel = entry?.level === 'warn' ? 'warn' : 'error';
    const category = normalizeText(entry?.category, 40) || 'general';
    const message = normalizeText(entry?.message, MAX_MESSAGE_CHARS) || '(无消息)';
    const record: ProblemRecord = {
      ts: Date.now(),
      level,
      category,
      message,
      detail: normalizeText(entry?.detail, MAX_DETAIL_CHARS),
      userId: optionalId(entry?.userId),
      refType: optionalId(entry?.refType),
      refId: optionalId(entry?.refId),
    };
    const line = `[anppt-v2][problem][${category}] ${message}`;
    if (level === 'warn') console.warn(line);
    else console.error(line);
    const dir = problemLogDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `problems-${dayKey(new Date())}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
    cleanupOldFiles(dir);
  } catch {
    // 日志落盘失败静默兜底：问题日志绝不影响业务
  }
}

/** 机会式清理：删除目录内早于 14 天的 problems-*.jsonl（best effort，失败忽略） */
function cleanupOldFiles(dir: string): void {
  try {
    const cutoff = startOfDay(new Date());
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    for (const name of readdirSync(dir)) {
      const match = FILE_RE.exec(name);
      if (!match) continue;
      const fileDay = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (fileDay.getTime() < cutoff.getTime()) rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // best effort：清理失败不影响写入
  }
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
  };
}

/** 读取最近若干天的问题（含今天），倒序返回；坏行跳过，单次最多解析 3000 行。 */
export function readProblems(options: ReadProblemsOptions = {}): { items: ProblemRecord[] } {
  const days = clampInt(options.days, 1, MAX_READ_DAYS, DEFAULT_READ_DAYS);
  const limit = clampInt(options.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = clampInt(options.offset, 0, 1_000_000, 0);
  const category = trim(options.category);
  const level = options.level === 'warn' || options.level === 'error' ? options.level : '';
  const items: ProblemRecord[] = [];
  let parsedLines = 0;
  try {
    const dir = problemLogDir();
    const today = startOfDay(new Date());
    outer: for (let i = 0; i < days; i += 1) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      let content = '';
      try {
        content = readFileSync(path.join(dir, `problems-${dayKey(day)}.jsonl`), 'utf8');
      } catch {
        continue; // 当天没有文件（或不可读）属正常情况
      }
      const lines = content.split('\n');
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const raw = lines[j].trim();
        if (!raw) continue;
        if (parsedLines >= MAX_PARSE_LINES) break outer;
        parsedLines += 1;
        const item = parseLine(raw);
        if (!item) continue; // 坏行跳过
        if (category && item.category !== category) continue;
        if (level && item.level !== level) continue;
        items.push(item);
      }
    }
  } catch {
    // 目录整体不可读时返回已收集结果，查询页不因此报错
  }
  items.sort((a, b) => b.ts - a.ts);
  return { items: items.slice(offset, offset + limit) };
}
