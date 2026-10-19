import { pdfText } from '@dhc/pdf-text';
import { readFileSync } from 'node:fs';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  type PDFPage,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderPrescriptionPdf, type RxDocument } from '../prescribing/pdf';
import { renderReferralLetterPdf, type LetterDocument } from '../referrals/letter-pdf';
import { samplePdf } from './document-samples';
import * as attack from './pdf-attack-samples';
import { PDF_REBUILD_LIMITS, rebuildPdf } from './pdf-rebuild';
import { MAX_DECODED, PAGE_KEYS, type RewriteOutcome } from './pdf-rebuild-worker';
import { checkOwnPdf } from './pdf-scan';

/** A blocked name, an object or cross-reference stream, or the synthetic script's text. */
const ACTIVE =
  /\/(JS|JavaScript|Launch|EmbeddedFiles?|RichMedia|XFA|GoToR|GoToE|SubmitForm|ImportData|AA|OpenAction|ObjStm|XRef|Annots|AcroForm|Names|Outlines|StructTreeRoot|OCProperties)\b|app\.alert/;

/** Rebuilds a file, timed. */
async function timed(file: Buffer) {
  const started = performance.now();
  const outcome = await rebuildPdf(file);
  return { outcome, ms: performance.now() - started };
}

/**
 * Rebuilds a hostile file within the time limit (plus a margin for starting the worker):
 * refused as `not_a_document`, or out and clean. Which one can depend on the machine's speed.
 */
async function cleanOrRefused(file: Buffer) {
  const { outcome, ms } = await timed(file);
  expect(ms).toBeLessThan(PDF_REBUILD_LIMITS.timeoutMs + 1500);
  if (outcome.ok) await clean(outcome, outcome.pages);
  else expect(outcome.reason).toBe('not_a_document');
  return { outcome, ms };
}

/** Rebuilds a file that must come out, and checks the output is clean. */
const rebuilt = async (file: Buffer, pages = 1) => clean(await rebuildPdf(file), pages);

