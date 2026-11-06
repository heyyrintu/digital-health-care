import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { CURRENT_CONSENT_VERSIONS, type TokenResponse } from '@dhc/contracts';
import { withTenant, withAuth, withPlatform } from '@dhc/db';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  patientLogin,
  bearer,
} from './harness';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  doctor: TokenResponse,
  admin: TokenResponse,
  patient: TokenResponse,
  other: TokenResponse,
  id: string;
const def = {
  title: 'Synthetic questionnaire',
  titleHi: '',
  instructions: '',
  instructionsHi: '',
  questions: [
    { id: 'q1', label: 'Synthetic first question', labelHi: '', min: 0, max: 10 },
    { id: 'q2', label: 'Synthetic second question', labelHi: '', min: 1, max: 5 },
  ],
};
const call = (method: string, path: string, body?: object, token = doctor) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    headers: bearer(token),
    payload: body,
  });
const consent = (token: TokenResponse) =>
  call(
    'POST',
    '/portal/consents',
    {
      accept: Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
        kind,
        version,
      })),
    },
    token,
  );
beforeEach(async () => {
  await resetDatabase(h.owner);
  h.clock.ms = Date.UTC(2026, 10, 7, 4, 30);
  clinics = await seedTwoClinics(h);
  id = clinics.a.patients[0]!.id;
  await h.owner.patient.update({ where: { id }, data: { phone: '+919876543210' } });
  await h.owner.patient.update({
    where: { id: clinics.a.patients[1]!.id },
    data: { phone: '+919876543211' },
  });
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  patient = await patientLogin(h, 'clinic-a', '9876543210');
  other = await patientLogin(h, 'clinic-a', '9876543211');
  await consent(patient);
  await consent(other);
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
async function form() {
  const r = await call('POST', '/assessment-forms', { id: randomUUID(), definition: def });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function assign(formId?: string, patientId = id) {
  const r = await call('POST', `/patients/${patientId}/assessments`, {
    id: randomUUID(),
    formId: formId ?? (await form()).id,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const submit = (key: string, answers = { q1: 7, q2: 3 }, token = patient) =>
  call('POST', `/portal/assessments/${key}/submit`, { answers }, token);
it('publishes immutable clinic-only forms with role checks and safe retry', async () => {
  const key = randomUUID(),
    body = { id: key, definition: def };
  expect((await call('POST', '/assessment-forms', body, patient)).statusCode).toBe(403);
  expect((await call('POST', '/assessment-forms', body, admin)).statusCode).toBe(201);
  expect((await call('POST', '/assessment-forms', body)).statusCode).toBe(201);
  expect(await h.owner.assessmentForm.count()).toBe(1);
  expect(
    (await call('POST', '/assessment-forms', { ...body, definition: { ...def, title: 'Changed' } }))
      .statusCode,
  ).toBe(409);
  expect(await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.assessmentForm.count())).toBe(
    0,
  );
  await expect(
    h.owner.assessmentForm.update({
      where: { id: key },
      data: { definition: { ...def, title: 'Changed' } },
    }),
  ).rejects.toThrow(/immutable/);
});
it('assigns only with doctor chart access and does not expose history to clinic admins', async () => {
  const f = await form(),
    key = randomUUID(),
    body = { id: key, formId: f.id };
  expect((await call('POST', `/patients/${id}/assessments`, body, admin)).statusCode).toBe(403);
  expect(
    (await call('POST', `/patients/${clinics.b.patients[0]!.id}/assessments`, body)).statusCode,
  ).toBe(404);
  expect((await call('POST', `/patients/${id}/assessments`, body)).statusCode).toBe(201);
  expect((await call('POST', `/patients/${id}/assessments`, body)).statusCode).toBe(201);
  expect(await h.owner.patientAssessment.count()).toBe(1);
  expect((await call('GET', `/patients/${id}/assessments`, undefined, admin)).statusCode).toBe(403);
  await h.owner.organisationSettings.create({
    data: { organisationId: clinics.a.org.id, chartModel: 'own_patients' },
  });
  expect((await call('GET', `/patients/${id}/assessments`)).statusCode).toBe(403);
});
it('requires current consent and family ownership for list and submission', async () => {
  const a = await assign();
  expect(
    (await call('GET', `/portal/patients/${id}/assessments`, undefined, other)).statusCode,
  ).toBe(404);
  expect((await submit(a.id, { q1: 7, q2: 3 }, other)).statusCode).toBe(404);
  await h.owner.accountConsent.updateMany({
    where: {
      userId: (await h.owner.user.findFirstOrThrow({ where: { phone: '+919876543210' } })).id,
    },
    data: { withdrawnAt: h.services.now() },
  });
  expect((await submit(a.id)).statusCode).toBe(403);
  expect(await h.owner.patientAssessment.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
    state: 'pending',
    resultCipher: null,
  });
});
it('validates complete answers, encrypts responses, scores on server and prevents replacement', async () => {
  const a = await assign();
  expect((await submit(a.id, { q1: 12, q2: 1 })).statusCode).toBe(400);
  expect(
    (await call('POST', `/portal/assessments/${a.id}/submit`, { answers: { q1: 1 } }, patient))
      .statusCode,
  ).toBe(400);
  const r = await submit(a.id);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().result).toEqual({
    answers: { q1: 7, q2: 3 },
    total: 10,
    minimum: 1,
    maximum: 15,
  });
  const stored = await h.owner.patientAssessment.findUniqueOrThrow({ where: { id: a.id } });
  expect(stored.resultCipher).not.toContain('answers');
  expect(JSON.parse(h.services.cipher.decrypt(stored.resultCipher!)).total).toBe(10);
  expect((await submit(a.id)).statusCode).toBe(200);
  expect((await submit(a.id, { q1: 6, q2: 3 })).statusCode).toBe(409);
  await expect(
    h.owner.patientAssessment.update({
      where: { id: a.id },
      data: { state: 'pending', resultCipher: null, submittedAt: null, submittedByUserId: null },
    }),
  ).rejects.toThrow(/immutable/);
  expect((await call('POST', `/assessments/${a.id}/cancel`)).statusCode).toBe(409);
});
it('allows pending answers on archived forms but blocks new assignments', async () => {
  const f = await form(),
    a = await assign(f.id);
  expect((await call('POST', `/assessment-forms/${f.id}/archive`, {}, admin)).statusCode).toBe(200);
  expect(
    (await call('POST', `/patients/${id}/assessments`, { id: randomUUID(), formId: f.id }))
      .statusCode,
  ).toBe(409);
  expect((await submit(a.id)).statusCode).toBe(200);
});
it('serializes concurrent responses and cancellation without overwriting history', async () => {
  const a = await assign();
  const results = await Promise.all([submit(a.id), submit(a.id)]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(
    await h.owner.auditLog.count({ where: { action: 'assessment.submitted', entityId: a.id } }),
  ).toBe(1);
  const b = await assign();
  const race = await Promise.all([submit(b.id), call('POST', `/assessments/${b.id}/cancel`)]);
  expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const saved = await h.owner.patientAssessment.findUniqueOrThrow({ where: { id: b.id } });
  expect(['submitted', 'cancelled']).toContain(saved.state);
});
it('includes family and merged history while preventing merged-record assignments', async () => {
  const child = await h.owner.patient.create({
    data: {
      organisationId: clinics.a.org.id,
      uhid: 'SYNTH-CHILD',
      name: 'Synthetic child',
      guardianPatientId: id,
    },
  });
  const a = await assign(undefined, child.id);
  expect((await submit(a.id)).statusCode).toBe(200);
  const old = await h.owner.patient.create({
    data: { organisationId: clinics.a.org.id, uhid: 'SYNTH-OLD', name: 'Synthetic merged' },
  });
  const b = await assign(undefined, old.id);
  await h.owner.patient.update({
    where: { id: old.id },
    data: { mergedIntoId: id, mergedAt: h.services.now() },
  });
  expect((await submit(b.id)).statusCode).toBe(200);
  const list = await call('GET', `/portal/patients/${id}/assessments`, undefined, patient);
  expect(list.json().data.map((r: { id: string }) => r.id)).toContain(b.id);
  expect(
    (await call('POST', `/patients/${old.id}/assessments`, { id: randomUUID(), formId: b.formId }))
      .statusCode,
  ).toBe(409);
});
it('enforces same-clinic foreign references in the database and bounded pagination', async () => {
  const f = await form();
  await expect(
    h.owner.patientAssessment.create({
      data: {
        id: randomUUID(),
        organisationId: clinics.a.org.id,
        patientId: clinics.b.patients[0]!.id,
        formId: f.id,
        assignedByUserId: clinics.a.doctor.userId,
        createdAt: h.services.now(),
      },
    }),
  ).rejects.toThrow(/references/);
  for (let i = 0; i < 51; i++)
    await h.owner.patientAssessment.create({
      data: {
        id: randomUUID(),
        organisationId: clinics.a.org.id,
        patientId: id,
        formId: f.id,
        assignedByUserId: clinics.a.doctor.userId,
        createdAt: h.services.now(),
      },
    });
  const first = await call('GET', `/patients/${id}/assessments`);
  expect(first.json().data).toHaveLength(50);
  expect(first.json().nextCursor).toBeTruthy();
  const next = await call('GET', `/patients/${id}/assessments?cursor=${first.json().nextCursor}`);
  expect(next.json().data).toHaveLength(1);
  expect(next.json().nextCursor).toBeNull();
  expect(
    await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.patientAssessment.count()),
  ).toBe(0);
});

it('includes only owned assessment questions and answers in the patient data export', async () => {
  const a = await assign();
  await submit(a.id);
  const b = await assign(a.formId, clinics.a.patients[1]!.id);
  await submit(b.id, { q1: 1, q2: 1 }, other);
  const r = await call('POST', '/data-rights/export', { id: randomUUID(), patientId: id }, patient);
  expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'assessment-export-'));
  try {
    const file = join(dir, 'data.zip');
    writeFileSync(file, r.rawPayload);
    const payload = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read("data.json").decode())',
          file,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(payload.assessments).toHaveLength(1);
    expect(payload.assessments[0]).toMatchObject({
      id: a.id,
      result: { total: 10 },
      definition: { title: def.title },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps clinical assessment tables unreadable to authentication and platform roles', async () => {
  await assign();
  for (const run of [withAuth, withPlatform]) {
    await expect(run(h.services.db, (tx) => tx.patientAssessment.count())).rejects.toThrow();
    await expect(run(h.services.db, (tx) => tx.assessmentForm.count())).rejects.toThrow();
  }
});
