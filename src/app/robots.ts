import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/style-packs', '/login', '/showcase-cases'],
        disallow: ['/api/', '/deck/', '/projects', '/recharge', '/account/', '/single-page'],
      },
    ],
    sitemap: 'https://ppt.an520.xin/sitemap.xml',
  };
}
