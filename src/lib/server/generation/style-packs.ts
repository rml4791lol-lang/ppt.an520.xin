// 风格包加载与生图 prompt 组装。
// 唯一对外风格库：src/data/style-packs.ts（旁门 27 包迁移）。
// 引擎侧烘焙产物 src/data/style-packs.runtime.json（{id, stylePrompt, palette, blueprint}[]）
// 存在则优先用其 stylePrompt/blueprint，否则回退包名+描述（契约 §5）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STYLE_PACKS, type StylePack } from '../../../data/style-packs';
import { cleanString } from './types';

// 契约 §6「易于转可编辑」条款，逐字注入每页生图 prompt（放在风格/版式指令之后）。
export const EDITABLE_FRIENDLY_CLAUSE =
  '所有文字必须使用清晰可读的常规无衬线字体字形，水平排版，不得使用艺术字、变形字或竖排特效；文字只出现在纯色或低噪背景上，保持高对比度，不得压盖照片或复杂纹理；版式遵循清晰栅格，内容块边界分明、边缘对齐、留白充足；图表与图示使用扁平纯色矢量风格；每段文案只出现一次；不得渲染任何设计说明、坐标、字号、色值等元信息；不得出现水印、占位符或虚构 UI 元素。';

export interface StylePackRuntimeEntry {
  id: string;
  stylePrompt?: string;
  palette?: string[];
  blueprint?: string;
}

export interface ResolvedStylePack {
  id: string;
  name: string;
  description: string;
  /** 引擎烘焙的视觉风格描述（runtime json），无则空串 */
  stylePrompt: string;
  palette: string[];
  blueprint: string;
  /** 首张预览图的站内路径（/assets/style-packs/...，public 下），无则空串 */
  firstPreviewPath: string;
}

let runtimeCache: Map<string, StylePackRuntimeEntry> | null | undefined;

function runtimeJsonPath(): string {
  // Next server 进程与脚本测试的 cwd 都是项目根；与 env.ts 的 cwd 约定一致。
  return path.resolve(process.cwd(), 'src', 'data', 'style-packs.runtime.json');
}

function loadRuntimeMap(): Map<string, StylePackRuntimeEntry> | null {
  if (runtimeCache !== undefined) return runtimeCache;
  try {
    const parsed = JSON.parse(readFileSync(runtimeJsonPath(), 'utf8'));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.packs) ? parsed.packs : [];
    const map = new Map<string, StylePackRuntimeEntry>();
    for (const item of list) {
      const id = cleanString(item?.id, 80);
      if (!id) continue;
      map.set(id, {
        id,
        stylePrompt: cleanString(item?.stylePrompt, 4000),
        palette: Array.isArray(item?.palette) ? item.palette.map((c: unknown) => cleanString(c, 20)).filter(Boolean) : [],
        blueprint: cleanString(item?.blueprint, 2000),
      });
    }
    runtimeCache = map;
  } catch {
    runtimeCache = null; // 文件不存在或格式不对：只用包名+描述
  }
  return runtimeCache;
}

/** 测试/热更新用：清掉 runtime json 缓存 */
export function resetStylePackRuntimeCache(): void {
  runtimeCache = undefined;
}

export function listStylePacks(): StylePack[] {
  return STYLE_PACKS;
}

export function findStylePack(id: string): StylePack | null {
  const clean = cleanString(id, 80);
  return STYLE_PACKS.find((pack) => pack.id === clean) || null;
}

export function resolveStylePack(id: string): ResolvedStylePack | null {
  const pack = findStylePack(id);
  if (!pack) return null;
  const runtime = loadRuntimeMap()?.get(pack.id);
  return {
    id: pack.id,
    name: pack.name,
    description: cleanString(pack.description, 1000),
    stylePrompt: runtime?.stylePrompt || '',
    palette: runtime?.palette || [],
    blueprint: runtime?.blueprint || '',
    firstPreviewPath: pack.previewImageUrls[0] || pack.previewUrl || '',
  };
}

/** 风格指令文本：优先烘焙产物，否则包名+描述（契约 §5 的降级路径） */
export function styleDirective(pack: ResolvedStylePack | null): string {
  if (!pack) return '现代简洁商务演示风格，版式干净、留白充足。';
  const parts: string[] = [];
  if (pack.stylePrompt) parts.push(pack.stylePrompt);
  if (pack.blueprint) parts.push(`视觉规范：${pack.blueprint}`);
  if (pack.palette.length > 0) parts.push(`主色板：${pack.palette.join('、')}`);
  if (parts.length === 0) {
    parts.push(`设计风格：「${pack.name}」${pack.description ? `——${pack.description}` : ''}`);
  }
  return parts.join('\n');
}

/** 首页/样例页的风格参考图（契约：走 reference_images；读 public 下预览图转 data URL） */
export function loadStyleReferenceDataUrl(pack: ResolvedStylePack | null): string | null {
  if (!pack?.firstPreviewPath) return null;
  try {
    const rel = pack.firstPreviewPath.replace(/^\/+/, '');
    const absPath = path.resolve(process.cwd(), 'public', rel);
    if (!absPath.startsWith(path.resolve(process.cwd(), 'public') + path.sep)) return null;
    const buf = readFileSync(absPath);
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return null;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export interface SlidePromptInput {
  role: string;
  pageType: string;
  title: string;
  goal: string;
  copyLines: string[];
  visualNote: string;
}

/** 生图 prompt = 页面文案段 + 风格包指令 + 契约 §6 条款（逐字，置后） */
export function buildSlideImagePrompt(
  slide: SlidePromptInput,
  pack: ResolvedStylePack | null,
  opts: { withStyleReferenceHint?: boolean } = {},
): string {
  const copy = slide.copyLines.filter(Boolean);
  const parts = [
    '为一张 16:9 商务演示 PPT 幻灯片生成完整的最终视觉图（整页一张图，含全部排版与文字）。',
    `页面角色：${slide.role || 'content'}${slide.pageType ? `（版式：${slide.pageType}）` : ''}`,
    slide.title ? `页面标题：${slide.title}` : '',
    slide.goal ? `本页表达目标：${slide.goal}` : '',
    copy.length > 0
      ? `页面文案（必须逐字完整呈现，不得增删、不得改写）：\n${copy.map((line) => `- ${line}`).join('\n')}`
      : '',
    slide.visualNote ? `版式/配图建议：${slide.visualNote}` : '',
    `风格要求：\n${styleDirective(pack)}`,
    opts.withStyleReferenceHint ? '随附风格参考图，请严格延续其配色、版式与视觉气质。' : '',
    `易转可编辑排版条款（必须严格遵守）：${EDITABLE_FRIENDLY_CLAUSE}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}