/** Checks a rebuild came out with `pages` pages and nothing else of the upload's. */
async function clean(outcome: RewriteOutcome, pages: number): Promise<Buffer> {
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason} (${outcome.detail})`);
  const out = Buffer.from(outcome.data);
  expect(outcome.pages).toBe(pages);
  expect(checkOwnPdf(out)).toBeNull();
  expect(out.toString('latin1')).not.toMatch(ACTIVE);
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  expect(doc.getPageCount()).toBe(pages);
  // A fresh catalog and information dictionary: nothing of the upload's.
  expect(doc.catalog.keys().map((k) => k.decodeText())).toEqual(['Type', 'Pages']);
  expect(doc.getProducer()).toBe('Digital Healthcare');
  expect(doc.getTitle()).toBeUndefined();
  expect(doc.getCreationDate()).toBeUndefined();
  for (const page of doc.getPages()) {
    for (const key of page.node.keys()) expect(PAGE_KEYS.has(key.decodeText())).toBe(true);
  }
  return out;
}

/** Each page's content, decoded (the rebuild may compress a stream that had no filter). */
function contents(doc: PDFDocument): string[] {
  const decode = (page: PDFPage) => {
    const value = page.node.Contents();
    const refs = value instanceof PDFArray ? value.asArray() : value ? [value] : [];
    return refs
      .map((ref) => {
        const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (!(stream instanceof PDFRawStream)) return '';
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      })
      .join('\n');
  };
  return doc.getPages().map(decode);
}

/** A rebuilt file draws the same pages: same count, same decoded content streams. */
async function samePages(file: Buffer) {
  const source = await PDFDocument.load(file, { updateMetadata: false });
  const out = await rebuilt(file, source.getPageCount());
  expect(contents(await PDFDocument.load(out))).toEqual(contents(source));
  return out;
}

describe('rebuildPdf: what is kept and what is dropped', { timeout: 60_000 }, () => {
  it('keeps the pages of a plain PDF and writes the same bytes for the same upload', async () => {
    const sheet = samplePdf({ text: 'Synthetic knee exercises' });
    const out = await samePages(sheet);
    expect(out.equals(sheet)).toBe(false);
    expect((await rebuilt(sheet)).equals(out)).toBe(true);
  });

  it('drops document and page actions, scripts, attachments, forms, links, bookmarks and metadata', async () => {
    const out = await rebuilt(attack.everyActiveContent());
    // The page still draws its text, with its font.
    const doc = await PDFDocument.load(out);
    expect(contents(doc)[0]).toContain('Synthetic exercise sheet');
    expect(out.toString('latin1')).toContain('/BaseFont /Helvetica');
    expect(out.toString('latin1')).not.toMatch(/\/Widget|\/Link|\/Filespec|\/Info.*Author/);
  });

  it('neuters scripts the pages reach through their resources, escaped names too', async () => {
    const out = (await rebuilt(attack.scriptsInResources())).toString('latin1');
    // The form XObject the page draws is kept; its additional actions are not.
    expect(out).toContain('/Subtype /Form');
    expect(out).not.toMatch(/J#61vaScript|J#53|\/Next \[\/Launch/);
  });

  it('comes out clean from the shapes that hid a script from the scanner', async () => {
    await rebuilt(attack.scriptInObjectStream('table'));
    await rebuilt(attack.scriptInObjectStream('stream'));
    for (const file of attack.scriptsInStreamData()) await rebuilt(file);
    await rebuilt(attack.duplicateObjectStream());
    // The page whose content stream hid an object keeps that stream, compressed.
    const hidden = attack.scriptsInStreamData()[2]!;
    const out = await rebuilt(hidden);
    expect(out.toString('latin1')).toContain('/Filter /FlateDecode');
    expect(contents(await PDFDocument.load(out))[0]).toContain('app.alert');
  });

  it('writes a classic cross-reference with no object streams, whatever the upload used', async () => {
    const lib = await PDFDocument.create();
    lib.addPage().drawText('Synthetic diet chart', {
      font: await lib.embedFont(StandardFonts.Helvetica),
    });
    for (const useObjectStreams of [true, false]) {
      const out = await samePages(Buffer.from(await lib.save({ useObjectStreams })));
      expect(out.toString('latin1')).toMatch(/\nxref\n0 \d+\n/);
    }
    await rebuilt(samplePdf({ xref: 'stream-up' }));
  });
});

describe('rebuildPdf: refusals', { timeout: 60_000 }, () => {
  it('refuses encrypted PDFs as such', async () => {
    expect(await rebuildPdf(attack.encryptedPdf())).toMatchObject({
      ok: false,
      reason: 'encrypted',
    });
  });

  it('refuses more than 500 pages, also when the page tree only claims them', async () => {
    const lib = await PDFDocument.create();
    for (let i = 0; i < 501; i++) lib.addPage([200, 200]);
    const many = Buffer.from(await lib.save());
    expect(await rebuildPdf(many)).toMatchObject({ ok: false, reason: 'too_many_pages' });
    lib.removePage(500);
    await rebuilt(Buffer.from(await lib.save()), 500);
    expect(await rebuildPdf(attack.lyingPageCount())).toMatchObject({
      ok: false,
      reason: 'too_many_pages',
    });
  });

  it('refuses what is not a PDF it can read: no pages, a cyclic page tree, garbage', async () => {
    for (const file of [
      attack.cyclicPageTree(),
      Buffer.from('%PDF-1.7\n%%EOF\n'),
      Buffer.from('%PDF-1.7\nnot a pdf at all\n%%EOF\n'),
    ]) {
      expect(await rebuildPdf(file)).toMatchObject({ ok: false, reason: 'not_a_document' });
    }
  });
});

describe('rebuildPdf: bounded work on hostile input', { timeout: 120_000 }, () => {
  it('stops a cross-reference stream claiming two billion entries', async () => {
    await cleanOrRefused(attack.hugeXrefSize());
    // A classic table claiming as many is read only as far as its entries go.
    await rebuilt(attack.hugeXrefTable());
  });

  it('stops an object stream header bomb, and caps how far any stream inflates', async () => {
    await cleanOrRefused(attack.objectStreamHeaderBomb());
    // 128 MB of object stream from a few hundred kilobytes: never inflated past the cap, and
    // the page still comes out.
    expect(128 * 1024 * 1024).toBeGreaterThan(MAX_DECODED);
    const bomb = await cleanOrRefused(attack.objectStreamZipBomb(128));
    expect(bomb.outcome.ok).toBe(true);
    expect(bomb.ms).toBeLessThan(3000);
  });

  it('refuses deep nesting, whether pdf-lib can parse it or not', async () => {
    await rebuilt(attack.deepNesting(50));
    for (const depth of [1000, 100_000]) {
      const { outcome } = await cleanOrRefused(attack.deepNesting(depth));
      expect(outcome.ok, String(depth)).toBe(false);
    }
  });

  it('copes with long names within the limits', async () => {
    await rebuilt(attack.longName(1000));
    // 5 million escaped characters (20 MB), kept short of the upload limit.
    await cleanOrRefused(attack.longName(5_000_000));
  });

  it('ends a worker that runs out of memory, and the API carries on', async () => {
    const small = {
      ...PDF_REBUILD_LIMITS,
      maxOldGenerationSizeMb: 16,
      maxYoungGenerationSizeMb: 4,
    };
    const outcome = await rebuildPdf(attack.hugeXrefSize(), small);
    expect(outcome).toMatchObject({ ok: false, reason: 'not_a_document' });
    if (!outcome.ok) expect(outcome.detail).toMatch(/worker|memory|timeout/i);
    await rebuilt(samplePdf());
  });
});

describe('rebuildPdf: real PDFs keep their pages', { timeout: 120_000 }, () => {
  const letter = (language: 'en' | 'hi'): LetterDocument => ({
    language,
    paperSize: 'a4',
    watermark: null,
    doctor: {
      name: 'Dr. Synthetic Doctor',
      qualifications: 'MBBS',
      specialty: 'Orthopaedics',
      registrationNumber: 'TEST-12345',
      council: 'Test Medical Council',
    },
    organisationName: 'Synthetic Clinic',
    clinic: { name: 'Main clinic', address: '1 Test Road', phone: null },
    date: '2026-10-08',
    visitDate: '2026-10-06',
    patient: { name: 'Asha Verma', age: { years: 41, months: 9 }, gender: 'female', uhid: 'SY-1' },
    recipient: { name: 'Dr Meera Iyer', specialty: null, hospital: null, phone: null },
    urgency: 'soon',
    reason: 'Synthetic reason.',
    notes: null,
    diagnoses: [],
    signature: {
      signedAt: new Date('2026-10-08T05:12:00Z'),
      method: 'test_key',
      certificate: 'TEST KEY ed25519 0000',
    },
    verificationUrl: 'https://app.test/verify/referral/ABCDEFGHJKMNPQRSTVWXYZ01',
  });
  const prescription = (language: 'en' | 'hi'): RxDocument => ({
    language,
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
      uhid: 'SY-1',
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
    tests: [],
    testsAdvised: '',
    advice: '',
    followUpDate: null,
    signature: {
      signedAt: new Date('2026-10-08T05:12:00Z'),
      method: 'test_key',
      certificate: 'TEST KEY',
    },
    verificationUrl: 'https://app.test/verify/ABC',
  });

  it('keeps the text of our own prescriptions and referral letters, in English and Hindi', async () => {
    for (const language of ['en', 'hi'] as const) {
      for (const pdf of [
        await renderReferralLetterPdf(letter(language)),
        await renderPrescriptionPdf(prescription(language)),
      ]) {
        const out = await samePages(pdf);
        expect(pdfText(out)).toBe(pdfText(pdf));
      }
    }
  });

  it('keeps every page of the product documents (Chromium PDFs with links and tags)', async () => {
    for (const name of ['PRD-v3.0-Final.pdf', 'Build-Plan-Web-iOS-Android.pdf']) {
      const file = readFileSync(new URL(`../../../../../docs/product/${name}`, import.meta.url));
      const out = await samePages(file);
      // Links and the structure tree are gone; the pages are not.
      expect(out.length).toBeLessThan(file.length);
    }
  });
});
