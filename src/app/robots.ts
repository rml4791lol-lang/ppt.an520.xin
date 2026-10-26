import type { MetadataRoute } from 'next';
import { getSiteConfig } from '@/data/site-config';

export default function robots(): MetadataRoute.Robots {
  const base = getSiteConfig().publicBaseUrl;
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/style-packs', '/help', '/about', '/legal/'],
        disallow: [
          '/api/',
          '/deck/',
          '/projects',
          '/recharge',
          '/account/',
          '/single-page',
          '/beautify',
          '/tools/',
          '/exports',
          '/admin',
          '/login',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
