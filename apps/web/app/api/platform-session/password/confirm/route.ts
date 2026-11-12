import { NextResponse, type NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  readJson,
  clearSession,
  PLATFORM_COOKIE,
} from '../../../../../lib/session-server';
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const result = await callApi(request, '/platform/auth/password/confirm', {
    body: await readJson(request),
  });
  const response =
    result.status === 204
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json(result.body, { status: result.status });
  response.headers.set('cache-control', 'no-store');
  return result.status === 204 ? clearSession(response, PLATFORM_COOKIE) : response;
}
