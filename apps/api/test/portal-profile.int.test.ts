import { samplePng } from '../src/modules/branding/logo-samples';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, it, expect, vi } from 'vitest';
import { CURRENT_CONSENT_VERSIONS, PortalProfile, type TokenResponse } from '@dhc/contracts';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  patientLogin,
  staffLogin,
  bearer,
} from './harness';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  patient: TokenResponse,
  doctor: TokenResponse,
  admin: TokenResponse,
  id: string,
  child: string,
  adult: string;
const oldPhone = '9876543210',
  newPhone = '9876543211';
const call = (method: string, path: string, body?: unknown, token = patient) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    headers: bearer(token),
    payload: body as object,
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
const view = () => call('GET', `/portal/patients/${id}/profile`);
const profileBody = (p: PortalProfile) => ({
  updatedAt: p.updatedAt,
  name: p.name,
  dob: p.dob!,
  gender: p.gender!,
  language: p.language,
  email: p.email,
  address: p.address,
  emergencyContactName: p.emergencyContactName,
  emergencyContactPhone: p.emergencyContactPhone,
  reportedBloodGroup: p.reportedBloodGroup,
});
async function start(phone = newPhone, key = randomUUID()) {
  const r = await call('POST', `/portal/patients/${id}/phone-change`, { id: key, newPhone: phone });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { id: string; ready: boolean };
}
const codes = () => ({
  oldCode: h.sentCodes.findLast((c) => c.phone === '+91' + oldPhone)!.code,
  newCode: h.sentCodes.findLast((c) => c.phone === '+91' + newPhone)!.code,
});
const verify = (change: string, body = codes(), token = patient) =>
  call('POST', `/portal/phone-changes/${change}/verify`, body, token);
beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  h.sentCodes.length = 0;
  id = clinics.a.patients[0]!.id;
  await h.owner.patient.update({
    where: { id },
    data: { phone: '+91' + oldPhone, dob: new Date('1992-03-14'), gender: 'female' },
  });
  child = (
    await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'CHILD',
        name: 'Child',
        guardianPatientId: id,
        dob: new Date('2020-06-01'),
        gender: 'male',
      },
    })
  ).id;
  adult = (
    await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'ADULT',
        name: 'Other Adult',
        phone: '+91' + oldPhone,
        dob: new Date('1990-06-01'),
        gender: 'male',
      },
    })
  ).id;
  patient = await patientLogin(h, 'clinic-a', oldPhone);
  await consent(patient);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

