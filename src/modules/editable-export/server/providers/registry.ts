// 通道总表与回退顺序唯一来源。新增第四个通道 = 新增一个适配器文件 + 下面登记一次。
import type { GenerationConfig } from '@/lib/server/generation/config';
import { codiaProvider } from './codia';
import { image2PptProvider } from './image2ppt';
import type { EditableProvider, EditableProviderId } from './types';
import { wpsProvider } from './wps';

export const EDITABLE_PROVIDERS: readonly EditableProvider[] = [wpsProvider, image2PptProvider, codiaProvider];

/** 历史行没有 upstream_provider（那时只有 Codia 通道）：恢复按它走，避免旧行卡死。 */
export const LEGACY_EDITABLE_PROVIDER_ID: EditableProviderId = 'codia';

export function editableProviderById(id: unknown): EditableProvider | null {
  const key = String(id ?? '');
  return EDITABLE_PROVIDERS.find((provider) => provider.id === key) ?? null;
}

function preferredOrder(config: GenerationConfig): readonly EditableProviderId[] {
  if (config.editableProvider === 'codia') return ['codia', 'image2ppt', 'wps'];
  if (config.editableProvider === 'image2ppt') return ['image2ppt', 'wps', 'codia'];
  return ['wps', 'image2ppt', 'codia'];
}

/** 回退顺序：配置主通道优先 → 剔除未配置 → 剔除页数上限接不住的通道。 */
export function resolveEditableProviders(config: GenerationConfig, pageCount: number): EditableProvider[] {
  const providers: EditableProvider[] = [];
  for (const id of preferredOrder(config)) {
    const provider = editableProviderById(id);
    if (!provider) continue;
    if (!provider.capabilities.configured(config)) continue;
    if (provider.capabilities.maxPages < pageCount) continue;
    providers.push(provider);
  }
  return providers;
}

/** 已配置通道（不按页数过滤）：健康检查与管理员探针看的是「准备了哪些通道」。 */
export function configuredEditableProviders(config: GenerationConfig): EditableProviderId[] {
  return resolveEditableProviders(config, 0).map((provider) => provider.id);
}

/** 可编辑导出的页数上限 = 已配置通道链的能力上限；0 表示没有可用通道。 */
export function editablePageCapacity(config: GenerationConfig): number {
  return resolveEditableProviders(config, 0)
    .reduce((capacity, provider) => Math.max(capacity, provider.capabilities.maxPages), 0);
}
