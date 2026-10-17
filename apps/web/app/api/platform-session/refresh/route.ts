import type { NextRequest } from 'next/server';
import {
  PLATFORM_COOKIE,
  callApi,
  clearSession,
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  sessionResponse,
} from '../../../../lib/session-server';

/**
 * Exchanges the console's session cookie for a fresh access token, rotating the refresh
 * token. Reads only the platform cookie: a clinic session is never used here.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const refreshToken = request.cookies.get(PLATFORM_COOKIE.name)?.value;
  if (!refreshToken) return errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.');

  const result = await callApi(request, '/platform/auth/refresh', { body: { refreshToken } });
  const response = sessionResponse(request, result, PLATFORM_COOKIE);
  // A refused refresh (expired, revoked, reused) ends the browser session too.
  return result.status === 401 ? clearSession(response, PLATFORM_COOKIE) : response;
}