it('updates owned demographic and emergency details with optimistic locking; cannot override phone, UHID or confirmed blood group', async () => {
  const p = PortalProfile.parse((await view()).json());
  const body = {
    ...profileBody(p),
    address: 'Test road',
    email: 'patient@example.test',
    emergencyContactName: 'Family contact',
    emergencyContactPhone: '98765 43212',
    reportedBloodGroup: 'O+',
  };
  const r = await call('PUT', `/portal/patients/${id}/profile`, body);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({
    address: 'Test road',
    emergencyContactPhone: '+919876543212',
    bloodGroup: null,
    reportedBloodGroup: 'O+',
    bloodGroupPending: true,
  });
  expect((await call('PUT', `/portal/patients/${id}/profile`, body)).statusCode).toBe(409);
  for (const extra of [
    { phone: '+919876543219' },
    { bloodGroup: 'A+' },
    { uhid: 'OVERRIDE' },
    { guardianPatientId: adult },
  ])
    expect(
      (await call('PUT', `/portal/patients/${id}/profile`, { ...profileBody(r.json()), ...extra }))
        .statusCode,
    ).toBe(400);
  const row = await h.owner.patient.findUniqueOrThrow({ where: { id } });
  expect(row.phone).toBe('+91' + oldPhone);
  expect(row.bloodGroup).toBeNull();
});
it('protects family, tenant, merged and consent boundaries', async () => {
  for (const other of [clinics.a.patients[1]!.id, clinics.b.patients[0]!.id])
    expect((await call('GET', `/portal/patients/${other}/profile`)).statusCode).toBe(404);
  expect((await call('GET', `/portal/patients/${child}/profile`)).statusCode).toBe(200);
  await h.owner.patient.update({
    where: { id: child },
    data: { mergedIntoId: id, mergedAt: h.services.now() },
  });
  expect((await call('GET', `/portal/patients/${child}/profile`)).statusCode).toBe(404);
  await call('POST', '/portal/consents/health_data/withdraw');
  expect((await view()).statusCode).toBe(403);
});
it('keeps reported facts unverified until a permitted doctor confirms them, retaining the original history', async () => {
  const r = await call('POST', `/portal/patients/${id}/medical-basics`, {
    kind: 'allergies',
    substance: 'Penicillin',
    reaction: 'Rash',
  });
  expect(r.statusCode, r.body).toBe(201);
  const entry = r.json().allergies[0];
  expect(entry.source).toBe('patient');
  const endpoint = `/patients/${id}/chart/allergies/${entry.id}/confirm`;
  expect((await call('POST', endpoint, {}, patient)).statusCode).toBe(403);
  expect((await call('POST', endpoint, {}, admin)).statusCode).toBe(403);
  expect((await call('POST', endpoint, {}, doctor)).statusCode).toBe(200);
  const old = await h.owner.allergy.findUniqueOrThrow({ where: { id: entry.id } });
  expect(old.source).toBe('patient');
  expect(old.removedAt).not.toBeNull();
  expect((await view()).json().allergies).toEqual([
    expect.objectContaining({ substance: 'Penicillin', source: 'doctor' }),
  ]);
  expect((await call('POST', endpoint, {}, doctor)).statusCode).toBe(404);
});
it('binds doctor blood confirmation to the report version', async () => {
  let p = PortalProfile.parse((await view()).json());
  p = (
    await call('PUT', `/portal/patients/${id}/profile`, {
      ...profileBody(p),
      reportedBloodGroup: 'A+',
    })
  ).json();
  const report = (
    await call('GET', `/patients/${id}/reported-blood-group`, undefined, doctor)
  ).json();
  const changed = await call('PUT', `/portal/patients/${id}/profile`, {
    ...profileBody(p),
    reportedBloodGroup: 'B+',
  });
  expect(changed.statusCode).toBe(200);
  expect(
    (
      await call(
        'POST',
        `/patients/${id}/reported-blood-group/confirm`,
        { updatedAt: report.updatedAt },
        doctor,
      )
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await call(
        'POST',
        `/patients/${id}/reported-blood-group/confirm`,
        { updatedAt: changed.json().updatedAt },
        doctor,
      )
    ).statusCode,
  ).toBe(200);
  expect((await view()).json()).toMatchObject({ bloodGroup: 'B+', bloodGroupPending: false });
});
it('cannot turn a guardian into a child or save invalid paired emergency contact details', async () => {
  const p = PortalProfile.parse((await view()).json());
  expect(
    (await call('PUT', `/portal/patients/${id}/profile`, { ...profileBody(p), dob: '2020-01-01' }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await call('PUT', `/portal/patients/${id}/profile`, {
        ...profileBody(p),
        emergencyContactName: 'Contact',
        emergencyContactPhone: null,
      })
    ).statusCode,
  ).toBe(400);
});
it('changes only the selected adult and dependants, preserves UHIDs/history and other clinics, then revokes clinic patient sessions', async () => {
  const otherClinicRecord = await h.owner.patient.create({
    data: {
      organisationId: clinics.b.org.id,
      uhid: 'OTHER-CLINIC',
      name: 'Same Person',
      phone: '+91' + oldPhone,
    },
  });
  const otherClinic = await patientLogin(h, 'clinic-b', oldPhone);
  await consent(otherClinic);
  const originalUhid = (await view()).json().uhid;
  const r = await start();
  expect(r.ready).toBe(true);
  const changed = await verify(r.id);
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().completed).toBe(true);
  expect((await view()).statusCode).toBe(401);
  expect((await call('GET', '/me', undefined, otherClinic)).statusCode).toBe(200);
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id: adult } })).phone).toBe(
    '+91' + oldPhone,
  );
  expect(
    (await h.owner.patient.findUniqueOrThrow({ where: { id: otherClinicRecord.id } })).phone,
  ).toBe('+91' + oldPhone);
  const next = await patientLogin(h, 'clinic-a', newPhone);
  await consent(next);
  const family = (await call('GET', '/portal/patients', undefined, next)).json().data;
  expect(family.map((p: { id: string }) => p.id).sort()).toEqual([id, child].sort());
  expect(family.find((p: { id: string }) => p.id === id).uhid).toBe(originalUhid);
  h.clock.advance(601);
  const oldAgain = await patientLogin(h, 'clinic-a', oldPhone);
  expect(
    (await call('GET', '/portal/patients', undefined, oldAgain))
      .json()
      .data.map((p: { id: string }) => p.id),
  ).toEqual([adult]);
});
it('does not accept phone-change codes for sign-in, other accounts or without both proofs; wrong attempts persist', async () => {
  const r = await start();
  const stored = await h.owner.patientPhoneChange.findUniqueOrThrow({ where: { id: r.id } });
  expect(
    (
      await call('POST', '/auth/otp/verify', {
        challengeId: stored.newChallengeId,
        code: codes().newCode,
      })
    ).statusCode,
  ).toBe(401);
  const stranger = await patientLogin(h, 'clinic-a', '9876543219');
  await consent(stranger);
  expect((await verify(r.id, codes(), stranger)).statusCode).toBe(404);
  const bad = { ...codes(), newCode: codes().newCode === '000000' ? '111111' : '000000' };
  for (let i = 0; i < 5; i++) expect((await verify(r.id, bad)).statusCode).toBe(400);
  expect((await verify(r.id)).statusCode).toBe(400);
  expect(
    (await h.owner.otpChallenge.findUniqueOrThrow({ where: { id: stored.newChallengeId! } }))
      .attempts,
  ).toBe(5);
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).phone).toBe('+91' + oldPhone);
});
it('expires proofs and refuses a new number that already has a clinic record', async () => {
  const r = await start();
  h.clock.advance(301);
  expect((await verify(r.id)).statusCode).toBe(400);
  h.clock.advance(600);
  await h.owner.patient.update({
    where: { id: clinics.a.patients[1]!.id },
    data: { phone: '+91' + newPhone },
  });
  const next = await start();
  expect((await verify(next.id)).statusCode).toBe(409);
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).phone).toBe('+91' + oldPhone);
});
it('retries an original code request without sending a second pair and rejects ID/body reuse', async () => {
  const key = randomUUID();
  const first = await start(newPhone, key),
    count = h.sentCodes.length;
  expect((await start(newPhone, key)).id).toBe(first.id);
  expect(h.sentCodes).toHaveLength(count);
  expect(
    (await call('POST', `/portal/patients/${id}/phone-change`, { id: key, newPhone: '9876543215' }))
      .statusCode,
  ).toBe(404);
});

