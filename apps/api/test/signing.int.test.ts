/**
 * Signing, immutability and delivery through the API (PRD §6.6, §9.1, §9.4): the doctor's
 * prescription pad and PIN, platform verification, signing with the safety re-check,
 * the stored PDF and its hash, amendments, voiding and the public QR check.
 * Drug facts come from the synthetic sample, which is illustrative, not clinical data.
 */
import {
  AppointmentDetail,
  DoctorProfile,
  Prescription,
  PrescriptionCheck,
  PrescriptionView,
  type TokenResponse,
} from '@dhc/contracts';
import { seedSampleMedicines } from '@dhc/db';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { supportVerifyDoctor } from '../src/modules/support/verify-doctor';
import type { TestKeySigner } from '../src/signing/signer';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  STAFF_PASSWORD,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let doctorA: TokenResponse;
let clinicId: string;
let inPerson: string;
const PIN = '482916';
const source = { id: 'test-run', ip: 'test', headers: { 'user-agent': 'test' } };

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  await seedSampleMedicines(h.owner);
  clinics = await seedTwoClinics(h);
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { displayName: 'Dr. Synthetic Doctor' },
  });
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const org = clinics.a.org.id;
  clinicId = (
    await h.owner.clinic.create({
      data: { organisationId: org, name: 'Main clinic', address: '1 Test Road' },
    })
  ).id;
  inPerson = (
    await h.owner.consultationType.create({
      data: {
        organisationId: org,
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
      },
    })
  ).id;
  await h.owner.patient.updateMany({
    where: { organisationId: org },
    data: { dob: new Date('1985-01-01T00:00:00.000Z'), gender: 'female' },
  });
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

let token = 0;
async function visit() {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: clinics.a.patients[0]!.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: inPerson,
      date: new Date('2026-10-06T00:00:00.000Z'),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: 'in_consultation',
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
  return row.id;
}

async function line(name: string, over: Record<string, unknown> = {}) {
  const m = await h.owner.medicine.findFirstOrThrow({ where: { name, organisationId: null } });
  return {
    id: randomUUID(),
    medicineId: m.id,
    name: m.name,
    composition: m.composition,
    form: m.form,
    route: m.defaultRoute,
    timing: 'after_food',
    steps: [{ dose: '1 tablet', frequency: '1-0-1', durationValue: 5, durationUnit: 'days' }],
    quantity: null,
    instructions: null,
    remarks: '',
    remarksEdited: false,
    ...over,
  };
}

const saved = async (id: string, items: unknown[], revision = 0) => {
  const res = await call('PUT', `/appointments/${id}/prescription`, doctorA, {
    language: 'en',
    items,
    revision,
  });
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
};
const view = async (id: string, tokens = doctorA) => {
  const res = await call('GET', `/appointments/${id}/prescription`, tokens);
  expect(res.statusCode, res.body).toBe(200);
  return PrescriptionView.parse(res.json());
};
const sign = (id: string, revision: number, pin = PIN, tokens = doctorA) =>
  call('POST', `/appointments/${id}/prescription/sign`, tokens, { revision, pin });
const signed = async (id: string, revision: number) => {
  const res = await sign(id, revision);
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
};
/** The visit's prescription as the queue card shows it (no clinical content). */
const card = async (id: string, tokens = doctorA) =>
  AppointmentDetail.parse((await call('GET', `/appointments/${id}`, tokens)).json()).prescription;
const codeOf = (rx: Prescription) => rx.verificationUrl!.split('/verify/')[1]!;
const verify = async (code: string) => {
  const res = await call('POST', '/verify', null, { code });
  expect(res.statusCode, res.body).toBe(200);
  return PrescriptionCheck.parse(res.json());
};

const profileBody = {
  registrationNumber: 'TEST-12345',
  council: 'Test Medical Council',
  qualifications: 'MBBS, MS (Ortho)',
  specialty: 'Orthopaedics',
  rxPrefix: 'sd',
  paperSize: 'a5',
};

/** Profile, PIN and platform verification: everything signing needs. */
async function readyToSign(tokens = doctorA, staff = clinics.a.doctor) {
  expect((await call('PUT', '/doctor-profile', tokens, profileBody)).statusCode).toBe(200);
  const pin = await call('PUT', '/doctor-profile/signing-pin', tokens, {
    password: STAFF_PASSWORD,
    pin: PIN,
  });
  expect(pin.statusCode, pin.body).toBe(204);
  await supportVerifyDoctor(h.services, source, {
    identifier: staff.email,
    clinic: 'clinic-a',
    ticket: 'SUP-1',
    operator: 'ops@platform.test',
  });
}

