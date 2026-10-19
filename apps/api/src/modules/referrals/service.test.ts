import type { Referral } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { decodeReferralCursor, encodeReferralCursor, summaryOf } from './service';

const referral: Referral = {
  id: '2b7c1f3e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
  kind: 'internal',
  status: 'seen',
  urgency: 'soon',
  patient: { id: '3c8d2a4f-5e6b-4c7d-9e8f-0a1b2c3d4e5f', name: 'Asha Verma', uhid: 'EK10001' },
  referringDoctor: { userId: '4d9e3b5a-6f7c-4d8e-8f9a-1b2c3d4e5f60', name: 'Dr. Synthetic' },
  receivingDoctor: { userId: '5eaf4c6b-7a8d-4e9f-9a0b-2c3d4e5f6071', name: 'Dr. Second' },
  external: null,
  appointmentId: '6fb05d7c-8b9e-4fa0-8b1c-3d4e5f607182',
  visitDate: '2026-10-06',
  sentAt: '2026-10-06T05:00:00.000Z',
  seenAt: '2026-10-06T06:00:00.000Z',
  closedAt: null,
  reason: 'Knee effusion for an arthroscopy opinion',
  notes: 'MRI attached at the desk',
  closedBy: null,
  closeNote: null,
  role: 'receiving',
  canClose: true,
};

describe('summaryOf', () => {
  it('keeps who, to whom and status, and leaves out the clinical text', () => {
    const summary = summaryOf(referral);
    expect(summary).not.toHaveProperty('reason');
    expect(summary).not.toHaveProperty('notes');
    expect(summary).not.toHaveProperty('closeNote');
    expect(summary).toMatchObject({
      id: referral.id,
      status: 'seen',
      receivingDoctor: referral.receivingDoctor,
      seenAt: referral.seenAt,
    });
  });
});

describe('referral cursors', () => {
  it('round-trips an ID and refuses anything else', () => {
    expect(decodeReferralCursor(encodeReferralCursor(referral.id))).toBe(referral.id);
    expect(() => decodeReferralCursor(Buffer.from('nope').toString('base64url'))).toThrow(AppError);
  });
});
