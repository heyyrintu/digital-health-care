import { createApiClient } from '@dhc/api-client';
import { API_BASE_URL } from './config';
import { expiringFetch, SessionManager } from './auth/session';
import { secureVault } from './auth/vault';
import { PatientAccount } from './patient/account';
import { clearPickedFiles, prescriptionPdfs, testResultFiles } from './patient/pdf-native';
import { clearOnSignOut } from './patient/upload';

/** Sign-in calls, which carry no session. */
export const publicApi = createApiClient({ baseUrl: API_BASE_URL });

const withToken = (token: string) =>
  createApiClient({ baseUrl: API_BASE_URL, getAccessToken: () => token });

export const session = new SessionManager(secureVault, {
  refresh: (refreshToken) => publicApi.refresh(refreshToken),
  me: (token) => withToken(token).me(),
  logout: (token) => withToken(token).logout(),
});

/** Every signed-in call; a 401 (session revoked or signed out elsewhere) signs this device out. */
export const api = createApiClient({
  baseUrl: API_BASE_URL,
  getAccessToken: () => session.getAccessToken(),
  fetch: expiringFetch(globalThis.fetch.bind(globalThis), (token) => void session.expire(token)),
});

/** The signed-in patient's account and family (Patient app). */
export const patientAccount = new PatientAccount({
  consents: () => api.portalConsents(),
  patients: async () => (await api.portalPatients()).data,
});
// A new sign-in starts with a fresh family, and no PDF or test result opened, nor a file
// picked to upload, in the last session is left in the cache (threat model T24).
session.subscribe(() => {
  clearOnSignOut(session.getState().status, {
    account: patientAccount,
    caches: [prescriptionPdfs, testResultFiles],
    clearPicked: clearPickedFiles,
  });
});
