import { requireUser } from '@/lib/server/auth';
import { ApiError, defineRoute } from '@/lib/server/http';
import { hasEverPaid } from '@/lib/server/recharge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOOLKIT = `# AnPPT × ONLYOFFICE 兼容工具包

永久会员权益说明：任意一笔充值成功后持续可用。

## 1. 推荐字体
- 中文：Noto Sans SC
- 英文与数字：Inter
- 若收件电脑缺少字体，请先安装字体或在最终交付前嵌入/替换字体。

## 2. 从 AnPPT 到 ONLYOFFICE
1. 在 AnPPT 下载中心获取可编辑 PPTX。
2. 使用 ONLYOFFICE Desktop Editors 打开文件。
3. 逐页检查文字换行、字号、页眉 Logo、图表标签和元素层级。
4. 需要外发时另存一份 PDF，确保不同电脑上的演示效果一致。

## 3. 交付前检查
- 页面比例是否为 16:9。
- 标题、正文是否有溢出或异常换行。
- Noto Sans SC / Inter 是否可用。
- 动画、切换、视频和特殊图表是否按预期播放。
- 页眉 Logo 的大小、位置和颜色是否跨页一致。

## 4. 兼容提示
ONLYOFFICE 可覆盖大多数日常 PPTX 编辑、排版、演示和 PDF 导出需求；复杂宏、少数高级动画、特殊字体或专有对象可能存在差异。好作品值得多检查一遍。

## 5. 安装包下载
请返回 AnPPT 的「免费 PPT 编辑」页面，根据电脑架构选择 Windows x64、x86 或 ARM64。

ONLYOFFICE 是第三方开源项目；AnPPT 提供的是受保护的一键下载、版本校验、兼容指引、文件衔接和会员支持服务。
`;

export const GET = defineRoute(async (request) => {
  const { user } = requireUser(request);
  if (!hasEverPaid(user.id)) {
    throw new ApiError('MEMBER_BENEFIT_REQUIRED', '充值任意套餐后可永久解锁兼容工具包', 403, false);
  }
  const download = new URL(request.url).searchParams.get('download') === '1';
  return new Response(TOOLKIT, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'private, no-store',
      ...(download
        ? { 'Content-Disposition': "attachment; filename*=UTF-8''AnPPT-ONLYOFFICE-toolkit.md" }
        : {}),
    },
  });
});
