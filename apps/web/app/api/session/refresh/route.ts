import type { NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  callApi,
  clearSession,
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  sessionResponse,
} from '../../../../lib/session-server';

/** Exchanges the session cookie for a fresh access token, rotating the refresh token. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const refreshToken = request.cookies.get(SESSION_COOKIE)?.value;
  if (!refreshToken) return errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.');

  const result = await callApi(request, '/auth/refresh', { body: { refreshToken } });
  const response = sessionResponse(request, result);
  // A refused refresh (expired, revoked, reused) ends the browser session too.
  return result.status === 401 ? clearSession(response) : response;
}
