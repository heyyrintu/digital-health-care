import { describe, expect, it } from 'vitest';
import {
  CreateLibraryDocumentBody,
  DOCUMENT_LIMITS,
  DocumentTitle,
  LibraryDocumentQuery,
  PatientDocumentListQuery,
  ShareDocumentBody,
  UpdateLibraryDocumentBody,
  buildOpenApiDocument,
  checkDocumentUpload,
  documentFileName,
  documentTypesFor,
} from './index';

const fileId = '7d6b1d1e-9a5f-4a51-8b8f-2f1c3c1d9e01';
const sheetId = '7d6b1d1e-9a5f-4a51-8b8f-2f1c3c1d9e02';

describe('document types and limits', () => {
  const mb = 1024 * 1024;
  const clinic = { maxUploadMb: 5, uploadTypes: ['pdf', 'jpeg', 'png'] as const };

  it('follows the clinic’s PDF, JPEG and PNG switches, always takes WebP and never HEIC', () => {
    expect(documentTypesFor({ uploadTypes: ['pdf', 'jpeg', 'png'] })).toEqual([
      'pdf',
      'jpeg',
      'png',
      'webp',
    ]);
    expect(documentTypesFor({ uploadTypes: ['pdf', 'heic'] })).toEqual(['pdf', 'webp']);
  });

  it('checks the type and the clinic’s largest file', () => {
    const settings = { ...clinic, uploadTypes: [...clinic.uploadTypes] };
    expect(checkDocumentUpload(settings, { mediaType: 'application/pdf', sizeBytes: 5 * mb })).toBe(
      'ok',
    );
    expect(checkDocumentUpload(settings, { mediaType: 'IMAGE/WEBP', sizeBytes: 1 })).toBe('ok');
    expect(
      checkDocumentUpload(settings, { mediaType: 'application/pdf', sizeBytes: 5 * mb + 1 }),
    ).toBe('too_large');
    for (const mediaType of ['image/svg+xml', 'text/html', 'image/heic', 'image/gif', '']) {
      expect(checkDocumentUpload(settings, { mediaType, sizeBytes: 1 }), mediaType).toBe(
        'type_not_allowed',
      );
    }
    // A clinic that switched PNG off for uploads takes no PNG documents either.
    expect(
      checkDocumentUpload(
        { maxUploadMb: 5, uploadTypes: ['pdf'] },
        { mediaType: 'image/png', sizeBytes: 1 },
      ),
    ).toBe('type_not_allowed');
  });

  it('saves a document under a name that says nothing about it', () => {
    expect(documentFileName(2, 'application/pdf')).toBe('document-2.pdf');
    expect(documentFileName(1, 'image/jpeg')).toBe('document-1.jpg');
    expect(documentFileName(0, 'image/webp')).toBe('document-1.webp');
    expect(documentFileName(3, 'application/zip')).toBe('document-3.bin');
  });
});

describe('DocumentTitle', () => {
  it('makes a title one tidy line', () => {
    expect(DocumentTitle.parse('  Knee   exercises\n(week 1) ')).toBe('Knee exercises (week 1)');
    expect(DocumentTitle.parse('घुटने के व्यायाम')).toBe('घुटने के व्यायाम');
  });

  it('refuses blank, long, control, bidirectional and invisible text', () => {
    for (const bad of [
      '   ',
      'x'.repeat(DOCUMENT_LIMITS.title + 1),
      'Knee\u0000sheet',
      'Knee\u202esheet',
      'Knee\u200bsheet',
      'Knee\ufeffsheet',
    ]) {
      expect(DocumentTitle.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('library bodies', () => {
  it('takes a sheet with an optional category', () => {
    expect(
      CreateLibraryDocumentBody.parse({
        fileId,
        title: 'Diet chart',
        category: '',
        language: 'hi',
      }),
    ).toEqual({ fileId, title: 'Diet chart', category: null, language: 'hi' });
    expect(
      CreateLibraryDocumentBody.safeParse({ fileId, title: 'Diet chart', language: 'ta' }).success,
    ).toBe(false);
  });

  it('needs at least one change, and nothing it does not know', () => {
    expect(UpdateLibraryDocumentBody.safeParse({}).success).toBe(false);
    expect(UpdateLibraryDocumentBody.safeParse({ archived: true }).success).toBe(true);
    expect(UpdateLibraryDocumentBody.parse({ category: '' })).toEqual({ category: null });
    expect(
      UpdateLibraryDocumentBody.safeParse({ title: 'x', organisationId: fileId }).success,
    ).toBe(false);
  });

  it('lists active sheets unless asked for the archive', () => {
    expect(LibraryDocumentQuery.parse({})).toEqual({ status: 'active' });
    expect(LibraryDocumentQuery.parse({ q: ' knee ', status: 'archived' })).toEqual({
      q: 'knee',
      status: 'archived',
    });
  });
});

describe('ShareDocumentBody', () => {
  it('shares a library sheet with a note, blank notes being none', () => {
    expect(
      ShareDocumentBody.parse({ source: 'library', libraryDocumentId: sheetId, note: '  ' }),
    ).toEqual({ source: 'library', libraryDocumentId: sheetId, appointmentId: null, note: null });
  });

  it('shares a one-off upload with its own title, keeping line breaks in the note', () => {
    expect(
      ShareDocumentBody.parse({
        source: 'upload',
        fileId,
        title: ' MRI report ',
        note: 'Bring this\nto the next visit.',
      }),
    ).toEqual({
      source: 'upload',
      fileId,
      title: 'MRI report',
      category: null,
      language: null,
      appointmentId: null,
      note: 'Bring this\nto the next visit.',
    });
  });

  it('refuses what the database would refuse', () => {
    for (const bad of [
      { source: 'library' },
      { source: 'upload', fileId },
      { source: 'upload', fileId, title: '' },
      { source: 'library', libraryDocumentId: sheetId, note: 'x'.repeat(501) },
      { source: 'library', libraryDocumentId: sheetId, note: 'bell\u0007' },
      { source: 'library', libraryDocumentId: sheetId, note: 'hidden\u2066text' },
      { source: 'link', libraryDocumentId: sheetId },
    ]) {
      expect(ShareDocumentBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('filters a patient’s documents by visit', () => {
    expect(PatientDocumentListQuery.parse({ appointmentId: fileId })).toMatchObject({
      appointmentId: fileId,
      limit: 50,
    });
  });
});

describe('OpenAPI', () => {
  it('lists the document endpoints with file bodies of the four document types', () => {
    const doc = buildOpenApiDocument({ version: 'test' });
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/document-files',
        '/library-documents',
        '/library-documents/{id}',
        '/library-documents/{id}/file',
        '/patients/{id}/documents',
        '/patient-documents/{id}/withdraw',
        '/patient-documents/{id}/file',
        '/portal/documents',
        '/portal/documents/{id}/file',
      ]),
    );
    const upload = (doc.paths['/document-files'] as Record<string, unknown>).post as {
      requestBody: { content: Record<string, unknown> };
    };
    expect(Object.keys(upload.requestBody.content).sort()).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});
