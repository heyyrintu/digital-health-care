import type { NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  passThrough,
  readJson,
} from '../../../../../lib/session-server';

/** Patient sign-in, first step: the API texts a 6-digit code. Returns the challenge; no session yet. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return passThrough(
    await callApi(request, '/auth/otp/request', { body: await readJson(request) }),
  );
}
