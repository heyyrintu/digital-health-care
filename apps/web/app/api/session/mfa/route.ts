import type { NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  readJson,
  sessionResponse,
} from '../../../../lib/session-server';

/** Authenticator step. On success, starts the browser session. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return sessionResponse(
    request,
    await callApi(request, '/auth/mfa/verify', { body: await readJson(request) }),
  );
}
