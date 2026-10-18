import type { MetadataRoute } from 'next';
import { publicSiteUrl } from '../lib/config';
import { doctorPath } from '../lib/public-doctor';
import { listedDoctors } from '../lib/public-doctor-server';

/** Built per request (the API is not there at build time); the list itself is cached 5 minutes. */
export const dynamic = 'force-dynamic';

/** The home page and every public doctor page shown (`GET /v1/public/doctors`). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = publicSiteUrl();
  const doctors = await listedDoctors();
  return [
    { url: `${site}/` },
    ...doctors.map((d) => ({
      url: `${site}${doctorPath(d.slug)}`,
      lastModified: d.updatedAt,
    })),
  ];
}
