import {
  CreatedPlatformOrganisation,
  PlatformDoctorList,
  PlatformOrganisationList,
  PlatformUsageReport,
  VerifiedPlatformDoctor,
  type TokenResponse,
} from '@dhc/contracts';
import { withAuth, withPlatform, withTenant, type Tx } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { totpAt } from '../src/auth/totp';
import { maskIdentifier } from '../src/modules/invites/service';
import {
  createPlatformOperator,
  disablePlatformOperator,
  enablePlatformOperator,
  resetPlatformOperatorAuthenticator,
} from '../src/modules/platform/operators';
import { supportVerifyDoctor } from '../src/modules/support/verify-doctor';
import { IpAllowlist, parseCidrs } from '../src/plugins/ip-allowlist';
import {
  STAFF_PASSWORD,
  addOperator,
  bearer,
  createHarness,
  platformLogin,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  type OperatorFixture,
} from './harness';

/**
 * Platform console (PRD §3.2, §9.3; ADR 0016): its own sign-in and token audience, IP
 * allowlist, and cross-organisation reads that carry no patient or clinical data.
 */
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let op: OperatorFixture;

// Synthetic credentials, named so they read as test data (and secret scanners agree).
const OTHER_PASSWORD = 'another synthetic passphrase';
const WRONG_PASSWORD = 'not the synthetic passphrase';
const SHORT_PASSWORD = 'short';
const WRONG_CODE = '000000';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

const source = { id: 'support-cli-test', ip: 'support-cli', headers: { 'user-agent': 'test' } };

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  op = await addOperator(h);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse | null, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: tokens ? bearer(tokens) : {},
    payload: payload as object,
  });

const passwordStep = (email: string, password = STAFF_PASSWORD) =>
  call('POST', '/platform/auth/login', null, { email, password });

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

/** Field names that would mean patient or clinical data reached the console. */
const CLINICAL =
  /patient|uhid|dob|birth|gender|allerg|diagnos|condition|medic|vital|note|complaint|chart|prescriptionItem|dose/i;

function expectNoClinicalData(body: string) {
  const keys = [...keysOf(JSON.parse(body))];
  expect(keys.filter((k) => CLINICAL.test(k))).toEqual([]);
  for (const name of ['Asha Verma', 'Kamla Devi', 'Ravi Mehra', 'Imran Khan', 'Neha Kapoor']) {
    expect(body).not.toContain(name);
  }
  for (const p of [...clinics.a.patients, ...clinics.b.patients]) {
    expect(body).not.toContain(p.id);
    expect(body).not.toContain(p.uhid);
  }
}

/** What the console sends: the ticket and the details the queue showed. */
const checked = (
  profile: { registrationNumber: string | null; council: string | null; submittedAt: string },
  ticket = 'SUP-1',
) => ({
  ticket,
  expected: {
    registrationNumber: profile.registrationNumber,
    council: profile.council,
    submittedAt: profile.submittedAt,
  },
});

const profileBody = {
  registrationNumber: 'TEST-12345',
  council: 'Test Medical Council',
  qualifications: 'MBBS, MS (Ortho)',
  specialty: 'Orthopaedics',
  rxPrefix: 'sd',
  paperSize: 'a5',
};

