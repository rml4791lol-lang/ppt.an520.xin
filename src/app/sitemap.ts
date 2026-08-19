import type { MetadataRoute } from 'next';

const BASE = 'https://ppt.an520.xin';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE}/style-packs`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE}/login`, lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
  ];
}
