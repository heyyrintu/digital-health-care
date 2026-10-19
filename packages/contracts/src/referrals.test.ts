import { describe, expect, it } from 'vitest';
import {
  CloseReferralBody,
  CreateReferralBody,
  REFERRAL_LIMITS,
  Referral,
  ReferralLetterCheck,
  ReferralLetterPreviewQuery,
  ReferralListQuery,
  SignReferralLetterBody,
  VerifyReferralLetterBody,
  buildOpenApiDocument,
} from './index';

const doctorId = '7d6b1d1e-9a5f-4a51-8b8f-2f1c3c1d9e01';

describe('CreateReferralBody', () => {
  it('takes an internal referral to a doctor, with blank notes as none', () => {
    expect(
      CreateReferralBody.parse({
        kind: 'internal',
        receivingDoctorUserId: doctorId,
        reason: '  Persistent knee effusion; please assess for arthroscopy.  ',
        urgency: 'soon',
        notes: '   ',
      }),
    ).toEqual({
      kind: 'internal',
      receivingDoctorUserId: doctorId,
      reason: 'Persistent knee effusion; please assess for arthroscopy.',
      urgency: 'soon',
      notes: null,
    });
  });

  it('takes an external referral with only a name, tidying the one-line fields', () => {
    const parsed = CreateReferralBody.parse({
      kind: 'external',
      external: { name: '  Dr  Meera   Iyer ', specialty: '', hospital: undefined },
      reason: 'Cardiology opinion before surgery',
      urgency: 'routine',
    });
    expect(parsed).toEqual({
      kind: 'external',
      external: { name: 'Dr Meera Iyer', specialty: null, hospital: null, phone: null },
      reason: 'Cardiology opinion before surgery',
      urgency: 'routine',
      notes: null,
    });
  });

  it('keeps line breaks in the reason and notes but not in names', () => {
    const parsed = CreateReferralBody.parse({
      kind: 'external',
      external: { name: 'City\nHospital', phone: '+91 90000-00001' },
      reason: 'Line one\nLine two',
      urgency: 'urgent',
      notes: 'More\n\ndetail',
    });
    expect(parsed.kind === 'external' && parsed.external).toMatchObject({
      name: 'City Hospital',
      phone: '+91 90000-00001',
    });
    expect(parsed.reason).toBe('Line one\nLine two');
    expect(parsed.notes).toBe('More\n\ndetail');
  });

  it('refuses what the database would refuse', () => {
    const base = { reason: 'Opinion', urgency: 'routine' };
    const bad = [
      // Neither kind, or the wrong fields for the kind.
      { ...base },
      { ...base, kind: 'internal' },
      { ...base, kind: 'internal', receivingDoctorUserId: 'not-a-uuid' },
      { ...base, kind: 'external' },
      { ...base, kind: 'external', external: { name: '   ' } },
      // Limits.
      {
        ...base,
        kind: 'external',
        external: { name: 'x'.repeat(REFERRAL_LIMITS.externalName + 1) },
      },
      { ...base, kind: 'external', external: { name: 'Clinic', phone: 'call me' } },
      { ...base, kind: 'external', external: { name: 'Clinic', phone: '12345' } },
      { ...base, kind: 'external', external: { name: 'Clinic', specialty: 'Ortho\u0007' } },
      { ...base, kind: 'internal', receivingDoctorUserId: doctorId, urgency: 'asap' },
      { ...base, kind: 'internal', receivingDoctorUserId: doctorId, reason: '   ' },
      {
        ...base,
        kind: 'internal',
        receivingDoctorUserId: doctorId,
        reason: 'x'.repeat(REFERRAL_LIMITS.reason + 1),
      },
      {
        ...base,
        kind: 'internal',
        receivingDoctorUserId: doctorId,
        notes: 'x'.repeat(REFERRAL_LIMITS.notes + 1),
      },
    ];
    for (const body of bad) {
      expect(CreateReferralBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('control characters in the reason, notes and closing note', () => {
  it('keeps line breaks and tabs but refuses other control characters', () => {
    const base = { kind: 'internal', receivingDoctorUserId: doctorId, urgency: 'routine' };
    expect(
      CreateReferralBody.parse({ ...base, reason: 'One\r\nTwo\tthree', notes: 'a\nb' }),
    ).toMatchObject({ reason: 'One\r\nTwo\tthree', notes: 'a\nb' });
    for (const bad of ['\u0000', '\u0007', '\u000b', '\u001b', '\u007f', '\u0085', '\u009f']) {
      expect(CreateReferralBody.safeParse({ ...base, reason: `x${bad}y` }).success).toBe(false);
      expect(
        CreateReferralBody.safeParse({ ...base, reason: 'ok', notes: `x${bad}y` }).success,
      ).toBe(false);
      expect(CloseReferralBody.safeParse({ note: `x${bad}y` }).success).toBe(false);
    }
  });
});

describe('CloseReferralBody', () => {
  it('takes an optional note', () => {
    expect(CloseReferralBody.parse({})).toEqual({ note: null });
    expect(CloseReferralBody.parse({ note: ' Seen; surgery planned. ' })).toEqual({
      note: 'Seen; surgery planned.',
    });
    expect(
      CloseReferralBody.safeParse({ note: 'x'.repeat(REFERRAL_LIMITS.closeNote + 1) }).success,
    ).toBe(false);
  });
});

describe('ReferralListQuery', () => {
  it('needs the box and pages like other lists', () => {
    expect(ReferralListQuery.parse({ box: 'received' })).toEqual({ box: 'received', limit: 50 });
    expect(ReferralListQuery.safeParse({}).success).toBe(false);
    expect(ReferralListQuery.safeParse({ box: 'all' }).success).toBe(false);
    expect(ReferralListQuery.safeParse({ box: 'sent', status: 'open' }).success).toBe(false);
  });
});

describe('the referral letter', () => {
  it('signs with the 6-digit PIN, in the patient’s language unless one is given', () => {
    expect(SignReferralLetterBody.parse({ pin: '482916' })).toEqual({ pin: '482916' });
    expect(SignReferralLetterBody.parse({ pin: '482916', language: 'hi' })).toEqual({
      pin: '482916',
      language: 'hi',
    });
    for (const pin of ['48291', '4829167', 'abcdef', '']) {
      expect(SignReferralLetterBody.safeParse({ pin }).success, pin).toBe(false);
    }
    expect(SignReferralLetterBody.safeParse({ pin: '482916', language: 'ta' }).success).toBe(false);
    expect(ReferralLetterPreviewQuery.parse({})).toEqual({});
    expect(ReferralLetterPreviewQuery.safeParse({ language: 'fr' }).success).toBe(false);
  });

  it('checks a code like the prescription QR, trimmed', () => {
    expect(VerifyReferralLetterBody.parse({ code: '  ABCDEFGHJKMNPQRSTVWXYZ01 ' })).toEqual({
      code: 'ABCDEFGHJKMNPQRSTVWXYZ01',
    });
    expect(VerifyReferralLetterBody.safeParse({ code: 'short' }).success).toBe(false);
  });

  it('shows the patient as initials only and no clinical text on the check', () => {
    const check = ReferralLetterCheck.parse({
      status: 'genuine',
      signedAt: '2026-10-06T05:00:00.000Z',
      signatureMethod: 'test_key',
      doctor: {
        name: 'Dr. Synthetic Doctor',
        qualifications: null,
        registrationNumber: null,
        council: null,
      },
      clinicName: 'Main clinic',
      patient: { initials: 'A. V.', ageYears: 41, gender: 'female' },
      recipient: { kind: 'external', name: 'Dr Meera Iyer', specialty: null, hospital: null },
      urgency: 'soon',
      visitDate: '2026-10-06',
      // Anything else is dropped.
      reason: 'Persistent knee effusion',
    });
    expect(check).not.toHaveProperty('reason');
    expect(ReferralLetterCheck.safeParse({ ...check, status: 'void' }).success).toBe(false);
  });

  it('carries the letter, or null, on a referral', () => {
    const shape = Referral.shape;
    expect(shape.letter.safeParse(null).success).toBe(true);
    expect(
      shape.letter.safeParse({
        signedAt: '2026-10-06T05:00:00.000Z',
        language: 'hi',
        paperSize: 'a5',
        signatureMethod: 'test_key',
        verificationUrl: 'https://app.test/verify/referral/ABCDEFGHJKMNPQRSTVWXYZ01',
      }).success,
    ).toBe(true);
  });
});

describe('OpenAPI', () => {
  it('lists the referral endpoints', () => {
    const doc = buildOpenApiDocument({ version: 'test' });
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/appointments/{id}/referrals',
        '/referrals',
        '/referrals/counts',
        '/referrals/{id}',
        '/referrals/{id}/seen',
        '/referrals/{id}/close',
        '/referrals/{id}/letter/preview',
        '/referrals/{id}/letter/sign',
        '/referrals/{id}/letter',
        '/verify/referral-letter',
      ]),
    );
    const create = (doc.paths['/appointments/{id}/referrals'] as Record<string, unknown>).post as {
      responses: Record<string, unknown>;
    };
    expect(Object.keys(create.responses)).toContain('201');
  });
});
