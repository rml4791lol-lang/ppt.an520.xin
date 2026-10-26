import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AnPPT · AI 生成 PPT，支持转可编辑',
    short_name: 'AnPPT',
    description: '导入文档，AI 生成设计机构级 PPT，支持 PPT 美化和转可编辑。',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'zh-CN',
    dir: 'ltr',
    background_color: '#f7f5f0',
    theme_color: '#f2571a',
    categories: ['productivity', 'business', 'design'],
    icons: [
      {
        src: '/icon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
    shortcuts: [
      {
        name: '新建 PPT',
        short_name: '新建',
        description: '上传文档或逐页录入，开始生成 PPT',
        url: '/#start',
      },
      {
        name: '我的项目',
        short_name: '项目',
        description: '查看已保存的 PPT 项目',
        url: '/projects',
      },
    ],
  };
}
