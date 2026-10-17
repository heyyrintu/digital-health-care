import type { NextRequest } from 'next/server';
import {
  PLATFORM_COOKIE,
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  readJson,
  sessionResponse,
} from '../../../../lib/session-server';

/** Platform console authenticator step. On success, starts the console's own browser session. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return sessionResponse(
    request,
    await callApi(request, '/platform/auth/mfa/verify', { body: await readJson(request) }),
    PLATFORM_COOKIE,
  );
}
