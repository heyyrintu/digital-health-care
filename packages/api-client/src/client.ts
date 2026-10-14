import {
  AcceptInviteResponse,
  ErrorResponse,
  HealthResponse,
  InviteDetails,
  TokenResponse,
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

  /** A file response (a PDF); errors come back as the usual JSON error shape. */
  async function requestFile(
    method: 'GET' | 'POST',
    path: string,
    { body, signal }: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Blob> {
    const headers: Record<string, string> = { accept: 'application/pdf, application/json' };
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

  return {
    request,
    requestFile,
    stream,
    getHealth: (signal?: AbortSignal) =>
      request('GET', '/health', { schema: HealthResponse, signal }),

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

    /** Doctor: set or change the signing PIN, confirmed with the account password. */
    setSigningPin: (password: string, pin: string) =>
      request('PUT', '/doctor-profile/signing-pin', { schema: NoContent, body: { password, pin } }),
    /** Ends the session of the current access token. */
    logout: () => request('POST', '/auth/logout', { schema: NoContent }),
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
