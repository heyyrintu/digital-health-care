import {
  AcceptInviteResponse,
  AdminTestCatalogueItem,
  AdminTestCatalogueList,
  type CreateTestCatalogueItemBody,
  type ReorderTestCatalogueBody,
  type UpdateTestCatalogueItemBody,
  BookingOptions,
  ConsentStatus,
  DoctorProfile,
  OrganisationBranding,
  PublicBranding,
  type UpdateOrganisationBrandingBody,
  PublicDoctor,
  PublicDoctorDirectory,
  PublicDoctorList,
  type SaveDoctorPublicProfileBody,
  AwaitingReviewList,
  PatientTestOrderList,
  Referral,
  ReferralCounts,
  ReferralList,
  VisitReferralList,
  type CloseReferralBody,
  type CreateReferralBody,
  type ReferralListQuery,
  PortalAppointment,
  PortalAppointmentList,
  PortalPrescriptionList,
  PortalTestOrderList,
  TestCatalogueList,
  TestOrder,
  SlotsResponse,
  type PortalBookBody,
  type PortalSlotsQuery,
  PortalPatient,
  PortalPatientList,
  type AcceptConsentsBody,
  type CreatePortalPatientBody,
  CreatedPlatformOrganisation,
  ErrorResponse,
  HealthResponse,
  PlatformDoctorList,
  PlatformHealth,
  PlatformLoginResponse,
  PlatformMeResponse,
  PlatformOrganisationList,
  PlatformUsageReport,
  VerifiedPlatformDoctor,
  type CreatePlatformOrganisationBody,
  type PlatformLoginBody,
  type PlatformUsageQuery,
  type VerifyPlatformDoctorBody,
  InviteDetails,
  LoginResponse,
  MeResponse,
  OtpRequestResponse,
  TokenResponse,
  type LoginBody,
  type ErrorCode,
} from '@dhc/contracts';
import { z } from 'zod';

const NoContent = z.undefined();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly requestId: string | undefined,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Base URL including the version, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Returns the current access token, or null when signed out. */
  getAccessToken?: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

export interface RequestOptions<T extends z.ZodType> {
  schema: T;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Required on retryable writes (API guide §1); the same key replays the same result. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function request<T extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    { schema, body, query, idempotencyKey, signal }: RequestOptions<T>,
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const token = await options.getAccessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetchImpl(buildUrl(baseUrl, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    const payload: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response, payload);
    return schema.parse(payload);
  }

