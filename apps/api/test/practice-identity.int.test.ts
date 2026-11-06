import { afterAll, beforeEach, expect, it } from 'vitest';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';
const h = createHarness();
beforeEach(() => resetDatabase(h.owner));
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('limits organisation renaming to its own admin and audits changes', async () => {
  const { a, b } = await seedTwoClinics(h);
  const admin = await staffLogin(h, 'clinic-a', a.admin);
  const doctor = await staffLogin(h, 'clinic-a', a.doctor);
  const call = (path: string, token: typeof admin, payload: object) =>
    h.app.inject({ method: 'PUT', url: '/v1' + path, headers: bearer(token), payload });
  expect((await call('/organisation-identity', doctor, { name: 'Forbidden' })).statusCode).toBe(
    403,
  );
  expect((await call('/organisation-identity', admin, { name: '  ' })).statusCode).toBe(400);
  expect(
    (await call('/organisation-identity', admin, { name: 'Updated clinic', slug: 'hijack' }))
      .statusCode,
  ).toBe(400);
  const saved = await call('/organisation-identity', admin, { name: 'Updated clinic' });
  expect(saved.statusCode, saved.body).toBe(200);
  expect((await h.owner.organisation.findUniqueOrThrow({ where: { id: a.org.id } })).name).toBe(
    'Updated clinic',
  );
  expect((await h.owner.organisation.findUniqueOrThrow({ where: { id: b.org.id } })).name).toBe(
    'Clinic B',
  );
  const renamed = await call('/staff/profile', doctor, { name: 'Dr Updated' });
  expect(renamed.statusCode, renamed.body).toBe(200);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: a.doctor.userId } })).displayName,
  ).toBe('Dr Updated');
  expect(
    (await call('/staff/profile', doctor, { name: 'Other', userId: b.doctor.userId })).statusCode,
  ).toBe(400);
  expect(
    await h.owner.auditLog.count({
      where: { action: { in: ['staff.profile_updated', 'organisation.name_updated'] } },
    }),
  ).toBe(2);
  const c = await h.owner.clinic.create({
    data: { organisationId: a.org.id, name: 'Old location', address: 'Old address' },
  });
  const edit = await h.app.inject({
    method: 'PATCH',
    url: '/v1/clinics/' + c.id,
    headers: bearer(admin),
    payload: { name: 'New location', address: 'New address' },
  });
  expect(edit.statusCode, edit.body).toBe(200);
  expect(edit.json()).toMatchObject({ name: 'New location', address: 'New address' });
});
