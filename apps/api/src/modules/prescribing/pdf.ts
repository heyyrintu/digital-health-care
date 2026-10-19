import type { ConsultationMode, DoseStep, Gender, Language } from '@dhc/contracts';
import { t } from '@dhc/i18n';
import PDFDocument from 'pdfkit';
import {
  FONTS,
  formatDate,
  GREY,
  PAGE,
  scriptRuns,
  startDocument,
  type DocumentSignature,
  type LetterheadDoctor,
} from '../../documents/pdf-kit';

export { formatDate, formatDateTime, scriptRuns } from '../../documents/pdf-kit';

/** Bumped whenever the layout changes; stored with each signed prescription. */
/** `rx-2`: ordered tests print under "Prescribed tests" (PRD §7.1). */
export const PDF_TEMPLATE_VERSION = 'rx-2';

/** Everything printed on a prescription (PRD §6.6), already read and decrypted. */
export interface RxDocument {
  language: Language;
  paperSize: 'a4' | 'a5';
  /** `preview` before signing; `void` on the copy of a voided prescription. */
  watermark: 'preview' | 'void' | null;
  doctor: LetterheadDoctor;
  clinic: { name: string; address: string | null; phone: string | null } | null;
  organisationName: string;
  patient: {
    name: string;
    age: { years: number; months: number } | null;
    gender: Gender | null;
    uhid: string;
  };
  /** The visit date, YYYY-MM-DD. */
  date: string;
  mode: ConsultationMode;
  number: string | null;
  version: number;
  amendment: { reason: string; date: string } | null;
  void: { reason: string; date: string } | null;
  vitals: {
    bpSystolic: number | null;
    bpDiastolic: number | null;
    pulse: number | null;
    temperatureC: number | null;
    spo2: number | null;
    weightKg: number | null;
    heightCm: number | null;
    bmi: number | null;
  } | null;
  complaints: string[];
  diagnoses: string[];
  allergies: string[];
  items: {
    name: string;
    /** Printed in capitals under the name (generic names in capitals, NMC guidance). */
    generic: string | null;
    steps: DoseStep[];
    quantity: string | null;
    instructions: string | null;
    remarks: string;
  }[];
  /** Ordered tests, as `testOrderLabel` writes them (e.g. "MRI knee, right"), in order. */
  tests: { label: string; notes: string | null }[];
  /** The free-text "tests advised" from the notes, printed after the ordered tests. */
  testsAdvised: string;
  advice: string;
  followUpDate: string | null;
  signature: DocumentSignature | null;
  verificationUrl: string | null;
}

/**
 * Renders the prescription as a PDF: black and white, A4 or A5, English or Hindi labels.
 * Output is deterministic for the same input, so the stored hash can be checked again.
 */
export async function renderPrescriptionPdf(doc: RxDocument): Promise<Buffer> {
  const kit = startDocument({
    language: doc.language,
    paperSize: doc.paperSize,
    title: `${t(doc.language, 'pdf.title')} ${doc.number ?? ''}`.trim(),
    author: doc.doctor.name,
    creator: doc.organisationName,
    created: doc.signature?.signedAt ?? new Date(`${doc.date}T00:00:00Z`),
  });
  const { pdf, left, width, L, write, rule, section } = kit;

  // ---- Header: doctor and clinic ----
  const clinic = doc.clinic
    ? [doc.clinic.name, doc.clinic.address, doc.clinic.phone].filter(Boolean).join(' · ')
    : doc.organisationName;
  kit.letterhead(doc.doctor, clinic);

  // ---- Patient and visit ----
  const { age, gender } = kit.ageAndGender(doc.patient);
  write(`${L('pdf.patient')}: ${doc.patient.name}`, { bold: true });
  write(
    [
      `${L('pdf.age')}: ${age}`,
      `${L('pdf.gender')}: ${gender}`,
      `${L('pdf.uhid')}: ${doc.patient.uhid}`,
    ].join('   '),
  );
  const number = doc.number
    ? `${doc.number}${doc.version > 1 ? ` (${L('pdf.version', { version: doc.version })})` : ''}`
    : '—';
  write(
    [
      `${L('pdf.date')}: ${formatDate(doc.date)}`,
      `${L('pdf.number')}: ${number}`,
      `${L('pdf.mode')}: ${L(`mode.${doc.mode}`)}`,
    ].join('   '),
  );
  if (doc.amendment) {
    write(
      L('pdf.amended', {
        date: formatDate(doc.amendment.date),
        reason: doc.amendment.reason,
        previous: doc.version - 1,
      }),
      { bold: true },
    );
  }
  if (doc.void) {
    write(L('pdf.voided', { date: formatDate(doc.void.date), reason: doc.void.reason }), {
      bold: true,
    });
  }
  rule();

  // ---- Clinical summary ----
  const v = doc.vitals;
  if (v) {
    const parts = [
      v.bpSystolic !== null && v.bpDiastolic !== null
        ? `${L('pdf.bp')} ${v.bpSystolic}/${v.bpDiastolic} mmHg`
        : null,
      v.pulse !== null ? `${L('pdf.pulse')} ${v.pulse}/min` : null,
      v.temperatureC !== null ? `${L('pdf.temperature')} ${v.temperatureC} °C` : null,
      v.spo2 !== null ? `${L('pdf.spo2')} ${v.spo2}%` : null,
      v.weightKg !== null ? `${L('pdf.weight')} ${v.weightKg} kg` : null,
      v.heightCm !== null ? `${L('pdf.height')} ${v.heightCm} cm` : null,
      v.bmi !== null ? `${L('pdf.bmi')} ${v.bmi}` : null,
    ].filter((p): p is string => p !== null);
    if (parts.length) write(`${L('pdf.vitals')}: ${parts.join(' · ')}`);
  }
  if (doc.complaints.length) write(`${L('pdf.complaints')}: ${doc.complaints.join('; ')}`);
  if (doc.diagnoses.length) write(`${L('pdf.diagnosis')}: ${doc.diagnoses.join('; ')}`);
  write(
    `${L('pdf.allergies')}: ${doc.allergies.length ? doc.allergies.join(', ') : L('pdf.noAllergies')}`,
    { bold: doc.allergies.length > 0 },
  );

  // ---- Medicines (a prescription may order tests only) ----
  if (doc.items.length) section(`Rx  ${L('pdf.medicines')}`);
  doc.items.forEach((item, i) => {
    pdf.moveDown(0.25);
    write(`${i + 1}. ${item.name}`, { bold: true });
    const indent = left + 12;
    const inner = width - 12;
    if (item.generic) write(item.generic.toUpperCase(), { x: indent, width: inner });
    for (const step of item.steps) {
      const duration =
        step.durationValue !== null && step.durationUnit
          ? `${step.durationValue} ${L(`rx.unit.${step.durationUnit}`)}`
          : null;
      const line = [step.dose, step.frequency, duration].filter(Boolean).join(' · ');
      if (line) write(line, { x: indent, width: inner });
    }
    if (item.remarks) write(item.remarks, { x: indent, width: inner });
    if (item.instructions) write(item.instructions, { x: indent, width: inner, color: GREY });
    if (item.quantity)
      write(L('pdf.quantity', { quantity: item.quantity }), {
        x: indent,
        width: inner,
        color: GREY,
      });
  });

  if (doc.tests.length || doc.testsAdvised.trim()) {
    section(L('pdf.tests'));
    doc.tests.forEach((test, i) => {
      pdf.moveDown(0.15);
      write(`${i + 1}. ${test.label}`);
      if (test.notes) write(test.notes, { x: left + 12, width: width - 12, color: GREY });
    });
    if (doc.testsAdvised.trim()) {
      if (doc.tests.length) pdf.moveDown(0.25);
      write(doc.testsAdvised.trim());
    }
  }
  if (doc.advice.trim()) {
    section(L('pdf.advice'));
    write(doc.advice.trim());
  }
  if (doc.followUpDate) {
    pdf.moveDown(0.4);
    write(`${L('pdf.followUp')}: ${formatDate(doc.followUpDate)}`, { bold: true });
  }

  // ---- Signature block and QR, kept together ----
  kit.signatureBlock({
    doctorName: doc.doctor.name,
    signature: doc.signature,
    verificationUrl: doc.verificationUrl,
    notSigned: L('pdf.notSigned'),
    verify: (url) => L('pdf.verify', { url }),
    disclaimer: L('pdf.disclaimer'),
  });

  // ---- Every page: watermark and page numbers ----
  return kit.finish(
    doc.watermark ? (doc.watermark === 'void' ? 'VOID' : 'PREVIEW - NOT SIGNED') : null,
    doc.number,
  );
}

