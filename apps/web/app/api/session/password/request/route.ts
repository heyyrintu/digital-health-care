import { NextResponse, type NextRequest } from 'next/server';
import {
  callApi,
  forbiddenOrigin,
  isSameOrigin,
  readJson,
} from '../../../../../lib/session-server';
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const result = await callApi(request, '/auth/password/request', {
    body: await readJson(request),
  });
  const response =
    result.status === 204
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json(result.body, { status: result.status });
  response.headers.set('cache-control', 'no-store');
  return response;
}
