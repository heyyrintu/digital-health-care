import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, it, expect } from 'vitest';
import {
  CURRENT_CONSENT_VERSIONS,
  ONLINE_CONSENT_VERSION,
  type TokenResponse,
} from '@dhc/contracts';
import { withTenant, withPlatform } from '@dhc/db';
import {
  assertOnlineReady,
  assertOnlineAmendmentEvidence,
} from '../src/modules/online-visits/service';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  patientLogin,
  bearer,
  addStaff,
} from './harness';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  admin: TokenResponse,
  doctor: TokenResponse,
  patient: TokenResponse,
  other: TokenResponse,
  desk: TokenResponse,
  id: string,
  pid: string,
  typeId: string,
  clinicId: string,
  n = 0;
const call = (method: string, path: string, body?: object, token = admin) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    payload: body,
    headers: bearer(token),
    remoteAddress: `127.0.0.${n}`,
  });
const path = () => '/portal/appointments/' + id + '/online';
const staffPath = () => '/appointments/' + id + '/online';
const get = async () => {
  const r = await call('GET', path(), undefined, patient);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
async function intake(patch: object = {}) {
  const view = await get();
  return call(
    'PUT',
    path(),
    {
      version: view.version,
      consentVersion: ONLINE_CONSENT_VERSION,
      agreed: true,
      identity: {
        name: 'Synthetic Patient',
        dob: '1990-01-01',
        address: 'Synthetic address, India',
        guardianName: null,
        guardianRelationship: null,
        authorityConfirmed: true,
      },
      ...patch,
    },
    patient,
  );
}
async function configure(url = 'https://meet.google.com/abc-defg-hij') {
  const view = await get();
  return call('PUT', staffPath() + '/call', {
    version: view.version,
    meetingUrl: url,
    callPhone: null,
  });
}
async function verify() {
  const view = await get();
  return call(
    'POST',
    staffPath() + '/verify',
    {
      version: view.version,
      identityConfirmed: true,
      ageConfirmed: true,
      guardianConfirmed: true,
      suitable: true,
      method: 'video',
    },
    doctor,
  );
}
async function ready() {
  expect((await configure()).statusCode).toBe(200);
  expect((await intake()).statusCode).toBe(200);
  expect((await verify()).statusCode).toBe(200);
}
async function fixtureMode(mode: 'in_person' | 'audio') {
  const type = await h.owner.consultationType.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Synthetic ' + mode,
      mode,
      defaultDurationMin: 15,
      feePaise: 0,
    },
  });
  const previous = await h.owner.appointment.findUniqueOrThrow({ where: { id } });
  id = (
    await h.owner.appointment.create({
      data: { ...previous, id: randomUUID(), consultationTypeId: type.id, tokenNumber: 2 },
    })
  ).id;
  typeId = type.id;
}
beforeEach(async () => {
  n++;
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { displayName: 'Synthetic Doctor' },
  });
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  other = await staffLogin(h, 'clinic-b', clinics.b.admin);
  desk = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test'),
  );
  pid = clinics.a.patients[0]!.id;
  await h.owner.patient.update({
    where: { id: pid },
    data: { phone: '+919876543210', dob: new Date('1990-01-01') },
  });
  patient = await patientLogin(h, 'clinic-a', '9876543210');
  await call(
    'POST',
    '/portal/consents',
    {
      accept: Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
        kind,
        version,
      })),
    },
    patient,
  );
  await h.owner.doctorProfile.create({
    data: {
      organisationId: clinics.a.org.id,
      userId: clinics.a.doctor.userId,
      registrationNumber: 'SYNTHETIC-001',
      council: 'Synthetic council',
      qualifications: 'Synthetic qualification',
      verification: 'verified',
      verifiedAt: h.services.now(),
    },
  });
  clinicId = (
    await h.owner.clinic.create({
      data: { organisationId: clinics.a.org.id, name: 'Synthetic clinic' },
    })
  ).id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: clinics.a.org.id,
        name: 'Video visit',
        mode: 'video',
        defaultDurationMin: 15,
        feePaise: 0,
      },
    })
  ).id;
  id = (
    await h.owner.appointment.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: pid,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        date: new Date('2026-10-06'),
        startAt: h.services.now(),
        endAt: new Date(h.clock.ms + 15 * 60000),
        status: 'checked_in',
        source: 'front_desk',
        tokenNumber: 1,
        createdByUserId: clinics.a.admin.userId,
      },
    })
  ).id;
  expect((await call('PUT', '/online-settings', { version: 0, enabled: true })).statusCode).toBe(
    200,
  );
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('limits settings to admin and checks revisions', async () => {
  expect(
    (await call('PUT', '/online-settings', { version: 1, enabled: false }, doctor)).statusCode,
  ).toBe(403);
  expect((await call('PUT', '/online-settings', { version: 0, enabled: false })).statusCode).toBe(
    409,
  );
  expect(await h.owner.auditLog.count({ where: { action: 'online.settings_updated' } })).toBe(1);
});
it('collects encrypted consent, withholds the URL on reads and grants an explicit join only', async () => {
  await configure();
  expect((await get()).joinAvailable).toBe(false);
  expect((await call('POST', path() + '/join', undefined, patient)).statusCode).toBe(409);
  const r = await intake();
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().meetingUrl).toBeNull();
  expect(r.json().joinAvailable).toBe(true);
  expect((await call('POST', path() + '/join', undefined, patient)).json()).toEqual({
    url: 'https://meet.google.com/abc-defg-hij',
  });
  const stored = await h.owner.onlineVisit.findUniqueOrThrow({ where: { appointmentId: id } });
  expect(stored.stateCipher).not.toContain('Synthetic address');
  expect(stored.stateCipher).not.toContain('meet.google.com');
  expect(await h.owner.onlineVisitEvent.count()).toBe(2);
  expect(await h.owner.auditLog.count({ where: { action: 'online.join_authorized' } })).toBe(1);
});
it('rejects other clinics, strangers and nonassigned doctors and protects identity from operational roles', async () => {
  await ready();
  expect((await call('GET', staffPath(), undefined, other)).statusCode).toBe(404);
  const stranger = await patientLogin(h, 'clinic-a', '9000000000');
  expect((await call('GET', path(), undefined, stranger)).statusCode).toBe(404);
  const second = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'doctor', 'other-doc@clinic-a.test'),
  );
  expect((await call('GET', staffPath(), undefined, second)).statusCode).toBe(404);
  expect((await call('GET', staffPath(), undefined, desk)).json().identity).toBeNull();
  expect((await call('GET', staffPath(), undefined, doctor)).json().identity.name).toBe(
    'Synthetic Patient',
  );
  await expect(withPlatform(h.services.db, (tx) => tx.onlineVisit.findMany())).rejects.toThrow();
});
it('gates start and signing readiness on assigned doctor verification, while preserving in-person flow', async () => {
  await configure();
  await intake();
  expect(
    (await call('POST', '/appointments/' + id + '/actions', { action: 'start' }, doctor))
      .statusCode,
  ).toBe(409);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).rejects.toThrow();
  await verify();
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).resolves.toBeUndefined();
  expect(
    (await call('POST', '/appointments/' + id + '/actions', { action: 'start' }, doctor))
      .statusCode,
  ).toBe(200);
  await fixtureMode('in_person');
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).resolves.toBeUndefined();
});
it('withdrawal closes joining and readiness even after health-data withdrawal', async () => {
  await ready();
  await call('POST', '/portal/consents/health_data/withdraw', undefined, patient);
  const v = await get();
  expect(v.joinAvailable).toBe(false);
  expect(
    (await call('POST', path() + '/withdraw', { version: v.version }, patient)).statusCode,
  ).toBe(200);
  expect((await call('POST', path() + '/join', undefined, patient)).statusCode).not.toBe(200);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).rejects.toThrow();
  expect(await h.owner.onlineVisitEvent.count({ where: { action: 'withdraw' } })).toBe(1);
});
it('rejects changed revision, identity age mismatch and invalid meeting destinations', async () => {
  await configure();
  const current = await get();
  await intake();
  expect(
    (
      await call('PUT', staffPath() + '/call', {
        version: current.version,
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        callPhone: null,
      })
    ).statusCode,
  ).toBe(409);
  expect((await configure('https://evil.test/meeting')).statusCode).toBe(400);
  const r = await intake({
    identity: {
      name: 'Synthetic',
      dob: '1991-01-01',
      address: 'Synthetic address',
      guardianName: null,
      guardianRelationship: null,
      authorityConfirmed: true,
    },
  });
  expect(r.statusCode).toBe(409);
});
it('requires guardian details for a minor and doctor confirmation of authority', async () => {
  await h.owner.patient.update({ where: { id: pid }, data: { dob: new Date('2016-01-01') } });
  const identity = {
    name: 'Synthetic child',
    dob: '2016-01-01',
    address: 'Synthetic address',
    guardianName: null as string | null,
    guardianRelationship: null as string | null,
    authorityConfirmed: true,
  };
  expect((await intake({ identity })).statusCode).toBe(409);
  identity.guardianName = 'Synthetic adult';
  identity.guardianRelationship = 'parent';
  expect((await intake({ identity })).statusCode).toBe(200);
  const view = await get();
  expect(
    (
      await call(
        'POST',
        staffPath() + '/verify',
        {
          version: view.version,
          identityConfirmed: true,
          ageConfirmed: true,
          guardianConfirmed: false,
          suitable: true,
          method: 'video',
        },
        doctor,
      )
    ).statusCode,
  ).toBe(409);
  expect((await verify()).statusCode).toBe(200);
});
it('invalidates consent, identity and join details after rescheduling, profile change or settings revision', async () => {
  await ready();
  await h.owner.appointment.update({
    where: { id },
    data: { startAt: new Date(h.clock.ms + 3600000), endAt: new Date(h.clock.ms + 4500000) },
  });
  let v = await get();
  expect(v.stale).toBe(true);
  expect(v.joinAvailable).toBe(false);
  expect(v.verified).toBe(false);
  await configure();
  await intake();
  await verify();
  await h.owner.patient.update({ where: { id: pid }, data: { address: 'Changed address' } });
  v = await get();
  expect(v.stale).toBe(true);
  await call('PUT', '/online-settings', { version: 1, enabled: false });
  v = await get();
  expect(v.joinAvailable).toBe(false);
});
it('never authorizes a disabled consent holder, closed profile or cancelled appointment', async () => {
  await ready();
  await h.owner.user.updateMany({
    where: { phone: '+919876543210' },
    data: { status: 'disabled' },
  });
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).rejects.toThrow();
  await h.owner.patient.update({ where: { id: pid }, data: { portalClosedAt: h.services.now() } });
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).rejects.toThrow();
  await h.owner.appointment.update({ where: { id }, data: { status: 'cancelled' } });
  expect((await call('GET', staffPath(), undefined, doctor)).json().joinAvailable).toBe(false);
});
it('enforces both edges of the join window and matching audio contact type', async () => {
  await ready();
  await h.owner.appointment.update({
    where: { id },
    data: { startAt: new Date(h.clock.ms + 3600000), endAt: new Date(h.clock.ms + 4500000) },
  });
  await configure();
  await intake();
  expect((await get()).joinAvailable).toBe(false);
  await h.owner.appointment.update({
    where: { id },
    data: { startAt: new Date(h.clock.ms - 7200000), endAt: new Date(h.clock.ms - 3700000) },
  });
  await configure();
  await intake();
  expect((await get()).joinAvailable).toBe(false);
  await fixtureMode('audio');
  await h.owner.appointment.update({
    where: { id },
    data: { startAt: h.services.now(), endAt: new Date(h.clock.ms + 15 * 60000) },
  });
  const view = await get();
  expect(
    (
      await call('PUT', staffPath() + '/call', {
        version: view.version,
        meetingUrl: null,
        callPhone: '+919876543211',
      })
    ).statusCode,
  ).toBe(200);
  expect((await intake()).statusCode).toBe(200);
  expect((await call('POST', path() + '/join', undefined, patient)).json()).toEqual({
    url: 'tel:+919876543211',
  });
});
it('preserves immutable consent history and exports owned evidence without meeting credentials', async () => {
  await ready();
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.onlineVisitEvent.updateMany({ data: { action: 'verify' } }),
    ),
  ).rejects.toThrow();
  const r = await call(
    'POST',
    '/data-rights/export',
    { id: randomUUID(), patientId: pid },
    patient,
  );
  expect(r.statusCode).toBe(200);
  const data = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import io,zipfile,sys; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(z.read("data.json").decode())',
      ],
      { input: r.rawPayload, encoding: 'utf8' },
    ),
  );
  expect(data.onlineConsultations).toHaveLength(3);
  expect(JSON.stringify(data.onlineConsultations)).not.toContain('meet.google.com');
});
it('only advertises enabled non-prepaid online types, and requires a verified doctor', async () => {
  let r = await call('GET', '/portal/booking-options', undefined, patient);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().consultationTypes.some((t: { id: string }) => t.id === typeId)).toBe(true);
  await h.owner.consultationType.update({
    where: { id: typeId },
    data: { requiresPrepayment: true },
  });
  r = await call('GET', '/portal/booking-options?prepaid=true', undefined, patient);
  expect(r.statusCode).toBe(200);
  expect(r.json().consultationTypes.some((t: { id: string }) => t.id === typeId)).toBe(false);
  await h.owner.consultationType.update({
    where: { id: typeId },
    data: { requiresPrepayment: false },
  });
  await h.owner.doctorProfile.updateMany({
    where: { userId: clinics.a.doctor.userId },
    data: { verification: 'pending', verifiedAt: null },
  });
  const slots = await call(
    'GET',
    `/portal/slots?doctorId=${clinics.a.doctor.userId}&clinicId=${clinicId}&consultationTypeId=${typeId}&date=2026-10-06`,
    undefined,
    patient,
  );
  expect(slots.statusCode, slots.body).toBe(409);
  await call('PUT', '/online-settings', { version: 1, enabled: false });
  r = await call('GET', '/portal/booking-options', undefined, patient);
  expect(r.statusCode).toBe(200);
  expect(r.json().consultationTypes.some((t: { id: string }) => t.id === typeId)).toBe(false);
});

