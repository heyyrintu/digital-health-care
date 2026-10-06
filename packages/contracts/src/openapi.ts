import { z } from 'zod';
import { AuditListResponse } from './audit';
import {
  LoginBody,
  LoginResponse,
  MeResponse,
  MfaVerifyBody,
  OtpRequestBody,
  OtpRequestResponse,
  OtpVerifyBody,
  RefreshBody,
  TokenResponse,
} from './auth';
import { ErrorResponse } from './errors';
import {
  AcceptInviteBody,
  AcceptInviteResponse,
  CompleteInviteBody,
  CreateStaffInviteBody,
  CreatedStaffInvite,
  InviteDetails,
  InviteTokenBody,
  StaffInviteList,
} from './invites';
import { HealthResponse } from './health';
import { CursorQuery } from './pagination';
import { PatientListQuery, PatientListResponse, PatientSummary } from './patients';

interface Operation {
  method: 'get' | 'post';
  path: string;
  operationId: string;
  summary: string;
  /** Endpoints without auth are listed explicitly; everything else needs a bearer token. */
  public?: boolean;
  body?: z.ZodType;
  query?: z.ZodObject;
  pathParams?: string[];
  response?: z.ZodType;
  /** Success status; defaults to 200. 204 has no body. */
  status?: 200 | 201 | 204;
}

/** Every endpoint, in one list. Field detail always comes from the Zod schemas. */
const operations: Operation[] = [
  {
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Service health',
    public: true,
    response: HealthResponse,
  },
  {
    method: 'post',
    path: '/auth/otp/request',
    operationId: 'requestOtp',
    summary: 'Send a sign-in code to a patient mobile',
    public: true,
    body: OtpRequestBody,
    response: OtpRequestResponse,
  },
  {
    method: 'post',
    path: '/auth/otp/verify',
    operationId: 'verifyOtp',
    summary: 'Exchange a sign-in code for tokens',
    public: true,
    body: OtpVerifyBody,
    response: TokenResponse,
  },
  {
    method: 'post',
    path: '/auth/login',
    operationId: 'login',
    summary: 'Staff password step',
    public: true,
    body: LoginBody,
    response: LoginResponse,
  },
  {
    method: 'post',
    path: '/auth/mfa/verify',
    operationId: 'verifyMfa',
    summary: 'Staff authenticator-code step',
    public: true,
    body: MfaVerifyBody,
    response: TokenResponse,
  },
  {
    method: 'post',
    path: '/auth/invites/inspect',
    operationId: 'inspectInvite',
    summary: 'Show who an invite is for',
    public: true,
    body: InviteTokenBody,
    response: InviteDetails,
  },
  {
    method: 'post',
    path: '/auth/invites/accept',
    operationId: 'acceptInvite',
    summary: 'Set or confirm the password for an invite',
    public: true,
    body: AcceptInviteBody,
    response: AcceptInviteResponse,
  },
  {
    method: 'post',
    path: '/auth/invites/complete',
    operationId: 'completeInvite',
    summary: 'Confirm the authenticator code and sign in',
    public: true,
    body: CompleteInviteBody,
    response: TokenResponse,
  },
  {
    method: 'post',
    path: '/auth/refresh',
    operationId: 'refreshTokens',
    summary: 'Rotate the refresh token',
    public: true,
    body: RefreshBody,
    response: TokenResponse,
  },
  {
    method: 'post',
    path: '/auth/logout',
    operationId: 'logout',
    summary: 'End this session',
    status: 204,
  },
  {
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: 'Signed-in user, organisation and role',
    response: MeResponse,
  },
  {
    method: 'get',
    path: '/patients',
    operationId: 'listPatients',
    summary: 'Search patients (staff)',
    query: PatientListQuery,
    response: PatientListResponse,
  },
  {
    method: 'get',
    path: '/patients/{id}',
    operationId: 'getPatient',
    summary: 'Patient summary (staff; view is audited)',
    pathParams: ['id'],
    response: PatientSummary,
  },
  {
    method: 'post',
    path: '/staff/invites',
    operationId: 'createStaffInvite',
    summary: 'Invite a staff member (clinic admin)',
    body: CreateStaffInviteBody,
    response: CreatedStaffInvite,
    status: 201,
  },
  {
    method: 'get',
    path: '/staff/invites',
    operationId: 'listStaffInvites',
    summary: 'Recent staff invites (clinic admin)',
    response: StaffInviteList,
  },
  {
    method: 'post',
    path: '/staff/invites/{id}/revoke',
    operationId: 'revokeStaffInvite',
    summary: 'Revoke a pending invite (clinic admin)',
    pathParams: ['id'],
    status: 204,
  },
  {
    method: 'get',
    path: '/audit-log',
    operationId: 'listAuditLog',
    summary: 'Audit log (clinic admin)',
    query: CursorQuery,
    response: AuditListResponse,
  },
];

const errorResponse = {
  description: 'Error',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};

export function buildOpenApiDocument(options: { version: string; serverUrl?: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const status = op.status ?? 200;
    const parameters = [
      ...(op.pathParams ?? []).map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      })),
      ...queryParameters(op.query),
    ];
    paths[op.path] ??= {};
    paths[op.path]![op.method] = {
      operationId: op.operationId,
      summary: op.summary,
      ...(op.public ? { security: [] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toSchema(op.body, 'input') } },
            },
          }
        : {}),
      responses: {
        [String(status)]:
          status === 204 || !op.response
            ? { description: 'No content' }
            : {
                description: status === 201 ? 'Created' : 'OK',
                content: { 'application/json': { schema: toSchema(op.response) } },
              },
        default: errorResponse,
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Digital Healthcare Platform API', version: options.version },
    servers: options.serverUrl ? [{ url: options.serverUrl }] : [],
    paths,
    components: {
      schemas: { ErrorResponse: toSchema(ErrorResponse) },
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearerAuth: [] }],
  };
}

function queryParameters(query: z.ZodObject | undefined) {
  if (!query) return [];
  const schema = toSchema(query, 'input') as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
    name,
    in: 'query',
    required: schema.required?.includes(name) ?? false,
    schema: prop,
  }));
}

/** JSON Schema 2020-12 (the dialect OpenAPI 3.1 uses), without the top-level `$schema`. */
function toSchema(schema: z.ZodType, io: 'input' | 'output' = 'output') {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  return rest;
}
