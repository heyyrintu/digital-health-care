import type { NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  patientSessionResponse,
  readJson,
} from '../../../../../lib/session-server';

/**
 * Patient sign-in, second step: the code. On success, starts the portal's own browser
 * session: until the browser closes, or 30 days when the patient ticked "Keep me signed
 * in" (`keep`, which the web app reads and never sends to the API).
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const { keep, ...body } = ((await readJson(request)) ?? {}) as Record<string, unknown>;
  return patientSessionResponse(
    request,
    await callApi(request, '/auth/otp/verify', { body }),
    keep === true,
  );
}
