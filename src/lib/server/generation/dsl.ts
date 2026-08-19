// 内容梳理 tagged-text DSL（契约 §3.2 冻结 v1）。
// 标签集：【标题】【注释】【区域：xx】【模块标题】【正文】【重点正文】【数据】【数据组】
// 【行头】【表头】【表格】（表格用 markdown 管道行）。
// 服务端校验：标签合法、表格配平、数据与 rawText 保真 diff。
// 标签集任何增删改 = 契约版本升级，先改契约再改这里。

export const DSL_TAGS = [
  '标题',
  '注释',
  '区域',
  '模块标题',
  '正文',
  '重点正文',
  '数据',
  '数据组',
  '行头',
  '表头',
  '表格',
] as const;

export type DslTag = (typeof DSL_TAGS)[number];

export interface DslBlock {
  tag: DslTag;
  /** 区域标签的参数（【区域：xx】的 xx），其余标签为空串 */
  arg: string;
  /** 标签行之后的随行内容 */
  content: string;
  /** 【表格】块内的 markdown 管道行 */
  tableRows: string[];
  lineNo: number;
}

const TAG_LINE_RE = /^【([^】]*)】(.*)$/;

export function parseTaggedDsl(text: string): { blocks: DslBlock[]; errors: string[] } {
  const blocks: DslBlock[] = [];
  const errors: string[] = [];
  const lines = String(text || '').split(/\r?\n/);
  let current: DslBlock | null = null;
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const match = line.match(TAG_LINE_RE);
    if (match) {
      const rawTag = match[1].trim();
      const content = match[2].trim();
      const [name, arg = ''] = rawTag.split(/[:：]/).map((part) => part.trim());
      if (!(DSL_TAGS as readonly string[]).includes(name)) {
        errors.push(`第 ${index + 1} 行：未知标签【${rawTag}】，合法标签集：${DSL_TAGS.map((t) => `【${t}】`).join('')}`);
        return;
      }
      if (name === '区域' && !arg) {
        errors.push(`第 ${index + 1} 行：【区域：xx】必须带区域名`);
        return;
      }
      if (name !== '区域' && arg) {
        errors.push(`第 ${index + 1} 行：【${name}】不接受「：参数」写法`);
        return;
      }
      current = { tag: name as DslTag, arg, content, tableRows: [], lineNo: index + 1 };
      blocks.push(current);
      return;
    }
    // 非标签行：只允许作为表格块内的 markdown 管道行
    if (/^\|.*\|$/.test(line)) {
      if (!current || current.tag !== '表格') {
        errors.push(`第 ${index + 1} 行：管道行只能出现在【表格】块内`);
        return;
      }
      current.tableRows.push(line);
      return;
    }
    errors.push(`第 ${index + 1} 行：内容行必须以标签开头（如【正文】）`);
  });
  return { blocks, errors };
}

function tableColumnCount(row: string): number {
  // 去掉首尾的 | 后按 | 分列
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|').length;
}

function isTableDividerRow(row: string): boolean {
  return /^\|[\s:|-]+\|$/.test(row);
}

/** 表格配平：每个【表格】块内所有管道行列数一致，且至少 1 行数据 */
export function validateTables(blocks: DslBlock[]): string[] {
  const errors: string[] = [];
  for (const block of blocks) {
    if (block.tag !== '表格') continue;
    if (block.tableRows.length < 2) {
      errors.push(`第 ${block.lineNo} 行：【表格】至少需要表头行与一行数据`);
      continue;
    }
    const widths = block.tableRows.map(tableColumnCount);
    if (new Set(widths).size !== 1) {
      errors.push(`第 ${block.lineNo} 行：【表格】列数不配平（${widths.join('/')} 列）`);
    }
    if (!block.tableRows.some(isTableDividerRow)) {
      errors.push(`第 ${block.lineNo} 行：【表格】缺少 markdown 分隔行（|---|---|）`);
    }
  }
  return errors;
}

/** 数字保真：【数据】【数据组】【表格】中出现的数字必须能在 rawText 中找到（允许去掉千分位逗号） */
export function diffDataFidelity(blocks: DslBlock[], rawText: string): string[] {
  const source = String(rawText || '');
  if (!source) return [];
  const normalizedSource = source.replace(/,/g, '');
  const errors: string[] = [];
  const numberRe = /\d+(?:\.\d+)?%?/g;
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.tag !== '数据' && block.tag !== '数据组' && block.tag !== '表格') continue;
    const haystack = [block.content, ...block.tableRows].join('\n');
    for (const match of haystack.matchAll(numberRe)) {
      const token = match[0];
      if (seen.has(token)) continue;
      seen.add(token);
      const plain = token.replace(/,/g, '');
      if (!source.includes(token) && !normalizedSource.includes(plain)) {
        errors.push(`第 ${block.lineNo} 行：数字「${token}」在原文 rawText 中找不到（数据保真校验未过）`);
      }
    }
  }
  return errors;
}

export interface DslValidationResult {
  ok: boolean;
  errors: string[];
  blocks: DslBlock[];
}

export function validateTaggedDsl(text: string, opts: { rawText?: string } = {}): DslValidationResult {
  const { blocks, errors } = parseTaggedDsl(text);
  if (blocks.length === 0 && errors.length === 0) {
    errors.push('内容为空：至少需要一行带标签的内容');
  }
  errors.push(...validateTables(blocks));
  if (opts.rawText) errors.push(...diffDataFidelity(blocks, opts.rawText));
  return { ok: errors.length === 0, errors, blocks };
}

export const DSL_TAG_SET_TEXT = DSL_TAGS.map((tag) =>
  tag === '区域' ? '【区域：xx】' : `【${tag}】`,
).join(' ');

/** 从 tagged DSL 提取纯文案段（喂生图 prompt 用） */
export function extractCopyFromDsl(text: string): { title: string; lines: string[] } {
  const { blocks } = parseTaggedDsl(text);
  let title = '';
  const lines: string[] = [];
  for (const block of blocks) {
    const pieces: string[] = [];
    if (block.content) pieces.push(block.content);
    if (block.tableRows.length > 0) {
      pieces.push(
        block.tableRows
          .filter((row) => !isTableDividerRow(row))
          .map((row) =>
            row
              .replace(/^\|/, '')
              .replace(/\|$/, '')
              .split('|')
              .map((cell) => cell.trim())
              .join(' · '),
          )
          .join('\n'),
      );
    }
    const text2 = pieces.filter(Boolean).join('\n').trim();
    if (!text2) continue;
    if (block.tag === '标题' && !title) {
      title = text2;
      continue;
    }
    const prefix =
      block.tag === '模块标题' ? '' : block.tag === '区域' ? `（${block.arg}）` : '';
    lines.push(prefix ? `${prefix}${text2}` : text2);
  }
  return { title, lines };
}