describe('doctor profile and signing PIN', () => {
  it('saves the pad details, keeps prefixes unique, and needs the password for the PIN', async () => {
    const empty = DoctorProfile.parse((await call('GET', '/doctor-profile', doctorA)).json());
    expect(empty).toMatchObject({ verification: 'pending', pinSet: false, paperSize: 'a5' });

    const res = await call('PUT', '/doctor-profile', doctorA, profileBody);
    expect(res.statusCode, res.body).toBe(200);
    expect(DoctorProfile.parse(res.json())).toMatchObject({
      rxPrefix: 'SD',
      verification: 'pending',
    });

    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test');
    const otherTokens = await staffLogin(h, 'clinic-a', other);
    const taken = await call('PUT', '/doctor-profile', otherTokens, profileBody);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.fields).toEqual({ rxPrefix: 'taken' });

    const wrong = await call('PUT', '/doctor-profile/signing-pin', doctorA, {
      password: 'not-the-password',
      pin: PIN,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.fields).toEqual({ password: 'wrong' });
    expect(
      (
        await call('PUT', '/doctor-profile/signing-pin', doctorA, {
          password: STAFF_PASSWORD,
          pin: '12ab',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('PUT', '/doctor-profile/signing-pin', doctorA, {
          password: STAFF_PASSWORD,
          pin: PIN,
        })
      ).statusCode,
    ).toBe(204);
    const row = await h.owner.doctorProfile.findFirstOrThrow({
      where: { userId: clinics.a.doctor.userId },
    });
    expect(row.signingPinHash).toMatch(/^scrypt\$/);
    expect(row.signingPinHash).not.toContain(PIN);

    const admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    expect((await call('GET', '/doctor-profile', admin)).statusCode).toBe(403);
  });

  it('is verified by the platform team, and a new registration number needs verifying again', async () => {
    await call('PUT', '/doctor-profile', doctorA, profileBody);
    const plan = await supportVerifyDoctor(h.services, source, {
      identifier: clinics.a.doctor.email,
      clinic: 'clinic-a',
      ticket: 'SUP-1',
      operator: 'ops@platform.test',
      dryRun: true,
    });
    expect(plan).toMatchObject({ registrationNumber: 'TEST-12345', alreadyVerified: false });
    expect((await call('GET', '/doctor-profile', doctorA)).json().verification).toBe('pending');

    await supportVerifyDoctor(h.services, source, {
      identifier: clinics.a.doctor.email,
      clinic: 'clinic-a',
      ticket: 'SUP-1',
      operator: 'ops@platform.test',
    });
    expect((await call('GET', '/doctor-profile', doctorA)).json().verification).toBe('verified');
    const audit = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'support.doctor.verified' },
    });
    expect(audit.metadata).toMatchObject({ ticket: 'SUP-1', operator: 'ops@platform.test' });

    // Qualifications can change; the registration cannot without a new check.
    await call('PUT', '/doctor-profile', doctorA, { ...profileBody, qualifications: 'MBBS' });
    expect((await call('GET', '/doctor-profile', doctorA)).json().verification).toBe('verified');
    await call('PUT', '/doctor-profile', doctorA, {
      ...profileBody,
      registrationNumber: 'TEST-999',
    });
    expect((await call('GET', '/doctor-profile', doctorA)).json().verification).toBe('pending');

    // A doctor without registration details cannot be verified.
    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test');
    await expect(
      supportVerifyDoctor(h.services, source, {
        identifier: other.email,
        clinic: 'clinic-a',
        ticket: 'SUP-2',
        operator: 'ops@platform.test',
      }),
    ).rejects.toThrow('registration number');
  });
});

