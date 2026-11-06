import type { NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  sessionResponse,
  PLATFORM_COOKIE,
  readJson,
} from '../../../../lib/session-server';

/** Platform console password step. Sets a browser session only when the configured policy completes sign-in. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return sessionResponse(
    request,
    await callApi(request, '/platform/auth/login', { body: await readJson(request) }),
    PLATFORM_COOKIE,
  );
}
