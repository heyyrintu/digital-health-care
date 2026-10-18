import type { NextRequest } from 'next/server';
import {
  PATIENT_COOKIE,
  PATIENT_KEEP_COOKIE,
  callApi,
  clearPatientSession,
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  patientSessionResponse,
} from '../../../../lib/session-server';

/**
 * Exchanges the portal's session cookie for a fresh access token, rotating the refresh
 * token, and keeps the lifetime the patient chose at sign-in. Reads only the patient
 * cookies: a staff session is never used here.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const refreshToken = request.cookies.get(PATIENT_COOKIE.name)?.value;
  if (!refreshToken) return errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.');

  const keep = request.cookies.get(PATIENT_KEEP_COOKIE.name)?.value === '1';
  const result = await callApi(request, '/auth/refresh', { body: { refreshToken } });
  const response = patientSessionResponse(request, result, keep);
  // A refused refresh (expired, revoked, reused) ends the browser session too.
  return result.status === 401 ? clearPatientSession(response) : response;
}
