import { LOGO_MAX_BYTES } from '@dhc/contracts';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { acceptLogo, inspectImage, inspectLogo, sniffLogoType } from './logo';
import { SAMPLE_SVG, sampleJpeg, samplePng, sampleWebp } from './logo-samples';

const reason = (mediaType: string, data: Buffer) => {
  try {
    acceptLogo({ mediaType, data });
  } catch (e) {
    if (e instanceof AppError) return e.fields?.file;
    throw e;
  }
  return 'accepted';
};

describe('sniffLogoType', () => {
  it('reads PNG, JPEG and WebP from the magic numbers, and markup as SVG', () => {
    expect(sniffLogoType(samplePng())).toBe('png');
    expect(sniffLogoType(sampleJpeg())).toBe('jpeg');
    expect(sniffLogoType(sampleWebp())).toBe('webp');
    expect(sniffLogoType(SAMPLE_SVG)).toBe('svg');
    expect(sniffLogoType(Buffer.from('\ufeff  <svg></svg>'))).toBe('svg');
    expect(sniffLogoType(Buffer.from('<html><body>hi</body></html>'))).toBe('svg');
    expect(sniffLogoType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffLogoType(Buffer.from('%PDF-1.7'))).toBeNull();
  });
});

describe('inspectLogo', () => {
  it('accepts well-formed PNG, JPEG and WebP images and reads their size', () => {
    expect(inspectLogo(samplePng({ width: 3, height: 2 }))).toEqual({
      type: 'png',
      width: 3,
      height: 2,
    });
    expect(inspectLogo(sampleJpeg({ width: 40, height: 20 }))).toEqual({
      type: 'jpeg',
      width: 40,
      height: 20,
    });
    expect(inspectLogo(sampleWebp({ width: 64, height: 32 }))).toEqual({
      type: 'webp',
      width: 64,
      height: 32,
    });
  });

  it('keeps ordinary metadata such as XMP', () => {
    const xmp = Buffer.from('<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    // As Adobe writes it: keyword, uncompressed, no language or translated keyword.
    const itxt = Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0'), xmp]);
    expect(inspectLogo(samplePng({ extra: [['iTXt', itxt]] }))).toMatchObject({ type: 'png' });
    expect(inspectLogo(sampleWebp({ extra: [['XMP ', xmp]] }))).toMatchObject({ type: 'webp' });
  });

  it('refuses SVG, empty and oversized files', () => {
    expect(inspectLogo(SAMPLE_SVG)).toBe('svg_not_allowed');
    expect(inspectLogo(Buffer.alloc(0))).toBe('empty');
    const big = samplePng({ extra: [['tEXt', Buffer.alloc(LOGO_MAX_BYTES)]] });
    expect(inspectLogo(big)).toBe('too_large');
  });

  it('refuses animation: APNG and animated WebP', () => {
    const actl = Buffer.alloc(8);
    expect(inspectLogo(samplePng({ extra: [['acTL', actl]] }))).toBe('animated');
    expect(inspectLogo(samplePng({ extra: [['fcTL', Buffer.alloc(26)]] }))).toBe('animated');
    expect(inspectLogo(sampleWebp({ extended: { flags: 0x02 } }))).toBe('animated');
    expect(inspectLogo(sampleWebp({ extra: [['ANIM', Buffer.alloc(6)]] }))).toBe('animated');
    expect(inspectLogo(sampleWebp({ extra: [['ANMF', Buffer.alloc(16)]] }))).toBe('animated');
    // A still VP8X image (alpha flag only) is fine.
    expect(inspectLogo(sampleWebp({ extended: { flags: 0x10 } }))).toMatchObject({
      type: 'webp',
    });
  });

  it('refuses more than 4 million pixels in all', () => {
    expect(inspectLogo(sampleWebp({ width: 2000, height: 2000 }))).toMatchObject({
      width: 2000,
    });
    expect(inspectLogo(sampleWebp({ width: 2001, height: 2000 }))).toBe('too_many_pixels');
    expect(inspectLogo(sampleWebp({ width: 4096, height: 1000 }))).toBe('too_many_pixels');
  });

  it('refuses images wider or taller than 4096 pixels', () => {
    expect(inspectLogo(sampleWebp({ width: 4097, height: 1 }))).toBe('too_many_pixels');
    expect(inspectLogo(sampleJpeg({ width: 1, height: 5000 }))).toBe('too_many_pixels');
    expect(inspectLogo(sampleWebp({ width: 4096, height: 900 }))).toMatchObject({ width: 4096 });
  });

  describe('polyglots and damaged files', () => {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');

    it('refuses anything after the end of the image', () => {
      expect(inspectLogo(Buffer.concat([samplePng(), html]))).toBe('not_an_image');
      expect(inspectLogo(Buffer.concat([sampleJpeg(), Buffer.from('PK\x03\x04zip')]))).toBe(
        'not_an_image',
      );
      // WebP: the RIFF size no longer matches the file.
      expect(inspectLogo(Buffer.concat([sampleWebp(), Buffer.from('%PDF-1.7')]))).toBe(
        'not_an_image',
      );
    });

    it('refuses markup or a document hidden in metadata or the header', () => {
      expect(inspectLogo(samplePng({ extra: [['tEXt', html]] }))).toBe('not_an_image');
      expect(inspectLogo(samplePng({ extra: [['zzZz', Buffer.from('<svg onload=x>')]] }))).toBe(
        'not_an_image',
      );
      expect(inspectLogo(sampleJpeg({ comment: '<SCRIPT>alert(1)</SCRIPT>' }))).toBe(
        'not_an_image',
      );
      expect(inspectLogo(sampleJpeg({ comment: 'javascript:alert(1)' }))).toBe('not_an_image');
      expect(inspectLogo(sampleWebp({ extra: [['EXIF', Buffer.from('%PDF-1.4 obj')]] }))).toBe(
        'not_an_image',
      );
    });

    it('refuses a PNG with a broken checksum, no image data or no end', () => {
      const png = samplePng();
      const broken = Buffer.from(png);
      broken[30] = broken[30]! ^ 0xff; // inside IHDR: its CRC no longer matches
      expect(inspectLogo(broken)).toBe('not_an_image');
      expect(inspectLogo(png.subarray(0, png.length - 12))).toBe('not_an_image');
      // Signature and IHDR only.
      expect(inspectLogo(png.subarray(0, 33))).toBe('not_an_image');
    });

    it('refuses a JPEG with two frame headers, or a scan before its frame', () => {
      expect(inspectLogo(sampleJpeg({ layout: 'two_frames' }))).toBe('not_an_image');
      expect(inspectLogo(sampleJpeg({ layout: 'scan_first' }))).toBe('not_an_image');
    });

    it('inflates compressed PNG text, and reads UTF-16 text, before scanning', () => {
      const ztxt = Buffer.concat([Buffer.from('Comment\0\0'), deflateSync(html)]);
      expect(inspectLogo(samplePng({ extra: [['zTXt', ztxt]] }))).toBe('not_an_image');
      const itxt = Buffer.concat([Buffer.from('Comment\0\x01\0en\0\0'), deflateSync(html)]);
      expect(inspectLogo(samplePng({ extra: [['iTXt', itxt]] }))).toBe('not_an_image');
      // A harmless compressed comment passes; a broken stream does not.
      const fine = Buffer.concat([Buffer.from('Comment\0\0'), deflateSync(Buffer.from('ok'))]);
      expect(inspectLogo(samplePng({ extra: [['zTXt', fine]] }))).toMatchObject({ type: 'png' });
      const broken = Buffer.concat([Buffer.from('Comment\0\0'), Buffer.from('not zlib')]);
      expect(inspectLogo(samplePng({ extra: [['zTXt', broken]] }))).toBe('not_an_image');
      const utf16 = Buffer.from('<script>alert(1)</script>', 'utf16le');
      expect(inspectLogo(samplePng({ extra: [['tEXt', utf16]] }))).toBe('not_an_image');
    });

    it('bounds compressed PNG text: 4 MB inflated in all and 64 text chunks, keeping nothing', () => {
      const text = (bytes: number) =>
        Buffer.concat([Buffer.from('Comment\0\0'), deflateSync(Buffer.alloc(bytes, 0x61))]);
      const chunks = (count: number, body: Buffer) =>
        Array.from({ length: count }, () => ['zTXt', body] as [string, Buffer]);
      const limits = { maxDimension: 10_000, maxPixels: 50_000_000 };
      // Many small chunks: up to 64 pass, one more is refused.
      expect(inspectImage(samplePng({ extra: chunks(64, text(100)) }), limits)).toMatchObject({
        type: 'png',
      });
      expect(inspectImage(samplePng({ extra: chunks(65, text(100)) }), limits)).toBe(
        'not_an_image',
      );
      // Four chunks of just under 1 MB each fit in 4 MB; a fifth does not, though each one
      // alone is within the per-chunk limit. The file stays small: these are bombs.
      const big = text(1024 * 1024 - 1);
      expect(big.length).toBeLessThan(2048);
      expect(inspectImage(samplePng({ extra: chunks(4, big) }), limits)).toMatchObject({
        type: 'png',
      });
      const bomb = samplePng({ extra: chunks(300, big) });
      const before = process.memoryUsage().rss;
      const started = performance.now();
      expect(inspectImage(bomb, limits)).toBe('not_an_image');
      expect(performance.now() - started).toBeLessThan(1000);
      expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
      // Markup in the last of many small chunks is still found.
      const last = Buffer.concat([Buffer.from('Comment\0\0'), deflateSync(html)]);
      expect(inspectLogo(samplePng({ extra: [...chunks(10, text(100)), ['zTXt', last]] }))).toBe(
        'not_an_image',
      );
    });

    it('refuses a JPEG cut short or with a bad segment length', () => {
      const jpeg = sampleJpeg();
      expect(inspectLogo(jpeg.subarray(0, jpeg.length - 2))).toBe('not_an_image');
      const bad = Buffer.from(jpeg);
      bad.writeUInt16BE(0xfff0, 4); // the JFIF segment claims more bytes than there are
      expect(inspectLogo(bad)).toBe('not_an_image');
    });

    it('refuses a WebP whose first chunk is not an image', () => {
      const webp = sampleWebp();
      const bad = Buffer.from(webp);
      bad.write('JUNK', 12, 'latin1');
      expect(inspectLogo(bad)).toBe('not_an_image');
    });
  });
});

describe('acceptLogo', () => {
  it('accepts an image sent as its own type', () => {
    expect(acceptLogo({ mediaType: 'image/png', data: samplePng() })).toMatchObject({
      type: 'png',
    });
    expect(acceptLogo({ mediaType: 'image/jpeg', data: sampleJpeg() }).type).toBe('jpeg');
    expect(acceptLogo({ mediaType: 'image/webp', data: sampleWebp() }).type).toBe('webp');
  });

  it('refuses SVG by name and by content, and anything not PNG, JPEG or WebP', () => {
    expect(reason('image/svg+xml', SAMPLE_SVG)).toBe('svg_not_allowed');
    expect(reason('image/png', SAMPLE_SVG)).toBe('svg_not_allowed');
    expect(reason('application/pdf', Buffer.from('%PDF-1.7'))).toBe('type_not_allowed');
    expect(reason('image/heic', samplePng())).toBe('type_not_allowed');
    expect(reason('image/gif', Buffer.from('GIF89a'))).toBe('type_not_allowed');
  });

  it('refuses an image sent as another type', () => {
    expect(reason('image/jpeg', samplePng())).toBe('type_mismatch');
    expect(reason('image/png', Buffer.from('GIF89a....'))).toBe('type_mismatch');
  });
});
