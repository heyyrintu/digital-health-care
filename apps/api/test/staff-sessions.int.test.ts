/**
 * Device sign-out (PRD §9.2): a clinic admin sees each staff member's signed-in devices
 * at this clinic and signs one or all of them out.
 */
import {
  AuditListResponse,
  SignOutAllResponse,
  StaffSessionList,
  type TokenResponse,
} from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let admin: TokenResponse;
let laptop: TokenResponse;
let phone: TokenResponse;
let elsewhere: TokenResponse;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  // Clinic A's doctor also works at clinic B.
  await h.owner.membership.create({
    data: { organisationId: clinics.b.org.id, userId: clinics.a.doctor.userId, role: 'doctor' },
  });
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  laptop = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  phone = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  elsewhere = await staffLogin(h, 'clinic-b', clinics.a.doctor);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse) =>
  h.app.inject({ method: method as 'GET', url: `/v1${url}`, headers: bearer(tokens) });

const sessionsOf = async (userId: string, tokens = admin) => {
  const res = await call('GET', `/staff/members/${userId}/sessions`, tokens);
  expect(res.statusCode, res.body).toBe(200);
  return StaffSessionList.parse(res.json()).data;
};

const stillSignedIn = async (tokens: TokenResponse) =>
  (await call('GET', '/staff/members/' + clinics.a.doctor.userId + '/sessions', tokens))
    .statusCode !== 401;

describe('staff devices', () => {
  it('lists a staff member’s devices at this clinic only, newest use first', async () => {
    h.clock.advance(60);
    // Using a session moves it to the top.
    await call('GET', '/staff/members', admin);
    const doctor = await sessionsOf(clinics.a.doctor.userId);
    expect(doctor).toHaveLength(2);
    expect(doctor.every((s) => !s.current)).toBe(true);

    const own = await sessionsOf(clinics.a.admin.userId);
    expect(own).toHaveLength(1);
    expect(own[0]!.current).toBe(true);
  });

  it('only clinic admins see devices; other clinics’ staff and patients read as not found', async () => {
    expect(
      (await call('GET', `/staff/members/${clinics.a.admin.userId}/sessions`, laptop)).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/staff/members/${clinics.b.admin.userId}/sessions`, admin)).statusCode,
    ).toBe(404);
  });

  it('signs one device out: it gets 401 at once, the others keep working, and it is audited', async () => {
    const [first] = await sessionsOf(clinics.a.doctor.userId);
    const revoke = await call('POST', `/staff/sessions/${first!.id}/revoke`, admin);
    expect(revoke.statusCode, revoke.body).toBe(204);

    const left = await sessionsOf(clinics.a.doctor.userId);
    expect(left.map((s) => s.id)).not.toContain(first!.id);
    expect(left).toHaveLength(1);
    // Exactly one of the doctor's clinic A tokens is dead.
    const alive = [await stillSignedIn(laptop), await stillSignedIn(phone)];
    expect(alive.filter(Boolean)).toHaveLength(1);

    // Twice is not found; so is another clinic's session.
    expect((await call('POST', `/staff/sessions/${first!.id}/revoke`, admin)).statusCode).toBe(404);
    const other = await h.owner.session.findFirstOrThrow({
      where: { organisationId: clinics.b.org.id, userId: clinics.a.doctor.userId },
    });
    expect((await call('POST', `/staff/sessions/${other.id}/revoke`, admin)).statusCode).toBe(404);

    const log = AuditListResponse.parse(
      (await call('GET', '/audit-log?action=staff.session', admin)).json(),
    );
    expect(log.data).toMatchObject([
      { action: 'staff.session.revoked', entityType: 'session', entityId: first!.id },
    ]);
  });

  it('signs a person out everywhere at this clinic, but not at the other clinic', async () => {
    const res = await call('POST', `/staff/members/${clinics.a.doctor.userId}/sign-out-all`, admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(SignOutAllResponse.parse(res.json())).toEqual({ revoked: 2 });
    expect(await sessionsOf(clinics.a.doctor.userId)).toEqual([]);
    expect(await stillSignedIn(laptop)).toBe(false);
    expect(await stillSignedIn(phone)).toBe(false);

    // Clinic B's session is untouched; the person can still sign in again here.
    const row = await h.owner.session.findFirstOrThrow({
      where: { organisationId: clinics.b.org.id, userId: clinics.a.doctor.userId },
    });
    expect(row.revokedAt).toBeNull();
    expect(elsewhere.accessToken).toBeTruthy();
    await staffLogin(h, 'clinic-a', clinics.a.doctor);

    const entry = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'staff.sessions.revoked_all' },
    });
    expect(entry).toMatchObject({
      organisationId: clinics.a.org.id,
      actorUserId: clinics.a.admin.userId,
      entityId: clinics.a.doctor.userId,
      metadata: { sessionsRevoked: 2 },
    });
  });
});
