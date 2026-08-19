// 内容梳理 tagged DSL 的浏览器端轻解析（只解析不校验，渲染用）。
// 语法与 src/lib/server/generation/dsl.ts 对齐（契约 §3.2 冻结 v1）：
// 【标题】【注释】【区域：xx】【模块标题】【正文】【重点正文】【数据】【数据组】【行头】【表头】【表格】
// 【表格】块内为 markdown 管道行。

export const DSL_TAGS = [
  "标题",
  "注释",
  "区域",
  "模块标题",
  "正文",
  "重点正文",
  "数据",
  "数据组",
  "行头",
  "表头",
  "表格",
] as const;

export type DslTag = (typeof DSL_TAGS)[number];

export interface DslBlock {
  tag: DslTag;
  /** 【区域：xx】的参数，其余标签为空串 */
  arg: string;
  /** 标签行随行内容 */
  content: string;
  /** 【表格】块内的 markdown 管道行（含分隔行） */
  tableRows: string[];
  lineNo: number;
}

const TAG_LINE_RE = /^【([^】]*)】(.*)$/;

export function parseDsl(text: string): { blocks: DslBlock[]; errors: string[] } {
  const blocks: DslBlock[] = [];
  const errors: string[] = [];
  const lines = String(text || "").split(/\r?\n/);
  let current: DslBlock | null = null;
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const match = line.match(TAG_LINE_RE);
    if (match) {
      const rawTag = match[1].trim();
      const content = match[2].trim();
      const [name, arg = ""] = rawTag.split(/[:：]/).map((part) => part.trim());
      if (!(DSL_TAGS as readonly string[]).includes(name)) {
        errors.push(`第 ${index + 1} 行：未知标签【${rawTag}】`);
        return;
      }
      current = { tag: name as DslTag, arg, content, tableRows: [], lineNo: index + 1 };
      blocks.push(current);
      return;
    }
    if (/^\|.*\|$/.test(line) && current?.tag === "表格") {
      current.tableRows.push(line);
      return;
    }
    errors.push(`第 ${index + 1} 行：无法识别的内容行`);
  });
  return { blocks, errors };
}

/** markdown 管道行 → 单元格数组 */
export function tableRowCells(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function isTableDividerRow(row: string): boolean {
  return /^\|[\s:|-]+\|$/.test(row);
}

/**
 * 把平铺 block 列表组装成模块树，便于按「区域 → 模块」分组渲染：
 * - 标题/注释挂在树根；
 * - 【区域：xx】开启一个区域分组；
 * - 【模块标题】开启一个模块，后续正文/数据/表格归入该模块。
 */
export interface DslModule {
  heading: string;
  blocks: DslBlock[];
}

export interface DslRegion {
  name: string;
  modules: DslModule[];
}

export interface DslTree {
  title: string;
  annotation: string;
  /** 不属于任何区域的松散模块（含标题前内容） */
  looseModules: DslModule[];
  regions: DslRegion[];
}

export function groupDsl(blocks: DslBlock[]): DslTree {
  const tree: DslTree = { title: "", annotation: "", looseModules: [], regions: [] };
  let currentRegion: DslRegion | null = null;
  let currentModule: DslModule | null = null;

  const pushBlock = (block: DslBlock) => {
    if (!currentModule) {
      currentModule = { heading: "", blocks: [] };
      (currentRegion ? currentRegion.modules : tree.looseModules).push(currentModule);
    }
    currentModule.blocks.push(block);
  };

  for (const block of blocks) {
    if (block.tag === "标题") {
      if (!tree.title) tree.title = block.content;
      else pushBlock(block);
      continue;
    }
    if (block.tag === "注释") {
      tree.annotation = tree.annotation ? `${tree.annotation}\n${block.content}` : block.content;
      continue;
    }
    if (block.tag === "区域") {
      currentRegion = { name: block.arg || block.content, modules: [] };
      tree.regions.push(currentRegion);
      currentModule = null;
      continue;
    }
    if (block.tag === "模块标题") {
      currentModule = { heading: block.content, blocks: [] };
      (currentRegion ? currentRegion.modules : tree.looseModules).push(currentModule);
      continue;
    }
    pushBlock(block);
  }
  // 去掉完全空的模块
  tree.looseModules = tree.looseModules.filter((m) => m.heading || m.blocks.length > 0);
  for (const region of tree.regions) {
    region.modules = region.modules.filter((m) => m.heading || m.blocks.length > 0);
  }
  return tree;
}
