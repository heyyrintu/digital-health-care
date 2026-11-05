import { samplePng } from '../src/modules/branding/logo-samples';
import { purgePatientRecords } from '../src/modules/patient-records/purge';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { withTenant } from '@dhc/db';
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
import { purgeRightsPhotos } from '../src/modules/data-rights/closure';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  patient: TokenResponse,
  admin: TokenResponse,
  doctor: TokenResponse,
  id: string;
const call = (method: string, path: string, body?: unknown, token = patient) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    headers: bearer(token),
    payload: body as object,
  });
const create = (overrides: Record<string, unknown> = {}) =>
  call('POST', '/data-rights', {
    id: randomUUID(),
    patientId: id,
    kind: 'correction',
    area: 'profile',
    field: 'name',
    value: 'Corrected Name',
    message: 'Please correct my name',
    referenceId: null,
    ...overrides,
  });
const decision = (revision = 1, overrides: Record<string, unknown> = {}) => ({
  revision,
  state: 'fulfilled',
  response: 'Corrected as requested.',
  policyReference: null,
  reviewAfter: null,
  evidenceId: null,
  ...overrides,
});
const getCode = () => h.sentCodes.at(-1)!.code;
beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  id = clinics.a.patients[0]!.id;
  await h.owner.patient.update({
    where: { id },
    data: { phone: '+919876543210', dob: new Date('1990-01-01') },
  });
  patient = await patientLogin(h, 'clinic-a', '9876543210');
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  await call('POST', '/portal/consents', {
    accept: Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({ kind, version })),
  });
  h.sentCodes.length = 0;
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('accepts rights requests after health consent withdrawal; atomically applies a profile correction with revision checks and immutable history', async () => {
  await call('POST', '/portal/consents/health_data/withdraw');
  const r = await create();
  expect(r.statusCode, r.body).toBe(200);
  const request = r.json();
  expect(
    h.services.cipher.decrypt(
      (await h.owner.dataRightsRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .detailsCipher,
    ),
  ).toContain('Please correct');
  const applied = await call('POST', `/data-rights/${request.id}/decision`, decision(), admin);
  expect(applied.statusCode, applied.body).toBe(200);
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).name).toBe('Corrected Name');
  expect(
    (await call('POST', `/data-rights/${request.id}/decision`, decision(), admin)).statusCode,
  ).toBe(409);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.dataRightsEvent.updateMany({ data: { action: 'rewritten' } }),
    ),
  ).rejects.toThrow();
  const logs = await h.owner.auditLog.findMany({
    where: { action: { startsWith: 'data_rights.' } },
  });
  expect(JSON.stringify(logs)).not.toContain('Corrected Name');
});
it('rejects foreign patients, changed retry payloads, phone field injection, front desk and other-clinic review', async () => {
  expect((await create({ patientId: clinics.b.patients[0]!.id })).statusCode).toBe(404);
  expect((await create({ field: 'phone' })).statusCode).toBe(400);
  const key = randomUUID(),
    r = await create({ id: key });
  expect(r.statusCode, r.body).toBe(200);
  expect((await create({ id: key })).statusCode).toBe(200);
  expect((await create({ id: key, value: 'Different' })).statusCode).toBe(409);
  const other = await staffLogin(h, 'clinic-b', clinics.b.admin);
  expect((await call('POST', `/data-rights/${key}/decision`, decision(), other)).statusCode).toBe(
    404,
  );
  const desk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@test.example');
  const dt = await staffLogin(h, 'clinic-a', desk);
  expect((await call('GET', '/data-rights', undefined, dt)).statusCode).toBe(403);
});
it('redacts clinical text from admins and requires an assigned doctor, chart access and real correction evidence', async () => {
  const r = await create({
      area: 'clinical',
      field: null,
      value: null,
      message: 'Private clinical request',
    }),
    key = r.json().id;
  expect(r.statusCode, r.body).toBe(200);
  const listing = await call('GET', '/data-rights', undefined, admin);
  expect(listing.body).not.toContain('Private clinical');
  expect(listing.json().data[0].details).toBeNull();
  expect((await call('POST', `/data-rights/${key}/decision`, decision(), admin)).statusCode).toBe(
    403,
  );
  expect((await call('GET', '/data-rights', undefined, doctor)).json().data).toEqual([]);
  const assign = await call(
    'POST',
    `/data-rights/${key}/assign`,
    { revision: 1, doctorId: clinics.a.doctor.userId },
    admin,
  );
  expect(assign.statusCode, assign.body).toBe(200);
  const queue = await call('GET', '/data-rights', undefined, doctor);
  expect(queue.body).toContain('Private clinical request');
  expect(
    (
      await call(
        'POST',
        `/data-rights/${key}/decision`,
        decision(2, { evidenceId: randomUUID() }),
        doctor,
      )
    ).statusCode,
  ).toBe(400);
  const retained = await call(
    'POST',
    `/data-rights/${key}/decision`,
    decision(2, {
      state: 'retained',
      response: 'Clinical record retained for care.',
      policyReference: 'CLINIC-RETENTION-1',
    }),
    doctor,
  );
  expect(retained.statusCode, retained.body).toBe(200);
  expect((await call('GET', '/data-rights', undefined, admin)).body).not.toContain(
    'Clinical record retained for care.',
  );
  expect((await call('GET', '/data-rights')).body).toContain('Clinical record retained for care.');
});
it('lets a requester withdraw; rejects stale review and cannot automatically erase clinical or financial records', async () => {
  const r = await create({ kind: 'erasure', area: 'financial', field: null, value: null });
  const key = r.json().id;
  expect((await call('POST', `/data-rights/${key}/decision`, decision(), admin)).statusCode).toBe(
    400,
  );
  const withdrawn = await call('POST', `/data-rights/${key}/withdraw`, { revision: 1 });
  expect(withdrawn.statusCode, withdrawn.body).toBe(200);
  expect(
    (
      await call(
        'POST',
        `/data-rights/${key}/decision`,
        decision(2, { state: 'retained', policyReference: 'P1' }),
        admin,
      )
    ).statusCode,
  ).toBe(409);
});
it('creates an independently readable ZIP excluding clinician private notes, unrelated patients, identity secrets and raw file keys; works without health consent', async () => {
  const place = await h.owner.clinic.create({
    data: { organisationId: clinics.a.org.id, name: 'Clinic' },
  });
  const visitType = await h.owner.consultationType.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Visit',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 10000,
    },
  });
  const ap = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      clinicId: place.id,
      consultationTypeId: visitType.id,
      startAt: h.services.now(),
      endAt: new Date(h.clock.ms + 900000),
      source: 'app',
      patientId: id,
      doctorUserId: clinics.a.doctor.userId,
      date: new Date('2026-10-06'),
      tokenNumber: 1,
      status: 'completed',
      createdByUserId: clinics.a.admin.userId,
    },
  });
  await h.owner.consultation.create({
    data: {
      organisationId: clinics.a.org.id,
      appointmentId: ap.id,
      patientId: id,
      doctorUserId: clinics.a.doctor.userId,
      lockedAt: h.services.now(),
      notesCipher: h.services.cipher.encrypt(
        JSON.stringify({
          chiefComplaint: 'Public complaint',
          symptoms: [],
          examination: '',
          diagnoses: [],
          plan: '',
          privateNotes: 'SECRET PRIVATE NOTE',
          testsAdvised: '',
          advice: '',
        }),
      ),
    },
  });
  await call('POST', '/portal/consents/health_data/withdraw');
  const key = randomUUID(),
    r = await call('POST', '/data-rights/export', { id: key, patientId: id });
  expect(r.statusCode, r.body.slice(0, 400)).toBe(200);
  expect(r.headers['content-type']).toContain('application/zip');
  expect(r.headers['cache-control']).toBe('no-store');
  const dir = mkdtempSync(join(tmpdir(), 'rights-zip-'));
  try {
    const path = join(dir, 'data.zip');
    writeFileSync(path, r.rawPayload);
    const json = execFileSync(
      'python3',
      [
        '-c',
        'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read("data.json").decode())',
        path,
      ],
      { encoding: 'utf8' },
    );
    expect(json).toContain('Public complaint');
    expect(json).not.toContain('SECRET PRIVATE NOTE');
    expect(json).not.toContain('privateNotes');
    expect(json).not.toContain('Kamla Devi');
    expect(json).not.toContain('notesCipher');
    expect(json).not.toContain('codeHash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect((await call('POST', '/data-rights/export', { id: key, patientId: id })).statusCode).toBe(
    200,
  );
  expect(
    (
      await call('POST', '/data-rights/export', {
        id: randomUUID(),
        patientId: clinics.b.patients[0]!.id,
      })
    ).statusCode,
  ).toBe(404);
});
it('purpose-binds closure OTPs, commits failed attempts, closes only current-clinic patient access and preserves care history', async () => {
  const other = await patientLogin(h, 'clinic-b', '9876543210');
  const key = randomUUID(),
    start = await call('POST', '/data-rights/closure', { id: key });
  expect(start.statusCode, start.body).toBe(200);
  const code = getCode();
  expect((await call('POST', '/data-rights/closure', { id: key })).statusCode).toBe(200);
  expect(h.sentCodes).toHaveLength(2); // One other-clinic login + one closure code.
  const attempt = await h.owner.accountClosureAttempt.findUniqueOrThrow({ where: { id: key } });
  const login = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { challengeId: attempt.challengeId, code },
  });
  expect(login.statusCode).not.toBe(200);
  const wrong = code === '000000' ? '111111' : '000000';
  expect(
    (await call('POST', `/data-rights/closure/${key}/verify`, { code: wrong, confirmed: true }))
      .statusCode,
  ).toBe(400);
  expect(
    (await h.owner.otpChallenge.findUniqueOrThrow({ where: { id: attempt.challengeId! } }))
      .attempts,
  ).toBe(1);
  const closed = await call('POST', `/data-rights/closure/${key}/verify`, {
    code,
    confirmed: true,
  });
  expect(closed.statusCode, closed.body).toBe(200);
  expect(
    (await h.owner.patient.findUniqueOrThrow({ where: { id } })).portalClosedAt,
  ).not.toBeNull();
  expect((await call('GET', '/data-rights/patients')).statusCode).toBe(401);
  expect((await call('GET', '/data-rights/patients', undefined, other)).statusCode).toBe(200);
  expect((await call('GET', '/data-rights', undefined, admin)).statusCode).toBe(200);
  h.clock.advance(601);
  const challenge = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/request',
    payload: { organisation: 'clinic-a', phone: '9876543210' },
  });
  expect(challenge.statusCode, challenge.body).toBe(200);
  const rejected = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { challengeId: challenge.json().challengeId, code: getCode() },
  });
  expect(rejected.statusCode).not.toBe(200);
});
it('requires fresh closure proof and permanently blocks the sixth guess', async () => {
  const key = randomUUID();
  await call('POST', '/data-rights/closure', { id: key });
  const code = getCode(),
    wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++)
    expect(
      (await call('POST', `/data-rights/closure/${key}/verify`, { code: wrong, confirmed: true }))
        .statusCode,
    ).toBe(400);
  expect(
    (await call('POST', `/data-rights/closure/${key}/verify`, { code, confirmed: true }))
      .statusCode,
  ).toBe(400);
  expect((await call('GET', '/data-rights/patients')).statusCode).toBe(200);
});
it('durably queues profile photo erasure and purges it while retaining clinic profile data', async () => {
  const key = `organisations/${clinics.a.org.id}/profiles/${id}.jpg`;
  await h.services.files.put(key, Buffer.from('synthetic photo'));
  await h.owner.patient.update({
    where: { id },
    data: { photoKey: key, photoMediaType: 'image/jpeg' },
  });
  const closure = randomUUID();
  await call('POST', '/data-rights/closure', { id: closure });
  const r = await call('POST', `/data-rights/closure/${closure}/verify`, {
    code: getCode(),
    confirmed: true,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(await h.owner.rightsFileDeletion.count({ where: { fileKey: key, doneAt: null } })).toBe(1);
  await purgeRightsPhotos(h.services, clinics.a.org.id);
  await expect(h.services.files.get(key)).rejects.toThrow();
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).name).toBe('Asha Verma');
});

