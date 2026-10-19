import type { Gender, Language, ReferralUrgency } from '@dhc/contracts';
import { t } from '@dhc/i18n';
import {
  formatDate,
  GREY,
  startDocument,
  type DocumentSignature,
  type LetterheadDoctor,
  type PaperSize,
} from '../../documents/pdf-kit';

/**
 * Bumped whenever the layout changes; stored with each signed letter.
 * `referral-1`: the first layout (PRD §7.2).
 */
export const LETTER_TEMPLATE_VERSION = 'referral-1';

/** Everything printed on a referral letter, already read and decrypted. */
export interface LetterDocument {
  language: Language;
  paperSize: PaperSize;
  /** `preview` before signing: marked PREVIEW, with no signature or QR. */
  watermark: 'preview' | null;
  /** The referring doctor, from their prescription pad. */
  doctor: LetterheadDoctor;
  /** The organisation as patients know it (its branding name, else its name). */
  organisationName: string;
  clinic: { name: string; address: string | null; phone: string | null } | null;
  /** The letter's date (the day it was signed, or today for a preview), YYYY-MM-DD. */
  date: string;
  /** The day of the visit the referral was made at, YYYY-MM-DD. */
  visitDate: string;
  patient: {
    name: string;
    age: { years: number; months: number } | null;
    gender: Gender | null;
    uhid: string;
  };
  /** A doctor of the organisation, or someone outside it, as the referral names them. */
  recipient: {
    name: string;
    specialty: string | null;
    hospital: string | null;
    phone: string | null;
  };
  urgency: ReferralUrgency;
  reason: string;
  notes: string | null;
  /** The visit's diagnoses from the doctor's notes, as the prescription prints them. */
  diagnoses: string[];
  signature: DocumentSignature | null;
  verificationUrl: string | null;
}

/**
 * Renders the referral letter: the referring doctor's letterhead, the date and urgency,
 * the recipient, the patient, the reason, diagnoses and notes, then the signature block
 * and the QR. Black and white, A4 or A5, English or Hindi labels; deterministic for the
 * same input, so the stored hash can be checked again.
 */
export async function renderReferralLetterPdf(doc: LetterDocument): Promise<Buffer> {
  const kit = startDocument({
    language: doc.language,
    paperSize: doc.paperSize,
    title: t(doc.language, 'letter.title'),
    author: doc.doctor.name,
    creator: doc.organisationName,
    created: doc.signature?.signedAt ?? new Date(`${doc.date}T00:00:00Z`),
  });
  const { pdf, page, L, write, rule, section } = kit;

  // ---- Letterhead: doctor and clinic ----
  const clinic = doc.clinic
    ? [doc.organisationName, doc.clinic.name, doc.clinic.address, doc.clinic.phone]
        .filter((part, i, all) => part && all.indexOf(part) === i)
        .join(' · ')
    : doc.organisationName;
  kit.letterhead(doc.doctor, clinic);

  // ---- Title, date and urgency ----
  write(L('letter.title'), { bold: true, size: page.body + 3 });
  write(
    [
      `${L('pdf.date')}: ${formatDate(doc.date)}`,
      `${L('referrals.urgency')}: ${L(`referrals.urgency.${doc.urgency}`)}`,
    ].join('   '),
    { bold: doc.urgency === 'urgent' },
  );

  // ---- Recipient ----
  pdf.moveDown(0.4);
  write(`${L('letter.to')}:`, { bold: true });
  write(doc.recipient.name);
  for (const line of [doc.recipient.specialty, doc.recipient.hospital, doc.recipient.phone]) {
    if (line) write(line);
  }
  rule();

  // ---- Patient ----
  const { age, gender } = kit.ageAndGender(doc.patient);
  write(`${L('pdf.patient')}: ${doc.patient.name}`, { bold: true });
  write(
    [
      `${L('pdf.age')}: ${age}`,
      `${L('pdf.gender')}: ${gender}`,
      `${L('pdf.uhid')}: ${doc.patient.uhid}`,
    ].join('   '),
  );
  write(`${L('letter.seenOn')}: ${formatDate(doc.visitDate)}`);
  rule();

  // ---- The letter ----
  write(L('letter.salutation'));
  pdf.moveDown(0.3);
  write(L('letter.intro'));
  section(L('referrals.reasonLabel'));
  write(doc.reason);
  if (doc.diagnoses.length) {
    section(L('letter.diagnoses'));
    doc.diagnoses.forEach((d, i) => write(`${i + 1}. ${d}`));
  }
  if (doc.notes) {
    section(L('referrals.notes'));
    write(doc.notes);
  }
  pdf.moveDown(0.6);
  write(L('letter.closing'));
  write(doc.doctor.name, { bold: true });
  if (doc.doctor.registrationNumber) {
    write(
      L('pdf.regNo', { number: doc.doctor.registrationNumber, council: doc.doctor.council ?? '' }),
      { color: GREY },
    );
  }

  // ---- Signature block and QR, kept together ----
  kit.signatureBlock({
    doctorName: doc.doctor.name,
    signature: doc.signature,
    verificationUrl: doc.verificationUrl,
    notSigned: L('letter.notSigned'),
    verify: (url) => L('letter.verify', { url }),
    disclaimer: L('letter.disclaimer'),
  });

  // ---- Every page: watermark and page numbers ----
  return kit.finish(doc.watermark ? 'PREVIEW - NOT SIGNED' : null, L('letter.title'));
}
