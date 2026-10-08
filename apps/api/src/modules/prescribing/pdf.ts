import type { ConsultationMode, DoseStep, Gender, Language } from '@dhc/contracts';
import { t, type MessageKey } from '@dhc/i18n';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/** Bumped whenever the layout changes; stored with each signed prescription. */
export const PDF_TEMPLATE_VERSION = 'rx-1';

const require = createRequire(import.meta.url);
// Read once: every document registers the fonts again (pdfkit parses them per document).
const font = (pkg: string, file: string) => readFileSync(require.resolve(`${pkg}/files/${file}`));
// One family split into its Latin and Devanagari subsets: the same metrics keep mixed
// English and Hindi on one baseline.
const NOTO = '@fontsource/noto-sans-devanagari';
const FONTS = {
  latin: font(NOTO, 'noto-sans-devanagari-latin-400-normal.woff'),
  latinBold: font(NOTO, 'noto-sans-devanagari-latin-700-normal.woff'),
  deva: font(NOTO, 'noto-sans-devanagari-devanagari-400-normal.woff'),
  devaBold: font(NOTO, 'noto-sans-devanagari-devanagari-700-normal.woff'),
};

/** Everything printed on a prescription (PRD §6.6), already read and decrypted. */
export interface RxDocument {
  language: Language;
  paperSize: 'a4' | 'a5';
  /** `preview` before signing; `void` on the copy of a voided prescription. */
  watermark: 'preview' | 'void' | null;
  doctor: {
    name: string;
    qualifications: string | null;
    specialty: string | null;
    registrationNumber: string | null;
    council: string | null;
  };
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
  testsAdvised: string;
  advice: string;
  followUpDate: string | null;
  signature: { signedAt: Date; method: string; certificate: string } | null;
  verificationUrl: string | null;
}

// Devanagari (with the spaces and joiners inside a run) uses the Devanagari subset; the
// rest, including digits and punctuation, the Latin one. Neither has the other's glyphs.
// The classes hold whole Unicode blocks, combining vowel signs included, on purpose: each
// code point is classified on its own and runs are kept together.
const DEVA = String.raw`\u0900-\u097F\u1CD0-\u1CFF\uA8E0-\uA8FF\u200C\u200D`;
// eslint-disable-next-line no-misleading-character-class
const DEVANAGARI = new RegExp(`[${DEVA}]`);
// eslint-disable-next-line no-misleading-character-class
const RUN = new RegExp(`[${DEVA}]+(?:\\s+[${DEVA}]+)*|[^${DEVA}]+`, 'g');

export function scriptRuns(text: string): { text: string; deva: boolean }[] {
  return (text.match(RUN) ?? []).map((run) => ({ text: run, deva: DEVANAGARI.test(run) }));
}

const IST_OFFSET_MS = 330 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `8 Oct 2026`; digits and month names stay in English in both languages. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** `8 Oct 2026, 10:42 IST`. */
export function formatDateTime(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS).toISOString();
  return `${formatDate(ist.slice(0, 10))}, ${ist.slice(11, 16)} IST`;
}

const PAGE = { a4: { size: 'A4', margin: 40, body: 10 }, a5: { size: 'A5', margin: 28, body: 9 } };
const GREY = '#555555';

/**
 * Renders the prescription as a PDF: black and white, A4 or A5, English or Hindi labels.
 * Output is deterministic for the same input, so the stored hash can be checked again.
 */