it('keeps photos private, validates bytes and removes replaced photos', async () => {
  const endpoint = `/portal/patients/${id}/photo`;
  const upload = (data: Buffer, type = 'image/png') =>
    h.app.inject({
      method: 'POST',
      url: '/v1' + endpoint,
      headers: { ...bearer(patient), 'content-type': type },
      payload: data,
    });
  expect((await upload(Buffer.from('<svg/>'), 'image/png')).statusCode).toBe(400);
  const image = samplePng();
  const r = await upload(image);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().hasPhoto).toBe(true);
  const file = await call('GET', endpoint);
  expect(file.statusCode).toBe(200);
  expect(file.rawPayload.equals(image)).toBe(true);
  expect(file.headers['cache-control']).toBe('no-store');
  const old = await h.owner.patient.findUniqueOrThrow({ where: { id } });
  await call('DELETE', endpoint);
  expect((await call('GET', endpoint)).statusCode).toBe(404);
  await expect(h.services.files.get(old.photoKey!)).rejects.toThrow();
  const foreign = await call('GET', `/portal/patients/${clinics.b.patients[0]!.id}/photo`);
  expect(foreign.statusCode).toBe(404);
});

it('honours own-patient chart restrictions for confirmation and clinical profile reports', async () => {
  const r = await call('POST', `/portal/patients/${id}/medical-basics`, {
    kind: 'conditions',
    name: 'Diabetes',
  });
  const entry = r.json().conditions[0];
  await h.owner.organisationSettings.upsert({
    where: { organisationId: clinics.a.org.id },
    create: { organisationId: clinics.a.org.id, chartModel: 'own_patients' },
    update: { chartModel: 'own_patients' },
  });
  expect(
    (await call('POST', `/patients/${id}/chart/conditions/${entry.id}/confirm`, {}, doctor))
      .statusCode,
  ).toBe(403);
  expect(
    (await call('GET', `/patients/${id}/reported-blood-group`, undefined, doctor)).statusCode,
  ).toBe(403);
  expect(
    (await h.owner.medicalCondition.findUniqueOrThrow({ where: { id: entry.id } })).source,
  ).toBe('patient');
});
it('claims a code request once even when the response is retried while sending', async () => {
  let ready!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => {
      ready = r;
    }),
    release = new Promise<void>((r) => {
      finish = r;
    });
  const original = h.services.otpSender.send.bind(h.services.otpSender);
  let calls = 0;
  const spy = vi.spyOn(h.services.otpSender, 'send').mockImplementation(async (...args) => {
    calls++;
    if (calls === 1) {
      ready();
      await release;
    }
    return original(...args);
  });
  const key = randomUUID();
  const sending = call('POST', `/portal/patients/${id}/phone-change`, { id: key, newPhone });
  // Fastify's inject starts on awaiting/then, so attach the observer before waiting.
  const pending = Promise.resolve(sending);
  try {
    await started;
    const retry = await call('POST', `/portal/patients/${id}/phone-change`, { id: key, newPhone });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().ready).toBe(false);
    expect(calls).toBe(1);
  } finally {
    finish();
  }
  const done = await pending;
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json().ready).toBe(true);
  expect(calls).toBe(2);
  await start(newPhone, key);
  expect(calls).toBe(2);
  spy.mockRestore();
});
it('concurrent successful verification commits only one transfer and one audit event', async () => {
  const r = await start(),
    body = codes();
  const results = await Promise.all([verify(r.id, body), verify(r.id, body)]);
  expect(results.some((r) => r.statusCode === 200)).toBe(true);
  expect(results.every((r) => [200, 401].includes(r.statusCode))).toBe(true);
  expect(
    await h.owner.auditLog.count({ where: { action: 'patient.phone_changed', entityId: id } }),
  ).toBe(1);
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).phone).toBe('+91' + newPhone);
});
it('does not transfer a profile after patient access is revoked', async () => {
  const r = await start();
  await h.owner.membership.updateMany({
    where: { organisationId: clinics.a.org.id, role: 'patient' },
    data: { status: 'revoked' },
  });
  expect((await verify(r.id)).statusCode).toBe(401);
  expect((await h.owner.patient.findUniqueOrThrow({ where: { id } })).phone).toBe('+91' + oldPhone);
});
