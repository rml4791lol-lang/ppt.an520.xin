import type { MetadataRoute } from 'next';
import { getSiteConfig } from '@/data/site-config';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteConfig().publicBaseUrl;
  const now = new Date();
  const pages: { path: string; priority: number; changeFrequency: 'weekly' | 'monthly' }[] = [
    { path: '/', priority: 1, changeFrequency: 'weekly' },
    { path: '/style-packs', priority: 0.9, changeFrequency: 'weekly' },
    { path: '/help', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/about', priority: 0.6, changeFrequency: 'monthly' },
    { path: '/legal/privacy', priority: 0.3, changeFrequency: 'monthly' },
    { path: '/legal/terms', priority: 0.3, changeFrequency: 'monthly' },
    { path: '/legal/refund', priority: 0.3, changeFrequency: 'monthly' },
  ];
  return pages.map((page) => ({
    url: `${base}${page.path}`,
    lastModified: now,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
