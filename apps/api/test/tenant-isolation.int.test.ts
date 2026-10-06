import { ErrorResponse, PatientListResponse } from '@dhc/contracts';
import { withAuth, withTenant } from '@dhc/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';

/**
 * Phase 0 exit criterion: a signed-in user in organisation A cannot see organisation B.
 * Checked through the API and directly against Postgres row-level security.
 */
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

describe('through the API', () => {
  it('lists only the caller’s own patients', async () => {
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const res = await h.app.inject({ method: 'GET', url: '/v1/patients', headers: bearer(tokens) });
    expect(res.statusCode).toBe(200);
    const names = PatientListResponse.parse(res.json()).data.map((p) => p.name);
    expect(names.sort()).toEqual(['Asha Verma', 'Kamla Devi']);
  });

  it('returns 404 for another organisation’s patient, exactly like a missing one', async () => {
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const foreign = await h.app.inject({
      method: 'GET',
      url: `/v1/patients/${clinics.b.patients[0]!.id}`,
      headers: bearer(tokens),
    });
    const missing = await h.app.inject({
      method: 'GET',
      url: '/v1/patients/00000000-0000-4000-8000-000000000000',
      headers: bearer(tokens),
    });
    expect(foreign.statusCode).toBe(404);
    expect(ErrorResponse.parse(foreign.json()).error.code).toBe('NOT_FOUND');
    expect(foreign.json().error.message).toBe(missing.json().error.message);
  });

  it('never matches another organisation’s patients in search', async () => {
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/patients?q=Ravi',
      headers: bearer(tokens),
    });
    expect(res.json().data).toEqual([]);
  });

  it('shows each clinic admin only their own audit trail', async () => {
    await staffLogin(h, 'clinic-b', clinics.b.doctor);
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.admin);
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/audit-log?limit=100',
      headers: bearer(tokens),
    });
    expect(res.statusCode).toBe(200);
    const actors = new Set(
      res.json().data.map((e: { actorUserId: string | null }) => e.actorUserId),
    );
    expect(actors.has(clinics.b.doctor.userId)).toBe(false);
    expect(actors.has(clinics.a.admin.userId)).toBe(true);
  });

  it('records each patient view in the viewer’s audit trail', async () => {
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const patient = clinics.a.patients[0]!;
    await h.app.inject({
      method: 'GET',
      url: `/v1/patients/${patient.id}`,
      headers: bearer(tokens),
    });
    const views = await h.owner.auditLog.findMany({
      where: { action: 'patient.viewed', entityId: patient.id },
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      organisationId: clinics.a.org.id,
      actorUserId: clinics.a.doctor.userId,
    });
  });

  it('cannot sign in to an organisation the user does not belong to', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        organisation: 'clinic-b',
        identifier: clinics.a.doctor.email,
        password: 'synthetic-Passw0rd!',
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('in the database (row-level security)', () => {
  it('scopes reads to the organisation set for the transaction', async () => {
    const countA = await withTenant(h.services.db, clinics.a.org.id, (tx) => tx.patient.count());
    const countB = await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.patient.count());
    expect([countA, countB]).toEqual([2, 3]);
  });

  it('sees nothing when no organisation is set', async () => {
    const count = await h.services.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_app');
      return tx.patient.count();
    });
    expect(count).toBe(0);
  });

  it('rejects writes that name another organisation', async () => {
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.patient.create({
          data: { organisationId: clinics.b.org.id, uhid: 'X-1', name: 'Synthetic' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move a row into another organisation', async () => {
    const id = clinics.a.patients[0]!.id;
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.patient.update({ where: { id }, data: { organisationId: clinics.b.org.id } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('gives the sign-in role no access to clinical tables', async () => {
    await expect(withAuth(h.services.db, (tx) => tx.patient.count())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('keeps the audit log append-only, even for the owner', async () => {
    await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await expect(h.owner.auditLog.updateMany({ data: { action: 'tampered' } })).rejects.toThrow(
      /append-only/,
    );
    await expect(h.owner.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it('protects every table that has an organisation_id column', async () => {
    const unprotected = await h.owner.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS table
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organisation_id' AND NOT a.attisdropped
      WHERE c.relkind = 'r'
        AND c.relname NOT IN ('sessions', 'otp_challenges')
        AND (NOT c.relrowsecurity OR NOT EXISTS (
          SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND 'dhc_app'::regrole = ANY (p.polroles)
        ))`;
    // sessions and otp_challenges are identity tables reachable only by dhc_auth.
    expect(unprotected).toEqual([]);
  });
});