describe('sign-in', () => {
  it('signs in with password and authenticator code, and refuses a code twice', async () => {
    const tokens = await platformLogin(h, op);
    const me = await call('GET', '/platform/me', tokens);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      operator: { id: op.operatorId, email: op.email, displayName: 'Synthetic Operator' },
    });

    // The same code again, in the same 30 seconds.
    const again = await passwordStep(op.email);
    const replay = await call('POST', '/platform/auth/mfa/verify', null, {
      mfaToken: again.json().mfaToken,
      code: totpAt(op.totpSecret, h.clock.ms / 1000),
    });
    expect(replay.statusCode).toBe(401);

    const audit = await h.owner.auditLog.findMany({
      where: { action: { startsWith: 'platform.auth.' } },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'platform.auth.login.succeeded',
      'platform.auth.mfa.failed',
    ]);
    expect(audit.every((a) => a.organisationId === null && a.entityId === op.operatorId)).toBe(
      true,
    );
  });

  it('gives unknown emails, wrong passwords and clinic staff the same 401', async () => {
    const unknown = await passwordStep('nobody@platform.test');
    const wrong = await passwordStep(op.email, WRONG_PASSWORD);
    const staff = await passwordStep(clinics.a.admin.email);
    for (const res of [unknown, wrong, staff]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Invalid sign-in details.');
    }
  });

  it('locks the operator for 15 minutes after 5 wrong passwords or codes', async () => {
    const step = await passwordStep(op.email);
    expect(step.statusCode).toBe(200);
    // Four wrong passwords, then a wrong code: both count.
    for (let i = 0; i < 4; i++) {
      expect((await passwordStep(op.email, WRONG_PASSWORD)).statusCode).toBe(401);
    }
    const badCode = await call('POST', '/platform/auth/mfa/verify', null, {
      mfaToken: step.json().mfaToken,
      code: WRONG_CODE,
    });
    expect(badCode.statusCode).toBe(401);

    const locked = await passwordStep(op.email);
    expect(locked.statusCode).toBe(429);
    const row = await h.owner.platformOperator.findUniqueOrThrow({ where: { id: op.operatorId } });
    expect(row.lockedUntil?.getTime()).toBe(h.clock.ms + 15 * 60_000);
    expect(await h.owner.auditLog.count({ where: { action: 'platform.auth.login.locked' } })).toBe(
      1,
    );
    // A code while locked is refused and audited too.
    const lockedCode = await call('POST', '/platform/auth/mfa/verify', null, {
      mfaToken: step.json().mfaToken,
      code: totpAt(op.totpSecret, h.clock.ms / 1000),
    });
    expect(lockedCode.statusCode).toBe(429);
    expect(
      await h.owner.auditLog.count({
        where: { action: 'platform.auth.login.locked', metadata: { equals: { step: 'mfa' } } },
      }),
    ).toBe(1);

    h.clock.advance(15 * 60 + 1);
    await expect(platformLogin(h, op)).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('locks after wrong codes even when each sign-in starts with the right password', async () => {
    // Someone who knows the password guesses one code per sign-in: the password step must
    // not wipe the count.
    for (let i = 0; i < 5; i++) {
      const step = await passwordStep(op.email);
      expect(step.statusCode, `attempt ${i + 1}`).toBe(200);
      const res = await call('POST', '/platform/auth/mfa/verify', null, {
        mfaToken: step.json().mfaToken,
        code: WRONG_CODE,
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await passwordStep(op.email)).statusCode).toBe(429);
  });

  it('a right code resets the count', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await passwordStep(op.email, WRONG_PASSWORD)).statusCode).toBe(401);
    }
    await platformLogin(h, op);
    const row = await h.owner.platformOperator.findUniqueOrThrow({ where: { id: op.operatorId } });
    expect(row.failedLoginCount).toBe(0);
  });

  it('accepts one code once, even when two requests race with it', async () => {
    const [first, second] = await Promise.all([passwordStep(op.email), passwordStep(op.email)]);
    h.clock.advance(30);
    const code = totpAt(op.totpSecret, h.clock.ms / 1000);
    const results = await Promise.all(
      [first!, second!].map((step) =>
        call('POST', '/platform/auth/mfa/verify', null, { mfaToken: step.json().mfaToken, code }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(await h.owner.platformSession.count()).toBe(1);
  });

  it('counts concurrent wrong passwords atomically', async () => {
    await Promise.all(Array.from({ length: 5 }, () => passwordStep(op.email, WRONG_PASSWORD)));
    expect((await passwordStep(op.email)).statusCode).toBe(429);
  });

  it('rotates refresh tokens, ends the session on reuse, and logs out at once', async () => {
    const tokens = await platformLogin(h, op);
    const refreshed = await call('POST', '/platform/auth/refresh', null, {
      refreshToken: tokens.refreshToken,
    });
    expect(refreshed.statusCode).toBe(200);
    const next = refreshed.json() as TokenResponse;
    expect(next.refreshToken).not.toBe(tokens.refreshToken);

    // Replaying the old one ends the session, the new tokens included.
    expect(
      (await call('POST', '/platform/auth/refresh', null, { refreshToken: tokens.refreshToken }))
        .statusCode,
    ).toBe(401);
    expect((await call('GET', '/platform/me', next)).statusCode).toBe(401);

    const second = await platformLogin(h, op);
    expect((await call('POST', '/platform/auth/logout', second)).statusCode).toBe(204);
    expect((await call('GET', '/platform/me', second)).statusCode).toBe(401);
    expect(
      await h.owner.auditLog.count({
        where: { action: { in: ['platform.auth.refresh.reuse_detected', 'platform.auth.logout'] } },
      }),
    ).toBe(2);
  });

  it('a disabled operator is signed out and cannot sign in', async () => {
    const tokens = await platformLogin(h, op);
    const done = await disablePlatformOperator(h.services, source, {
      email: op.email,
      ticket: 'SUP-9',
      operator: 'lead@platform.test',
    });
    expect(done.sessionsRevoked).toBe(1);
    expect((await call('GET', '/platform/organisations', tokens)).statusCode).toBe(401);
    expect((await passwordStep(op.email)).statusCode).toBe(401);
    const audit = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'platform.operator.disabled' },
    });
    expect(audit).toMatchObject({ organisationId: null, entityId: op.operatorId });
  });

  it('creates operators only with a strong password and a unique email', async () => {
    const deps = h.services;
    const base = {
      email: 'New.Ops@Platform.test',
      displayName: 'New Operator',
      password: STAFF_PASSWORD,
      totpSecret: TOTP_SECRET,
      confirmedStep: Math.floor(h.clock.ms / 30_000),
      ticket: 'SUP-10',
      operator: 'lead@platform.test',
    };
    await expect(
      createPlatformOperator(deps, source, { ...base, password: SHORT_PASSWORD }),
    ).rejects.toThrow(/12 characters/);
    const created = await createPlatformOperator(deps, source, base);
    expect(created.email).toBe('new.ops@platform.test');
    await expect(createPlatformOperator(deps, source, base)).rejects.toThrow(/already exists/);
    const row = await h.owner.platformOperator.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.mfaSecret).not.toContain(base.totpSecret);
    expect(row.passwordHash).toMatch(/^scrypt\$/);

    // The code that confirmed the authenticator at the terminal cannot sign in.
    const fixture = { operatorId: created.id, email: created.email, totpSecret: TOTP_SECRET };
    const step = await passwordStep(fixture.email);
    const reuse = await call('POST', '/platform/auth/mfa/verify', null, {
      mfaToken: step.json().mfaToken,
      code: totpAt(TOTP_SECRET, h.clock.ms / 1000),
    });
    expect(reuse.statusCode).toBe(401);
    await expect(platformLogin(h, fixture)).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('replaces a lost authenticator and enables the operator again, both audited', async () => {
    const tokens = await platformLogin(h, op);
    const trail = { email: op.email, ticket: 'SUP-11', operator: 'lead@platform.test' };
    await disablePlatformOperator(h.services, source, trail);
    const reset = await resetPlatformOperatorAuthenticator(h.services, source, {
      ...trail,
      totpSecret: TOTP_SECRET,
      confirmedStep: Math.floor(h.clock.ms / 30_000),
    });
    expect(reset.sessionsRevoked).toBe(0);
    // Still disabled until enabled.
    expect((await passwordStep(op.email)).statusCode).toBe(401);
    expect(await enablePlatformOperator(h.services, source, trail)).toMatchObject({
      alreadyActive: false,
    });
    // The old authenticator no longer works; the new one does.
    const step = await passwordStep(op.email);
    h.clock.advance(30);
    const old = await call('POST', '/platform/auth/mfa/verify', null, {
      mfaToken: step.json().mfaToken,
      code: totpAt(op.totpSecret, h.clock.ms / 1000),
    });
    expect(old.statusCode).toBe(401);
    await expect(platformLogin(h, { ...op, totpSecret: TOTP_SECRET })).resolves.toMatchObject({
      tokenType: 'Bearer',
    });
    expect((await call('GET', '/platform/me', tokens)).statusCode).toBe(401);
    const actions = (
      await h.owner.auditLog.findMany({
        where: { action: { startsWith: 'platform.operator.' }, entityId: op.operatorId },
      })
    ).map((a) => a.action);
    expect(actions.sort()).toEqual([
      'platform.operator.authenticator_reset',
      'platform.operator.disabled',
      'platform.operator.enabled',
    ]);
  });
});