describe('signing', () => {
  it('signs: number, stored PDF with its hash and signature, QR, locked record', async () => {
    await readyToSign();
    const id = await visit();
    const draft = await saved(id, [await line('Paracetamol 500')]);
    expect((await view(id)).signingMissing).toEqual([]);

    const preview = await call('GET', `/appointments/${id}/prescription/preview`, doctorA);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('application/pdf');
    expect(preview.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const wrong = await sign(id, draft.revision, '000000');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.fields).toEqual({ pin: 'wrong' });

    const rx = await signed(id, draft.revision);
    expect(rx).toMatchObject({
      status: 'signed',
      version: 1,
      number: 'SD-00001',
      signatureMethod: 'test_key',
    });
    expect(rx.verificationUrl).toMatch(/^https:\/\/app\.test\/verify\/[0-9A-Z]{24}$/);

    const row = await h.owner.prescription.findUniqueOrThrow({ where: { id: rx.id } });
    const pdf = await call('GET', `/prescriptions/${rx.id}/pdf`, doctorA);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toBe('inline; filename="SD-00001-v1.pdf"');
    const digest = createHash('sha256').update(pdf.rawPayload).digest();
    expect(digest.toString('hex')).toBe(row.pdfSha256);
    expect((h.services.signer as TestKeySigner).verify(digest, row.signature!)).toBe(true);
    expect(row).toMatchObject({ templateVersion: 'rx-1', paperSize: 'a5' });

    // The visit record and the prescription are locked.
    const consultation = await h.owner.consultation.findUniqueOrThrow({
      where: { appointmentId: id },
    });
    expect(consultation.lockedAt).not.toBeNull();
    const edit = await call('PUT', `/appointments/${id}/prescription`, doctorA, {
      language: 'en',
      items: [],
      revision: rx.revision,
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.code).toBe('PRESCRIPTION_LOCKED');
    expect(await view(id)).toMatchObject({ canEdit: false, canAmend: true });

    // The audit records the hash and method, never medicine names.
    const audit = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'prescription.signed' },
    });
    expect(audit.metadata).toMatchObject({
      number: 'SD-00001',
      pdfSha256: row.pdfSha256,
      signatureMethod: 'test_key',
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('Paracetamol');

    // Numbers run on per doctor.
    const second = await visit();
    const draft2 = await saved(second, [await line('Paracetamol 650')]);
    expect((await signed(second, draft2.revision)).number).toBe('SD-00002');
    // Once printed, a prefix cannot pass to another doctor, whose numbers would repeat.
    await call('PUT', '/doctor-profile', doctorA, { ...profileBody, rxPrefix: 'SG' });
    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test');
    const reuse = await call(
      'PUT',
      '/doctor-profile',
      await staffLogin(h, 'clinic-a', other),
      profileBody,
    );
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.fields).toEqual({ rxPrefix: 'taken' });
    // Its own doctor may go back to it; the numbers carry on.
    expect((await call('PUT', '/doctor-profile', doctorA, profileBody)).statusCode).toBe(200);
  });

  it('is immutable in the database itself once signed', async () => {
    await readyToSign();
    const id = await visit();
    const rx = await signed(id, (await saved(id, [await line('Paracetamol 500')])).revision);
    await expect(
      h.owner.prescription.update({ where: { id: rx.id }, data: { language: 'hi' } }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      h.owner.prescriptionItem.updateMany({
        where: { prescriptionId: rx.id },
        data: { remarks: 'changed' },
      }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      h.owner.prescriptionItem.deleteMany({ where: { prescriptionId: rx.id } }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      h.owner.consultation.update({ where: { appointmentId: id }, data: { revision: 9 } }),
    ).rejects.toThrow(/locked/);
  });

  it('refuses until the doctor is verified, the pad is complete, a PIN is set and the service runs', async () => {
    const id = await visit();
    const draft = await saved(id, [await line('Paracetamol 500')]);
    expect((await view(id)).signingMissing).toEqual(['profile', 'verification', 'pin']);

    expect((await sign(id, draft.revision)).json().error.fields).toEqual({ pin: 'unset' });
    await call('PUT', '/doctor-profile/signing-pin', doctorA, {
      password: STAFF_PASSWORD,
      pin: PIN,
    });
    const unverified = await sign(id, draft.revision);
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json().error.code).toBe('DOCTOR_NOT_VERIFIED');

    await call('PUT', '/doctor-profile', doctorA, profileBody);
    await supportVerifyDoctor(h.services, source, {
      identifier: clinics.a.doctor.email,
      clinic: 'clinic-a',
      ticket: 'SUP-1',
      operator: 'ops@platform.test',
    });
    const signer = h.services.signer;
    h.services.signer = null;
    try {
      expect((await view(id)).signingMissing).toEqual(['service']);
      const off = await sign(id, draft.revision);
      expect(off.statusCode).toBe(503);
      expect(off.json().error.code).toBe('SIGNING_UNAVAILABLE');
    } finally {
      h.services.signer = signer;
    }
    expect((await sign(id, draft.revision + 1)).json().error.fields).toEqual({ revision: 'stale' });

    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test');
    expect(
      (await sign(id, draft.revision, PIN, await staffLogin(h, 'clinic-a', other))).statusCode,
    ).toBe(422);
    expect((await signed(id, draft.revision)).status).toBe('signed');
  });

  it('re-checks safety: open warnings stop signing until answered', async () => {
    await readyToSign();
    await h.owner.currentMedication.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: clinics.a.patients[0]!.id,
        name: 'Warfarin 5 mg',
        source: 'doctor',
        recordedByUserId: clinics.a.doctor.userId,
      },
    });
    const id = await visit();
    const draft = await saved(id, [await line('Ibuprofen 400')]);
    const blocked = await sign(id, draft.revision);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toMatchObject({
      code: 'SAFETY_BLOCK',
      fields: { openBlocks: '0', openWarnings: '1' },
    });
    const sr05 = draft.safety.alerts.find((a) => a.ruleId === 'SR-05')!;
    const ack = await call('POST', `/appointments/${id}/prescription/safety-actions`, doctorA, {
      key: sr05.key,
      action: 'acknowledge',
      reason: 'INR checked this week',
    });
    expect(ack.statusCode, ack.body).toBe(200);
    expect((await signed(id, draft.revision)).status).toBe('signed');
    // The safety log of a signed prescription is frozen with it.
    await expect(
      h.owner.safetyAlert.updateMany({
        where: { prescriptionId: draft.id },
        data: { reason: 'x' },
      }),
    ).rejects.toThrow(/cannot change/);
  });

  it('pauses signing for 15 minutes after five wrong PINs', async () => {
    await readyToSign();
    const id = await visit();
    const draft = await saved(id, [await line('Paracetamol 500')]);
    for (let i = 0; i < 4; i++) {
      expect((await sign(id, draft.revision, '111111')).json().error.fields).toEqual({
        pin: 'wrong',
      });
    }
    const fifth = await sign(id, draft.revision, '111111');
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error.fields).toEqual({ pin: 'locked' });
    expect((await sign(id, draft.revision)).statusCode).toBe(429);
    expect((await call('GET', '/doctor-profile', doctorA)).json().pinLockedUntil).not.toBeNull();
    expect(await h.owner.auditLog.count({ where: { action: 'doctor.signing_pin_locked' } })).toBe(
      1,
    );
    h.clock.advance(15 * 60 + 1);
    expect((await signed(id, draft.revision)).status).toBe('signed');
  });
});

