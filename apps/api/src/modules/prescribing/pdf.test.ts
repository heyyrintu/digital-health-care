import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  renderPrescriptionPdf,
  scriptRuns,
  type RxDocument,
} from './pdf';

const doc = (over: Partial<RxDocument> = {}): RxDocument => ({
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
  clinic: { name: 'Main clinic', address: '1 Test Road', phone: null },
  organisationName: 'Synthetic Clinic',
  patient: {
    name: 'Asha Synthetic',
    age: { years: 34, months: 0 },
    gender: 'female',
    uhid: 'SY-000001',
  },
  date: '2026-10-08',
  mode: 'in_person',
  number: 'SD-00001',
  version: 1,
  amendment: null,
  void: null,
  vitals: null,
  complaints: ['Knee pain'],
  diagnoses: ['Osteoarthritis of knee'],
  allergies: [],
  items: [
    {
      name: 'Paracetamol 500 mg Tablet',
      generic: 'Paracetamol 500 mg',
      steps: [{ dose: '1 tablet', frequency: '1-0-1', durationValue: 5, durationUnit: 'days' }],
      quantity: null,
      instructions: null,
      remarks: 'Take 1 tablet twice a day for 5 days.',
    },
  ],
  testsAdvised: '',
  advice: '',
  followUpDate: null,
  signature: {
    signedAt: new Date('2026-10-08T05:12:00Z'),
    method: 'test_key',
    certificate: 'TEST KEY',
  },
  verificationUrl: 'https://app.test/verify/ABC',
  ...over,
});

const pages = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;

describe('scriptRuns', () => {
  it('splits Hindi from digits and punctuation, keeping spaces inside a Hindi run', () => {
    expect(scriptRuns('दिन में 2 बार, 5 दिन तक।')).toEqual([
      { text: 'दिन में', deva: true },
      { text: ' 2 ', deva: false },
      { text: 'बार', deva: true },
      { text: ', 5 ', deva: false },
      { text: 'दिन तक।', deva: true },
    ]);
    expect(scriptRuns('Take 1 tablet')).toEqual([{ text: 'Take 1 tablet', deva: false }]);
  });
});

describe('dates on the PDF', () => {
  it('prints the date, and the signing time in IST', () => {
    expect(formatDate('2026-10-08')).toBe('8 Oct 2026');
    expect(formatDateTime(new Date('2026-10-08T20:00:00Z'))).toBe('9 Oct 2026, 01:30 IST');
  });
});

describe('renderPrescriptionPdf', () => {
  it('renders the same bytes for the same prescription, so its hash can be checked', async () => {
    const a = await renderPrescriptionPdf(doc());
    const b = await renderPrescriptionPdf(doc());
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
    expect(pages(a)).toBe(1);
  });

  it('renders Hindi, A4, a watermark and an amendment', async () => {
    const plain = await renderPrescriptionPdf(doc({ language: 'hi' }));
    const marked = await renderPrescriptionPdf(
      doc({
        language: 'hi',
        paperSize: 'a4',
        watermark: 'void',
        version: 2,
        amendment: { reason: 'Dose corrected', date: '2026-10-09' },
        void: { reason: 'Wrong patient', date: '2026-10-10' },
      }),
    );
    expect(plain.subarray(0, 5).toString()).toBe('%PDF-');
    expect(marked.equals(plain)).toBe(false);
  });

  it('flows a long prescription onto more pages', async () => {
    const item = doc().items[0]!;
    const pdf = await renderPrescriptionPdf(doc({ items: Array.from({ length: 30 }, () => item) }));
    expect(pages(pdf)).toBeGreaterThan(1);
  });

  it('renders an unsigned preview without a QR', async () => {
    const pdf = await renderPrescriptionPdf(
      doc({ watermark: 'preview', number: null, signature: null, verificationUrl: null }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
