import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { SAMPLE_SVG, sampleJpeg, samplePng, sampleWebp } from '../branding/logo-samples';
import { acceptDocument, inspectDocument, precheckPdf } from './content';
import { samplePdf } from './document-samples';
import { everyActiveContent, encryptedPdf } from './pdf-attack-samples';
import { PDF_REBUILD_LIMITS, PdfRebuilder } from './pdf-rebuild';

const pdf = new PdfRebuilder();

const clinic = { maxUploadMb: 1, uploadTypes: ['pdf' as const, 'jpeg' as const, 'png' as const] };

const reason = async (mediaType: string, data: Buffer, settings = clinic) => {
  try {
    const { type, extension } = await acceptDocument(settings, { mediaType, data }, { pdf });
    return { type, extension };
  } catch (e) {
    if (e instanceof AppError) return e.fields?.file;
    throw e;
  }
};

describe('precheckPdf', () => {
  it('passes a plain PDF, also with whitespace after the end marker', () => {
    expect(precheckPdf(samplePdf())).toBe('ok');
    expect(precheckPdf(Buffer.concat([samplePdf(), Buffer.from('\r\n\n')]))).toBe('ok');
  });

  it('refuses a header that is not at the start, and markup in the head', () => {
    expect(precheckPdf(Buffer.concat([Buffer.from('<html>'), samplePdf()]))).toBe('type_mismatch');
    expect(precheckPdf(Buffer.from('GIF89a'))).toBe('type_mismatch');
    const withHtml = Buffer.from(
      samplePdf().toString('latin1').replace('%PDF-1.7\n', '%PDF-1.7\n%<html><script>x</script>\n'),
      'latin1',
    );
    expect(precheckPdf(withHtml)).toBe('not_a_document');
  });

  it('refuses anything appended after the end marker (a polyglot) and a missing marker', () => {
    expect(precheckPdf(Buffer.concat([samplePdf(), Buffer.from('PK\x03\x04synthetic zip')]))).toBe(
      'not_a_document',
    );
    expect(precheckPdf(Buffer.concat([samplePdf(), Buffer.from('<html></html>')]))).toBe(
      'not_a_document',
    );
    expect(precheckPdf(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'))).toBe('not_a_document');
  });
});

describe('inspectDocument', () => {
  it('accepts still PNG, JPEG and WebP images of the type they were sent as', () => {
    expect(inspectDocument('png', samplePng())).toBe('png');
    expect(inspectDocument('jpeg', sampleJpeg())).toBe('jpeg');
    expect(inspectDocument('webp', sampleWebp())).toBe('webp');
    expect(inspectDocument('png', sampleJpeg())).toBe('type_mismatch');
    expect(inspectDocument('pdf', samplePng())).toBe('type_mismatch');
  });

  it('refuses SVG and HTML sent as an image, polyglots and animation', () => {
    expect(inspectDocument('png', SAMPLE_SVG)).toBe('not_a_document');
    expect(inspectDocument('png', Buffer.from('<!doctype html><p>synthetic</p>'))).toBe(
      'not_a_document',
    );
    expect(inspectDocument('png', Buffer.concat([samplePng(), samplePdf()]))).toBe(
      'not_a_document',
    );
    expect(inspectDocument('png', samplePng({ extra: [['acTL', Buffer.alloc(8)]] }))).toBe(
      'animated',
    );
  });

  it('allows a large photo but not one that decodes to a huge image', () => {
    expect(inspectDocument('jpeg', sampleJpeg({ width: 8000, height: 6000 }))).toBe('jpeg');
    expect(inspectDocument('jpeg', sampleJpeg({ width: 10_001, height: 10 }))).toBe(
      'too_many_pixels',
    );
    expect(inspectDocument('jpeg', sampleJpeg({ width: 9000, height: 9000 }))).toBe(
      'too_many_pixels',
    );
  });
});

describe('acceptDocument', { timeout: 30_000 }, () => {
  it('returns the type and the extension to store it under', async () => {
    expect(await reason('application/pdf', samplePdf())).toEqual({ type: 'pdf', extension: 'pdf' });
    expect(await reason('image/webp', sampleWebp())).toEqual({ type: 'webp', extension: 'webp' });
    expect(await reason('image/jpeg', sampleJpeg())).toEqual({ type: 'jpeg', extension: 'jpg' });
  });

  it('stores an image as sent and a PDF as rebuilt', async () => {
    const png = samplePng();
    expect(
      (await acceptDocument(clinic, { mediaType: 'image/png', data: png }, { pdf })).data,
    ).toBe(png);
    const upload = everyActiveContent();
    const out = await acceptDocument(
      clinic,
      { mediaType: 'application/pdf', data: upload },
      { pdf },
    );
    expect(out).toMatchObject({ type: 'pdf', mediaType: 'application/pdf' });
    expect(out.data.equals(upload)).toBe(false);
    expect(out.data.toString('latin1')).not.toMatch(/OpenAction|JavaScript|\/AA\b|\/Annots/);
  });

  it('applies the clinic’s limits, and refuses SVG and HTML by name', async () => {
    expect(await reason('image/svg+xml', SAMPLE_SVG)).toBe('type_not_allowed');
    expect(await reason('text/html', Buffer.from('<p>synthetic</p>'))).toBe('type_not_allowed');
    expect(await reason('image/heic', Buffer.from('synthetic'))).toBe('type_not_allowed');
    expect(await reason('image/png', samplePng(), { maxUploadMb: 1, uploadTypes: ['pdf'] })).toBe(
      'type_not_allowed',
    );
    expect(await reason('application/pdf', Buffer.alloc(0))).toBe('empty');
    const big = Buffer.concat([samplePdf(), Buffer.alloc(1024 * 1024, 0x20)]);
    expect(await reason('application/pdf', big)).toBe('too_large');
    expect(await reason('application/pdf', samplePng())).toBe('type_mismatch');
    expect(await reason('image/png', Buffer.concat([samplePng(), Buffer.from('<html>')]))).toBe(
      'not_a_document',
    );
  });

  it('refuses what the rebuild refuses, and logs why', async () => {
    const logged: [string, unknown][] = [];
    const log = {
      info: (details: object) => logged.push(['info', details]),
      warn: (details: object) => logged.push(['warn', details]),
      error: (details: object) => logged.push(['error', details]),
    };
    const refused = async (data: Buffer, rebuilder = pdf, settings = clinic) => {
      try {
        await acceptDocument(
          settings,
          { mediaType: 'application/pdf', data },
          { pdf: rebuilder, log },
        );
      } catch (e) {
        if (e instanceof AppError) return e;
        throw e;
      }
    };
    const encrypted = await refused(encryptedPdf());
    expect(encrypted?.fields).toEqual({ file: 'encrypted' });
    expect(encrypted?.message).toMatch(/password-protected/);
    expect((await refused(Buffer.from('%PDF-1.7\nnothing\n%%EOF\n')))?.fields).toEqual({
      file: 'not_a_document',
    });
    expect(logged).toEqual([
      ['info', expect.objectContaining({ reason: 'encrypted' })],
      ['info', expect.objectContaining({ reason: 'not_a_document' })],
    ]);

    // A rebuilt file over the clinic's limit (here 500 bytes of output allowed).
    const tight = new PdfRebuilder({ ...PDF_REBUILD_LIMITS, maxOutputBytes: 500 });
    expect((await refused(everyActiveContent(), tight))?.fields).toEqual({ file: 'too_large' });

    // A broken rebuild is ours: 503, logged as an error.
    logged.length = 0;
    const broken = new PdfRebuilder(PDF_REBUILD_LIMITS, new URL('./missing.js', import.meta.url));
    const down = await refused(samplePdf(), broken);
    expect(down).toMatchObject({
      statusCode: 503,
      code: 'UNAVAILABLE',
      fields: { file: 'unavailable' },
    });
    expect(logged.map(([level]) => level)).toEqual(['error']);

    // A full queue: 503 busy, try again in a minute.
    const full = new PdfRebuilder({ ...PDF_REBUILD_LIMITS, maxQueue: 0, concurrency: 1 });
    const holding = full.rebuild(samplePdf());
    const busy = await refused(samplePdf(), full);
    expect(busy).toMatchObject({ statusCode: 503, fields: { file: 'busy' } });
    expect(busy?.headers).toEqual({ 'retry-after': '60' });
    expect(busy?.message).toMatch(/try again in a minute/);
    await holding;
  });
});
