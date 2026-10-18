import 'server-only';
import { ApiError, createApiClient } from '@dhc/api-client';
import { isPublicSlug, type PublicDoctor, type PublicDoctorList } from '@dhc/contracts';
import { cache } from 'react';
import { publicApiBaseUrl } from './config';

/** Seconds the public pages and their API answers are kept (ISR and the fetch cache). */
export const PUBLIC_REVALIDATE = 300;

/**
 * The API, as the public pages call it from the server: answers kept for five minutes in
 * Next's fetch cache (only 200s are kept). The visitor's address is not passed on: reading
 * the request headers would make every page dynamic and end the caching that keeps the
 * API's per-address limit out of reach (threat model T25).
 */
const publicApi = () =>
  createApiClient({
    baseUrl: publicApiBaseUrl(),
    fetch: (input, init) => fetch(input, { ...init, next: { revalidate: PUBLIC_REVALIDATE } }),
  });

/** Every page shown, from the cached sitemap list (one API call per five minutes). */
export const listedDoctors = cache(
  async (): Promise<PublicDoctorList['data']> => (await publicApi().publicDoctors()).data,
);

/**
 * A doctor's page data, or null when there is no such page. An address that is not a
 * slug, or not in the cached list, never reaches the single-doctor API, so probing made-up
 * addresses costs the API nothing. A page listed in the last five minutes may not be in
 * the list yet. Other failures (the API busy with 429, or down) are thrown, for the
 * page's error boundary to show "busy, try again"; nothing is cached for them.
 */
export const loadPublicDoctor = cache(async (slug: string): Promise<PublicDoctor | null> => {
  if (!isPublicSlug(slug)) return null;
  const listed = await listedDoctors();
  if (!isListedSlug(slug, listed)) return null;
  try {
    return await publicApi().publicDoctor(slug);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
});

/** Whether the cached list has this address. */
export const isListedSlug = (slug: string, listed: { slug: string }[]) =>
  listed.some((d) => d.slug === slug);
