import type { ErrorCode, PortalTestOrder, TestOrder, TestResultSummary } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import {
  appendPage,
  canUploadResult,
  checkPickedFile,
  fileCheckMessage,
  fileSize,
  findOrder,
  InFlight,
  isStale,
  pickedMediaType,
  replaceRow,
  resultFileName,
  shareTypeOf,
  uploadErrorMessage,
  withUploaded,
} from './patient-tests';

// Synthetic personas only (docs/qa/test-plan.md §3): Pooja Singh's account looks after Aarav.
const POOJA = { id: '00000000-0000-4000-8000-000000000001', name: 'Pooja Singh' };
const AARAV = { id: '00000000-0000-4000-8000-000000000002', name: 'Aarav' };

const result = (n: number, over: Partial<TestResultSummary> = {}): TestResultSummary => ({
  id: `00000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`,
  mediaType: 'application/pdf',
  sizeBytes: 120_000,
  uploadedAt: '2026-10-12T05:00:00.000Z',
  uploadedBy: 'patient',
  ...over,
});

const order = (id: string, over: Partial<PortalTestOrder> = {}): PortalTestOrder => ({
  id,
  patient: POOJA,
  doctorName: 'Dr Synthetic',
  visitDate: '2026-10-10',
  kind: 'mri',
  name: 'MRI',
  region: 'Knee',
  side: 'right',
  views: [],
  notes: null,
  status: 'ordered',
  orderedAt: '2026-10-10T06:00:00.000Z',
  reviewedAt: null,
  results: [],
  ...over,
});

const err = (status: number, fields: Record<string, string> = {}, code: ErrorCode = 'CONFLICT') =>
  new ApiError(status, code, 'Server message.', 'req-1', fields);

describe('upload eligibility', () => {
  it('allows uploads until the test is reviewed or holds 10 results', () => {
    expect(canUploadResult(order('a'))).toBe(true);
    expect(canUploadResult(order('a', { status: 'result_uploaded', results: [result(1)] }))).toBe(
      true,
    );
    expect(canUploadResult(order('a', { status: 'reviewed', results: [result(1)] }))).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => result(i + 1));
    expect(canUploadResult(order('a', { status: 'result_uploaded', results: nine }))).toBe(true);
    const ten = [...nine, result(10)];
    expect(canUploadResult(order('a', { status: 'result_uploaded', results: ten }))).toBe(false);
  });
});

