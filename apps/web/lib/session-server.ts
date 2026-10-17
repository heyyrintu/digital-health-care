import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Token handler for the web dashboard (ADR 0015). The refresh token lives only in an
 * httpOnly, SameSite=Strict cookie scoped to /api/session, so page scripts can never read
 * it. The page keeps the short-lived access token in memory and calls the API directly.
 */
export interface SessionCookie {
  name: string;
  /** The only path the browser sends the cookie to: that session's own routes. */
  path: string;
  maxAgeSeconds: number;
}

/** Staff dashboard. Matches the API's staff session lifetime; the API stays the authority on expiry. */
export const STAFF_COOKIE: SessionCookie = {
  name: 'dhc_session',
  path: '/api/session',
  maxAgeSeconds: 12 * 3600,
};

/**
 * Platform console (ADR 0016): its own cookie on its own routes, so a clinic session is
 * never sent to the console's routes and a console session never reaches the clinic's.
 * Matches the API's 8-hour platform session.
 */
export const PLATFORM_COOKIE: SessionCookie = {
  name: 'dhc_platform_session',
  path: '/api/platform-session',
  maxAgeSeconds: 8 * 3600,
};

export const SESSION_COOKIE = STAFF_COOKIE.name;

interface TokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export function apiBaseUrl(): string {
  return (
    process.env.API_INTERNAL_BASE_URL ??
    process.env.API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    'http://localhost:4000/v1'
  ).replace(/\/+$/, '');
}

/** Only this site's own pages may call the session routes (with SameSite=Strict, belt and braces). */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === request.nextUrl.host;
  } catch {
    return false;
  }
}

export function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message, requestId: 'web' } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export const forbiddenOrigin = () => errorResponse(403, 'FORBIDDEN', 'Request not allowed.');

/**
 * The browser's address to pass on to the API, or null to pass none. Only with
 * `FORWARD_CLIENT_IP=true`, and then only the rightmost `X-Forwarded-For` entry: the one
 * the load balancer in front of the web servers wrote. Entries to its left are whatever
 * the client sent (Next fills the header in only when it is missing), so they are never
 * passed on. Turn it on only once the web servers accept traffic from the load balancer
 * alone, and their subnets are in the API's `TRUSTED_PROXY_CIDRS` (API guide §3s).
 */
export function forwardedClientIp(
  header: string | null,
  enabled = process.env.FORWARD_CLIENT_IP === 'true',
): string | null {
  if (!enabled || !header) return null;
  const last = header.split(',').at(-1)?.trim();
  return last ? last : null;
}

/** Calls the API on the person's behalf, passing on their address and browser for audit and rate limits. */
export async function callApi(
  request: NextRequest,
  path: string,
  options: { body?: unknown; accessToken?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
  const userAgent = request.headers.get('user-agent');
  if (userAgent) headers['user-agent'] = userAgent;
  const clientIp = forwardedClientIp(request.headers.get('x-forwarded-for'));
  if (clientIp) headers['x-forwarded-for'] = clientIp;

  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, {
      method: 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
    const body: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);
    return { status: response.status, body };
  } catch (error) {
    // Only a failure to connect proves the API never saw the request, so that a retry
    // cannot replay a refresh token it already rotated: 503 with `fields.api: unreachable`.
    // Anything else (a reset mid-request, a timeout) is a 502 the page must not retry.
    const unreachable = connectFailed(error);
    return {
      status: unreachable ? 503 : 502,
      body: {
        error: {
          code: 'INTERNAL',
          message: 'Could not reach the server. Try again.',
          requestId: 'web',
          ...(unreachable ? { fields: { api: UNREACHABLE } } : {}),
        },
      },
    };
  }
}

/** `fields.api` on a 503 from the session routes: the API was never reached. */
export const UNREACHABLE = 'unreachable';

/** Node's fetch (undici) error codes for a connection that was never made. */
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function connectFailed(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' && CONNECT_ERRORS.has(cause.code);
}

export function passThrough({ status, body }: { status: number; body: unknown }) {
  if (status === 204)
    return new NextResponse(null, { status, headers: { 'cache-control': 'no-store' } });
  return NextResponse.json(body ?? {}, { status, headers: { 'cache-control': 'no-store' } });
}

function isTokenPair(body: unknown): body is TokenPair {
  const b = body as Partial<TokenPair> | undefined;
  return (
    typeof b?.accessToken === 'string' &&
    typeof b.refreshToken === 'string' &&
    typeof b.expiresIn === 'number'
  );
}

/**
 * Turns an API token pair into a browser session: the refresh token goes into the cookie,
 * and only the access token (and its lifetime) is returned to the page.
 */
export function sessionResponse(
  request: NextRequest,
  result: { status: number; body: unknown },
  cookie: SessionCookie = STAFF_COOKIE,
) {
  if (result.status !== 200 || !isTokenPair(result.body)) return passThrough(result);
  const response = NextResponse.json(
    { accessToken: result.body.accessToken, expiresIn: result.body.expiresIn },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
  response.cookies.set(cookie.name, result.body.refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: request.nextUrl.protocol === 'https:' || process.env.NODE_ENV === 'production',
    path: cookie.path,
    maxAge: cookie.maxAgeSeconds,
  });
  return response;
}

export function clearSession<T extends NextResponse>(
  response: T,
  cookie: SessionCookie = STAFF_COOKIE,
): T {
  response.cookies.set(cookie.name, '', {
    httpOnly: true,
    sameSite: 'strict',
    path: cookie.path,
    maxAge: 0,
  });
  return response;
}

export async function readJson(request: NextRequest): Promise<unknown> {
  return request.json().catch(() => undefined);
}

/**
 * Ends a session at the API and clears its cookie, even if the API call fails. Uses the
 * page's access token when it still works; when there is none, or the API refuses it
 * (expired), gets a fresh one from the cookie first, so the session cannot outlive the
 * cookie being cleared.
 */
export async function endSession(
  request: NextRequest,
  cookie: SessionCookie,
  paths: { refresh: string; logout: string },
) {
  const header = request.headers.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const refreshToken = request.cookies.get(cookie.name)?.value;

  const loggedOut = bearer
    ? (await callApi(request, paths.logout, { accessToken: bearer })).status
    : 401;
  if (loggedOut === 401 && refreshToken) {
    const refreshed = await callApi(request, paths.refresh, { body: { refreshToken } });
    const accessToken = (refreshed.body as { accessToken?: string } | undefined)?.accessToken;
    if (refreshed.status === 200 && accessToken) {
      await callApi(request, paths.logout, { accessToken });
    }
  }

  return clearSession(
    new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
    cookie,
  );
}
