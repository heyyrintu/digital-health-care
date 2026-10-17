import { NextResponse, type NextRequest } from 'next/server';
import {
  PLATFORM_COOKIE,
  callApi,
  clearSession,
  forbiddenOrigin,
  isSameOrigin,
} from '../../../../lib/session-server';

/** Ends the console session at the API and clears its cookie, even if the API call fails. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const header = request.headers.get('authorization');
  let accessToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  const refreshToken = request.cookies.get(PLATFORM_COOKIE.name)?.value;
  if (!accessToken && refreshToken) {
    // The page lost its access token (e.g. reload): get one so the session can be ended.
    const refreshed = await callApi(request, '/platform/auth/refresh', { body: { refreshToken } });
    const body = refreshed.body as { accessToken?: string } | undefined;
    if (refreshed.status === 200) accessToken = body?.accessToken;
  }
  if (accessToken) await callApi(request, '/platform/auth/logout', { accessToken });

  return clearSession(
    new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
    PLATFORM_COOKIE,
  );
}
