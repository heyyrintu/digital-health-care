import type { NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  readJson,
  sessionResponse,
} from '../../../../lib/session-server';

/** Completes a staff invite and signs the person straight in. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return sessionResponse(
    request,
    await callApi(request, '/auth/invites/complete', { body: await readJson(request) }),
  );
}
