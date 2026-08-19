import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AnPPT · 专业PPT设计机构出品',
    short_name: 'AnPPT',
    description: '导入文档，AI 生成设计机构级 PPT，支持转可编辑。',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f5f0',
    theme_color: '#f2571a',
    icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }],
  };
}