export async function renderPrescriptionPdf(doc: RxDocument): Promise<Buffer> {
  const page = PAGE[doc.paperSize];
  const created = doc.signature?.signedAt ?? new Date(`${doc.date}T00:00:00Z`);
  const pdf = new PDFDocument({
    size: page.size,
    margin: page.margin,
    bufferPages: true,
    info: {
      Title: `${t(doc.language, 'pdf.title')} ${doc.number ?? ''}`.trim(),
      Author: doc.doctor.name,
      Creator: doc.organisationName,
      CreationDate: created,
      ModDate: created,
    },
  });
  // A fixed document ID keeps the bytes the same for the same input.
  (pdf as unknown as { _id?: Buffer })._id = Buffer.alloc(16);
  pdf.registerFont('latin', FONTS.latin);
  pdf.registerFont('latinBold', FONTS.latinBold);
  pdf.registerFont('deva', FONTS.deva);
  pdf.registerFont('devaBold', FONTS.devaBold);

  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    pdf.on('end', () => resolve(Buffer.concat(chunks))),
  );

  const L = (key: MessageKey, params?: Record<string, string | number>) =>
    t(doc.language, key, params);
  const left = page.margin;
  const width = pdf.page.width - page.margin * 2;

  /** Writes mixed English and Hindi text, wrapping as one paragraph. */
  const write = (
    text: string,
    opts: {
      size?: number;
      bold?: boolean;
      color?: string;
      x?: number;
      width?: number;
      align?: 'left' | 'right' | 'center';
    } = {},
  ) => {
    const runs = scriptRuns(text.length ? text : ' ');
    pdf.fontSize(opts.size ?? page.body).fillColor(opts.color ?? 'black');
    runs.forEach((run, i) => {
      pdf.font(run.deva ? (opts.bold ? 'devaBold' : 'deva') : opts.bold ? 'latinBold' : 'latin');
      const options = {
        continued: i < runs.length - 1,
        width: opts.width ?? width,
        align: opts.align ?? 'left',
      };
      if (i === 0) pdf.text(run.text, opts.x ?? pdf.x, pdf.y, options);
      else pdf.text(run.text, options);
    });
    pdf.x = left;
  };
  const rule = () => {
    pdf.moveDown(0.3);
    pdf
      .moveTo(left, pdf.y)
      .lineTo(left + width, pdf.y)
      .lineWidth(0.5)
      .strokeColor('black')
      .stroke();
    pdf.moveDown(0.4);
  };
  const section = (title: string) => {
    pdf.moveDown(0.4);
    write(title, { bold: true, size: page.body + 1 });
  };

  // ---- Header: doctor and clinic ----
  write(doc.doctor.name, { bold: true, size: page.body + 5 });
  const credentials = [doc.doctor.qualifications, doc.doctor.specialty].filter(Boolean).join(' · ');
  if (credentials) write(credentials);
  if (doc.doctor.registrationNumber) {
    write(
      L('pdf.regNo', { number: doc.doctor.registrationNumber, council: doc.doctor.council ?? '' }),
    );
  }
  const clinic = doc.clinic
    ? [doc.clinic.name, doc.clinic.address, doc.clinic.phone].filter(Boolean).join(' · ')
    : doc.organisationName;
  write(clinic, { color: GREY });
  rule();

  // ---- Patient and visit ----
  const age = doc.patient.age
    ? doc.patient.age.years > 0
      ? L('pdf.ageYears', { years: doc.patient.age.years })
      : L('pdf.ageMonths', { months: doc.patient.age.months })
    : '—';
  const gender = doc.patient.gender ? L(`gender.${doc.patient.gender}`) : '—';
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

  // ---- Medicines ----
  section(`Rx  ${L('pdf.medicines')}`);
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

  if (doc.testsAdvised.trim()) {
    section(L('pdf.tests'));
    write(doc.testsAdvised.trim());
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
  const qrSize = doc.paperSize === 'a4' ? 84 : 68;
  if (pdf.y + qrSize + 36 > pdf.page.height - page.margin) pdf.addPage();
  rule();
  const blockTop = pdf.y;
  const textWidth = width - qrSize - 12;
  if (doc.signature) {
    write(
      L('pdf.signedBy', { name: doc.doctor.name, date: formatDateTime(doc.signature.signedAt) }),
      {
        bold: true,
        width: textWidth,
      },
    );
    if (doc.signature.method === 'test_key') write(L('pdf.testSignature'), { width: textWidth });
    write(L('pdf.certificate', { certificate: doc.signature.certificate }), {
      width: textWidth,
      size: page.body - 2,
      color: GREY,
    });
  } else {
    write(L('pdf.notSigned'), { bold: true, width: textWidth });
  }
  if (doc.verificationUrl) {
    pdf.moveDown(0.3);
    write(L('pdf.verify', { url: doc.verificationUrl }), { width: textWidth, size: page.body - 1 });
    drawQr(pdf, doc.verificationUrl, left + width - qrSize, blockTop, qrSize);
  }
  pdf.y = Math.max(pdf.y, blockTop + qrSize) + 6;
  write(L('pdf.disclaimer'), { size: page.body - 2, color: GREY });

  // ---- Every page: watermark and page numbers ----
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    if (doc.watermark)
      drawWatermark(pdf, doc.watermark === 'void' ? 'VOID' : 'PREVIEW - NOT SIGNED');
    const label = [doc.number, `${i + 1}/${range.count}`].filter(Boolean).join(' · ');
    // Writing in the bottom margin must not start a new page.
    const bottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.x = left;
    pdf.y = pdf.page.height - page.margin + 8;
    write(label, { size: page.body - 2, color: GREY, align: 'right' });
    pdf.page.margins.bottom = bottom;
  }
  pdf.end();
  return done;
}

/** The QR as filled squares: sharp at any print size, and black on white. */
function drawQr(pdf: PDFKit.PDFDocument, text: string, x: number, y: number, size: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const quiet = 2;
  const cell = size / (count + quiet * 2);
  pdf.save();
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.modules.get(row, col)) {
        pdf.rect(x + (col + quiet) * cell, y + (row + quiet) * cell, cell, cell);
      }
    }
  }
  pdf.fill('black').restore();
}

function drawWatermark(pdf: PDFKit.PDFDocument, text: string) {
  const { width, height } = pdf.page;
  pdf.save();
  pdf.rotate(-35, { origin: [width / 2, height / 2] });
  pdf
    .font('latinBold')
    .fontSize(text.length > 6 ? width / 13 : width / 5)
    .fillColor('#bbbbbb')
    .fillOpacity(0.45);
  pdf.text(text, 0, height / 2 - width / 26, { width, align: 'center', lineBreak: false });
  pdf.restore();
  pdf.fillOpacity(1);
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