  /**
   * A server-sent event stream (the live queue). Calls `onEvent` for each event until the
   * server closes the stream or `signal` aborts; refusals throw ApiError like requests do.
   * Uses fetch rather than EventSource so the bearer token goes in a header.
   */
  async function stream(
    method: 'GET' | 'POST',
    path: string,
    {
      body,
      query,
      signal,
      onEvent,
    }: {
      body?: unknown;
      query?: RequestOptions<z.ZodType>['query'];
      signal?: AbortSignal;
      onEvent: (event: string, data: unknown) => void;
    },
  ): Promise<void> {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = await options.getAccessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(buildUrl(baseUrl, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      throw toApiError(response, await response.json().catch(() => undefined));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!block || block.startsWith(':')) continue;
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const raw = /^data: (.*)$/m.exec(block)?.[1];
        onEvent(event, parseData(raw));
      }
    }
  }

  /**
   * A file response: a PDF, or an uploaded result (pass a wider `accept`). Errors come back
   * as the usual JSON error shape.
   */
  async function requestFile(
    method: 'GET' | 'POST',
    path: string,
    {
      body,
      signal,
      accept = 'application/pdf, application/json',
    }: { body?: unknown; signal?: AbortSignal; accept?: string } = {},
  ): Promise<Blob> {
    const headers: Record<string, string> = { accept };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = await options.getAccessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(buildUrl(baseUrl, path, undefined), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw toApiError(response, await response.json().catch(() => undefined));
    }
    return response.blob();
  }

  /**
   * Sends a file as the request body (an uploaded result: PDF, JPEG, PNG or HEIC), typed by
   * the file's own type, and parses the JSON answer. Check `checkUpload` first so people
   * hear about the clinic's limits before a long upload.
   */
  async function uploadFile<T extends z.ZodType>(
    path: string,
    file: Blob,
    { schema, signal }: { schema: T; signal?: AbortSignal },
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': file.type || 'application/octet-stream',
    };
    const token = await options.getAccessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(buildUrl(baseUrl, path, undefined), {
      method: 'POST',
      headers,
      body: file,
      signal,
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response, payload);
    return schema.parse(payload);
  }

  return {
    request,
    requestFile,
    uploadFile,
    stream,
    getHealth: (signal?: AbortSignal) =>
      request('GET', '/health', { schema: HealthResponse, signal }),

    // Sign-in for the mobile apps (web signs in through its own session routes, ADR 0015).
    /** Patient: text a 6-digit code to this mobile number. */
    requestOtp: (organisation: string, phone: string) =>
      request('POST', '/auth/otp/request', {
        schema: OtpRequestResponse,
        body: { organisation, phone },
      }),
    verifyOtp: (challengeId: string, code: string) =>
      request('POST', '/auth/otp/verify', { schema: TokenResponse, body: { challengeId, code } }),
    /** Staff: password first; the authenticator code follows with `verifyMfa`. */
    login: (body: LoginBody) => request('POST', '/auth/login', { schema: LoginResponse, body }),
    verifyMfa: (mfaToken: string, code: string) =>
      request('POST', '/auth/mfa/verify', { schema: TokenResponse, body: { mfaToken, code } }),
    /** Single use: keep the new refresh token from the response. */
    refresh: (refreshToken: string) =>
      request('POST', '/auth/refresh', { schema: TokenResponse, body: { refreshToken } }),
    me: (signal?: AbortSignal) => request('GET', '/me', { schema: MeResponse, signal }),

    // Staff invite links (the token comes from the invite URL fragment).
    inspectInvite: (token: string) =>
      request('POST', '/auth/invites/inspect', { schema: InviteDetails, body: { token } }),
    acceptInvite: (token: string, password: string) =>
      request('POST', '/auth/invites/accept', {
        schema: AcceptInviteResponse,
        body: { token, password },
      }),
    completeInvite: (token: string, code: string) =>
      request('POST', '/auth/invites/complete', { schema: TokenResponse, body: { token, code } }),

    /** Clinic admin: revoke a pending staff invite. */
    revokeStaffInvite: (inviteId: string) =>
      request('POST', `/staff/invites/${encodeURIComponent(inviteId)}/revoke`, {
        schema: NoContent,
      }),

    /** Clinic admin: sign one staff device out. */
    revokeStaffSession: (sessionId: string) =>
      request('POST', `/staff/sessions/${encodeURIComponent(sessionId)}/revoke`, {
        schema: NoContent,
      }),

    /** Withdraw a weekly schedule that has not started yet. */
    deleteAvailabilityVersion: (id: string) =>
      request('DELETE', `/availability/versions/${encodeURIComponent(id)}`, {
        schema: NoContent,
      }),
    /** Remove leave, a holiday or an extra session that has not started yet. */
    deleteAvailabilityException: (id: string) =>
      request('DELETE', `/availability/exceptions/${encodeURIComponent(id)}`, {
        schema: NoContent,
      }),

    /** Clinic admin: stop a waiting-room screen link working. */
    revokeDisplayScreen: (id: string) =>
      request('POST', `/display-screens/${encodeURIComponent(id)}/revoke`, {
        schema: NoContent,
      }),

    /** Doctor: remove an allergy, condition or current medicine; the entry is kept with the reason. */
    removeChartEntry: (
      patientId: string,
      kind: 'allergies' | 'conditions' | 'medications',
      entryId: string,
      reason: string,
    ) =>
      request(
        'POST',
        `/patients/${encodeURIComponent(patientId)}/${kind}/${encodeURIComponent(entryId)}/remove`,
        { schema: NoContent, body: { reason } },
      ),

    /** Doctor: delete one of their prescription templates. */
    deletePrescriptionTemplate: (id: string) =>
      request('DELETE', `/prescription-templates/${encodeURIComponent(id)}`, {
        schema: NoContent,
      }),

    // Test orders (PRD §7.1). Lines are written with the prescription draft (`tests`).
    /** Doctor: the clinic's test catalogue, optionally filtered by name. */
    testCatalogue: (q?: string) =>
      request('GET', '/test-catalogue', { schema: TestCatalogueList, query: { q } }),
    /** Clinic admin: every catalogue test, active or not, in the clinic's order. */
    testCatalogueItems: () =>
      request('GET', '/test-catalogue/items', { schema: AdminTestCatalogueList }),
    /** Clinic admin: add a test. Send the same `idempotencyKey` when retrying one attempt. */
    createTestCatalogueItem: (body: CreateTestCatalogueItemBody, idempotencyKey?: string) =>
      request('POST', '/test-catalogue/items', {
        schema: AdminTestCatalogueItem,
        body,
        idempotencyKey,
      }),
    /** Clinic admin: rename, change regions or views, or (de)activate; orders keep theirs. */
    updateTestCatalogueItem: (id: string, body: UpdateTestCatalogueItemBody) =>
      request('PATCH', `/test-catalogue/items/${encodeURIComponent(id)}`, {
        schema: AdminTestCatalogueItem,
        body,
      }),
    /** Clinic admin: one kind's tests in a new order (all of them, each once). */
    reorderTestCatalogue: (body: ReorderTestCatalogueBody) =>
      request('POST', '/test-catalogue/items/reorder', { schema: AdminTestCatalogueList, body }),
    /** Doctor or front desk: a patient's ordered tests (front desk: without notes). */
    /** One page, newest first; pass the previous page's `nextCursor` for the next. */
    patientTestOrders: (patientId: string, cursor?: string) =>
      request('GET', `/patients/${encodeURIComponent(patientId)}/test-orders`, {
        schema: PatientTestOrderList,
        query: { cursor },
      }),
    /** Doctor: their results waiting for review. */
    testResultsAwaitingReview: () =>
      request('GET', '/test-orders/awaiting-review', { schema: AwaitingReviewList }),
    /** Doctor or front desk: upload a result (the file's own type) for an ordered test. */
    uploadTestResult: (orderId: string, file: Blob) =>
      uploadFile(`/test-orders/${encodeURIComponent(orderId)}/results`, file, {
        schema: TestOrder,
      }),
    /** Doctor: mark the uploaded result reviewed. */
    reviewTestOrder: (orderId: string) =>
      request('POST', `/test-orders/${encodeURIComponent(orderId)}/review`, { schema: TestOrder }),
    /** Doctor: one result's file. */
    testResultFile: (resultId: string) =>
      requestFile('GET', `/test-results/${encodeURIComponent(resultId)}/file`, { accept: '*/*' }),

    // Referrals (PRD §7.2). Doctors only.
    /** The visit's doctor: refer the patient. Send the same `idempotencyKey` when retrying. */
    createReferral: (appointmentId: string, body: CreateReferralBody, idempotencyKey?: string) =>
      request('POST', `/appointments/${encodeURIComponent(appointmentId)}/referrals`, {
        schema: Referral,
        body,
        idempotencyKey,
      }),
    /** The referrals made at a visit that the signed-in doctor sent or received. */
    visitReferrals: (appointmentId: string) =>
      request('GET', `/appointments/${encodeURIComponent(appointmentId)}/referrals`, {
        schema: VisitReferralList,
      }),
    /** One page of received or sent referrals, newest first. */
    referrals: (query: {
      box: ReferralListQuery['box'];
      status?: ReferralListQuery['status'];
      cursor?: string;
      limit?: number;
    }) => request('GET', '/referrals', { schema: ReferralList, query: { ...query } }),
    /** New and open referrals, for the dashboard. */
    referralCounts: () => request('GET', '/referrals/counts', { schema: ReferralCounts }),
    referral: (id: string) =>
      request('GET', `/referrals/${encodeURIComponent(id)}`, { schema: Referral }),
    /** The receiving doctor opened it: sent becomes seen (no change otherwise). */
    markReferralSeen: (id: string) =>
      request('POST', `/referrals/${encodeURIComponent(id)}/seen`, { schema: Referral }),
    closeReferral: (id: string, body: CloseReferralBody) =>
      request('POST', `/referrals/${encodeURIComponent(id)}/close`, { schema: Referral, body }),

    /** Doctor: set or change the signing PIN, confirmed with the account password. */
    setSigningPin: (password: string, pin: string) =>
      request('PUT', '/doctor-profile/signing-pin', { schema: NoContent, body: { password, pin } }),
    /** Doctor: the public page's address, listing, about and languages (only fields sent change). */
    saveDoctorPublicProfile: (body: SaveDoctorPublicProfileBody) =>
      request('PATCH', '/doctor-profile/public', { schema: DoctorProfile, body }),
    // Public website (no sign-in).
    /** A listed, verified doctor's public page; 404 for any other address. */
    publicDoctor: (slug: string) =>
      request('GET', `/public/doctors/${encodeURIComponent(slug)}`, { schema: PublicDoctor }),
    /** Every public doctor page shown: address and last change (a sitemap). */
    publicDoctors: () => request('GET', '/public/doctors', { schema: PublicDoctorList }),
    /** Every public doctor page shown, as cards for the home page's directory (at most 500). */
    publicDoctorDirectory: ({ signal }: { signal?: AbortSignal } = {}) =>
      request('GET', '/public/doctor-directory', { schema: PublicDoctorDirectory, signal }),
    /** An active organisation's saved branding (the portal's sign-in); 404 when it has none. */
    publicBranding: (slug: string, { signal }: { signal?: AbortSignal } = {}) =>
      request('GET', `/public/organisations/${encodeURIComponent(slug)}/branding`, {
        schema: PublicBranding,
        signal,
      }),
    // Clinic admin: the organisation's branding.
    organisationBranding: () =>
      request('GET', '/organisation-branding', { schema: OrganisationBranding }),
    saveOrganisationBranding: (body: UpdateOrganisationBrandingBody) =>
      request('PUT', '/organisation-branding', { schema: OrganisationBranding, body }),
    /** The logo file itself: PNG, JPEG or WebP, up to 512 KB (check `LOGO_MAX_BYTES` first). */
    uploadOrganisationLogo: (file: Blob) =>
      uploadFile('/organisation-branding/logo', file, { schema: OrganisationBranding }),
    deleteOrganisationLogo: () =>
      request('DELETE', '/organisation-branding/logo', { schema: OrganisationBranding }),
    // Patient app and web portal (patients only).
    portalConsents: () => request('GET', '/portal/consents', { schema: ConsentStatus }),
    acceptConsents: (accept: AcceptConsentsBody['accept']) =>
      request('POST', '/portal/consents', { schema: ConsentStatus, body: { accept } }),
    withdrawHealthDataConsent: () =>
      request('POST', '/portal/consents/health_data/withdraw', { schema: ConsentStatus }),
    portalPatients: () => request('GET', '/portal/patients', { schema: PortalPatientList }),
    addPortalPatient: (body: CreatePortalPatientBody) =>
      request('POST', '/portal/patients', { schema: PortalPatient, body }),
    bookingOptions: () => request('GET', '/portal/booking-options', { schema: BookingOptions }),
    portalSlots: (query: PortalSlotsQuery) =>
      request('GET', '/portal/slots', { schema: SlotsResponse, query: { ...query } }),
    portalAppointments: () =>
      request('GET', '/portal/appointments', { schema: PortalAppointmentList }),
    /** Send the same `idempotencyKey` when retrying one booking attempt. */
    bookPortalAppointment: (body: PortalBookBody, idempotencyKey?: string) =>
      request('POST', '/portal/appointments', { schema: PortalAppointment, body, idempotencyKey }),
    cancelPortalAppointment: (id: string, reason?: string) =>
      request('POST', `/portal/appointments/${encodeURIComponent(id)}/cancel`, {
        schema: PortalAppointment,
        body: reason ? { reason } : {},
      }),
    portalPrescriptions: () =>
      request('GET', '/portal/prescriptions', { schema: PortalPrescriptionList }),
    /** The signed PDF of one of the family's prescriptions. */
    portalPrescriptionPdf: (id: string) =>
      requestFile('GET', `/portal/prescriptions/${encodeURIComponent(id)}/pdf`),

    /** The family's ordered tests, with Upload result. */
    portalTestOrders: (cursor?: string) =>
      request('GET', '/portal/test-orders', { schema: PortalTestOrderList, query: { cursor } }),
    uploadPortalTestResult: (orderId: string, file: Blob) =>
      uploadFile(`/portal/test-orders/${encodeURIComponent(orderId)}/results`, file, {
        schema: TestOrder,
      }),
    portalTestResultFile: (resultId: string) =>
      requestFile('GET', `/portal/test-results/${encodeURIComponent(resultId)}/file`, {
        accept: '*/*',
      }),

    /** Ends the session of the current access token. */
    logout: () => request('POST', '/auth/logout', { schema: NoContent }),

    // Platform console (platform operators only; its own tokens, which clinic endpoints refuse).
    platform: {
      /** Password first; the authenticator code follows with `verifyMfa`. */
      login: (body: PlatformLoginBody) =>
        request('POST', '/platform/auth/login', { schema: PlatformLoginResponse, body }),
      verifyMfa: (mfaToken: string, code: string) =>
        request('POST', '/platform/auth/mfa/verify', {
          schema: TokenResponse,
          body: { mfaToken, code },
        }),
      /** Single use: keep the new refresh token from the response. */
      refresh: (refreshToken: string) =>
        request('POST', '/platform/auth/refresh', {
          schema: TokenResponse,
          body: { refreshToken },
        }),
      logout: () => request('POST', '/platform/auth/logout', { schema: NoContent }),
      me: () => request('GET', '/platform/me', { schema: PlatformMeResponse }),
      organisations: () =>
        request('GET', '/platform/organisations', { schema: PlatformOrganisationList }),
      /** Onboarding: the response carries the first admin's invite link, shown once. */
      createOrganisation: (body: CreatePlatformOrganisationBody) =>
        request('POST', '/platform/organisations', { schema: CreatedPlatformOrganisation, body }),
      /** One page of the queue; pass the previous page's `nextCursor` for the next. */
      doctors: (status: 'pending' | 'verified' = 'pending', cursor?: string) =>
        request('GET', '/platform/doctors', {
          schema: PlatformDoctorList,
          query: { status, cursor },
        }),
      /** `expected`: the registration details the queue showed and the operator checked. */
      verifyDoctor: (profileId: string, body: VerifyPlatformDoctorBody) =>
        request('POST', `/platform/doctors/${encodeURIComponent(profileId)}/verify`, {
          schema: VerifiedPlatformDoctor,
          body,
        }),
      usage: (query: PlatformUsageQuery = {}) =>
        request('GET', '/platform/usage', { schema: PlatformUsageReport, query: { ...query } }),
      /** API, database and background queues: status and counts only. */
      health: () => request('GET', '/platform/health', { schema: PlatformHealth }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function buildUrl(baseUrl: string, path: string, query: RequestOptions<z.ZodType>['query']) {
  const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function toApiError(response: Response, payload: unknown): ApiError {
  const parsed = ErrorResponse.safeParse(payload);
  if (parsed.success) {
    const { code, message, fields, requestId } = parsed.data.error;
    return new ApiError(response.status, code, message, requestId, fields);
  }
  return new ApiError(
    response.status,
    response.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL',
    'Something went wrong. Please try again.',
    response.headers.get('x-request-id') ?? undefined,
  );
}

function parseData(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