describe('amendments, voiding and the QR check', () => {
  it('amends into version 2; the QR shows Genuine and Superseded correctly', async () => {
    await readyToSign();
    const id = await visit();
    const first = await saved(id, [await line('Paracetamol 500')]);
    expect(await card(id)).toBeNull();
    const v1 = await signed(id, first.revision);
    expect(await verify(codeOf(v1))).toMatchObject({ status: 'genuine', number: 'SD-00001' });
    expect(await card(id)).toEqual({ id: v1.id, number: 'SD-00001', version: 1, status: 'signed' });

    const amend = await call('POST', `/appointments/${id}/prescription/amend`, doctorA, {
      reason: 'Dose corrected',
    });
    expect(amend.statusCode, amend.body).toBe(201);
    const draft = Prescription.parse(amend.json());
    expect(draft).toMatchObject({ status: 'draft', version: 2, amendmentReason: 'Dose corrected' });
    expect(draft.items[0]!.id).not.toBe(v1.items[0]!.id);
    expect(draft.items[0]!.name).toBe(v1.items[0]!.name);
    // Until it is signed, version 1 stays genuine; the amendment is writable after the lock.
    expect((await verify(codeOf(v1))).status).toBe('genuine');
    expect((await card(id))?.id).toBe(v1.id);
    expect((await view(id)).canEdit).toBe(true);
    const edited = await saved(
      id,
      [
        {
          ...draft.items[0]!,
          steps: [{ dose: '1 tablet', frequency: '1-1-1', durationValue: 3, durationUnit: 'days' }],
        },
      ],
      draft.revision,
    );
    const v2 = await signed(id, edited.revision);
    expect(v2).toMatchObject({ status: 'signed', version: 2, number: 'SD-00001' });
    expect(await card(id)).toEqual({ id: v2.id, number: 'SD-00001', version: 2, status: 'signed' });

    expect(await verify(codeOf(v1))).toMatchObject({
      status: 'superseded',
      version: 1,
      latestVersion: 2,
    });
    const check = await verify(codeOf(v2).toLowerCase());
    expect(check).toMatchObject({
      status: 'genuine',
      version: 2,
      clinicName: 'Main clinic',
      doctor: { name: 'Dr. Synthetic Doctor', registrationNumber: 'TEST-12345' },
      patient: { initials: 'A. V.', ageYears: 41, gender: 'female' },
      medicines: [{ name: 'Paracetamol 500', generic: 'Paracetamol 500 mg' }],
    });
    // The page shows initials, never the patient's name.
    expect(JSON.stringify(check)).not.toContain('Asha');
    expect((await view(id)).versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'signed'],
      [1, 'superseded'],
    ]);
  });

  it('voids with a reason and the PIN; the copy is stamped and the QR shows Void', async () => {
    await readyToSign();
    const id = await visit();
    const rx = await signed(id, (await saved(id, [await line('Paracetamol 500')])).revision);
    const original = (await call('GET', `/prescriptions/${rx.id}/pdf`, doctorA)).rawPayload;

    expect(
      (
        await call('POST', `/appointments/${id}/prescription/void`, doctorA, {
          reason: 'Wrong patient',
          pin: '000000',
        })
      ).statusCode,
    ).toBe(400);
    const res = await call('POST', `/appointments/${id}/prescription/void`, doctorA, {
      reason: 'Wrong patient',
      pin: PIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(Prescription.parse(res.json())).toMatchObject({
      status: 'void',
      voidReason: 'Wrong patient',
    });

    const copy = await call('GET', `/prescriptions/${rx.id}/pdf`, doctorA);
    expect(copy.headers['content-disposition']).toBe('inline; filename="SD-00001-v1-void.pdf"');
    expect(copy.rawPayload.equals(original)).toBe(false);
    expect(copy.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // The signed file is kept unchanged and still matches its hash.
    const row = await h.owner.prescription.findUniqueOrThrow({ where: { id: rx.id } });
    expect(row.pdfSha256).toBe(createHash('sha256').update(original).digest('hex'));

    expect(await verify(codeOf(rx))).toMatchObject({ status: 'void' });
    expect(await card(id)).toEqual({ id: rx.id, number: 'SD-00001', version: 1, status: 'void' });
    expect(
      (await call('POST', `/appointments/${id}/prescription/amend`, doctorA, { reason: 'x' }))
        .statusCode,
    ).toBe(409);
  });

  it('will not void while an amendment is open, and answers 404 for unknown codes', async () => {
    await readyToSign();
    const id = await visit();
    await signed(id, (await saved(id, [await line('Paracetamol 500')])).revision);
    await call('POST', `/appointments/${id}/prescription/amend`, doctorA, {
      reason: 'Dose corrected',
    });
    const res = await call('POST', `/appointments/${id}/prescription/void`, doctorA, {
      reason: 'Wrong patient',
      pin: PIN,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Sign the amendment first');

    expect(
      (await call('POST', '/verify', null, { code: 'ABCDEFGHJKMNPQRSTVWXYZ01' })).statusCode,
    ).toBe(404);
  });

  it('lets the front desk find and print it, not the clinic admin; other clinics get 404', async () => {
    await readyToSign();
    const id = await visit();
    const rx = await signed(id, (await saved(id, [await line('Paracetamol 500')])).revision);
    const desk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
    const deskTokens = await staffLogin(h, 'clinic-a', desk);
    // The queue card gives the front desk what it needs to print, nothing clinical.
    expect(await card(id, deskTokens)).toEqual({
      id: rx.id,
      number: 'SD-00001',
      version: 1,
      status: 'signed',
    });
    expect((await call('GET', `/prescriptions/${rx.id}/pdf`, deskTokens)).statusCode).toBe(200);
    const admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    expect((await call('GET', `/prescriptions/${rx.id}/pdf`, admin)).statusCode).toBe(403);
    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    expect((await call('GET', `/prescriptions/${rx.id}/pdf`, doctorB)).statusCode).toBe(404);
    expect(
      await h.owner.auditLog.count({
        where: { action: 'prescription.pdf_viewed', entityId: rx.id },
      }),
    ).toBe(1);
  });
});
