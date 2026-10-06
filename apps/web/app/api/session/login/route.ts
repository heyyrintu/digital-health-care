import type { NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  passThrough,
  readJson,
} from '../../../../lib/session-server';

/** Password step. Returns the short-lived MFA token; no session yet. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return passThrough(await callApi(request, '/auth/login', { body: await readJson(request) }));
}
