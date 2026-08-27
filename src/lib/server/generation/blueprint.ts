// 全局视觉规范（Global Blueprint）：每套 deck 生成一份视觉总规范，逐页拼进生图 prompt，
// 保证整套页面像出自同一位设计师。LLM 每套只调用一次（平台吸收，不计用户扣费），
// 结果缓存到 data/blueprints/{deckId}.json（重启不丢、不建 DB 表、不动 decks schema）；
// 风格包或大纲内容变化时指纹失效、自动重算。LLM 未配置或调用失败时降级为空串，绝不阻塞生成。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chatCompletion, type EngineDeps } from '../engine'
import { getGenerationConfig, type GenerationConfig } from './config'
import { resolveStylePack, type ResolvedStylePack } from './style-packs'
import type { DeckRow, DeckSlideRow } from './decks'
import { cleanString } from './types'

interface BlueprintCache {
  stylePackId: string
  fingerprint: string
  blueprint: string
  createdAt: number
}

function blueprintPath(deckId: string, config: GenerationConfig): string {
  const safeId = cleanString(deckId, 80).replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(config.dataDir, 'blueprints', `${safeId}.json`)
}

function loadDeckBlueprint(deckId: string, config: GenerationConfig): BlueprintCache | null {
  try {
    const file = blueprintPath(deckId, config)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed.blueprint !== 'string') return null
    return {
      stylePackId: cleanString(parsed.stylePackId, 80),
      fingerprint: cleanString(parsed.fingerprint, 80),
      blueprint: cleanString(parsed.blueprint, 2000),
      createdAt: Number(parsed.createdAt) || 0,
    }
  } catch {
    return null
  }
}

function saveDeckBlueprint(deckId: string, cache: BlueprintCache, config: GenerationConfig): void {
  try {
    const file = blueprintPath(deckId, config)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cache), 'utf8')
  } catch (error) {
    console.warn('[anppt-v2][blueprint] 缓存写入失败：', error instanceof Error ? error.message : error)
  }
}

/** 蓝图失效指纹：风格包 + 页型/标题序列任一变化即重算。 */
function fingerprintOf(deck: DeckRow, slides: DeckSlideRow[]): string {
  const text = `${deck.stylePackId}|${deck.title}|${slides.map((s) => `${s.pageType}:${s.title}`).join('|')}`
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function buildBlueprintPrompt(deck: DeckRow, slides: DeckSlideRow[], pack: ResolvedStylePack | null): string {
  const pageLines = slides
    .slice(0, 8)
    .map((slide, index) => `${index + 1}. [${slide.pageType || slide.role || 'content'}] ${slide.title}`)
    .join('\n')
  return [
    '你是一名资深的演示文稿视觉总监。请为下面这一套 PPT 制定一份《全局视觉设计规范》——它会逐页下发给生图模型，目标是让全套页面看起来像由同一位设计师一次完成。',
    '',
    `整套主题：${cleanString(deck.title, 120) || '未命名演示'}`,
    deck.sourceText ? `素材摘要：${cleanString(deck.sourceText, 800)}` : '',
    pack
      ? `用户已选风格：${pack.name}；视觉关键词：${pack.visualKeywords.join('、')}；色板倾向：${pack.palette.join('、')}`
      : '用户未指定风格包，按通用专业演示风处理。',
    `页面大纲（共 ${slides.length} 页，以下列出前 ${Math.min(slides.length, 8)} 页）：\n${pageLines}`,
    '',
    '请直接输出规范正文，分四节，每节 2-4 条具体、可执行的规则；不要解释、不要复述题目、不要使用占位符：',
    '一、画面氛围：整体气质、光照与空间感的统一基调。',
    '二、色彩与材质：背景、主色、强调色、辅助色的分工与质感倾向（描述色彩倾向与关系，不堆色值）。',
    '三、版式与内容元素：标题层级、正文容器形态、图标与配图的风格边界。',
    '四、渲染方式：摄影、扁平插画或 3D 的选用规则与禁区。',
  ].filter(Boolean).join('\n')
}

/**
 * 取这套 deck 的全局视觉规范：缓存命中直接返回；未命中调用 LLM 生成并落盘。
 * 失败（未配置 LLM / 上游异常）向上抛，由调用方降级为空串。
 */
export async function ensureDeckBlueprint(
  deck: DeckRow,
  slides: DeckSlideRow[],
  deps: EngineDeps = {},
): Promise<string> {
  const config = deps.config ?? getGenerationConfig()
  const fingerprint = fingerprintOf(deck, slides)
  const cached = loadDeckBlueprint(deck.id, config)
  if (cached && cached.stylePackId === deck.stylePackId && cached.fingerprint === fingerprint && cached.blueprint) {
    return cached.blueprint
  }
  const pack = resolveStylePack(deck.stylePackId)
  const text = await chatCompletion([{ role: 'user', content: buildBlueprintPrompt(deck, slides, pack) }], deps)
  const blueprint = cleanString(text, 2000)
  if (!blueprint) return ''
  saveDeckBlueprint(deck.id, { stylePackId: deck.stylePackId, fingerprint, blueprint, createdAt: Date.now() }, config)
  return blueprint
}
