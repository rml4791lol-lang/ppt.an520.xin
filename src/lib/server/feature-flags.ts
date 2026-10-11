// 功能开关板：新功能先对测试用户开放，验收后管理员一键转 public。
// 状态机：off（仅管理员可见可用）→ beta（测试用户+管理员）→ public（全员）。
// 存储走 feature_flags 表（非密文，区别于 admin_runtime_config 的加密配置）。
import { getDb } from './db';
import { ApiError } from './http';
import type { PublicUser } from './auth';
import { cleanString } from './generation/types';

export type FeatureFlagState = 'off' | 'beta' | 'public';

export interface FeatureFlagDef {
  key: string;
  label: string;
  description: string;
  defaultState: FeatureFlagState;
}

/** 在这里登记新功能；defaultState 即功能首次上线时的状态（新功能一律 beta 起步）。 */
export const FEATURE_FLAG_DEFS: FeatureFlagDef[] = [
  {
    key: 'editable_text_overlay',
    label: '轻量文字可编辑导出',
    description: '整页图 PPTX + 可编辑文本框覆盖层，成本近零的轻量档。',
    defaultState: 'beta',
  },
  {
    key: 'magic_erase',
    label: '高精清除',
    description: '抹除生成图上的指定元素（对标花卷高精清除）。',
    defaultState: 'off',
  },
  {
    key: 'image_text_edit',
    label: '图上改字',
    description: '直接修改生成图上的文字内容（对标花卷修改文字）。',
    defaultState: 'off',
  },
  {
    key: 'template_fusion',
    label: '模板融合',
    description: '两套模板风格融合生成（对标花卷模板融合）。',
    defaultState: 'off',
  },
  {
    key: 'set_as_reference',
    label: '设为参考图',
    description: '把已生成页设为全套风格锚点（对标花卷设为参考图）。',
    defaultState: 'off',
  },
  {
    key: 'gold_layouts_beta',
    label: '金奖版式测试包',
    description: '2025 国赛金奖版式提炼的真模板测试包（版式锁死灌内容），验收采纳前仅测试用户可见可用。',
    defaultState: 'beta',
  },
  {
    key: 'ppt_replicate',
    label: 'PPT 美化（复刻）',
    description: '首页美化页与模板库「自己的 PPT」：上传参考稿保画面换文案。不进大纲工作台。',
    defaultState: 'beta',
  },
  {
    key: 'ppt_to_base',
    label: 'PPT 转模版底座',
    description: '上传 PPTX 本地程序化擦除文字，导出 1536×864 通用模版底座图与槽位 JSON。纯前端，零成本。',
    defaultState: 'beta',
  },
];

const VALID_STATES = new Set<FeatureFlagState>(['off', 'beta', 'public']);
const DEF_BY_KEY = new Map(FEATURE_FLAG_DEFS.map((def) => [def.key, def]));

export interface FeatureFlagView extends FeatureFlagDef {
  state: FeatureFlagState;
  updatedAt: number;
  updatedBy: string | null;
}

interface FlagRow {
  key: string;
  state: string;
  updated_by: string | null;
  updated_at: number;
}

function readRows(): Map<string, FlagRow> {
  const rows = getDb().prepare('SELECT key, state, updated_by, updated_at FROM feature_flags').all() as unknown as FlagRow[];
  return new Map(rows.map((row) => [row.key, row]));
}

/** 全量开关视图（管理端用）：登记项 + 数据库覆盖状态。 */
export function listFeatureFlags(): FeatureFlagView[] {
  const rows = readRows();
  return FEATURE_FLAG_DEFS.map((def) => {
    const row = rows.get(def.key);
    const state = VALID_STATES.has(row?.state as FeatureFlagState)
      ? (row!.state as FeatureFlagState)
      : def.defaultState;
    return { ...def, state, updatedAt: row?.updated_at ?? 0, updatedBy: row?.updated_by ?? null };
  });
}

export function getFeatureFlagState(key: string): FeatureFlagState {
  const def = DEF_BY_KEY.get(key);
  const row = readRows().get(key);
  if (row && VALID_STATES.has(row.state as FeatureFlagState)) return row.state as FeatureFlagState;
  return def?.defaultState ?? 'off';
}

export function setFeatureFlag(key: string, state: FeatureFlagState, actorUserId: string): void {
  const def = DEF_BY_KEY.get(cleanString(key, 60));
  if (!def) throw new ApiError('VALIDATION_ERROR', '未知的功能开关', 400, false);
  if (!VALID_STATES.has(state)) throw new ApiError('VALIDATION_ERROR', '开关状态必须是 off/beta/public', 400, false);
  getDb().prepare(
    `INSERT INTO feature_flags (key, state, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET state = excluded.state, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(def.key, state, actorUserId || null, Date.now());
}

/** 测试用户判定：role=tester；管理员天然拥有全部可见性。 */
export function isTesterUser(user: PublicUser | null | undefined): boolean {
  return user?.role === 'tester';
}

/** 某功能对某用户是否可见可用。未登录按普通用户处理。 */
export function isFeatureVisible(key: string, user: PublicUser | null | undefined): boolean {
  if (user?.role === 'admin') return true;
  const state = getFeatureFlagState(key);
  if (state === 'public') return true;
  if (state === 'beta') return isTesterUser(user);
  return false;
}

/** 服务端硬门：不可见的功能按 404 处理（不暴露功能存在性）。 */
export function assertFeatureVisible(key: string, user: PublicUser | null | undefined): void {
  if (!isFeatureVisible(key, user)) {
    throw new ApiError('NOT_FOUND', '功能不存在或尚未开放', 404, false);
  }
}

/** 当前用户视角的可见性地图（/api/features，前端隐藏入口用）。 */
export function featureVisibilityFor(user: PublicUser | null | undefined): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const def of FEATURE_FLAG_DEFS) map[def.key] = isFeatureVisible(def.key, user);
  return map;
}
