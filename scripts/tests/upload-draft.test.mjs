// [13b] 生成器草稿（src/lib/client/upload-draft.ts）：
// 登录跳转是 SPA 导航，草稿要能跨组件重挂载保留；刷新会丢（File 不可序列化），
// 这里只锁模块级内存的存取、过期与清理三条契约。
export async function runUploadDraftTests({ check }) {
  const { saveUploadDraft, readUploadDraft, clearUploadDraft } = await import(
    '../../src/lib/client/upload-draft.ts'
  );

  clearUploadDraft();
  check('草稿：未保存时读出 null', readUploadDraft() === null);

  const file = new File(['# 测试'], 'draft.md', { type: 'text/markdown' });
  const draft = {
    tab: 'paged',
    style: null,
    duration: 'custom',
    customPages: '12',
    quality: 'fine',
    pages: ['第一页', ''],
    file,
  };
  saveUploadDraft(draft);
  const saved = readUploadDraft();
  check(
    '草稿：字段与 File 原样保留',
    saved !== null &&
      saved.tab === 'paged' &&
      saved.duration === 'custom' &&
      saved.customPages === '12' &&
      saved.quality === 'fine' &&
      saved.pages.length === 2 &&
      saved.file === file &&
      typeof saved.savedAt === 'number',
    JSON.stringify(saved && { ...saved, file: saved.file?.name }),
  );

  // 过期：31 分钟后不再恢复（模块内有 30 分钟窗口）
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60 * 1000;
  let expired = null;
  try {
    expired = readUploadDraft();
  } finally {
    Date.now = realNow;
  }
  check('草稿：超过 30 分钟不再恢复', expired === null);

  clearUploadDraft();
  check('草稿：清理后读出 null', readUploadDraft() === null);
}
