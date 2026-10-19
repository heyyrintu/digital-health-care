import { ApiError } from '@dhc/api-client';
import { t as translate, type MessageKey } from '@dhc/i18n';
import { describe, expect, it } from 'vitest';
import {
  checkDocumentFile,
  documentAccept,
  documentErrorText,
  documentTypeNames,
} from './documents';

const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate('en', key, params);
const clinic = { maxUploadMb: 5, uploadTypes: ['pdf' as const, 'png' as const] };
const refused = (
  fields: Record<string, string>,
  code: ConstructorParameters<typeof ApiError>[1] = 'VALIDATION_FAILED',
  status = 400,
) => new ApiError(status, code, 'Server message.', 'req_1', fields);

describe('document files on the web', () => {
  it('offers the clinic’s document types, WebP always and never HEIC', () => {
    expect(documentAccept(clinic)).toBe('application/pdf,image/png,image/webp');
    expect(documentAccept(null)).toBe('application/pdf,image/jpeg,image/png,image/webp');
    expect(documentTypeNames(clinic)).toBe('PDF, PNG, WebP');
  });

  it('checks a chosen file before it is sent, reading the type from the name when missing', () => {
    expect(
      checkDocumentFile({ name: 'sheet.pdf', type: 'application/pdf', size: 10 }, clinic, t),
    ).toEqual({
      mediaType: 'application/pdf',
    });
    expect(checkDocumentFile({ name: 'chart.WEBP', type: '', size: 10 }, clinic, t)).toEqual({
      mediaType: 'image/webp',
    });
    expect(
      checkDocumentFile({ name: 'photo.jpg', type: 'image/jpeg', size: 10 }, clinic, t),
    ).toEqual({
      text: 'Choose a PDF or an image this clinic accepts: PDF, PNG, WebP.',
    });
    expect(
      checkDocumentFile({ name: 'logo.svg', type: 'image/svg+xml', size: 10 }, clinic, t),
    ).toHaveProperty('text');
    expect(
      checkDocumentFile(
        { name: 'big.pdf', type: 'application/pdf', size: 5 * 1024 * 1024 + 1 },
        clinic,
        t,
      ),
    ).toEqual({ text: 'The file is larger than this clinic’s 5 MB limit.' });
    expect(
      checkDocumentFile({ name: 'empty.pdf', type: 'application/pdf', size: 0 }, clinic, t),
    ).toEqual({
      text: 'The file is empty.',
    });
  });

  it('words the server’s refusals', () => {
    expect(documentErrorText(refused({ file: 'too_many_pages' }), t, clinic)).toMatch(
      /more than 500 pages/,
    );
    expect(documentErrorText(refused({ file: 'encrypted' }), t, clinic)).toMatch(
      /password-protected/,
    );
    expect(documentErrorText(refused({ file: 'too_large' }), t, clinic)).toBe(
      'The file is larger than this clinic’s 5 MB limit.',
    );
    // Without the clinic's limits, the server's message names them.
    expect(documentErrorText(refused({ file: 'too_large' }), t, null)).toBe('Server message.');
    expect(documentErrorText(refused({}, 'CHART_RESTRICTED', 403), t, clinic)).toMatch(/chart/);
    expect(documentErrorText(refused({ fileId: 'used' }, 'CONFLICT', 409), t, clinic)).toBe(
      'This upload was already used. Choose the file again.',
    );
    expect(documentErrorText(refused({ fileId: 'expired' }), t, clinic)).toMatch(/expired/);
    expect(documentErrorText(refused({ fileId: 'invalid' }), t, clinic)).toMatch(/not found/);
    expect(documentErrorText(refused({ library: 'full' }, 'CONFLICT', 409), t, clinic)).toBe(
      'The library holds up to 500 sheets, archived ones included.',
    );
    expect(documentErrorText(refused({ status: 'archived' }, 'CONFLICT', 409), t, clinic)).toBe(
      'This sheet is archived. Restore it first.',
    );
    expect(
      documentErrorText(refused({ appointmentId: 'not_seen' }, 'BUSINESS_RULE', 422), t, clinic),
    ).toMatch(/checked in/);
    // In Hindi too.
    const hi = (key: MessageKey, params?: Record<string, string | number>) =>
      translate('hi', key, params);
    expect(documentErrorText(refused({ fileId: 'used' }, 'CONFLICT', 409), hi, clinic)).toBe(
      translate('hi', 'documents.error.fileUsed'),
    );
    expect(documentErrorText(refused({ other: 'x' }, 'CONFLICT', 409), t, clinic)).toBe(
      'Server message.',
    );
    expect(documentErrorText(new TypeError('fetch failed'), t, clinic)).toBe(t('error.network'));
  });
});
