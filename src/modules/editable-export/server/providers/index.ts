// 上游通道接口层出口：接口 / 能力 / registry / 共享文案。
export * from './types';
export { EDITABLE_PROVIDERS, configuredEditableProviders, editablePageCapacity, editableProviderById, resolveEditableProviders } from './registry';
export { codiaProvider } from './codia';
export { image2PptProvider } from './image2ppt';
export { wpsProvider } from './wps';
