import 'server-only';

/**
 * API address the browser should call, read when the page is rendered (these pages are
 * dynamic), so one build works in every environment. NEXT_PUBLIC_API_BASE_URL is the
 * build-time fallback.
 */
export function publicApiBaseUrl(): string {
  return (
    process.env.API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    'http://localhost:4000/v1'
  ).replace(/\/+$/, '');
}

/**
 * The public website's own address (canonical links, OpenGraph, schema markup, sitemap),
 * read when pages render: PUBLIC_SITE_URL, else WEB_BASE_URL (the API's name for the same
 * origin). In development, the development server; in production one of them must be set,
 * or every canonical link would point at localhost.
 */
export function publicSiteUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.PUBLIC_SITE_URL?.trim() || env.WEB_BASE_URL?.trim();
  if (!url && env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_SITE_URL (or WEB_BASE_URL) must be set in production.');
  }
  return (url || 'http://localhost:3000').replace(/\/+$/, '');
}

/** The privacy notice and terms of use, by consent kind. */
export type ConsentDocumentUrls = { privacy_notice?: string; terms?: string };

let warned = false;

/**
 * The published privacy notice and terms of use, linked from the patient portal's consents
 * screen before the patient accepts them (PRD §4.1), read when pages render. In production
 * both must be set: without them a patient would accept documents they cannot read, so
 * `missing` is true, the consents screen offers no way to accept, and the server warns
 * (once per process).
 */
export function consentDocuments(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): { urls: ConsentDocumentUrls; missing: boolean } {
  const url = (value: string | undefined) => value?.trim() || undefined;
  const urls = { privacy_notice: url(env.PRIVACY_NOTICE_URL), terms: url(env.TERMS_URL) };
  const missing = env.NODE_ENV === 'production' && (!urls.privacy_notice || !urls.terms);
  if (missing && !warned) {
    warned = true;
    warn(
      'PRIVACY_NOTICE_URL and TERMS_URL must both be set: patients cannot accept the consents on the web portal until they are.',
    );
  }
  return { urls, missing };
}
