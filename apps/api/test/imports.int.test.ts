import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { withTenant, withPlatform } from '@dhc/db';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  patientLogin,
  bearer,
} from './harness';
import type { TokenResponse } from '@dhc/contracts';
const h = createHarness();
let testAddress = 0;
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  admin: TokenResponse,
  other: TokenResponse,
  doctor: TokenResponse;
const mapping = { externalId: 'ID', name: 'Name', phone: 'Mobile', dob: 'DOB', uhid: 'UHID' };
const csv = 'ID,Name,Mobile,DOB,UHID\nOLD-001,Synthetic Import,9123456789,1990-01-02,OLD1001';
const call = (method: string, path: string, body?: object, token = admin) =>
  h.app.inject({
    method: method as 'GET',
    remoteAddress: `127.0.0.${testAddress}`,
    url: '/v1' + path,
    payload: body,
    headers: bearer(token),
  });
const preview = (text = csv, id = randomUUID(), source = 'legacy') =>
  call('POST', '/patient-imports/preview', { id, source, csv: text, mapping });
async function draft(text = csv) {
  const r = await preview(text);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const apply = (id: string) => call('POST', `/patient-imports/${id}/apply`, { acknowledged: true });
beforeEach(async () => {
  testAddress++;
  await resetDatabase(h.owner);
  h.clock.ms = Date.now();
  clinics = await seedTwoClinics(h);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  other = await staffLogin(h, 'clinic-b', clinics.b.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('dry runs do not create patients; preview payload is encrypted and reads are audited', async () => {
  const before = await h.owner.patient.count(),
    j = await draft();
  expect(j.newCount).toBe(1);
  expect(j.rows[0].phone).toBe('+919123456789');
  expect(await h.owner.patient.count()).toBe(before);
  const raw = await h.owner.patientImportJob.findUniqueOrThrow({ where: { id: j.id } });
  expect(raw.payloadCipher).not.toContain('Synthetic Import');
  expect((await call('GET', `/patient-imports/${j.id}`)).statusCode).toBe(200);
  expect(await h.owner.auditLog.count({ where: { action: 'import.viewed' } })).toBe(1);
});
it('requires clinic admin and isolates previews, apply, cancel and list from another clinic and platform', async () => {
  const j = await draft();
  for (const method of ['GET', 'POST'])
    expect(
      (
        await call(
          method,
          `/patient-imports/${j.id}${method === 'POST' ? '/apply' : ''}`,
          method === 'POST' ? { acknowledged: true } : undefined,
          doctor,
        )
      ).statusCode,
    ).toBe(403);
  expect((await call('GET', `/patient-imports/${j.id}`, undefined, other)).statusCode).toBe(404);
  expect(
    (await call('POST', `/patient-imports/${j.id}/apply`, { acknowledged: true }, other))
      .statusCode,
  ).toBe(404);
  expect((await call('POST', `/patient-imports/${j.id}/cancel`, undefined, other)).statusCode).toBe(
    404,
  );
  expect((await call('GET', '/patient-imports', undefined, other)).json().data).toHaveLength(0);
  await expect(
    withPlatform(h.services.db, (tx) => tx.patientImportJob.findMany()),
  ).rejects.toThrow();
  const patient = await patientLogin(h, 'clinic-a', '9876543210');
  expect((await call('GET', '/patient-imports', undefined, patient)).statusCode).toBe(403);
});
it('atomically creates and preserves UHID, with no login accounts, consent or messages', async () => {
  const j = await draft(),
    users = await h.owner.user.count();
  expect((await apply(j.id)).statusCode).toBe(200);
  const p = await h.owner.patient.findUniqueOrThrow({
    where: { organisationId_uhid: { organisationId: clinics.a.org.id, uhid: 'OLD1001' } },
  });
  expect(p.phone).toBe('+919123456789');
  expect(p.accountUserId).toBeNull();
  expect(await h.owner.user.count()).toBe(users);
  expect(await h.owner.accountConsent.count()).toBe(0);
  expect(await h.owner.whatsAppDelivery.count()).toBe(0);
  const results = await Promise.all([apply(j.id), apply(j.id)]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(await h.owner.patientImportRecord.count()).toBe(1);
});
it('recovers stable previews and rejects changed input reuse', async () => {
  const id = randomUUID(),
    a = await preview(csv, id),
    b = await preview(csv, id);
  expect(b.json()).toEqual(a.json());
  expect((await preview(csv.replace('OLD-001', 'OLD-002'), id)).statusCode).toBe(409);
});
it('allows another clinic admin to inspect but not confirm or cancel someone else’s preview', async () => {
  const j = await draft();
  await h.owner.membership.create({
    data: {
      organisationId: clinics.a.org.id,
      userId: clinics.b.admin.userId,
      role: 'clinic_admin',
      status: 'active',
    },
  });
  const second = await staffLogin(h, 'clinic-a', clinics.b.admin);
  expect((await call('GET', `/patient-imports/${j.id}`, undefined, second)).statusCode).toBe(200);
  expect(
    (await call('POST', `/patient-imports/${j.id}/apply`, { acknowledged: true }, second))
      .statusCode,
  ).toBe(403);
  expect(
    (await call('POST', `/patient-imports/${j.id}/cancel`, undefined, second)).statusCode,
  ).toBe(403);
});
it('skips unchanged source IDs across files and blocks changed source data without overwriting', async () => {
  const j = await draft();
  await apply(j.id);
  const again = await draft();
  expect(again.skippedCount).toBe(1);
  expect((await apply(again.id)).statusCode).toBe(200);
  expect(await h.owner.patientImportRecord.count()).toBe(1);
  const changed = await draft(csv.replace('Synthetic Import', 'Changed Name'));
  expect(changed.errorCount).toBe(1);
  expect((await apply(changed.id)).statusCode).toBe(409);
});
it('rejects invalid rows and intra-file external-ID, UHID and identity duplicates', async () => {
  for (const text of [
    csv.replace('9123456789', '123'),
    csv.replace('1990-01-02', '2990-01-02'),
    csv + '\nOLD-001,Other Person,9234567890,1980-01-01,OLD1002',
    csv + '\nOLD-002,Other Person,9234567890,1980-01-01,OLD1001',
    csv + '\nOLD-002,Synthetic Import,9123456789,1990-01-02,OLD1002',
  ]) {
    const j = await draft(text);
    expect(j.errorCount).toBeGreaterThan(0);
    expect((await apply(j.id)).statusCode).toBe(409);
  }
  expect(await h.owner.patientImportRecord.count()).toBe(0);
});
it('blocks existing patients even under different legacy IDs and blocks stale previews atomically', async () => {
  const j = await draft(csv + '\nOLD-002,Second Import,9234567890,1980-01-01,OLD1002');
  await h.owner.patient.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Synthetic Import',
      phone: '+919123456789',
      uhid: 'EXISTING',
      createdByUserId: clinics.a.admin.userId,
    },
  });
  expect((await apply(j.id)).statusCode).toBe(409);
  expect(await h.owner.patientImportRecord.count()).toBe(0);
  expect(await h.owner.patient.count({ where: { uhid: 'OLD1002' } })).toBe(0);
  expect((await draft()).errorCount).toBe(1);
});
it('shares a number with a distinct family member only after preview acknowledgement', async () => {
  const j = await draft(csv + '\nOLD-002,Other Family,9123456789,1980-01-01,OLD1002');
  expect(j.errorCount).toBe(0);
  expect(j.rows.every((r: { warnings: string[] }) => r.warnings.length > 0)).toBe(true);
  expect(
    (await call('POST', `/patient-imports/${j.id}/apply`, { acknowledged: false })).statusCode,
  ).toBe(400);
  expect((await apply(j.id)).statusCode).toBe(200);
});
it('allocates UHIDs around legacy numbers and refuses duplicate UHIDs', async () => {
  const j = await draft(
    'ID,Name,Mobile,DOB,UHID\nOLD-002,Other Patient,9234567890,1980-01-01,\n' +
      csv.split('\n')[1]!.replace('OLD1001', '10001'),
  );
  expect((await apply(j.id)).statusCode).toBe(200);
  const p = await h.owner.patient.findFirstOrThrow({ where: { name: 'Other Patient' } });
  expect(p.uhid).toBe('10002');
  expect((await draft(csv.replace('OLD-001', 'OLD-003'))).errorCount).toBe(1);
});
it('serializes competing previews so only one can create a source record', async () => {
  const a = await draft(),
    b = await draft(),
    r = await Promise.all([apply(a.id), apply(b.id)]);
  expect(r.map((x) => x.statusCode).sort()).toEqual([200, 409]);
  expect(await h.owner.patientImportRecord.count()).toBe(1);
});
it('cancellation and expiry prevent applying; imported provenance cannot be rewritten', async () => {
  const j = await draft();
  expect((await call('POST', `/patient-imports/${j.id}/cancel`)).statusCode).toBe(200);
  expect((await apply(j.id)).statusCode).toBe(409);
  const exp = await draft();
  h.clock.advance(86401);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  expect((await apply(exp.id)).statusCode).toBe(409);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.patientImportJob.update({ where: { id: j.id }, data: { source: 'other' } }),
    ),
  ).rejects.toThrow();
});
it('rejects malformed CSV and ambiguous or missing mapping', async () => {
  expect((await preview('ID,ID\n1,2')).statusCode).toBe(400);
  const b = {
    id: randomUUID(),
    source: 'legacy',
    csv,
    mapping: { externalId: 'ID', name: 'Name', phone: 'Missing' },
  };
  expect((await call('POST', '/patient-imports/preview', b)).statusCode).toBe(400);
  expect(
    (
      await call('POST', '/patient-imports/preview', {
        ...b,
        mapping: { ...mapping, phone: 'Name' },
      })
    ).statusCode,
  ).toBe(400);
});
it('exports only the signed-in patient import provenance, never a batch containing another person', async () => {
  const j = await draft(csv + '\nOTHER-SECRET,Other Export Person,9234567890,1980-01-01,OTHER1001');
  expect((await apply(j.id)).statusCode).toBe(200);
  const record = await h.owner.patientImportRecord.findFirstOrThrow({
    where: { externalId: 'OLD-001' },
  });
  const patient = await patientLogin(h, 'clinic-a', '9123456789');
  const r = await call(
    'POST',
    '/data-rights/export',
    { id: randomUUID(), patientId: record.patientId },
    patient,
  );
  expect(r.statusCode).toBe(200);
  const json = execFileSync(
    'python3',
    [
      '-c',
      'import io,zipfile,sys; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(z.read("data.json").decode())',
    ],
    { input: r.rawPayload, encoding: 'utf8' },
  );
  expect(JSON.parse(json).importProvenance).toEqual([
    { source: 'legacy', externalId: 'OLD-001', patientId: record.patientId },
  ]);
  expect(json).not.toContain('OTHER-SECRET');
  expect(json).not.toContain('Other Export Person');
});
it('handles the maximum batch atomically and blocks row 101', async () => {
  const text =
    'ID,Name,Mobile,DOB,UHID\n' +
    Array.from(
      { length: 100 },
      (_, i) => `CAP-${i},Capacity Patient ${i},9${String(100000000 + i)},1990-01-01,CAP${i}`,
    ).join('\n');
  const j = await draft(text);
  expect(j.newCount).toBe(100);
  const r = await apply(j.id);
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  expect(await h.owner.patientImportRecord.count()).toBe(100);
  expect((await preview(text + '\nOVER,Overflow,9234567890,1990-01-01,OVER1')).statusCode).toBe(
    400,
  );
});