describe('rows', () => {
  it('keeps the list fields and takes the uploaded status and results', () => {
    const row = order('a', { patient: AARAV, notes: 'Fasting' });
    const updated: TestOrder = {
      id: 'a',
      catalogueItemId: null,
      kind: 'mri',
      name: 'MRI',
      region: 'Knee',
      side: 'right',
      views: [],
      notes: null,
      status: 'result_uploaded',
      orderedAt: '2026-10-10T06:00:00.000Z',
      resultUploadedAt: '2026-10-12T05:00:00.000Z',
      reviewedAt: null,
      results: [result(1)],
    };
    const next = withUploaded(row, updated);
    expect(next.patient).toEqual(AARAV);
    expect(next.doctorName).toBe('Dr Synthetic');
    expect(next.visitDate).toBe('2026-10-10');
    expect(next.notes).toBe('Fasting');
    expect(next.status).toBe('result_uploaded');
    expect(next.results).toHaveLength(1);
  });

  it('replaces one row and appends a page without repeats', () => {
    const rows = [order('a'), order('b')];
    const b = order('b', { status: 'reviewed' });
    expect(replaceRow(rows, b).map((o) => o.status)).toEqual(['ordered', 'reviewed']);
    expect(appendPage(rows, [order('b'), order('c')]).map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('finds an order again across pages, or reports it gone or unknown', async () => {
    const pages: Record<string, { data: PortalTestOrder[]; nextCursor: string | null }> = {
      first: { data: [order('a')], nextCursor: 'p2' },
      p2: { data: [order('b', { status: 'reviewed' })], nextCursor: null },
    };
    const asked: (string | undefined)[] = [];
    const fetchPage = async (cursor?: string) => {
      asked.push(cursor);
      return pages[cursor ?? 'first']!;
    };
    expect(await findOrder(fetchPage, 'b')).toMatchObject({ id: 'b', status: 'reviewed' });
    expect(asked).toEqual([undefined, 'p2']);
    expect(await findOrder(fetchPage, 'z')).toBe('gone');
    // Never more pages than allowed, and running out says nothing about the order.
    let fetched = 0;
    const endless = async () => (fetched++, { data: [order('a')], nextCursor: 'more' });
    expect(await findOrder(endless, 'z', 3)).toBe('unknown');
    expect(fetched).toBe(3);
  });
});

describe('picked files', () => {
  it('reads the media type from the picker, or from the file name', () => {
    expect(pickedMediaType({ name: 'report.pdf', mimeType: 'application/pdf' })).toBe(
      'application/pdf',
    );
    expect(pickedMediaType({ name: 'IMG_0042.jpg', mimeType: 'image/jpg' })).toBe('image/jpeg');
    expect(pickedMediaType({ name: 'IMG_0042.HEIC' })).toBe('image/heic');
    expect(pickedMediaType({ name: 'scan.png', mimeType: 'application/octet-stream' })).toBe(
      'image/png',
    );
    expect(pickedMediaType({ name: 'notes.docx', mimeType: 'application/msword' })).toBe(
      'application/msword',
    );
  });

  it('accepts PDFs and photos within 25 MB, refuses the rest before uploading', () => {
    const mb = 1024 * 1024;
    expect(checkPickedFile({ name: 'mri.pdf', mimeType: 'application/pdf', size: mb })).toEqual({
      ok: true,
      mediaType: 'application/pdf',
    });
    expect(checkPickedFile({ name: 'x.heif', mimeType: 'image/heif', size: 25 * mb }).ok).toBe(
      true,
    );
    expect(checkPickedFile({ name: 'x.jpg', mimeType: 'image/jpeg', size: 25 * mb + 1 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(checkPickedFile({ name: 'x.gif', mimeType: 'image/gif', size: mb })).toEqual({
      ok: false,
      reason: 'type_not_allowed',
    });
    expect(checkPickedFile({ name: 'x.pdf', mimeType: 'application/pdf', size: 0 })).toEqual({
      ok: false,
      reason: 'empty',
    });
    // A size the picker could not tell is left to the server.
    expect(checkPickedFile({ name: 'x.pdf', mimeType: 'application/pdf' }).ok).toBe(true);
  });

  it('words the app’s own refusals', () => {
    expect(fileCheckMessage('type_not_allowed').key).toBe('patient.tests.file.type');
    expect(fileCheckMessage('too_large')).toEqual({
      key: 'patient.tests.file.tooLarge',
      params: { mb: 25 },
    });
    expect(fileCheckMessage('empty').key).toBe('orders.file.empty');
  });
});

describe('upload errors', () => {
  it('maps every refusal the API documents to the app’s wording', () => {
    const key = (e: unknown) => uploadErrorMessage(e)?.key;
    expect(key(err(409, { status: 'reviewed' }))).toBe('orders.alreadyReviewed');
    expect(uploadErrorMessage(err(409, { file: 'too_many' }))).toEqual({
      key: 'orders.file.too_many',
      params: { max: 10 },
    });
    expect(key(err(413, {}, 'VALIDATION_FAILED'))).toBe('patient.tests.file.tooLarge');
    expect(key(err(415, { file: 'type_not_allowed' }))).toBe('patient.tests.file.type');
    expect(key(err(400, { file: 'type_not_allowed' }))).toBe('patient.tests.file.clinicType');
    expect(key(err(400, { file: 'too_large' }))).toBe('patient.tests.file.clinicTooLarge');
    expect(key(err(400, { file: 'type_mismatch' }))).toBe('orders.file.type_mismatch');
    expect(key(err(400, { file: 'empty' }))).toBe('orders.file.empty');
    expect(key(err(429, {}, 'RATE_LIMITED'))).toBe('patient.tests.rateLimited');
  });

  it('leaves anything else to the API’s own message or the network wording', () => {
    expect(uploadErrorMessage(err(404, {}, 'NOT_FOUND'))).toBeNull();
    expect(uploadErrorMessage(new TypeError('Network request failed'))).toBeNull();
  });

  it('refetches the row after a 409 only', () => {
    expect(isStale(err(409, { status: 'reviewed' }))).toBe(true);
    expect(isStale(err(409, { file: 'too_many' }))).toBe(true);
    expect(isStale(err(400, { file: 'empty' }))).toBe(false);
    expect(isStale(new TypeError('offline'))).toBe(false);
  });
});

describe('results on screen', () => {
  it('names the type and size', () => {
    expect(shareTypeOf('application/pdf').label).toBe('PDF');
    // Not listed: the screen translates "File" itself.
    expect(shareTypeOf('application/zip')).toEqual({
      label: null,
      extension: 'bin',
      uti: 'public.data',
    });
    expect(shareTypeOf('image/heic')).toEqual({
      label: 'HEIC',
      extension: 'heic',
      uti: 'public.heic',
    });
    expect(fileSize(300)).toBe('1 KB');
    expect(fileSize(340 * 1024)).toBe('340 KB');
    expect(fileSize(1.25 * 1024 * 1024)).toBe('1.3 MB');
    expect(fileSize(24.6 * 1024 * 1024)).toBe('25 MB');
  });

  it('shares a result under a name that does not say what the test is', () => {
    expect(resultFileName(2, 'application/pdf')).toBe('test-result-2.pdf');
    expect(resultFileName(1, 'image/jpeg')).toBe('test-result-1.jpg');
    expect(resultFileName(0, 'image/heif')).toBe('test-result-1.heif');
  });
});

describe('InFlight', () => {
  it('lets one upload per test start until it ends', () => {
    const inFlight = new InFlight();
    expect(inFlight.start('a')).toBe(true);
    // A second tap in the same frame.
    expect(inFlight.start('a')).toBe(false);
    // Another test is not held up.
    expect(inFlight.start('b')).toBe(true);
    inFlight.end('a');
    expect(inFlight.start('a')).toBe(true);
  });
});
