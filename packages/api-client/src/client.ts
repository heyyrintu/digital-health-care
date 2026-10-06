import { ErrorResponse, HealthResponse, type ErrorCode } from '@dhc/contracts';
import type { z } from 'zod';

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

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response, payload);
    return schema.parse(payload);
  }

  return {
    request,
    getHealth: (signal?: AbortSignal) =>
      request('GET', '/health', { schema: HealthResponse, signal }),
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
