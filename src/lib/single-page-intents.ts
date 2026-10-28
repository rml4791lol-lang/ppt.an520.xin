// 单页生成/导出动作的 typed intent 契约：客户端与路由共用一份，动作名即既有路由。
// kind → 解析器回答「什么 payload 合法」：类型、字符串上限、必填字段、数组清洗都在解析器里；
// 由 toSinglePageActionCall 决定发往哪条路由（机制与取舍见 docs/DEBUG-HANDBOOK.md §30）。
import {
  readIntentFields,
  readRequiredText,
  type IntentParamsTable,
} from './intent-envelope';

export type SinglePageIntentParams = {
  /** 逐版本生成（10🌟/版）；requestId 用于幂等重放拒绝 */
  generatePage: {
    pageId: string;
    projectId?: string;
    title?: string;
    content: string;
    stylePackId?: string;
    imagePath?: string;
    requestId?: string;
    /** replicate = 复刻分支内部调用，挂 ppt_replicate 开关 */
    mode?: string;
    colorMode?: string;
    structure?: unknown;
  };
  refinePage: { pageId: string; editInstruction: string; requestId?: string };
  selectVersion: { pageId: string; versionId: string };
  exportImagePptx: { projectId?: string; pageIds?: string[]; title?: string };
  exportEditablePptx: { projectId: string; force?: boolean };
};

export type SinglePageIntentKind = keyof SinglePageIntentParams;

export type SinglePageIntent = {
  [K in SinglePageIntentKind]: { kind: K; params: SinglePageIntentParams[K] };
}[SinglePageIntentKind];

export interface SinglePageActionCall {
  path: string;
  method: 'POST';
}

/**
 * kind → 参数解析器的唯一登记：Record 强制穷尽（新增 kind 忘记登记即编译失败）。
 * 上限对齐 service 层 cleanString 口径（pageId 80 / title 120 / content 8000 / imagePath 300 / requestId 128）；
 * 页归属、开关、余额与幂等仍由路由/动作决定。
 */
export const SINGLE_PAGE_INTENT_PARAMS: IntentParamsTable<SinglePageIntentParams> = {
  generatePage: (params) => {
    const f = readIntentFields(params);
    const pageId = readRequiredText(f, 'pageId', 80, '缺少 pageId');
    const content = f.text('content', 8000);
    if (!content) f.fail('页面内容不能为空');
    const out: SinglePageIntentParams['generatePage'] = {
      pageId,
      content,
      projectId: f.text('projectId', 80),
      title: f.text('title', 120),
      stylePackId: f.text('stylePackId', 80),
      imagePath: f.text('imagePath', 300),
      requestId: f.text('requestId', 128),
      mode: f.text('mode', 20),
      colorMode: f.text('colorMode', 40),
    };
    // structure 的「是否提供」是语义（null 也代表结构卡），不能被洗成空串丢掉
    if (f.has('structure')) out.structure = f.raw('structure');
    return f.done(out);
  },
  refinePage: (params) => {
    const f = readIntentFields(params);
    return f.done({
      pageId: readRequiredText(f, 'pageId', 80, '缺少 pageId'),
      editInstruction: readRequiredText(f, 'editInstruction', 1000, '缺少 editInstruction'),
      requestId: f.text('requestId', 128),
    });
  },
  selectVersion: (params) => {
    const f = readIntentFields(params);
    const pageId = f.text('pageId', 80);
    const versionId = f.text('versionId', 80);
    if (!pageId || !versionId) f.fail('缺少 pageId 或 versionId');
    return f.done({ pageId, versionId });
  },
  exportImagePptx: (params) => {
    const f = readIntentFields(params);
    return f.done({
      projectId: f.text('projectId', 80),
      pageIds: f.raw('pageIds') == null ? undefined : f.list('pageIds', 80),
      title: f.text('title', 120),
    });
  },
  exportEditablePptx: (params) => {
    const f = readIntentFields(params);
    return f.done({
      projectId: readRequiredText(f, 'projectId', 80, '缺少 projectId'),
      force: f.flag('force'),
    });
  },
};

const SINGLE_PAGE_PATHS: Record<SinglePageIntentKind, string> = {
  generatePage: '/api/single-page/generate',
  refinePage: '/api/single-page/refine',
  selectVersion: '/api/single-page/select-version',
  exportImagePptx: '/api/single-page/export-image-pptx',
  exportEditablePptx: '/api/single-page/export-editable-pptx',
};

/** 意图 → 路由：路径只在这里出现（客户端分发唯一入口） */
export function toSinglePageActionCall(intent: SinglePageIntent): SinglePageActionCall {
  return { path: SINGLE_PAGE_PATHS[intent.kind], method: 'POST' };
}
