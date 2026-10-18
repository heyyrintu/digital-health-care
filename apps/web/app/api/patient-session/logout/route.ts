import type { NextRequest } from 'next/server';
import {
  PATIENT_COOKIE,
  clearPatientSession,
  endSession,
  forbiddenOrigin,
  isSameOrigin,
} from '../../../../lib/session-server';

/**
 * Ends the patient's session at the API and clears its cookies, even if the API call
 * fails. An expired or missing access token is replaced from the cookie first
 * (`endSession`), which is how a stale session found on reload is ended.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  return clearPatientSession(
    await endSession(request, PATIENT_COOKIE, { refresh: '/auth/refresh', logout: '/auth/logout' }),
  );
}
