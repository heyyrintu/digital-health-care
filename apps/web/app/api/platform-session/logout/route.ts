import type { NextRequest } from 'next/server';
import {
  PLATFORM_COOKIE,
  endSession,
  forbiddenOrigin,
  isSameOrigin,
} from '../../../../lib/session-server';

/**
 * Ends the console session at the API and clears its cookie, even if the API call fails. An
 * expired access token from the page is replaced from the cookie first (`endSession`).
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return endSession(request, PLATFORM_COOKIE, {
    refresh: '/platform/auth/refresh',
    logout: '/platform/auth/logout',
  });
}
