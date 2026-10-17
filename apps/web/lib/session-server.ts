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
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

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
  } catch {
    return {
      status: 502,
      body: {
        error: {
          code: 'INTERNAL',
          message: 'Could not reach the server. Try again.',
          requestId: 'web',
        },
      },
    };
  }
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
