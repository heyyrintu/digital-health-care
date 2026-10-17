import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { acceptUpload, sniffUploadType } from './upload';

const PDF = Buffer.from('%PDF-1.7\n%synthetic\n');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]);

const settings = { maxUploadMb: 1, uploadTypes: ['pdf', 'jpeg', 'heic'] as const };
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.fields?.file;
    throw e;
  }
  return 'accepted';
};

describe('sniffUploadType', () => {
  it('reads PDF, JPEG, PNG and HEIC from the first bytes, and nothing else', () => {
    expect(sniffUploadType(PDF)).toBe('pdf');
    expect(sniffUploadType(JPEG)).toBe('jpeg');
    expect(sniffUploadType(PNG)).toBe('png');
    expect(sniffUploadType(HEIC)).toBe('heic');
    expect(sniffUploadType(Buffer.from('<html><script>'))).toBeNull();
    expect(sniffUploadType(Buffer.alloc(0))).toBeNull();
  });
});

describe('acceptUpload', () => {
  const accept = (mediaType: string, data: Buffer) =>
    acceptUpload({ ...settings, uploadTypes: [...settings.uploadTypes] }, { mediaType, data });

  it('accepts a file of an allowed type within the limit, with its extension', () => {
    expect(accept('application/pdf', PDF)).toEqual({ type: 'pdf', extension: 'pdf' });
    expect(accept('image/heif', HEIC)).toEqual({ type: 'heic', extension: 'heic' });
  });

  it('follows the clinic’s types and size, and refuses a file that is not what it says', () => {
    expect(reason(() => accept('application/pdf', Buffer.alloc(0)))).toBe('empty');
    expect(reason(() => accept('image/png', PNG))).toBe('type_not_allowed');
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]);
    expect(reason(() => accept('application/pdf', big))).toBe('too_large');
    expect(reason(() => accept('image/jpeg', PDF))).toBe('type_mismatch');
    expect(reason(() => accept('application/pdf', Buffer.from('<html>')))).toBe('type_mismatch');
  });
});