/**
 * The copy of a voided prescription: the signed file's own pages, each stamped VOID, after
 * a notice page with the date and reason. The signed file itself is kept unchanged.
 */
export async function stampVoid(
  signed: Buffer,
  notice: {
    language: Language;
    paperSize: 'a4' | 'a5';
    number: string;
    version: number;
    doctorName: string;
    date: string;
    reason: string;
  },
): Promise<Buffer> {
  const { PDFDocument: LibDocument, StandardFonts, degrees, grayscale } = await import('pdf-lib');
  const page = PAGE[notice.paperSize];
  const cover = new PDFDocument({ size: page.size, margin: page.margin });
  cover.registerFont('latin', FONTS.latin);
  cover.registerFont('latinBold', FONTS.latinBold);
  cover.registerFont('deva', FONTS.deva);
  cover.registerFont('devaBold', FONTS.devaBold);
  const chunks: Buffer[] = [];
  cover.on('data', (c: Buffer) => chunks.push(c));
  const coverDone = new Promise<Buffer>((resolve) =>
    cover.on('end', () => resolve(Buffer.concat(chunks))),
  );
  const lines: [string, boolean][] = [
    ['VOID', true],
    [
      `${t(notice.language, 'pdf.number')}: ${notice.number} (${t(notice.language, 'pdf.version', { version: notice.version })})`,
      false,
    ],
    [
      t(notice.language, 'pdf.voided', { date: formatDate(notice.date), reason: notice.reason }),
      false,
    ],
    [notice.doctorName, false],
  ];
  for (const [text, bold] of lines) {
    const runs = scriptRuns(text);
    cover.fontSize(bold ? 28 : page.body + 2);
    runs.forEach((run, i) => {
      cover.font(run.deva ? (bold ? 'devaBold' : 'deva') : bold ? 'latinBold' : 'latin');
      cover.text(run.text, { continued: i < runs.length - 1 });
    });
    cover.moveDown(0.6);
  }
  cover.end();

  const out = await LibDocument.create();
  const [coverPage] = await out.copyPages(await LibDocument.load(await coverDone), [0]);
  out.addPage(coverPage!);
  const original = await LibDocument.load(signed);
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  for (const copied of await out.copyPages(original, original.getPageIndices())) {
    const { width, height } = copied.getSize();
    const size = width / 4;
    copied.drawText('VOID', {
      x: width / 2 - font.widthOfTextAtSize('VOID', size) / 2 + size * 0.3,
      y: height / 2 - size * 0.6,
      size,
      font,
      color: grayscale(0.55),
      opacity: 0.5,
      rotate: degrees(35),
    });
    out.addPage(copied);
  }
  out.setTitle(`VOID ${notice.number}`);
  return Buffer.from(await out.save());
}
