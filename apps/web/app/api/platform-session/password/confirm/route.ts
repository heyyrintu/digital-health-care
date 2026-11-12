import { type NextRequest } from 'next/server';
import {
  callApi,
  passThrough,
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
  const response = passThrough(result);
  return result.status === 204 ? clearSession(response, PLATFORM_COOKIE) : response;
}
