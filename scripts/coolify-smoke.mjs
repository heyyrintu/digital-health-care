// Destructive only to fresh synthetic demo invitations. CI/local deployment rehearsal.
// Uses the real invite, MFA, secure session cookie, refresh and protected API routes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { totpAt } from '../apps/api/src/auth/totp.ts';

assert.equal(
  process.env.DHC_SYNTHETIC_SMOKE,
  '1',
  'Set DHC_SYNTHETIC_SMOKE=1 only for an isolated synthetic stack.',
);
const [transport, origin, inviteFile] = process.argv.slice(2);
assert.ok(
  transport && origin && inviteFile,
  'Supply transport URL, public origin and private synthetic invite file.',
);
const content = await readFile(inviteFile, 'utf8');
const token = content.match(/frontdesk@demo-clinic\.test[^\n]*\/invite#([A-Za-z0-9_-]+)/)?.[1];
assert.ok(token, 'Expected the synthetic front-desk invitation.');
const password = `synthetic-${randomBytes(24).toString('hex')}`;
const host = new URL(origin).host;
const call = (path, body, extra = {}) =>
  fetch(`${transport}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      host,
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
const json = async (response, status = 200) => {
  assert.equal(response.status, status, 'Unexpected deployment HTTP status.');
  return response.json();
};
const wrongOrigin = await call('/api/session/login', {}, { origin: 'https://untrusted.example' });
assert.equal(wrongOrigin.status, 403);
const accepted = await json(await call('/v1/auth/invites/accept', { token, password }));
assert.equal(accepted.status, 'setup_required');
const secret = new URL(accepted.otpauthUri).searchParams.get('secret');
assert.ok(secret);
const response = await call('/api/session/invite', {
  token,
  code: totpAt(secret, Date.now() / 1000),
});
const completed = await json(response);
assert.ok(completed.accessToken);
assert.equal(completed.refreshToken, undefined, 'Refresh token must stay in the HttpOnly cookie.');
const setCookie = response.headers.get('set-cookie');
assert.match(setCookie, /HttpOnly/i);
assert.match(setCookie, /Secure/i);
assert.match(setCookie, /SameSite=Strict/i);
assert.match(setCookie, /Path=\/api\/session/i);
const cookie = setCookie.split(';')[0];
const patients = await json(
  await call('/v1/patients', undefined, { authorization: `Bearer ${completed.accessToken}` }),
);
assert.equal(patients.data.length, 6);
const refreshed = await json(await call('/api/session/refresh', {}, { cookie }));
assert.ok(refreshed.accessToken);
const login = await json(
  await call('/api/session/login', {
    organisation: 'demo-clinic',
    identifier: 'frontdesk@demo-clinic.test',
    password,
  }),
);
assert.equal(login.status, 'mfa_required');
const signedIn = await json(
  await call('/api/session/mfa', {
    mfaToken: login.mfaToken,
    code: totpAt(secret, Date.now() / 1000 + 30),
  }),
);
assert.ok(signedIn.accessToken);
console.warn(
  'Deployment smoke passed: invite, MFA, secure cookie, protected patients, refresh, login and origin rejection.',
);
