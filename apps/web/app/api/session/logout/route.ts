import type { NextRequest } from 'next/server';
import {
  STAFF_COOKIE,
  endSession,
  forbiddenOrigin,
  isSameOrigin,
} from '../../../../lib/session-server';

/**
 * Ends the session at the API and clears its cookie, even if the API call fails. An
 * expired access token from the page is replaced from the cookie first (`endSession`).
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return endSession(request, STAFF_COOKIE, {
    refresh: '/auth/refresh',
    logout: '/auth/logout',
  });
}
