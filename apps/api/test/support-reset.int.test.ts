import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { totpAt } from '../src/auth/totp';
import { supportResetAuthenticator, type SupportResetParams } from '../src/modules/support/service';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;

const source = {
  id: 'support-cli-test',
  ip: 'support-cli',
  headers: { 'user-agent': 'support-cli' },
};
const NEW_PASSWORD = 'a fresh synthetic passphrase';
const post = (url: string, payload?: unknown) =>
  h.app.inject({ method: 'POST', url: `/v1${url}`, payload: payload as object });

const params = (overrides: Partial<SupportResetParams> = {}): SupportResetParams => ({
  identifier: clinics.b.doctor.email,
  clinic: 'clinic-a',
  ticket: 'SUP-1001',
  operator: 'support@platform.test',
  reason: 'Lost phone; identity confirmed by callback',
  ...overrides,
});
const run = (overrides?: Partial<SupportResetParams>) =>
  supportResetAuthenticator(h.services, source, params(overrides));

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  // Clinic B's doctor also works at clinic A, so neither clinic admin may reset them.
  await h.owner.membership.create({
    data: { organisationId: clinics.a.org.id, userId: clinics.b.doctor.userId, role: 'doctor' },
  });
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

describe('platform-support authenticator reset', () => {
  it('signs a multi-clinic doctor out everywhere, clears their sign-in and audits both clinics', async () => {
    const atA = await staffLogin(h, 'clinic-a', clinics.b.doctor);
    const atB = await staffLogin(h, 'clinic-b', clinics.b.doctor);

    const result = await run();
    expect(result).toMatchObject({
      dryRun: false,
      linkClinic: 'clinic-a',
      sessionsRevoked: 2,
      identifier: 'do****@clinic-b.test',
      clinics: [
        { slug: 'clinic-a', roles: ['doctor'] },
        { slug: 'clinic-b', roles: ['doctor'] },
      ],
    });
    expect(result.inviteUrl).toMatch(/^https:\/\/app\.test\/invite#/);

    for (const tokens of [atA, atB]) {
      const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(tokens) });
      expect(me.statusCode).toBe(401);
    }
    const user = await h.owner.user.findUniqueOrThrow({ where: { id: clinics.b.doctor.userId } });
    expect(user).toMatchObject({ passwordHash: null, mfaSecret: null });

    for (const org of [clinics.a.org, clinics.b.org]) {
      const entries = await h.owner.auditLog.findMany({
        where: { organisationId: org.id, action: 'support.authenticator.reset' },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorUserId: null,
        entityId: clinics.b.doctor.userId,
        requestId: 'support-cli-test',
        metadata: expect.objectContaining({
          ticket: 'SUP-1001',
          operator: 'support@platform.test',
        }),
      });
    }
    const linkAudit = await h.owner.auditLog.count({
      where: { organisationId: clinics.a.org.id, action: 'support.reset.link_created' },
    });
    expect(linkAudit).toBe(1);
  });

  it('issues a link that restores sign-in at every clinic', async () => {
    const { inviteUrl } = await run();
    const token = new URL(inviteUrl!).hash.slice(1);
    const details = (await post('/auth/invites/inspect', { token })).json();
    expect(details).toMatchObject({
      purpose: 'reset',
      role: 'doctor',
      organisation: { slug: 'clinic-a' },
    });

    const accept = await post('/auth/invites/accept', { token, password: NEW_PASSWORD });
    const secret = new URL(accept.json().otpauthUri).searchParams.get('secret')!;
    h.clock.advance(30);
    const complete = await post('/auth/invites/complete', {
      token,
      code: totpAt(secret, h.clock.ms / 1000),
    });
    expect(complete.statusCode, complete.body).toBe(200);

    for (const organisation of ['clinic-a', 'clinic-b']) {
      const login = await post('/auth/login', {
        organisation,
        identifier: clinics.b.doctor.email,
        password: NEW_PASSWORD,
      });
      expect(login.statusCode, login.body).toBe(200);
      h.clock.advance(30);
      const verify = await post('/auth/mfa/verify', {
        mfaToken: login.json().mfaToken,
        code: totpAt(secret, h.clock.ms / 1000),
      });
      expect(verify.statusCode, verify.body).toBe(200);
    }
  });

  it('revokes every other open link, so only the new one can set a password', async () => {
    const first = await run({ clinic: 'clinic-b' });
    await run();
    const stale = new URL(first.inviteUrl!).hash.slice(1);
    expect((await post('/auth/invites/inspect', { token: stale })).statusCode).toBe(404);
  });

  it('changes nothing on a dry run', async () => {
    await staffLogin(h, 'clinic-b', clinics.b.doctor);
    const plan = await run({ dryRun: true });
    expect(plan).toMatchObject({ dryRun: true, sessionsRevoked: 1 });
    expect(plan.inviteUrl).toBeUndefined();

    const user = await h.owner.user.findUniqueOrThrow({ where: { id: clinics.b.doctor.userId } });
    expect(user.mfaSecret).not.toBeNull();
    expect(await h.owner.auditLog.count({ where: { action: { startsWith: 'support.' } } })).toBe(0);
    expect(await h.owner.staffInvite.count()).toBe(0);
  });

  it('refuses unknown people, clinics that are not theirs and missing records', async () => {
    await expect(run({ identifier: 'nobody@clinic-a.test' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(run({ clinic: 'clinic-z' })).rejects.toThrow(/clinics: clinic-a, clinic-b\./);
    await expect(run({ ticket: 'no' })).rejects.toMatchObject({ fields: { ticket: 'invalid' } });
    await expect(run({ reason: 'lost' })).rejects.toMatchObject({ fields: { reason: 'invalid' } });
    await expect(run({ operator: '' })).rejects.toMatchObject({ fields: { operator: 'invalid' } });

    // A removed staff member is not found, even though the account still exists.
    await h.owner.membership.updateMany({
      where: { userId: clinics.a.admin.userId },
      data: { status: 'revoked' },
    });
    await expect(run({ identifier: clinics.a.admin.email })).rejects.toMatchObject({
      statusCode: 404,
    });

    const user = await h.owner.user.findUniqueOrThrow({ where: { id: clinics.b.doctor.userId } });
    expect(user.passwordHash).not.toBeNull();
  });
});
