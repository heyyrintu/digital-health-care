import { ApiError } from '@dhc/api-client';
import { ErrorResponse } from '@dhc/contracts';

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
}

/** Signs staff out after this long without activity (Build Plan §6.1). */
export const IDLE_TIMEOUT_MS = 15 * 60_000;
/** Refresh this long before the access token expires. */
export const REFRESH_LEAD_MS = 60_000;

/**
 * Calls this site's own session routes (`/api/session/*`), which hold the refresh token
 * in an httpOnly cookie. Non-2xx responses become the same `ApiError` the API client uses.
 */
export function postSession<T>(
  path: 'login' | 'mfa' | 'invite' | 'refresh' | 'logout',
  body?: unknown,
  accessToken?: string,
): Promise<T> {
  return postTo<T>(`/api/session/${path}`, body, accessToken);
}

/**
 * The platform console's session routes (`/api/platform-session/*`): a separate cookie,
 * so console and clinic sessions never stand in for each other.
 */
export function postPlatformSession<T>(
  path: 'login' | 'mfa' | 'refresh' | 'logout',
  body?: unknown,
  accessToken?: string,
): Promise<T> {
  return postTo<T>(`/api/platform-session/${path}`, body, accessToken);
}

/**
 * The patient portal's session routes (`/api/patient-session/*`): sign-in by SMS code, and
 * a cookie of its own, so patient and staff sessions never stand in for each other.
 */
export function postPatientSession<T>(
  path: 'otp/request' | 'otp/verify' | 'refresh' | 'logout',
  body?: unknown,
  accessToken?: string,
): Promise<T> {
  return postTo<T>(`/api/patient-session/${path}`, body, accessToken);
}

async function postTo<T>(url: string, body?: unknown, accessToken?: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    // A sign-out still reaches the server when the page is closed or navigates right after.
    keepalive: url.endsWith('/logout'),
  });
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = ErrorResponse.safeParse(payload);
    if (parsed.success) {
      const { code, message, requestId, fields } = parsed.data.error;
      throw new ApiError(response.status, code, message, requestId, fields);
    }
    throw new ApiError(
      response.status,
      'INTERNAL',
      'Something went wrong. Please try again.',
      undefined,
    );
  }
  return payload as T;
}

/** When to refresh, given the token lifetime in seconds (never sooner than 10 s). */
export function refreshDelayMs(expiresInSeconds: number): number {
  return Math.max(10_000, expiresInSeconds * 1000 - REFRESH_LEAD_MS);
}

/** Roles offered when a person holds several (`fields.role` is a comma-separated list). */
export function rolesFromField(field: string | undefined): string[] {
  return (field ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r === 'doctor' || r === 'front_desk' || r === 'clinic_admin');
}
