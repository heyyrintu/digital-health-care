/**
 * The signed referral letter through the API (PRD §7.2), slice 2: the referring doctor
 * previews and signs it with the signing PIN while the referral is open; both doctors
 * download it; anyone holding it checks it by its QR. The PIN rules and the pad's
 * verification are the prescription's (ADR 0008). Immutability, tenancy and audit
 * contents. Personas are synthetic (docs/qa/test-plan.md).
 */
import {
  AuditListResponse,
  PrescriptionCheck,
  Referral,
  ReferralLetterCheck,
  type TokenResponse,
} from '@dhc/contracts';
import { seedSampleMedicines, withTenant } from '@dhc/db';
import { pdfText } from '@dhc/pdf-text';
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
  type StaffFixture,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let doctor: TokenResponse;
let second: StaffFixture;
let secondDoctor: TokenResponse;
let thirdDoctor: TokenResponse;
let desk: TokenResponse;
let admin: TokenResponse;
let doctorB: TokenResponse;
let clinicId: string;
let typeId: string;
const PIN = '482916';
const source = { id: 'test-run', ip: 'test', headers: { 'user-agent': 'test' } };

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const org = clinics.a.org.id;
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { displayName: 'Dr. Synthetic Doctor' },
  });
  second = await addStaff(h, org, 'doctor', 'second@clinic-a.test');
  await h.owner.user.update({
    where: { id: second.userId },
    data: { displayName: 'Dr. Second Synthetic' },
  });
  const third = await addStaff(h, org, 'doctor', 'third@clinic-a.test');
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  secondDoctor = await staffLogin(h, 'clinic-a', second);
  thirdDoctor = await staffLogin(h, 'clinic-a', third);
  desk = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, org, 'front_desk', 'desk@clinic-a.test'),
  );
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
  clinicId = (
    await h.owner.clinic.create({
      data: { organisationId: org, name: 'Main clinic', address: '1 Test Road' },
    })
  ).id;
  typeId = (
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

const patientId = () => clinics.a.patients[0]!.id;

let token = 0;
async function visit() {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: patientId(),
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
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

const internal = () => ({
  kind: 'internal',
  receivingDoctorUserId: second.userId,
  reason: 'Persistent knee effusion; please assess for arthroscopy.',
  urgency: 'soon',
  notes: 'Aspirated once last month.',
});
const external = () => ({
  kind: 'external',
  external: {
    name: 'Dr Meera Iyer',
    specialty: 'Cardiology',
    hospital: 'City Heart Hospital',
    phone: '+91 90000 00001',
  },
  reason: 'Cardiology opinion before knee surgery.',
  urgency: 'urgent',
});

async function refer(visitId: string, body: unknown = internal()) {
  const res = await call('POST', `/appointments/${visitId}/referrals`, doctor, body);
  expect(res.statusCode, res.body).toBe(201);
  return Referral.parse(res.json());
}

const profileBody = {
  registrationNumber: 'TEST-12345',
  council: 'Test Medical Council',
  qualifications: 'MBBS, MS (Ortho)',
  specialty: 'Orthopaedics',
  rxPrefix: 'sd',
  paperSize: 'a5',
};

/** The pad and the PIN; verified by the platform team unless `verified` is false. */
async function readyToSign({ verified = true } = {}) {
  expect((await call('PUT', '/doctor-profile', doctor, profileBody)).statusCode).toBe(200);
  const pin = await call('PUT', '/doctor-profile/signing-pin', doctor, {
    password: STAFF_PASSWORD,
    pin: PIN,
  });
  expect(pin.statusCode, pin.body).toBe(204);
  if (!verified) return;
  await supportVerifyDoctor(h.services, source, {
    identifier: clinics.a.doctor.email,
    clinic: 'clinic-a',
    ticket: 'SUP-1',
    operator: 'ops@platform.test',
  });
}

const sign = (id: string, body: Record<string, unknown> = { pin: PIN }, tokens = doctor) =>
  call('POST', `/referrals/${id}/letter/sign`, tokens, body);
const signed = async (id: string, body: Record<string, unknown> = { pin: PIN }) => {
  const res = await sign(id, body);
  expect(res.statusCode, res.body).toBe(200);
  return Referral.parse(res.json());
};
const codeOf = (r: Referral) => r.letter!.verificationUrl.split('/verify/referral/')[1]!;
const verify = (code: string) => call('POST', '/verify/referral-letter', null, { code });
const auditOf = (action: string) =>
  h.owner.auditLog.findMany({ where: { action }, orderBy: { at: 'asc' } });

describe('signing the referral letter', () => {
  it('previews, then signs with the PIN: stored PDF with its hash and signature, and a QR', async () => {
    await readyToSign();
    const visitId = await visit();
    // The visit's diagnoses print on the letter; the private notes never do.
    const notes = await call('PUT', `/appointments/${visitId}/consultation`, doctor, {
      notes: {
        diagnoses: [{ code: 'M17.1', label: 'Osteoarthritis of knee' }],
        privateNotes: 'Synthetic private note',
      },
      followUpDate: null,
      revision: 0,
    });
    expect(notes.statusCode, notes.body).toBe(200);
    const made = await refer(visitId);
    expect(made).toMatchObject({ letter: null, canSignLetter: true });

    const preview = await call('GET', `/referrals/${made.id}/letter/preview`, doctor);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['content-type']).toBe('application/pdf');
    expect(preview.headers['cache-control']).toBe('no-store');
    const previewText = pdfText(preview.rawPayload);
    expect(previewText).toContain('Not signed. This preview is not a referral letter.');
    expect(previewText).toContain('PREVIEW - NOT SIGNED');
    // Nothing is stored by a preview.
    expect(await h.owner.referralLetter.count()).toBe(0);

    const wrong = await sign(made.id, { pin: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.fields).toEqual({ pin: 'wrong' });

    const done = await signed(made.id);
    expect(done).toMatchObject({
      canSignLetter: false,
      letter: {
        signedAt: h.clock.now().toISOString(),
        language: 'en',
        paperSize: 'a5',
        signatureMethod: 'test_key',
      },
    });
    expect(done.letter!.verificationUrl).toMatch(
      /^https:\/\/app\.test\/verify\/referral\/[0-9A-Z]{24}$/,
    );

    const row = await h.owner.referralLetter.findUniqueOrThrow({ where: { referralId: made.id } });
    expect(row).toMatchObject({
      templateVersion: 'referral-1',
      signedByUserId: clinics.a.doctor.userId,
      verificationCode: codeOf(done),
    });
    const pdf = await call('GET', `/referrals/${made.id}/letter`, doctor);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(
      'inline; filename="referral-letter-2026-10-06.pdf"',
    );
    const digest = createHash('sha256').update(pdf.rawPayload).digest();
    expect(digest.toString('hex')).toBe(row.pdfSha256);
    expect((h.services.signer as TestKeySigner).verify(digest, row.signature)).toBe(true);

    const text = pdfText(pdf.rawPayload);
    for (const part of [
      'Dr. Synthetic Doctor',
      'Reg. No. TEST-12345, Test Medical Council',
      'Referral letter',
      'Urgency: Soon',
      'To: Dr. Second Synthetic',
      'Patient: Asha Verma',
      'Age: 41 y',
      'Gender: Female',
      'Persistent knee effusion; please assess for arthroscopy.',
      'Diagnosis 1. Osteoarthritis of knee (M17.1)',
      'Aspirated once last month.',
      'Digitally signed by Dr. Synthetic Doctor',
      'Test signature: for development only, not legally valid.',
    ]) {
      expect(text, part).toContain(part);
    }
    expect(text).not.toContain('Synthetic private note');
    expect(text).not.toContain('PREVIEW');

    // The receiving doctor downloads the same file, and sees the letter on the referral.
    const theirs = await call('GET', `/referrals/${made.id}/letter`, secondDoctor);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.rawPayload.equals(pdf.rawPayload)).toBe(true);
    const seen = Referral.parse((await call('GET', `/referrals/${made.id}`, secondDoctor)).json());
    expect(seen).toMatchObject({ letter: done.letter, canSignLetter: false });

    // Signed once: no second letter, and no more previews.
    const again = await sign(made.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.fields).toEqual({ letter: 'signed' });
    expect((await call('GET', `/referrals/${made.id}/letter/preview`, doctor)).statusCode).toBe(
      409,
    );
  });

  it('writes the patient’s language by default, the other when asked, and an outside recipient', async () => {
    await readyToSign();
    await h.owner.patient.update({ where: { id: patientId() }, data: { language: 'hi' } });
    const first = await refer(await visit(), external());
    expect((await signed(first.id)).letter!.language).toBe('hi');
    const preview = await call('GET', `/referrals/${first.id}/letter/preview?language=en`, doctor);
    // Already signed.
    expect(preview.statusCode).toBe(409);

    const other = await refer(await visit(), external());
    const english = await call('GET', `/referrals/${other.id}/letter/preview?language=en`, doctor);
    expect(english.statusCode).toBe(200);
    expect(pdfText(english.rawPayload)).toContain(
      'To: Dr Meera Iyer Cardiology City Heart Hospital +91 90000 00001',
    );
    expect(
      (await call('GET', `/referrals/${other.id}/letter/preview?language=ta`, doctor)).statusCode,
    ).toBe(400);
    const done = await signed(other.id, { pin: PIN, language: 'en' });
    expect(done.letter!.language).toBe('en');
    expect(
      pdfText((await call('GET', `/referrals/${other.id}/letter`, doctor)).rawPayload),
    ).toContain('Urgency: Urgent');
  });

  it('prints on the pad’s paper size', async () => {
    await readyToSign();
    await call('PUT', '/doctor-profile', doctor, { ...profileBody, paperSize: 'a4' });
    const made = await refer(await visit());
    expect((await signed(made.id)).letter!.paperSize).toBe('a4');
  });
});

describe('who may sign and read the letter', () => {
  it('only the referring doctor signs; both doctors read; anyone else gets 404 or 403', async () => {
    await readyToSign();
    const made = await refer(await visit());

    // The receiving doctor may not preview or sign.
    expect(
      (await call('GET', `/referrals/${made.id}/letter/preview`, secondDoctor)).statusCode,
    ).toBe(403);
    expect((await sign(made.id, { pin: PIN }, secondDoctor)).statusCode).toBe(403);
    // A doctor who is neither side, and another clinic's doctor: 404, as for the referral.
    for (const tokens of [thirdDoctor, doctorB]) {
      expect((await call('GET', `/referrals/${made.id}/letter/preview`, tokens)).statusCode).toBe(
        404,
      );
      expect((await sign(made.id, { pin: PIN }, tokens)).statusCode).toBe(404);
      expect((await call('GET', `/referrals/${made.id}/letter`, tokens)).statusCode).toBe(404);
    }
    // The front desk and clinic admins have no clinical access.
    for (const tokens of [desk, admin]) {
      expect((await call('GET', `/referrals/${made.id}/letter/preview`, tokens)).statusCode).toBe(
        403,
      );
      expect((await sign(made.id, { pin: PIN }, tokens)).statusCode).toBe(403);
      expect((await call('GET', `/referrals/${made.id}/letter`, tokens)).statusCode).toBe(403);
    }
    // No letter yet: 404 for either doctor.
    expect((await call('GET', `/referrals/${made.id}/letter`, doctor)).statusCode).toBe(404);
    expect((await call('GET', `/referrals/${made.id}/letter`, secondDoctor)).statusCode).toBe(404);
    // An unknown referral.
    expect((await sign(randomUUID())).statusCode).toBe(404);
    // Signed in only.
    expect((await call('GET', `/referrals/${made.id}/letter`, null)).statusCode).toBe(401);
    // None of the refusals spent a PIN attempt or wrote a letter.
    const profile = await h.owner.doctorProfile.findFirstOrThrow({
      where: { userId: clinics.a.doctor.userId },
    });
    expect(profile.pinFailedCount).toBe(0);
    expect(await h.owner.referralLetter.count()).toBe(0);
  });

  it('cannot be signed once the referral is closed; a signed letter stays valid after closing', async () => {
    await readyToSign();
    const closedFirst = await refer(await visit());
    await call('POST', `/referrals/${closedFirst.id}/close`, secondDoctor, {});
    for (const res of [
      await call('GET', `/referrals/${closedFirst.id}/letter/preview`, doctor),
      await sign(closedFirst.id),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.fields).toEqual({ status: 'closed' });
    }
    const closed = Referral.parse(
      (await call('GET', `/referrals/${closedFirst.id}`, doctor)).json(),
    );
    expect(closed).toMatchObject({ letter: null, canSignLetter: false });

    const signedFirst = await refer(await visit());
    const done = await signed(signedFirst.id);
    const closing = await call('POST', `/referrals/${signedFirst.id}/close`, doctor, {
      note: 'Seen; arthroscopy planned.',
    });
    expect(Referral.parse(closing.json())).toMatchObject({
      status: 'closed',
      letter: done.letter,
      canSignLetter: false,
    });
    // Both doctors still download it, and the QR still says genuine.
    expect((await call('GET', `/referrals/${signedFirst.id}/letter`, doctor)).statusCode).toBe(200);
    expect(
      (await call('GET', `/referrals/${signedFirst.id}/letter`, secondDoctor)).statusCode,
    ).toBe(200);
    const check = await verify(codeOf(done));
    expect(check.statusCode).toBe(200);
    expect(ReferralLetterCheck.parse(check.json()).status).toBe('genuine');
  });
});

describe('the signing PIN and the prescription pad', () => {
  it('needs a PIN, pauses after five wrong ones, and needs the pad verified', async () => {
    const made = await refer(await visit());
    // No pad and no PIN yet.
    const unset = await sign(made.id);
    expect(unset.statusCode).toBe(422);
    expect(unset.json().error.fields).toEqual({ pin: 'unset' });

    // A PIN but not verified: refused after the PIN, with nothing written.
    await readyToSign({ verified: false });
    const pending = await sign(made.id);
    expect(pending.statusCode).toBe(403);
    expect(pending.json().error.code).toBe('DOCTOR_NOT_VERIFIED');

    // Four wrong PINs are refused; the fifth pauses signing, even with the right PIN.
    for (let i = 0; i < 4; i++) {
      const res = await sign(made.id, { pin: '000000' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.fields).toEqual({ pin: 'wrong' });
    }
    const locked = await sign(made.id, { pin: '000000' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.fields).toEqual({ pin: 'locked' });
    // One lockout for every document the doctor signs: prescriptions wait too, even with
    // the right PIN (the PIN is checked before the prescription itself).
    const rxSign = await call('POST', `/appointments/${await visit()}/prescription/sign`, doctor, {
      revision: 1,
      pin: PIN,
    });
    expect(rxSign.statusCode).toBe(429);
    expect(rxSign.json().error.fields).toEqual({ pin: 'locked' });
    await supportVerifyDoctor(h.services, source, {
      identifier: clinics.a.doctor.email,
      clinic: 'clinic-a',
      ticket: 'SUP-1',
      operator: 'ops@platform.test',
    });
    expect((await sign(made.id)).statusCode).toBe(429);
    // The same pause as for prescriptions: 15 minutes.
    h.clock.advance(15 * 60 + 1);
    expect((await sign(made.id)).statusCode).toBe(200);
    expect(await auditOf('doctor.signing_pin_locked')).toHaveLength(1);

    // A malformed PIN never reaches the check.
    const other = await refer(await visit());
    expect((await sign(other.id, { pin: '12ab56' })).statusCode).toBe(400);
  });

  it('needs a complete pad', async () => {
    await readyToSign();
    // A pad missing its prefix (as an older profile might be).
    await h.owner.doctorProfile.updateMany({
      where: { userId: clinics.a.doctor.userId },
      data: { rxPrefix: null },
    });
    const made = await refer(await visit());
    const res = await sign(made.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields).toEqual({ profile: 'incomplete' });
  });
});

describe('the public QR check', () => {
  it('shows enough to match the paper: initials, never the name or the reason', async () => {
    await readyToSign();
    const outside = await signed((await refer(await visit(), external())).id);
    const inside = await signed((await refer(await visit())).id);

    const res = await verify(codeOf(outside).toLowerCase());
    expect(res.statusCode, res.body).toBe(200);
    const check = ReferralLetterCheck.parse(res.json());
    expect(check).toEqual({
      status: 'genuine',
      signedAt: outside.letter!.signedAt,
      signatureMethod: 'test_key',
      doctor: {
        name: 'Dr. Synthetic Doctor',
        qualifications: 'MBBS, MS (Ortho)',
        registrationNumber: 'TEST-12345',
        council: 'Test Medical Council',
      },
      clinicName: 'Main clinic',
      patient: { initials: 'A. V.', ageYears: 41, gender: 'female' },
      recipient: {
        kind: 'external',
        name: 'Dr Meera Iyer',
        specialty: 'Cardiology',
        hospital: 'City Heart Hospital',
      },
      urgency: 'urgent',
      visitDate: '2026-10-06',
    });
    const raw = res.body;
    for (const secret of ['Asha', 'Verma', 'Cardiology opinion', '90000', 'CL-0']) {
      expect(raw, secret).not.toContain(secret);
    }
    const insideCheck = ReferralLetterCheck.parse((await verify(codeOf(inside))).json());
    expect(insideCheck.recipient).toEqual({
      kind: 'internal',
      name: 'Dr. Second Synthetic',
      specialty: null,
      hospital: null,
    });
  });

  it('knows only letter codes, and prescriptions keep their own check', async () => {
    await readyToSign();
    const done = await signed((await refer(await visit())).id);
    expect((await verify('ABCDEFGHJKMNPQRSTVWXYZ01')).statusCode).toBe(404);
    expect((await verify('short')).statusCode).toBe(400);
    // A letter's code is not a prescription's, and the other way round.
    expect((await call('POST', '/verify', null, { code: codeOf(done) })).statusCode).toBe(404);
    const rxVisit = await visit();
    await seedSampleMedicines(h.owner);
    const m = await h.owner.medicine.findFirstOrThrow({
      where: { name: 'Paracetamol 500', organisationId: null },
    });
    const saved = await call('PUT', `/appointments/${rxVisit}/prescription`, doctor, {
      language: 'en',
      items: [
        {
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
        },
      ],
      revision: 0,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const rx = await call('POST', `/appointments/${rxVisit}/prescription/sign`, doctor, {
      revision: saved.json().revision,
      pin: PIN,
    });
    expect(rx.statusCode, rx.body).toBe(200);
    const rxCode = rx.json().verificationUrl.split('/verify/')[1];
    expect((await verify(rxCode)).statusCode).toBe(404);
    const rxCheck = await call('POST', '/verify', null, { code: rxCode });
    expect(PrescriptionCheck.parse(rxCheck.json()).status).toBe('genuine');
  });
});

describe('immutability and tenancy', () => {
  it('a signed letter never changes and is never deleted, and the database checks who signs', async () => {
    await readyToSign();
    const made = await refer(await visit());
    await signed(made.id);
    const letter = await h.owner.referralLetter.findUniqueOrThrow({
      where: { referralId: made.id },
    });
    await expect(
      h.owner.referralLetter.update({ where: { id: letter.id }, data: { language: 'hi' } }),
    ).rejects.toThrow(/cannot change/);
    await expect(h.owner.referralLetter.delete({ where: { id: letter.id } })).rejects.toThrow(
      /cannot change/,
    );
    await expect(
      h.owner.referralLetterVerification.updateMany({ data: { createdAt: h.clock.now() } }),
    ).rejects.toThrow(/cannot change/);
    await expect(h.owner.referralLetterVerification.deleteMany()).rejects.toThrow(/cannot change/);

    // The app role has no UPDATE or DELETE grant at all.
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.referralLetter.update({ where: { id: letter.id }, data: { language: 'hi' } }),
      ),
    ).rejects.toThrow();

    // Rows the API would never write: a second letter, one signed by the receiving doctor,
    // one for a closed referral, one in another clinic, or one with a malformed hash.
    const other = await refer(await visit());
    const closed = await refer(await visit());
    await call('POST', `/referrals/${closed.id}/close`, doctor, {});
    const base = {
      ...letter,
      id: randomUUID(),
      referralId: other.id,
      verificationCode: 'ZZZZZZZZZZZZZZZZZZZZZZZZ',
      createdAt: undefined,
    };
    for (const [data, message] of [
      [{ ...base, referralId: made.id }, /referral_id/],
      [{ ...base, signedByUserId: second.userId }, /only the referring doctor/],
      [{ ...base, referralId: closed.id }, /closed referral/],
      [{ ...base, organisationId: clinics.b.org.id }, /does not match/],
      [{ ...base, pdfSha256: 'not-a-hash' }, /referral_letters_fields_check/],
      [{ ...base, verificationCode: 'ILOU0000000000000000000' }, /referral_letters_fields_check/],
    ] as const) {
      await expect(h.owner.referralLetter.create({ data }), String(message)).rejects.toThrow(
        message,
      );
    }
    expect(await h.owner.referralLetter.count()).toBe(1);
  });

  it('keeps another clinic’s letters out of sight', async () => {
    await readyToSign();
    const made = await refer(await visit());
    await signed(made.id);
    expect(
      await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.referralLetter.count()),
    ).toBe(0);
    expect(
      await withTenant(h.services.db, clinics.b.org.id, (tx) =>
        tx.referralLetterVerification.count(),
      ),
    ).toBe(0);
    expect((await call('GET', `/referrals/${made.id}/letter`, doctorB)).statusCode).toBe(404);
  });
});

describe('audit', () => {
  it('records preview, signing and each download, without patient data or the letter’s text', async () => {
    await readyToSign();
    const made = await refer(await visit());
    await call('GET', `/referrals/${made.id}/letter/preview?language=hi`, doctor);
    const done = await signed(made.id);
    await call('GET', `/referrals/${made.id}/letter`, doctor);
    await call('GET', `/referrals/${made.id}/letter`, secondDoctor);

    const [previewed] = await auditOf('referral.letter_previewed');
    expect(previewed).toMatchObject({
      entityType: 'referral',
      entityId: made.id,
      actorUserId: clinics.a.doctor.userId,
      metadata: { language: 'hi' },
    });
    const [signing] = await auditOf('referral.letter_signed');
    const letter = await h.owner.referralLetter.findUniqueOrThrow({
      where: { referralId: made.id },
    });
    expect(signing).toMatchObject({ entityType: 'referral', entityId: made.id });
    expect(signing!.metadata).toEqual({
      letterId: letter.id,
      language: 'en',
      paperSize: 'a5',
      pdfSha256: letter.pdfSha256,
      signatureMethod: 'test_key',
      templateVersion: 'referral-1',
    });
    const viewed = await auditOf('referral.letter_viewed');
    expect(viewed.map((a) => [a.actorUserId, a.metadata])).toEqual([
      [clinics.a.doctor.userId, { letterId: letter.id, by: 'referring' }],
      [second.userId, { letterId: letter.id, by: 'receiving' }],
    ]);
    const all = JSON.stringify(
      await h.owner.auditLog.findMany({ where: { action: { startsWith: 'referral.letter' } } }),
    );
    for (const secret of ['Asha', 'Verma', 'knee', 'Aspirated', codeOf(done), PIN]) {
      expect(all, secret).not.toContain(secret);
    }

    // The clinic admin's log lists them under Referrals.
    const log = AuditListResponse.parse(
      (await call('GET', '/audit-log?action=referral.letter', admin)).json(),
    );
    expect(log.data.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'referral.letter_previewed',
        'referral.letter_signed',
        'referral.letter_viewed',
      ]),
    );
  });
});