it('closure revokes shares and erases unused uploads, but retains used files and family care history', async () => {
  const child = await h.owner.patient.create({
    data: {
      organisationId: clinics.a.org.id,
      uhid: 'RIGHTS-CHILD',
      name: 'Dependent',
      guardianPatientId: id,
      dob: new Date('2020-01-01'),
    },
  });
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
  const visit = await h.owner.appointment.create({
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
  });
  const records = [];
  for (let i = 0; i < 2; i++) {
    const rid = randomUUID();
    const created = await call('POST', `/portal/patients/${id}/records`, {
      id: rid,
      title: 'Synthetic report',
      note: 'Private note',
      category: 'lab',
      recordDate: '2026-10-01',
      appointmentId: null,
      testOrderId: null,
    });
    expect(created.statusCode, created.body).toBe(200);
    const upload = await h.app.inject({
      method: 'POST',
      url: `/v1/portal/records/${rid}/file`,
      headers: { ...bearer(patient), 'content-type': 'image/png' },
      payload: samplePng(),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    records.push(upload.json());
    const shared = await call('POST', `/portal/records/${rid}/shares`, {
      id: randomUUID(),
      doctorUserId: clinics.a.doctor.userId,
      ttlHours: 24,
    });
    expect(shared.statusCode, shared.body).toBe(200);
  }
  const used = await call(
    'POST',
    `/patient-records/${records[0].id}/use`,
    { revision: records[0].revision, appointmentId: visit.id },
    doctor,
  );
  expect(used.statusCode, used.body).toBe(200);
  const retained = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: records[0].id } }),
    unused = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: records[1].id } });
  const closure = randomUUID();
  await call('POST', '/data-rights/closure', { id: closure });
  const r = await call('POST', `/data-rights/closure/${closure}/verify`, {
    code: getCode(),
    confirmed: true,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(
    (await h.owner.patient.findUniqueOrThrow({ where: { id: child.id } })).portalClosedAt,
  ).not.toBeNull();
  expect(await h.owner.patientRecordShare.count({ where: { revokedAt: null } })).toBe(0);
  const kept = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: retained.id } });
  expect(kept.state).toBe('ready');
  expect(kept.fileKey).toBe(retained.fileKey);
  expect(kept.hiddenAt).not.toBeNull();
  expect(kept.usedAt).not.toBeNull();
  await purgePatientRecords(h.services, clinics.a.org.id);
  expect(await h.services.files.get(retained.fileKey!)).toBeDefined();
  await expect(h.services.files.get(unused.fileKey!)).rejects.toThrow();
  expect((await h.owner.appointment.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe(
    'in_consultation',
  );
});
it('fails the complete export on missing or altered file bytes and tracks a recoverable failure', async () => {
  const rid = randomUUID();
  await call('POST', `/portal/patients/${id}/records`, {
    id: rid,
    title: 'Test report',
    note: null,
    category: 'lab',
    recordDate: null,
    appointmentId: null,
    testOrderId: null,
  });
  await h.app.inject({
    method: 'POST',
    url: `/v1/portal/records/${rid}/file`,
    headers: { ...bearer(patient), 'content-type': 'image/png' },
    payload: samplePng(),
  });
  const record = await h.owner.patientRecord.findUniqueOrThrow({ where: { id: rid } });
  await h.services.files.delete(record.fileKey!);
  const key = randomUUID(),
    r = await call('POST', '/data-rights/export', { id: key, patientId: id });
  expect(r.statusCode, r.body).toBe(409);
  expect((await h.owner.dataRightsRequest.findUniqueOrThrow({ where: { id: key } })).state).toBe(
    'failed',
  );
  await h.services.files.put(record.fileKey!, samplePng());
  expect((await call('POST', '/data-rights/export', { id: key, patientId: id })).statusCode).toBe(
    200,
  );
});
it('waits for an in-flight patient operation before committing account closure', async () => {
  const key = randomUUID();
  await call('POST', '/data-rights/closure', { id: key });
  const code = getCode(),
    user = await h.owner.user.findUniqueOrThrow({ where: { phone: '+919876543210' } });
  let unlock!: () => void, ready!: () => void;
  const held = new Promise<void>((r) => (ready = r)),
    gate = new Promise<void>((r) => (unlock = r));
  const work = withTenant(h.services.db, clinics.a.org.id, async (tx) => {
    await tx.$queryRaw`SELECT user_id FROM patient_account_access WHERE user_id=${user.id}::uuid FOR SHARE`;
    ready();
    await gate;
    await tx.patient.update({ where: { id }, data: { address: 'Completed in-flight write' } });
  });
  await held;
  const closing = call('POST', `/data-rights/closure/${key}/verify`, { code, confirmed: true });
  // Start the HTTP request while the first transaction still owns its shared lock.
  const result = Promise.resolve(closing);
  await new Promise((r) => setTimeout(r, 50));
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).portalClosedAt).toBeNull();
  unlock();
  await work;
  const done = await result;
  expect(done.statusCode, done.body).toBe(200);
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).address).toBe(
    'Completed in-flight write',
  );
});
it('completes an unused-upload erasure review only after the referenced bytes have been purged', async () => {
  const rid = randomUUID();
  await call('POST', `/portal/patients/${id}/records`, {
    id: rid,
    title: 'Erase this report',
    note: null,
    category: 'lab',
    recordDate: null,
    appointmentId: null,
    testOrderId: null,
  });
  await h.app.inject({
    method: 'POST',
    url: `/v1/portal/records/${rid}/file`,
    headers: { ...bearer(patient), 'content-type': 'image/png' },
    payload: samplePng(),
  });
  const request = await create({
      kind: 'erasure',
      area: 'profile',
      field: null,
      value: null,
      referenceId: rid,
    }),
    key = request.json().id;
  expect(request.statusCode, request.body).toBe(200);
  expect(
    (await call('POST', `/data-rights/${key}/decision`, decision(1, { evidenceId: rid }), admin))
      .statusCode,
  ).toBe(400);
  expect((await call('DELETE', `/portal/records/${rid}`)).statusCode).toBe(200);
  await purgePatientRecords(h.services, clinics.a.org.id);
  const done = await call(
    'POST',
    `/data-rights/${key}/decision`,
    decision(1, { evidenceId: rid, response: 'Unused upload erasure completed.' }),
    admin,
  );
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json().state).toBe('fulfilled');
  expect(
    (await h.owner.patientRecord.findUniqueOrThrow({ where: { id: rid } })).fileKey,
  ).toBeNull();
});
it('validates corrected birth dates against the clinic day in India, including a child born after local midnight', async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 19, 30);
  patient = await patientLogin(h, 'clinic-a', '9876543210');
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  const child = await h.owner.patient.create({
    data: {
      organisationId: clinics.a.org.id,
      uhid: 'MIDNIGHT-CHILD',
      name: 'Newborn',
      guardianPatientId: id,
      dob: new Date('2026-10-06'),
    },
  });
  const r = await create({ patientId: child.id, field: 'dob', value: '2026-10-07' });
  expect(r.statusCode, r.body).toBe(200);
  const saved = await call('POST', `/data-rights/${r.json().id}/decision`, decision(), admin);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(
    (await h.owner.patient.findUniqueOrThrow({ where: { id: child.id } })).dob
      ?.toISOString()
      .slice(0, 10),
  ).toBe('2026-10-07');
  const future = await create({ patientId: child.id, field: 'dob', value: '2026-10-08' });
  expect(
    (await call('POST', `/data-rights/${future.json().id}/decision`, decision(), admin)).statusCode,
  ).toBe(400);
});
