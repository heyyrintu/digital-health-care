import { pdfText } from '@dhc/pdf-text';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LETTER_TEMPLATE_VERSION,
  renderReferralLetterPdf,
  type LetterDocument,
} from './letter-pdf';

// Synthetic personas only (docs/qa/test-plan.md).
const doc = (over: Partial<LetterDocument> = {}): LetterDocument => ({
  language: 'en',
  paperSize: 'a5',
  watermark: null,
  doctor: {
    name: 'Dr. Synthetic Doctor',
    qualifications: 'MBBS, MS (Ortho)',
    specialty: 'Orthopaedics',
    registrationNumber: 'TEST-12345',
    council: 'Test Medical Council',
  },
  organisationName: 'Synthetic Clinic',
  clinic: { name: 'Main clinic', address: '1 Test Road', phone: null },
  date: '2026-10-08',
  visitDate: '2026-10-06',
  patient: {
    name: 'Asha Verma',
    age: { years: 41, months: 9 },
    gender: 'female',
    uhid: 'SY-000001',
  },
  recipient: {
    name: 'Dr Meera Iyer',
    specialty: 'Cardiology',
    hospital: 'City Heart Hospital',
    phone: '+91 90000 00001',
  },
  urgency: 'soon',
  reason: 'Cardiology opinion before knee surgery.',
  notes: 'Aspirated once last month.',
  diagnoses: ['Osteoarthritis of knee (M17.1)'],
  signature: {
    signedAt: new Date('2026-10-08T05:12:00Z'),
    method: 'test_key',
    certificate: 'TEST KEY ed25519 0000',
  },
  verificationUrl: 'https://app.test/verify/referral/ABCDEFGHJKMNPQRSTVWXYZ01',
  ...over,
});

const pages = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;

// Shaping Hindi is CPU-heavy; allow for a busy CI runner (as for prescriptions).
describe('renderReferralLetterPdf', { timeout: 30_000 }, () => {
  // Pins the `referral-1` layout: if this hash changes, the template (or pdf-kit.ts) changed, so bump the template version.
  it('renders the fixed `referral-1` sample to the same bytes as when the version was set', async () => {
    const pdf = await renderReferralLetterPdf(doc());
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(
      '15754bab9c23a91ba8d7574a5eeea410a6d5db22e804c45a92153812a329532c',
    );
  });

  it('is versioned', () => {
    expect(LETTER_TEMPLATE_VERSION).toMatch(/^referral-\d+$/);
  });

  it('renders the same bytes for the same letter, so its hash can be checked', async () => {
    const a = await renderReferralLetterPdf(doc());
    const b = await renderReferralLetterPdf(doc());
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
    expect(pages(a)).toBe(1);
  });

  it('prints the letterhead, recipient, patient, reason, diagnoses, notes and signature', async () => {
    const text = pdfText(await renderReferralLetterPdf(doc()));
    for (const part of [
      'Dr. Synthetic Doctor',
      'MBBS, MS (Ortho) · Orthopaedics',
      'Reg. No. TEST-12345, Test Medical Council',
      'Synthetic Clinic · Main clinic · 1 Test Road',
      'Referral letter',
      'Date: 8 Oct 2026',
      'Urgency: Soon',
      'To: Dr Meera Iyer Cardiology City Heart Hospital +91 90000 00001',
      'Patient: Asha Verma',
      'Age: 41 y',
      'Gender: Female',
      'UHID: SY-000001',
      'Seen on: 6 Oct 2026',
      'Reason for referral Cardiology opinion before knee surgery.',
      'Diagnosis 1. Osteoarthritis of knee (M17.1)',
      'Notes Aspirated once last month.',
      'Yours sincerely,',
      'Digitally signed by Dr. Synthetic Doctor on 8 Oct 2026, 10:42 IST',
      'Test signature: for development only, not legally valid.',
      // The link wraps where the line ends.
      'Scan to check this letter, or open https://app.test/verify/referral/',
      'ABCDEFGHJKMNPQRSTVWXYZ01',
    ]) {
      expect(text, part).toContain(part);
    }
    expect(text).not.toContain('PREVIEW');
  });

  it('leaves out empty sections, and names an internal recipient without a hospital', async () => {
    const text = pdfText(
      await renderReferralLetterPdf(
        doc({
          notes: null,
          diagnoses: [],
          recipient: { name: 'Dr. Second Synthetic', specialty: null, hospital: null, phone: null },
        }),
      ),
    );
    expect(text).toContain('To: Dr. Second Synthetic Patient: Asha Verma');
    expect(text).not.toContain('Diagnosis');
    expect(text).not.toContain('Notes');
  });

  it('marks a preview, with no signature or QR', async () => {
    const pdf = await renderReferralLetterPdf(
      doc({ watermark: 'preview', signature: null, verificationUrl: null }),
    );
    const text = pdfText(pdf);
    expect(text).toContain('Not signed. This preview is not a referral letter.');
    expect(text).toContain('PREVIEW - NOT SIGNED');
    expect(text).not.toContain('Digitally signed');
    expect(text).not.toContain('/verify/');
  });

  // Hindi text is shaped, so it is checked by bytes and page count only (as for prescriptions).
  it('renders Hindi and A4, and flows a long letter onto more pages', async () => {
    const english = await renderReferralLetterPdf(doc());
    const hindi = await renderReferralLetterPdf(doc({ language: 'hi', paperSize: 'a4' }));
    expect(hindi.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hindi.equals(english)).toBe(false);
    expect(pages(hindi)).toBe(1);
    const long = await renderReferralLetterPdf(
      doc({ notes: Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of notes.`).join('\n') }),
    );
    expect(pages(long)).toBeGreaterThan(1);
  });
});