describe('separate audiences', () => {
  it('refuses platform tokens on clinic endpoints', async () => {
    const tokens = await platformLogin(h, op);
    for (const url of ['/me', '/patients', '/audit-log', '/dashboard', '/doctor-profile']) {
      const res = await call('GET', url, tokens);
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('refuses clinic tokens, and clinic sign-in steps, on platform endpoints', async () => {
    const admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    for (const url of ['/platform/me', '/platform/organisations', '/platform/doctors']) {
      expect((await call('GET', url, admin)).statusCode, url).toBe(401);
    }
    expect(
      (await call('POST', '/platform/auth/refresh', null, { refreshToken: admin.refreshToken }))
        .statusCode,
    ).toBe(401);
    // A clinic password step cannot be finished at the platform's code step.
    const login = await call('POST', '/auth/login', null, {
      organisation: 'clinic-a',
      identifier: clinics.a.admin.email,
      password: STAFF_PASSWORD,
    });
    h.clock.advance(30);
    const mfa = await call('POST', '/platform/auth/mfa/verify', null, {
      mfaToken: login.json().mfaToken,
      code: totpAt(clinics.a.admin.totpSecret, h.clock.ms / 1000),
    });
    expect(mfa.statusCode).toBe(401);
    // And the platform's password step cannot be finished at the clinic's.
    const step = await passwordStep(op.email);
    const clinicMfa = await call('POST', '/auth/mfa/verify', null, {
      mfaToken: step.json().mfaToken,
      code: totpAt(op.totpSecret, h.clock.ms / 1000),
    });
    expect(clinicMfa.statusCode).toBe(401);
  });
});

describe('IP allowlist', () => {
  const restricted = createHarness({
    platformAllowlist: IpAllowlist.of(parseCidrs('10.0.0.0/8, 2001:db8::/32')!),
  });
  const denied = createHarness({ platformAllowlist: IpAllowlist.none() });

  afterAll(async () => {
    for (const x of [restricted, denied]) {
      await x.app.close();
      await x.owner.$disconnect();
    }
  });

  it('answers only from allowed networks, sign-in included', async () => {
    const login = (remoteAddress: string, app = restricted.app) =>
      app.inject({
        method: 'POST',
        url: '/v1/platform/auth/login',
        remoteAddress,
        payload: { email: op.email, password: STAFF_PASSWORD },
      });
    const outside = await login('203.0.113.5');
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error.code).toBe('FORBIDDEN');
    expect((await login('10.1.2.3')).statusCode).toBe(200);
    expect((await login('2001:db8::7')).statusCode).toBe(200);

    // A valid token does not help from outside.
    const tokens = await platformLogin(h, op);
    const fromOutside = await restricted.app.inject({
      method: 'GET',
      url: '/v1/platform/organisations',
      remoteAddress: '198.51.100.1',
      headers: bearer(tokens),
    });
    expect(fromOutside.statusCode).toBe(403);

    // No list in production: nobody.
    expect((await login('10.1.2.3', denied.app)).statusCode).toBe(403);
    // Clinic endpoints are not affected by the platform list.
    const health = await denied.app.inject({
      method: 'GET',
      url: '/v1/health',
      remoteAddress: '203.0.113.5',
    });
    expect(health.statusCode).toBe(200);
  });
});

describe('organisations', () => {
  it('lists organisations with clinic and staff counts and no patient data', async () => {
    await h.owner.clinic.create({ data: { organisationId: clinics.a.org.id, name: 'Main' } });
    await h.owner.clinic.create({
      data: { organisationId: clinics.a.org.id, name: 'Old', active: false },
    });
    await h.owner.membership.updateMany({
      where: { userId: clinics.b.admin.userId },
      data: { status: 'revoked' },
    });
    const tokens = await platformLogin(h, op);
    const res = await call('GET', '/platform/organisations', tokens);
    expect(res.statusCode).toBe(200);
    expectNoClinicalData(res.body);
    const list = PlatformOrganisationList.parse(res.json()).data;
    expect(list.map((o) => o.slug)).toEqual(['clinic-a', 'clinic-b']);
    expect(list[0]).toMatchObject({
      clinics: { active: 1, total: 2 },
      staff: {
        doctor: { active: 1, invited: 0, revoked: 0 },
        clinicAdmin: { active: 1, invited: 0, revoked: 0 },
        frontDesk: { active: 0, invited: 0, revoked: 0 },
      },
      doctorVerification: { pending: 0, verified: 0 },
    });
    expect(list[1]!.staff.clinicAdmin).toEqual({ active: 0, invited: 0, revoked: 1 });
    expect(
      await h.owner.auditLog.findFirst({
        where: { action: 'platform.organisations.listed', entityId: op.operatorId },
      }),
    ).toMatchObject({ organisationId: null, metadata: { count: 2 } });
  });

  it('onboards an organisation with its first clinic and admin invite, all audited', async () => {
    const tokens = await platformLogin(h, op);
    const res = await call('POST', '/platform/organisations', tokens, {
      name: 'Gupta Bone and Joint',
      slug: 'gupta-bone',
      clinic: { name: 'Sector 15', address: '1 Synthetic Road' },
      admin: { identifier: 'Pooja.Singh@gupta-bone.test', displayName: 'Pooja Singh' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = CreatedPlatformOrganisation.parse(res.json());
    expect(created.invite).toMatchObject({
      role: 'clinic_admin',
      identifier: 'po****@gupta-bone.test',
    });
    expect(created.invite.inviteUrl).toMatch(/^https:\/\/app\.test\/invite#/);
    const orgId = created.organisation.id;

    // The new admin completes the invite and signs in to the new organisation.
    const token = created.invite.inviteUrl.split('#')[1]!;
    const accept = await call('POST', '/auth/invites/accept', null, {
      token,
      password: OTHER_PASSWORD,
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const secret = new URL(accept.json().otpauthUri).searchParams.get('secret')!;
    h.clock.advance(30);
    const complete = await call('POST', '/auth/invites/complete', null, {
      token,
      code: totpAt(secret, h.clock.ms / 1000),
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const clinicsRes = await call('GET', '/clinics', complete.json());
    expect(clinicsRes.json().data.map((c: { name: string }) => c.name)).toEqual(['Sector 15']);

    const audit = await h.owner.auditLog.findMany({ where: { organisationId: orgId } });
    const onboarding = audit.filter((a) =>
      ['platform.organisation.created', 'clinic.created', 'staff.invite.created'].includes(
        a.action,
      ),
    );
    expect(onboarding.map((a) => a.action).sort()).toEqual([
      'clinic.created',
      'platform.organisation.created',
      'staff.invite.created',
    ]);
    for (const entry of onboarding) {
      expect(entry.actorUserId).toBeNull();
      expect(entry.metadata).toMatchObject({ operatorId: op.operatorId, operator: op.email });
    }
    expect(audit.map((a) => a.action)).toContain('staff.invite.accepted');
    // And in the operator's own trail, with no organisation.
    expect(
      await h.owner.auditLog.findFirst({
        where: { action: 'platform.organisation.created', organisationId: null },
      }),
    ).toMatchObject({ entityId: op.operatorId, metadata: { organisationId: orgId } });
    const usersBefore = await h.owner.user.count();

    // The slug is taken now: nothing more is created.
    const again = await call('POST', '/platform/organisations', tokens, {
      name: 'Another',
      slug: 'gupta-bone',
      clinic: { name: 'Main' },
      admin: { identifier: 'someone@gupta-bone.test' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.fields).toEqual({ slug: 'taken' });
    // Refused before anything was created, the admin's account included; and audited.
    expect(await h.owner.user.count()).toBe(usersBefore);
    expect(
      await h.owner.auditLog.findFirst({
        where: { action: 'platform.organisation.create_refused' },
      }),
    ).toMatchObject({
      organisationId: null,
      entityId: op.operatorId,
      metadata: { reason: 'slug_taken', slug: 'gupta-bone' },
    });
    expect(await h.owner.organisation.count()).toBe(3);
    expect(await h.owner.clinic.count({ where: { organisationId: orgId } })).toBe(1);
  });
});

describe('doctor verification', () => {
  it('lists the queue across organisations and verifies with the same audit as the CLI', async () => {
    const doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    expect((await call('PUT', '/doctor-profile', doctorA, profileBody)).statusCode).toBe(200);
    h.clock.advance(60);
    expect(
      (await call('PUT', '/doctor-profile', doctorB, { ...profileBody, registrationNumber: 'B-1' }))
        .statusCode,
    ).toBe(200);

    const tokens = await platformLogin(h, op);
    const res = await call('GET', '/platform/doctors?status=pending', tokens);
    expect(res.statusCode).toBe(200);
    expectNoClinicalData(res.body);
    const list = PlatformDoctorList.parse(res.json());
    expect(list.hasMore).toBe(false);
    const queue = list.data;
    expect(queue.map((d) => [d.organisation.slug, d.registrationNumber])).toEqual([
      ['clinic-a', 'TEST-12345'],
      ['clinic-b', 'B-1'],
    ]);
    expect(queue[0]).toMatchObject({
      identifier: maskIdentifier(clinics.a.doctor.email),
      council: 'Test Medical Council',
      qualifications: 'MBBS, MS (Ortho)',
      verification: 'pending',
      verifiedAt: null,
    });

    // The console verifies clinic A's doctor; the CLI verifies clinic B's.
    const verify = await call(
      'POST',
      `/platform/doctors/${queue[0]!.profileId}/verify`,
      tokens,
      checked(queue[0]!),
    );
    expect(verify.statusCode, verify.body).toBe(200);
    expect(VerifiedPlatformDoctor.parse(verify.json())).toMatchObject({
      verification: 'verified',
      verifiedBy: `${op.email} (SUP-1)`,
      alreadyVerified: false,
    });
    await supportVerifyDoctor(h.services, source, {
      identifier: clinics.b.doctor.email,
      clinic: 'clinic-b',
      ticket: 'SUP-2',
      operator: 'ops@platform.test',
    });
    expect((await call('GET', '/doctor-profile', doctorA)).json().verification).toBe('verified');

    const [consoleAudit, cliAudit] = await Promise.all(
      [clinics.a.org.id, clinics.b.org.id].map((organisationId) =>
        h.owner.auditLog.findFirstOrThrow({
          where: { organisationId, action: 'support.doctor.verified' },
        }),
      ),
    );
    for (const [entry, profile, ticket] of [
      [consoleAudit!, queue[0]!, 'SUP-1'],
      [cliAudit!, queue[1]!, 'SUP-2'],
    ] as const) {
      expect(entry).toMatchObject({
        actorUserId: null,
        entityType: 'doctor_profile',
        entityId: profile.profileId,
      });
      expect(entry.metadata).toMatchObject({
        ticket,
        operator: 'ops@platform.test',
        registrationNumber: profile.registrationNumber,
      });
    }
    // The console's entry also names the operator's account.
    expect(consoleAudit!.metadata).toEqual({
      ticket: 'SUP-1',
      operator: 'ops@platform.test',
      registrationNumber: 'TEST-12345',
      operatorId: op.operatorId,
    });
    expect(Object.keys(cliAudit!.metadata as object).sort()).toEqual([
      'operator',
      'registrationNumber',
      'ticket',
    ]);
    // The operator's own trail has it too, with no organisation.
    expect(
      await h.owner.auditLog.findFirst({
        where: { action: 'platform.doctor.verified', organisationId: null },
      }),
    ).toMatchObject({
      entityId: op.operatorId,
      metadata: {
        profileId: queue[0]!.profileId,
        ticket: 'SUP-1',
        organisationId: clinics.a.org.id,
      },
    });

    // Verified once: again changes nothing.
    const twice = await call(
      'POST',
      `/platform/doctors/${queue[0]!.profileId}/verify`,
      tokens,
      checked(queue[0]!, 'SUP-3'),
    );
    expect(twice.json().alreadyVerified).toBe(true);
    expect(await h.owner.auditLog.count({ where: { action: 'support.doctor.verified' } })).toBe(2);

    const verified = await call('GET', '/platform/doctors?status=verified', tokens);
    expect(PlatformDoctorList.parse(verified.json()).data).toHaveLength(2);
    expect((await call('GET', '/platform/doctors', tokens)).json().data).toEqual([]);
  });

  it('refuses unknown profiles, bad tickets and doctors who left', async () => {
    const doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await call('PUT', '/doctor-profile', doctorA, profileBody);
    const tokens = await platformLogin(h, op);
    const [profile] = PlatformDoctorList.parse(
      (await call('GET', '/platform/doctors', tokens)).json(),
    ).data;
    const verify = (id: string, ticket = 'SUP-1') =>
      call('POST', `/platform/doctors/${id}/verify`, tokens, checked(profile!, ticket));

    expect((await verify(randomUUID())).statusCode).toBe(404);
    expect((await verify('not-a-uuid')).statusCode).toBe(400);
    expect((await verify(profile!.profileId, 'no spaces allowed')).statusCode).toBe(400);
    await h.owner.membership.updateMany({
      where: { userId: clinics.a.doctor.userId },
      data: { status: 'revoked' },
    });
    expect((await verify(profile!.profileId)).statusCode).toBe(404);
    expect(await h.owner.auditLog.count({ where: { action: 'support.doctor.verified' } })).toBe(0);
    expect(
      await h.owner.auditLog.count({
        where: { action: 'platform.doctor.verify_refused', entityId: op.operatorId },
      }),
    ).toBe(2);
  });

  it('refuses to verify a registration that changed after the operator saw it', async () => {
    const doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await call('PUT', '/doctor-profile', doctorA, profileBody);
    const tokens = await platformLogin(h, op);
    const [shown] = PlatformDoctorList.parse(
      (await call('GET', '/platform/doctors', tokens)).json(),
    ).data;

    // While the operator checks TEST-12345 on the register, the doctor changes it.
    h.clock.advance(60);
    await call('PUT', '/doctor-profile', doctorA, {
      ...profileBody,
      registrationNumber: 'OTHER-9',
    });
    const res = await call(
      'POST',
      `/platform/doctors/${shown!.profileId}/verify`,
      tokens,
      checked(shown!),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.fields).toEqual({ profile: 'changed' });
    expect((await call('GET', '/doctor-profile', doctorA)).json().verification).toBe('pending');
    expect(await h.owner.auditLog.count({ where: { action: 'support.doctor.verified' } })).toBe(0);
    expect(
      await h.owner.auditLog.findFirst({ where: { action: 'platform.doctor.verify_refused' } }),
    ).toMatchObject({ metadata: { reason: 'changed', profileId: shown!.profileId } });

    // Changed back to the same number: submitted again, so the earlier check is stale too.
    h.clock.advance(60);
    await call('PUT', '/doctor-profile', doctorA, profileBody);
    const sameAgain = await call(
      'POST',
      `/platform/doctors/${shown!.profileId}/verify`,
      tokens,
      checked(shown!),
    );
    expect(sameAgain.statusCode).toBe(409);

    // Reloaded, the current details verify.
    const [current] = (await call('GET', '/platform/doctors', tokens)).json().data;
    expect(
      (
        await call(
          'POST',
          `/platform/doctors/${current.profileId}/verify`,
          tokens,
          checked(current),
        )
      ).statusCode,
    ).toBe(200);
  });

  it('the support command also refuses a profile that changed since its dry run', async () => {
    const doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await call('PUT', '/doctor-profile', doctorA, profileBody);
    const params = {
      identifier: clinics.a.doctor.email,
      clinic: 'clinic-a',
      ticket: 'SUP-4',
      operator: 'ops@platform.test',
    };
    const plan = await supportVerifyDoctor(h.services, source, { ...params, dryRun: true });
    h.clock.advance(60);
    await call('PUT', '/doctor-profile', doctorA, { ...profileBody, council: 'Another Council' });
    await expect(
      supportVerifyDoctor(h.services, source, {
        ...params,
        expected: {
          registrationNumber: plan.registrationNumber,
          council: plan.council,
          submittedAt: plan.submittedAt,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, fields: { profile: 'changed' } });
  });

  it('says when the queue holds more than one page', async () => {
    const users = Array.from({ length: 201 }, (_, i) => ({
      id: randomUUID(),
      email: `doctor${i}@clinic-b.test`,
    }));
    await h.owner.user.createMany({ data: users });
    await h.owner.membership.createMany({
      data: users.map((u) => ({
        organisationId: clinics.b.org.id,
        userId: u.id,
        role: 'doctor' as const,
      })),
    });
    await h.owner.doctorProfile.createMany({
      data: users.map((u, i) => ({
        organisationId: clinics.b.org.id,
        userId: u.id,
        registrationNumber: `B-${i}`,
        council: 'Test Medical Council',
        qualifications: 'MBBS',
        submittedAt: new Date(h.clock.ms + i * 1000),
      })),
    });
    const tokens = await platformLogin(h, op);
    const page = PlatformDoctorList.parse((await call('GET', '/platform/doctors', tokens)).json());
    expect(page.data).toHaveLength(200);
    expect(page.hasMore).toBe(true);
    expect(page.data[0]!.registrationNumber).toBe('B-0');
  });

  it('puts a profile back in the queue, as of now, when the registration changes', async () => {
    const doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await call('PUT', '/doctor-profile', doctorA, profileBody);
    const tokens = await platformLogin(h, op);
    const [first] = (await call('GET', '/platform/doctors', tokens)).json().data;
    const verified = await call(
      'POST',
      `/platform/doctors/${first.profileId}/verify`,
      tokens,
      checked(first),
    );
    expect(verified.statusCode).toBe(200);
    h.clock.advance(3600);
    await call('PUT', '/doctor-profile', doctorA, { ...profileBody, registrationNumber: 'NEW-1' });
    const [again] = (await call('GET', '/platform/doctors', tokens)).json().data;
    expect(again).toMatchObject({ registrationNumber: 'NEW-1', verification: 'pending' });
    expect(Date.parse(again.submittedAt)).toBe(h.clock.ms);
  });
});

describe('usage', () => {
  it('counts appointments, signed prescriptions and payments per organisation', async () => {
    const org = clinics.a.org.id;
    const clinicId = (await h.owner.clinic.create({ data: { organisationId: org, name: 'Main' } }))
      .id;
    const typeId = (
      await h.owner.consultationType.create({
        data: {
          organisationId: org,
          name: 'In person',
          mode: 'in_person',
          defaultDurationMin: 15,
          feePaise: 50000,
        },
      })
    ).id;
    let tokenNumber = 0;
    const visit = async (date: string, status: 'completed' | 'rescheduled' | 'cancelled') => {
      const startAt = new Date(`${date}T04:30:00.000Z`);
      return (
        await h.owner.appointment.create({
          data: {
            organisationId: org,
            patientId: clinics.a.patients[0]!.id,
            doctorUserId: clinics.a.doctor.userId,
            clinicId,
            consultationTypeId: typeId,
            date: new Date(`${date}T00:00:00.000Z`),
            startAt,
            endAt: new Date(startAt.getTime() + 15 * 60_000),
            status,
            source: 'front_desk',
            tokenNumber: ++tokenNumber,
            createdByUserId: clinics.a.doctor.userId,
          },
        })
      ).id;
    };
    const signed = async (appointmentId: string, signedAt: string, amends?: string) =>
      (
        await h.owner.prescription.create({
          data: {
            organisationId: org,
            appointmentId,
            patientId: clinics.a.patients[0]!.id,
            doctorUserId: clinics.a.doctor.userId,
            status: 'signed',
            number: `RX-${randomUUID().slice(0, 8)}`,
            signedAt: new Date(signedAt),
            pdfFileKey: 'test/key.pdf',
            pdfSha256: 'a'.repeat(64),
            templateVersion: '1',
            paperSize: 'a4',
            signatureMethod: 'test_key',
            signature: 'sig',
            verificationCode: randomUUID(),
            ...(amends
              ? { amendsPrescriptionId: amends, amendmentReason: 'Dose corrected', version: 2 }
              : {}),
          },
        })
      ).id;
    const pay = async (appointmentId: string, amountPaise: number, receivedAt: string) => {
      const bill = await h.owner.bill.create({
        data: {
          organisationId: org,
          appointmentId,
          patientId: clinics.a.patients[0]!.id,
          doctorUserId: clinics.a.doctor.userId,
          subtotalPaise: amountPaise,
          totalPaise: amountPaise,
          paidPaise: amountPaise,
          status: 'paid',
          createdByUserId: clinics.a.admin.userId,
        },
      });
      await h.owner.payment.create({
        data: {
          id: randomUUID(),
          organisationId: org,
          billId: bill.id,
          mode: 'cash',
          amountPaise,
          receiptNumber: `R${randomUUID().slice(0, 6)}`,
          receivedByUserId: clinics.a.admin.userId,
          receivedAt: new Date(receivedAt),
        },
      });
    };

    const v1 = await visit('2026-10-05', 'completed');
    const v2 = await visit('2026-10-06', 'completed');
    await visit('2026-10-06', 'rescheduled');
    await visit('2026-10-06', 'cancelled');
    const outside = await visit('2026-10-07', 'completed');
    const rx = await signed(v1, '2026-10-05T06:00:00Z');
    await signed(v1, '2026-10-05T07:00:00Z', rx);
    await signed(v2, '2026-10-06T06:00:00Z');
    await signed(outside, '2026-10-07T06:00:00Z');
    await pay(v1, 50000, '2026-10-05T06:30:00Z');
    await pay(v2, 30000, '2026-10-06T06:30:00Z');
    // 7 Oct 00:30 IST: outside a range ending 6 Oct, though 6 Oct in UTC.
    await pay(outside, 99900, '2026-10-06T19:00:00Z');

    const tokens = await platformLogin(h, op);
    const res = await call('GET', '/platform/usage?from=2026-10-05&to=2026-10-06', tokens);
    expect(res.statusCode, res.body).toBe(200);
    expectNoClinicalData(res.body);
    const report = PlatformUsageReport.parse(res.json());
    expect(report.data.map((r) => r.organisation.slug)).toEqual(['clinic-a', 'clinic-b']);
    expect(report.data[0]).toMatchObject({
      appointments: 3,
      prescriptions: 2,
      payments: { count: 2, amountPaise: 80000 },
      messages: null,
      scribeMinutes: null,
    });
    expect(report.data[1]).toMatchObject({
      appointments: 0,
      prescriptions: 0,
      payments: { count: 0, amountPaise: 0 },
    });
    expect(
      await h.owner.auditLog.findFirst({ where: { action: 'platform.usage.viewed' } }),
    ).toMatchObject({ organisationId: null, metadata: { from: '2026-10-05', to: '2026-10-06' } });

    // Defaults to the last 30 days; refuses a reversed or over-long range.
    const defaults = await call('GET', '/platform/usage', tokens);
    expect(defaults.json()).toMatchObject({ from: '2026-09-07', to: '2026-10-06' });
    expect(
      (await call('GET', '/platform/usage?from=2026-10-06&to=2026-10-05', tokens)).statusCode,
    ).toBe(400);
    expect(
      (await call('GET', '/platform/usage?from=2025-01-01&to=2026-10-05', tokens)).statusCode,
    ).toBe(400);
  });
});

describe('in the database (dhc_platform)', () => {
  const asPlatform = <T>(fn: (tx: Tx) => Promise<T>) => withPlatform(h.services.db, fn);

  it.each([
    'patients',
    'appointments',
    'prescriptions',
    'prescription_items',
    'consultations',
    'allergies',
    'vitals',
    'bills',
    'payments',
    'doctor_profiles',
    'memberships',
    'organisations',
    'users',
    'sessions',
    'audit_logs',
  ])('cannot read %s', async (table) => {
    await expect(
      asPlatform((tx) => tx.$queryRawUnsafe(`SELECT 1 FROM ${table} LIMIT 1`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('writes only platform-level audit entries', async () => {
    await expect(
      asPlatform((tx) =>
        tx.auditLog.createMany({ data: { action: 'test', organisationId: clinics.a.org.id } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('has no privilege on any table but its own, besides inserting audit entries', async () => {
    const tables = await h.owner.$queryRaw<
      { table: string; any: boolean; read: boolean; insert: boolean }[]
    >`
      SELECT c.relname AS table,
             has_table_privilege('dhc_platform', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any,
             has_table_privilege('dhc_platform', c.oid, 'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS read,
             has_table_privilege('dhc_platform', c.oid, 'INSERT') AS insert
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname NOT LIKE 'platform\\_%'
      ORDER BY 1`;
    expect(tables.length).toBeGreaterThan(40);
    const granted = tables.filter((t) => (t.table === 'audit_logs' ? t.read : t.any));
    expect(granted.map((t) => t.table)).toEqual([]);
    expect(tables.find((t) => t.table === 'audit_logs')?.insert).toBe(true);
  });

  it('can run no SECURITY DEFINER function but its own, nor send queue notifications', async () => {
    const definers = await h.owner.$queryRaw<{ name: string }[]>`
      SELECT p.proname AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.prosecdef AND has_function_privilege('dhc_platform', p.oid, 'EXECUTE')
        AND p.proname NOT LIKE 'platform\\_%'`;
    expect(definers).toEqual([]);
    await expect(
      asPlatform((tx) =>
        tx.$queryRawUnsafe(
          `SELECT queue_notify('${clinics.a.org.id}'::uuid, NULL, current_date, NULL)`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('keeps operators out of reach of the clinic roles, and the functions to itself', async () => {
    await expect(withAuth(h.services.db, (tx) => tx.platformOperator.count())).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) => tx.platformSession.count()),
    ).rejects.toThrow(/permission denied/);
    const functions = await h.owner.$queryRaw<
      { name: string; definer: boolean; app: boolean; auth: boolean; platform: boolean }[]
    >`
      SELECT proname AS name, prosecdef AS definer,
             has_function_privilege('dhc_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('dhc_auth', p.oid, 'EXECUTE') AS auth,
             has_function_privilege('dhc_platform', p.oid, 'EXECUTE') AS platform
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE proname LIKE 'platform\\_%' ORDER BY proname`;
    expect(functions.map((f) => f.name)).toEqual([
      'platform_create_organisation',
      'platform_doctor_profiles',
      'platform_mask_identifier',
      'platform_organisation_slug_taken',
      'platform_organisation_summaries',
      'platform_usage',
    ]);
    for (const f of functions) {
      expect({ name: f.name, app: f.app, auth: f.auth, platform: f.platform }).toEqual({
        name: f.name,
        app: false,
        auth: false,
        platform: true,
      });
    }
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.$queryRawUnsafe('SELECT * FROM platform_organisation_summaries()'),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('returns only the declared, non-clinical columns from each function', async () => {
    const columns = await h.owner.$queryRaw<{ name: string; args: string[] }[]>`
      SELECT proname AS name, coalesce(proargnames, '{}') AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE proname IN ('platform_organisation_summaries', 'platform_doctor_profiles', 'platform_usage')`;
    for (const { args } of columns) {
      expect(args.filter((a) => CLINICAL.test(a) && !a.startsWith('p_'))).toEqual([]);
    }
  });

  it('masks contact details the same way as the API', async () => {
    const cases = ['doctor@clinic-a.test', 'a@b.test', '+919876543210', 'short'];
    const rows = await asPlatform(
      (tx) =>
        tx.$queryRaw<{ masked: string }[]>`
        SELECT platform_mask_identifier(x) AS masked FROM unnest(${cases}::text[]) AS x`,
    );
    expect(rows.map((r) => r.masked)).toEqual(cases.map(maskIdentifier));
  });
});
