// PPT 转模版底座·截图 AI 路线：VLM 抽标题 + 精准编辑模型做「去风格化 + 文字中性词替换」。
// 5🌟/张（env 价键 ppt_to_base，插件动作 tool.ppt-to-base），失败全退；requestId 幂等，重放 409。
// 编辑提示词纪律（GPT Image 2.5 最佳实践）：点名参考图角色 → 改变项/保留项分离 → 不变量重复声明 → 中性词逐字加引号。
import { ApiError, validationError } from '@/lib/server/http';
import { findUserById } from '@/lib/server/auth';
import { assertFeatureVisible } from '@/lib/server/feature-flags';
import { debitCredits, estimateCredits, refundCredits } from '@/lib/server/credits';
import { chatCompletion } from '@/lib/server/engine';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { genId } from '@/lib/server/generation/db';
import { editImage, toPublicImageError, type ImageDeps } from '@/lib/server/generation/images';
import { saveFile } from '@/lib/server/generation/storage';
import { cleanString } from '@/lib/server/generation/types';
import { hitRateLimit } from '@/lib/server/rate-limit';

export const PPT_TO_BASE_ACTION = 'ppt_to_base';
export const PPT_TO_BASE_RATE = { windowMs: 60 * 60 * 1000, max: 30 };

/** 去风格化编辑指令：结构不变、文字换成中性角色词、风格归一为中性浅色系。 */
export const BASE_IMAGE_INSTRUCTION = [
  '参考图是一张 PPT 幻灯片截图，请把它精准改造成一张「通用模板底图」。只改以下两件事，其余一切保持原样：',
  '',
  '一、文字全部中性化：把图上每一处具体文字替换为描述该区域角色的中性词，并保持原来的位置、字号层级、粗细与对齐方式——',
  '- 主标题位置只显示"标题"；若有副标题，副标题位置只显示"副标题"',
  '- 正文段落位置只显示"正文"；列表/要点的每一项只显示"要点"',
  '- 页眉页脚、角标、小标签、编号等小字位置分别只显示"标签"或"编号"',
  '- 照片/插画区域整体替换为浅灰占位色块，色块中央只显示"图片"',
  '- 图表/表格区域保留外框与行列结构，内部具体文字一律改为"数据"',
  '',
  '二、去风格化：去除原图的主题配色、品牌色、Logo、装饰图案与材质质感，统一重绘为干净的中性浅色系——白色页面底色、浅灰分区色块、中灰线条，扁平克制的通用版式风格。',
  '',
  '必须保持不变：整体构图与栅格、每个区域的位置和大小、卡片/色块/线条的数量与形状、栏数、页面边距、16:9 横版画幅。',
  '',
  '约束：图上只允许出现"标题/副标题/正文/要点/标签/编号/图片/数据"这几个中性词，每个词出现的次数与原页面同类文字块的数量一致；不得出现原页面的任何具体文字、品牌名、Logo、水印；不要新增任何装饰元素；中性词用深灰色常规无衬线字体。',
].join('\n');

/** 标题抽取指令：只取主标题原文，JSON 返回。 */
export const TITLE_EXTRACT_PROMPT = [
  '这是一张 PPT 幻灯片截图。找出页面主标题（视觉层级最高的标题文字）的原文。',
  '只输出一行 JSON：{"title":"原文"}；若没有可辨认的标题，输出 {"title":""}。不要输出任何其他内容。',
].join('\n');

/** VLM 抽标题：失败一律降级为空串，不阻塞主流程。 */
export async function extractTitleText(image: Buffer, deps: ImageDeps): Promise<string> {
  try {
    const dataUrl = `data:image/png;base64,${image.toString('base64')}`;
    const raw = await chatCompletion(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: TITLE_EXTRACT_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      deps,
    );
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return '';
    const parsed = JSON.parse(match[0]) as { title?: unknown };
    return cleanString(String(parsed.title ?? ''), 100);
  } catch {
    return '';
  }
}

export interface PptToBaseInput {
  /** 客户端已 letterbox 成 1536×864 的 PNG 截图 */
  image: Buffer;
  requestId: string;
}

export interface PptToBaseResult {
  title: string;
  imageUrl: string;
  balance: number;
}

export type PptToBaseDeps = ImageDeps;

export async function runPptToBase(userId: string, input: PptToBaseInput, deps: PptToBaseDeps = {}): Promise<PptToBaseResult> {
  const config = deps.config ?? getGenerationConfig();
  const runDeps: PptToBaseDeps = { ...deps, config };
  assertFeatureVisible('ppt_to_base', findUserById(userId));
  if (!input.image || input.image.length === 0) throw validationError('缺少截图');
  const requestId = cleanString(input.requestId, 80);
  if (!requestId) throw validationError('缺少 requestId');
  const rl = hitRateLimit(`ppt-to-base:${userId}`, PPT_TO_BASE_RATE);
  if (!rl.allowed) {
    throw new ApiError('RATE_LIMITED', `操作太频繁，请 ${rl.retryAfterSeconds} 秒后再试`, 429, true);
  }

  const unitPrice = estimateCredits({ action: PPT_TO_BASE_ACTION }).credits;
  // 与 credits.cleanKey 同口径归一：重放命中即拒，不重复扣费也不再生成
  const chargeKey = `ppt-to-base:${userId}:${requestId}`.trim().slice(0, 128);
  const debit = debitCredits(userId, unitPrice, {
    reason: 'PPT 转模版底座',
    idempotencyKey: chargeKey,
    refType: 'ppt-to-base',
    refId: requestId,
  });
  if (debit.duplicate) throw new ApiError('DUPLICATE_REQUEST', '重复请求：请勿重复提交，结果请稍候查看', 409, false);

  try {
    const title = await extractTitleText(input.image, runDeps);
    const edited = await editImage({ image: input.image, instruction: BASE_IMAGE_INSTRUCTION }, runDeps);
    const saved = await saveFile('generated', userId, edited, { kind: 'ppt-to-base', ext: '.png', id: genId('base') }, config);
    return { title, imageUrl: saved.url, balance: debit.balance };
  } catch (error) {
    try {
      refundCredits(userId, unitPrice, {
        reason: '底座生成失败退回',
        idempotencyKey: `${chargeKey}:refund`,
        refType: 'ppt-to-base',
        refId: requestId,
      });
    } catch (refundError) {
      console.error('[anppt-v2][ppt-to-base] refund failed:', refundError);
    }
    const pub = toPublicImageError(error);
    throw new ApiError(pub.code, pub.message, pub.status, true);
  }
}
