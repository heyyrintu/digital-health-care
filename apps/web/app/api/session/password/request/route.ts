import { type NextRequest } from 'next/server';
import {
  callApi,
  passThrough,
  forbiddenOrigin,
  isSameOrigin,
  readJson,
} from '../../../../../lib/session-server';
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return forbiddenOrigin();
  const result = await callApi(request, '/auth/password/request', {
    body: await readJson(request),
  });
  const response = passThrough(result);
  return response;
}
