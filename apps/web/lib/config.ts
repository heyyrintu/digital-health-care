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