it('freezes the mode of used types and refuses changing an existing visit to another mode', async () => {
  expect(
    (await call('PATCH', '/consultation-types/' + typeId, { mode: 'in_person' })).statusCode,
  ).toBe(409);
  await expect(
    h.owner.consultationType.update({ where: { id: typeId }, data: { mode: 'in_person' } }),
  ).rejects.toThrow();
  const type = await h.owner.consultationType.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'In person alternative',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 0,
    },
  });
  await expect(
    h.owner.appointment.update({ where: { id }, data: { consultationTypeId: type.id } }),
  ).rejects.toThrow();
});
it('requires a recorded matching birth date before doctor verification', async () => {
  await h.owner.patient.update({ where: { id: pid }, data: { dob: null } });
  expect((await intake()).statusCode).toBe(200);
  expect((await verify()).statusCode).toBe(409);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).rejects.toThrow();
});
it('supports an owned child through the verified guardian account', async () => {
  const child = await h.owner.patient.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Synthetic Child',
      uhid: 'CHILD',
      dob: new Date('2016-01-01'),
      guardianPatientId: pid,
      createdByUserId: clinics.a.admin.userId,
    },
  });
  await h.owner.appointment.update({ where: { id }, data: { patientId: child.id } });
  const r = await intake({
    identity: {
      name: 'Synthetic Child',
      dob: '2016-01-01',
      address: 'Synthetic address, India',
      guardianName: 'Synthetic Parent',
      guardianRelationship: 'parent',
      authorityConfirmed: true,
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect((await verify()).statusCode).toBe(200);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => assertOnlineReady(h.services, tx, id)),
  ).resolves.toBeUndefined();
});

async function historicalParent(signedAt: Date) {
  return h.owner.prescription.create({
    data: {
      organisationId: clinics.a.org.id,
      appointmentId: id,
      patientId: pid,
      doctorUserId: clinics.a.doctor.userId,
      status: 'signed',
      number: 'SYNTHETIC-' + randomUUID(),
      signedAt,
      pdfFileKey: 'synthetic.pdf',
      pdfSha256: 'a'.repeat(64),
      templateVersion: 'test',
      paperSize: 'a4',
      signatureMethod: 'test_key',
      signature: 'synthetic',
      verificationCode: randomUUID(),
    },
  });
}
it('rejects online amendments without original verification evidence', async () => {
  const parent = await historicalParent(h.services.now());
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      assertOnlineAmendmentEvidence(h.services, tx, id, parent.id),
    ),
  ).rejects.toThrow();
});
it('rejects verification added only after the original prescription was signed', async () => {
  const parent = await historicalParent(new Date(h.clock.ms - 60000));
  await ready();
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      assertOnlineAmendmentEvidence(h.services, tx, id, parent.id),
    ),
  ).rejects.toThrow();
});
