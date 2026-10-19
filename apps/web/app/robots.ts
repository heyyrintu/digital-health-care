import type { MetadataRoute } from 'next';
import { publicSiteUrl } from '../lib/config';

/** Per request, so the site address comes from this environment, not the build's. */
export const dynamic = 'force-dynamic';

/** Search engines may read the public site; the portal, dashboards and APIs are not for them. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/doctor/'],
      disallow: ['/app', '/clinic', '/platform', '/api', '/display', '/invite'],
    },
    sitemap: `${publicSiteUrl()}/sitemap.xml`,
  };
}
