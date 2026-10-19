import 'server-only';
import { ApiError, createApiClient } from '@dhc/api-client';
import {
  isPublicSlug,
  type PublicDoctor,
  type PublicDoctorCard,
  type PublicDoctorList,
} from '@dhc/contracts';
import { cache } from 'react';
import { publicApiBaseUrl, publicApiCacheSeconds } from './config';

/**
 * The API, as the public pages call it from the server: answers kept in Next's fetch cache
 * on this web instance for `publicApiCacheSeconds()` (300 unless shortened; only 200s are
 * kept). Once that time has passed the next request still gets the kept answer while a
 * fresh one is fetched in the background (a doctor page being regenerated waits for the
 * fresh one instead). A 200 whose body the contract refuses is kept too, and fails the same
 * way until it is replaced. The visitor's address is not passed on: reading the request
 * headers would make every page dynamic and end the caching that keeps the API's
 * per-address limit out of reach (threat model T25).
 */
const publicApi = () =>
  createApiClient({
    baseUrl: publicApiBaseUrl(),
    fetch: (input, init) =>
      fetch(input, { ...init, next: { revalidate: publicApiCacheSeconds() } }),
  });

/** Every page shown, from the cached sitemap list (one API call per cache period). */
export const listedDoctors = cache(
  async (): Promise<PublicDoctorList['data']> => (await publicApi().publicDoctors()).data,
);

/**
 * A doctor's page data, or null when there is no such page. An address that is not a
 * slug, or not in the cached list, never reaches the single-doctor API, so probing made-up
 * addresses costs the API nothing. A page listed since the list was cached (up to one
 * cache period, five minutes by default) may not be in it yet. Other failures (the API
 * busy with 429, or down) are thrown, for the page's error boundary to show "busy, try
 * again"; nothing is cached for them.
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

/** How long the home page waits for the directory before showing "unavailable" (ms). */
export const DIRECTORY_TIMEOUT_MS = 3000;

/**
 * The home page's directory (`GET /v1/public/doctor-directory`, from the fetch cache as
 * above), or null when there is no kept answer and the API is busy (429), unreachable,
 * slower than three seconds or answers something the contract refuses: the home page
 * still renders, with a "try again later" note. A failure is never kept, so the next visit
 * asks again; while a kept list exists, visitors get it and a failed background refresh
 * goes unseen.
 */
export const loadDirectory = cache(async (): Promise<PublicDoctorCard[] | null> => {
  try {
    const signal = AbortSignal.timeout(DIRECTORY_TIMEOUT_MS);
    return (await publicApi().publicDoctorDirectory({ signal })).data;
  } catch (e) {
    console.warn(
      'Doctor directory unavailable:',
      e instanceof ApiError ? `HTTP ${e.status}` : e instanceof Error ? e.name : e,
    );
    return null;
  }
});
