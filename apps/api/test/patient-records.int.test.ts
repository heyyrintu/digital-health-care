import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { CURRENT_CONSENT_VERSIONS, type TokenResponse } from '@dhc/contracts';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  patientLogin,
  staffLogin,
  bearer,
  addStaff,
} from './harness';
import { samplePng } from '../src/modules/branding/logo-samples';
import { samplePdf } from '../src/modules/documents/document-samples';
import { purgePatientRecords } from '../src/modules/patient-records/purge';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  patient: TokenResponse,
  doctor: TokenResponse,
  admin: TokenResponse,
  otherDoctor: TokenResponse,
  id: string,
  child: string,
  visit: string;
const call = (method: string, path: string, body?: unknown, token = patient) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    headers: bearer(token),
    payload: body as object,
  });
const meta = (recordId = randomUUID()) => ({
  id: recordId,
  title: 'Synthetic report',
  note: 'Private test note',
  category: 'lab',
  recordDate: '2026-10-01',
  appointmentId: null,
  testOrderId: null,
});
async function create(patientId = id, body = meta()) {
  const r = await call('POST', `/portal/patients/${patientId}/records`, body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { id: string; revision: number };
}
const upload = (recordId: string, data: Buffer = samplePng(), mediaType = 'image/png') =>
  h.app.inject({
    method: 'POST',
    url: `/v1/portal/records/${recordId}/file`,
    headers: { ...bearer(patient), 'content-type': mediaType },
    payload: data,
  });
async function ready(patientId = id) {
  const r = await create(patientId);
  const result = await upload(r.id);
  expect(result.statusCode, result.body).toBe(200);
  return result.json() as { id: string; revision: number };
}
async function share(recordId: string, ttlHours = 24) {
  const r = await call('POST', `/portal/records/${recordId}/shares`, {
    id: randomUUID(),
    doctorUserId: clinics.a.doctor.userId,
    ttlHours,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { id: string; url: string };
}
const docFile = (recordId: string, token = doctor) =>
  call('GET', `/patient-records/${recordId}/file`, undefined, token);
const use = (r: { id: string; revision: number }, appointmentId = visit) =>
  call('POST', `/patient-records/${r.id}/use`, { revision: r.revision, appointmentId }, doctor);
beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  id = clinics.a.patients[0]!.id;
  await h.owner.patient.update({
    where: { id },
    data: { phone: '+919876543210', dob: new Date('1992-01-01') },
  });
  child = (
    await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'CHILD',
        name: 'Child',
        guardianPatientId: id,
      },
    })
  ).id;
  patient = await patientLogin(h, 'clinic-a', '9876543210');
  await call('POST', '/portal/consents', {
    accept: Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({ kind, version })),
  });
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  otherDoctor = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'doctor', 'other@clinic-a.test'),
  );
  const place = await h.owner.clinic.create({
      data: { organisationId: clinics.a.org.id, name: 'Clinic' },
    }),
    type = await h.owner.consultationType.create({
      data: {
        organisationId: clinics.a.org.id,
        name: 'Visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 10000,
      },
    });
  visit = (
    await h.owner.appointment.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: id,
        doctorUserId: clinics.a.doctor.userId,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date('2026-10-06'),
        startAt: h.services.now(),
        endAt: new Date(h.clock.ms + 900000),
        status: 'in_consultation',
        source: 'app',
        tokenNumber: 1,
        createdByUserId: clinics.a.doctor.userId,
      },
    })
  ).id;
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('uploads checked bytes once per request ID, encrypts titles/notes and rejects file replacement', async () => {
  const body = meta(),
    r = await create(id, body);
  expect((await create(id, body)).id).toBe(r.id);
  const first = await upload(r.id);
  expect(first.statusCode, first.body).toBe(200);
  expect((await upload(r.id)).statusCode).toBe(200);
  expect((await upload(r.id, samplePdf(), 'application/pdf')).statusCode).toBe(409);
  const row = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: r.id } });
  expect(row.detailsCipher).not.toContain('Synthetic report');
  expect(row.state).toBe('ready');
  const file = await call('GET', `/portal/records/${r.id}/file`);
  expect(file.rawPayload.equals(samplePng())).toBe(true);
  expect(file.headers['cache-control']).toBe('no-store');
  expect(
    await h.owner.auditLog.count({ where: { action: 'record.uploaded', entityId: r.id } }),
  ).toBe(1);
  expect(
    (await call('POST', `/portal/patients/${id}/records`, { ...body, title: 'Changed' }))
      .statusCode,
  ).toBe(409);
});
it('enforces family/tenant/consent boundaries and appointment patient references', async () => {
  const r = await ready(child);
  expect((await docFile(r.id)).statusCode).toBe(404);
  expect(
    (await call('POST', `/portal/patients/${clinics.b.patients[0]!.id}/records`, meta()))
      .statusCode,
  ).toBe(404);
  expect(
    (await call('POST', `/portal/patients/${child}/records`, { ...meta(), appointmentId: visit }))
      .statusCode,
  ).toBe(404);
  await call('POST', '/portal/consents/health_data/withdraw');
  expect((await call('GET', `/portal/records/${r.id}/file`)).statusCode).toBe(403);
});
it('shares only with the named active doctor, expires links and revokes existing access', async () => {
  const r = await ready(),
    s = await share(r.id, 1),
    token = s.url.split('#')[1];
  expect((await call('POST', '/record-shares/resolve', { token }, otherDoctor)).statusCode).toBe(
    404,
  );
  expect((await call('POST', '/record-shares/resolve', { token }, doctor)).statusCode).toBe(200);
  expect((await docFile(r.id)).statusCode).toBe(200);
  expect((await docFile(r.id, admin)).statusCode).toBe(403);
  h.clock.advance(3601);
  expect((await docFile(r.id)).statusCode).toBe(404);
  expect((await call('POST', '/record-shares/resolve', { token }, doctor)).statusCode).toBe(404);
  const next = await share(r.id);
  await call('DELETE', `/portal/records/${r.id}/shares/${next.id}`);
  expect((await docFile(r.id)).statusCode).toBe(404);
});
it('retains a used clinical file, blocks edits/erasure and allows patient hide/restore', async () => {
  const r = await ready();
  await share(r.id);
  const used = await use(r);
  expect(used.statusCode, used.body).toBe(200);
  expect(used.json().usedAt).toBeTruthy();
  await use(r);
  expect(await h.owner.patientRecordUse.count({ where: { recordId: r.id } })).toBe(1);
  expect(
    (await call('PATCH', `/portal/records/${r.id}`, { ...meta(), id: undefined, revision: 1 }))
      .statusCode,
  ).toBe(409);
  await expect(
    h.owner.patientRecord.update({ where: { id: r.id }, data: { usedAt: null } }),
  ).rejects.toThrow(/immutable/);
  const hidden = await call('DELETE', `/portal/records/${r.id}`);
  expect(hidden.json().state).toBe('ready');
  expect(hidden.json().canRestore).toBe(true);
  expect((await call('GET', `/portal/records/${r.id}/file`)).statusCode).toBe(404);
  expect((await docFile(r.id)).statusCode).toBe(200);
  await purgePatientRecords(h.services, clinics.a.org.id);
  expect((await docFile(r.id)).statusCode).toBe(200);
  expect((await call('POST', `/portal/records/${r.id}/restore`)).statusCode).toBe(200);
});
it('purges unused bytes and encrypted details durably; deleted IDs cannot be restored', async () => {
  const r = await ready();
  await share(r.id);
  const original = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: r.id } });
  expect((await call('DELETE', `/portal/records/${r.id}`)).json().state).toBe('deleting');
  expect((await docFile(r.id)).statusCode).toBe(404);
  await purgePatientRecords(h.services, clinics.a.org.id);
  const deleted = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: r.id } });
  expect(deleted).toMatchObject({
    state: 'deleted',
    fileKey: null,
    detailsCipher: null,
    sha256: null,
    sourceSha256: null,
  });
  await expect(h.services.files.get(original.fileKey!)).rejects.toThrow();
  expect((await call('POST', `/portal/records/${r.id}/restore`)).statusCode).toBe(409);
});
it('retries storage deletion failures without falsely reporting a purge', async () => {
  const r = await ready();
  await call('DELETE', `/portal/records/${r.id}`);
  const spy = vi
    .spyOn(h.services.files, 'delete')
    .mockRejectedValueOnce(new Error('Synthetic unavailable'));
  await purgePatientRecords(h.services, clinics.a.org.id);
  expect((await h.owner.patientRecord.findUniqueOrThrow({ where: { id: r.id } })).state).toBe(
    'deleting',
  );
  h.clock.advance(61);
  await purgePatientRecords(h.services, clinics.a.org.id);
  expect((await h.owner.patientRecord.findUniqueOrThrow({ where: { id: r.id } })).state).toBe(
    'deleted',
  );
  spy.mockRestore();
});
it('serializes care use against deletion and never purges a used file', async () => {
  const r = await ready();
  await share(r.id);
  const [used, deleted] = await Promise.all([use(r), call('DELETE', `/portal/records/${r.id}`)]);
  expect(deleted.statusCode).toBe(200);
  await purgePatientRecords(h.services, clinics.a.org.id);
  const row = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: r.id } });
  if (used.statusCode === 200) {
    expect(row.usedAt).not.toBeNull();
    expect(row.fileKey).not.toBeNull();
    await expect(h.services.files.get(row.fileKey!)).resolves.toBeDefined();
  } else {
    expect(used.statusCode).toBe(404);
    expect(row.state).toBe('deleted');
  }
});
it('combines checked photo pages into one verified multi-page PDF', async () => {
  const r = await create(),
    data =
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
    body = {
      pages: [
        { mediaType: 'image/jpeg', data },
        { mediaType: 'image/jpeg', data },
      ],
    };
  const merged = await call('POST', `/portal/records/${r.id}/photo-pages`, body);
  expect(merged.statusCode, merged.body).toBe(200);
  expect((await call('POST', `/portal/records/${r.id}/photo-pages`, body)).statusCode).toBe(200);
  const file = await call('GET', `/portal/records/${r.id}/file`);
  expect((await PDFDocument.load(file.rawPayload)).getPageCount()).toBe(2);
});
it('binds review/use to the displayed revision and requires a treating visit', async () => {
  const r = await ready();
  await share(r.id);
  const body = meta();
  const { id: _id, ...metadata } = body;
  const edited = await call('PATCH', `/portal/records/${r.id}`, {
    ...metadata,
    title: 'Updated report',
    revision: 1,
  });
  expect(edited.statusCode, edited.body).toBe(200);
  expect((await use(r)).statusCode).toBe(409);
  await h.owner.appointment.update({ where: { id: visit }, data: { status: 'confirmed' } });
  expect((await use({ id: r.id, revision: 2 })).statusCode).toBe(409);
  const review = await call('POST', `/patient-records/${r.id}/review`, { revision: 2 }, doctor);
  expect(review.statusCode).toBe(200);
  expect(review.json().reviewedAt).toBeTruthy();
});
it('an explicit file grant does not grant access to the rest of a restricted chart', async () => {
  const r = await ready();
  await share(r.id);
  await h.owner.appointment.update({ where: { id: visit }, data: { status: 'confirmed' } });
  await h.owner.organisationSettings.create({
    data: { organisationId: clinics.a.org.id, chartModel: 'own_patients' },
  });
  expect((await docFile(r.id)).statusCode).toBe(200);
  expect((await call('GET', `/patients/${id}/chart`, undefined, doctor)).statusCode).toBe(403);
  await h.owner.membership.updateMany({
    where: { organisationId: clinics.a.org.id, userId: clinics.a.doctor.userId },
    data: { status: 'revoked' },
  });
  expect((await docFile(r.id)).statusCode).toBe(401);
});
it('pages within owned records only and expires unfinished uploads', async () => {
  const a = await create(),
    b = await ready(child);
  const first = await call('GET', '/portal/records?limit=1');
  expect(first.json().data).toHaveLength(1);
  expect(first.json().nextCursor).toBeTruthy();
  const second = await call('GET', '/portal/records?limit=1&cursor=' + first.json().nextCursor);
  expect(second.json().data).toHaveLength(1);
  expect((await call('GET', '/portal/records?cursor=' + randomUUID())).statusCode).toBe(404);
  h.clock.advance(86401);
  await purgePatientRecords(h.services, clinics.a.org.id);
  expect((await h.owner.patientRecord.findUniqueOrThrow({ where: { id: a.id } })).state).toBe(
    'deleted',
  );
  expect((await h.owner.patientRecord.findUniqueOrThrow({ where: { id: b.id } })).state).toBe(
    'ready',
  );
});

it('consent withdrawal closes unused share access while clinical use stays retained', async () => {
  const unused = await ready(),
    care = await ready();
  const link = await share(unused.id);
  await share(care.id);
  expect((await use(care)).statusCode).toBe(200);
  await call('POST', '/portal/consents/health_data/withdraw');
  expect((await docFile(unused.id)).statusCode).toBe(404);
  expect((await docFile(care.id)).statusCode).toBe(200);
  expect(
    (await call('POST', '/record-shares/resolve', { token: link.url.split('#')[1] }, doctor))
      .statusCode,
  ).toBe(404);
  const listed = await call('GET', `/patients/${id}/records`, undefined, doctor);
  expect(listed.json().data.map((r: { id: string }) => r.id)).toEqual([care.id]);
});
