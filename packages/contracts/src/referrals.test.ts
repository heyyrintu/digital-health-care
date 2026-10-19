import { describe, expect, it } from 'vitest';
import {
  CloseReferralBody,
  CreateReferralBody,
  REFERRAL_LIMITS,
  ReferralListQuery,
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
      ]),
    );
    const create = (doc.paths['/appointments/{id}/referrals'] as Record<string, unknown>).post as {
      responses: Record<string, unknown>;
    };
    expect(Object.keys(create.responses)).toContain('201');
  });
});
