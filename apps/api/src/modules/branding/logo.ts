import {
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
  LOGO_MAX_PIXELS,
  LOGO_MEDIA_TYPES,
  type LogoType,
} from '@dhc/contracts';
import { crc32, inflateSync } from 'node:zlib';
import { AppError } from '../../errors';
import type { UploadedFile } from '../orders/upload';

/**
 * Logo checks (threat model T26). A logo is served to anonymous visitors from a public
 * route, so the API accepts only a file whose bytes are, from start to end, a well-formed,
 * still PNG, JPEG or WebP image of a sane size, and nothing besides:
 *
 * - the type comes from the file's first bytes (magic numbers), and must match what it was
 *   sent as; SVG (which can carry script) is refused by name and by content;
 * - the whole structure is walked (PNG chunks with their CRCs, JPEG segments up to the end
 *   of image with exactly one frame header before the first scan, WebP's RIFF chunks), and
 *   the file must end where the image ends: anything appended (a ZIP, a PDF, an HTML page:
 *   a polyglot) is refused;
 * - animation is refused (APNG's `acTL`/`fcTL`/`fdAT`, WebP's `ANIM`/`ANMF` or the VP8X
 *   animation flag): a logo is a still mark, and frames are more places to hide content;
 * - the first kilobyte and every metadata block (text chunks, EXIF/XMP, comments) must hold
 *   no markup or script (`<script`, `<html`, `<svg`, `javascript:`, `%PDF-`, ...), so no
 *   reader that sniffs content finds a page or a document in it. Compressed PNG text
 *   (`zTXt`, compressed `iTXt`) is inflated (up to 1 MB; more, or a broken stream, is
 *   refused) and scanned too, and metadata is also scanned with NUL bytes dropped, which
 *   catches UTF-16 text in plain Latin letters;
 * - at most 4096 pixels on a side and 4 million pixels in all, so a small file cannot
 *   decode to a huge image in a visitor's browser.
 *
 * Not scanned: image data itself (PNG IDAT, JPEG scans, WebP frames), which is compressed
 * (a match there would be chance), and text in other encodings. That content is never read
 * as anything but an image: the route sends the verified type with `nosniff` and a sandbox
 * policy, which is the control; the scan is a second line.
 */

export type LogoRefusal =
  | 'empty'
  | 'too_large'
  | 'svg_not_allowed'
  | 'type_not_allowed'
  | 'type_mismatch'
  | 'not_an_image'
  | 'animated'
  | 'too_many_pixels';

export interface LogoImage {
  type: LogoType;
  width: number;
  height: number;
}

const EXTENSIONS: Record<LogoType, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };
export const logoExtension = (type: LogoType) => EXTENSIONS[type];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Markup and document headers no logo has any reason to carry (compared lowercased). */
const MARKUP = [
  '<script',
  '<html',
  '<svg',
  '<!doctype',
  '<iframe',
  '<body',
  '<object',
  '<embed',
  '<?php',
  '<!entity',
  '<?xml-stylesheet',
  'javascript:',
  '%pdf-',
];

const hasMarkup = (bytes: Buffer) => {
  const text = bytes.toString('latin1').toLowerCase();
  return MARKUP.some((token) => text.includes(token));
};

/** What the first bytes say the file is: one of the logo types, `svg` for markup, or null. */
export function sniffLogoType(data: Buffer): LogoType | 'svg' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  // Text that starts with markup (after spaces or a byte-order mark, which trimStart drops).
  const head = data.subarray(0, 512).toString('utf8').trimStart();
  if (head.startsWith('<')) return 'svg';
  return null;
}

interface Walked {
  width: number;
  height: number;
  /** Metadata payloads to scan for markup (text already inflated). */
  metadata: Buffer[];
  animated: boolean;
}

/** Inflated text of a compressed PNG text chunk, at most 1 MB; null when it is broken. */
function inflateText(data: Buffer): Buffer | null {
  try {
    return inflateSync(data, { maxOutputLength: 1024 * 1024 });
  } catch {
    return null;
  }
}

/** The text of a PNG `zTXt` or `iTXt` chunk, inflated when compressed; null when broken. */
function pngText(type: 'zTXt' | 'iTXt', body: Buffer): Buffer | null {
  const keywordEnd = body.indexOf(0);
  if (keywordEnd < 0) return null;
  if (type === 'zTXt') return inflateText(body.subarray(keywordEnd + 2));
  const compressed = body[keywordEnd + 1] === 1;
  // Language tag and translated keyword, each NUL-terminated.
  const languageEnd = body.indexOf(0, keywordEnd + 3);
  const translatedEnd = languageEnd < 0 ? -1 : body.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return null;
  const text = body.subarray(translatedEnd + 1);
  return compressed ? inflateText(text) : body;
}

/** PNG chunks of an animation (APNG). */
const APNG_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);

/** Walks a PNG: signature, IHDR first, every chunk's CRC, at least one IDAT, IEND last. */
function walkPng(data: Buffer): Walked | null {
  let at = 8;
  let width = 0;
  let height = 0;
  let sawData = false;
  let animated = false;
  const metadata: Buffer[] = [];
  for (let index = 0; at + 12 <= data.length; index++) {
    const length = data.readUInt32BE(at);
    const type = data.subarray(at + 4, at + 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type) || at + 12 + length > data.length) return null;
    const body = data.subarray(at + 8, at + 8 + length);
    if (crc32(data.subarray(at + 4, at + 8 + length)) !== data.readUInt32BE(at + 8 + length)) {
      return null;
    }
    if (index === 0) {
      if (type !== 'IHDR' || length !== 13) return null;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
    } else if (type === 'IHDR') {
      return null;
    }
    at += 12 + length;
    if (type === 'IDAT') sawData = true;
    else if (type === 'IEND') {
      // The image ends here, and so must the file.
      return sawData && length === 0 && at === data.length
        ? { width, height, metadata, animated }
        : null;
    } else if (APNG_CHUNKS.has(type)) animated = true;
    else if (type === 'zTXt' || type === 'iTXt') {
      const text = pngText(type, body);
      if (!text) return null;
      metadata.push(body, text);
    } else if (type !== 'IHDR' && type !== 'PLTE') metadata.push(body);
  }
  return null;
}

const isSof = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * Walks a JPEG: every marker segment to each scan, through the scan's data to the next
 * marker, until the end-of-image marker, which must be the file's last two bytes. Exactly
 * one frame header (SOF), before the first scan.
 */
function walkJpeg(data: Buffer): Walked | null {
  let at = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  const metadata: Buffer[] = [];
  while (at < data.length) {
    if (data[at] !== 0xff) return null;
    while (data[at] === 0xff) at++; // fill bytes
    if (at >= data.length) return null;
    const marker = data[at]!;
    at++;
    if (marker === 0xd9) {
      return sawFrame && at === data.length ? { width, height, metadata, animated: false } : null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd8 || marker === 0x00) return null;
    if (at + 2 > data.length) return null;
    const length = data.readUInt16BE(at);
    if (length < 2 || at + length > data.length) return null;
    const body = data.subarray(at + 2, at + length);
    if (isSof(marker)) {
      // A second frame header could describe a second image to some decoders.
      if (sawFrame || body.length < 5) return null;
      sawFrame = true;
      height = body.readUInt16BE(1);
      width = body.readUInt16BE(3);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      metadata.push(body); // APPn (EXIF, XMP, ICC) and comments
    }
    at += length;
    if (marker === 0xda) {
      // A scan needs the frame it belongs to.
      if (!sawFrame) return null;
      // Entropy-coded data: runs until a marker that is not a stuffed 0x00 or a restart.
      while (at + 1 < data.length) {
        if (data[at] === 0xff) {
          const next = data[at + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            at += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        at++;
      }
      if (at + 1 >= data.length) return null;
    }
  }
  return null;
}

/** Image data chunks of a WebP; anything else is metadata (EXIF, XMP, ICC, unknown). */
const WEBP_IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH']);
/** WebP animation chunks. */
const WEBP_ANIMATION_CHUNKS = new Set(['ANIM', 'ANMF']);
/** The animation flag in VP8X's flags byte. */
const VP8X_ANIMATION = 0x02;

/** Walks a WebP: the RIFF size is the file's, every chunk fits, and the first is an image. */
function walkWebp(data: Buffer): Walked | null {
  if (data.readUInt32LE(4) + 8 !== data.length) return null;
  let at = 12;
  let width = 0;
  let height = 0;
  let animated = false;
  const metadata: Buffer[] = [];
  for (let index = 0; at < data.length; index++) {
    if (at + 8 > data.length) return null;
    const type = data.subarray(at, at + 4).toString('latin1');
    const length = data.readUInt32LE(at + 4);
    const padded = length + (length % 2);
    if (at + 8 + padded > data.length) return null;
    const body = data.subarray(at + 8, at + 8 + length);
    if (index === 0) {
      if (type === 'VP8X' && length >= 10) {
        if (body[0]! & VP8X_ANIMATION) animated = true;
        width = body.readUIntLE(4, 3) + 1;
        height = body.readUIntLE(7, 3) + 1;
      } else if (type === 'VP8L' && length >= 5 && body[0] === 0x2f) {
        const bits = body.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (
        type === 'VP8 ' &&
        length >= 10 &&
        body[3] === 0x9d &&
        body[4] === 0x01 &&
        body[5] === 0x2a
      ) {
        width = body.readUInt16LE(6) & 0x3fff;
        height = body.readUInt16LE(8) & 0x3fff;
      } else {
        return null;
      }
    } else if (WEBP_ANIMATION_CHUNKS.has(type)) {
      animated = true;
    } else if (!WEBP_IMAGE_CHUNKS.has(type)) {
      metadata.push(body);
    }
    at += 8 + padded;
  }
  return at === data.length && width > 0 ? { width, height, metadata, animated } : null;
}

/** Markup in a metadata block, as bytes or with NUL bytes dropped (UTF-16 text). */
const metadataHasMarkup = (block: Buffer) =>
  hasMarkup(block) || (block.includes(0) && hasMarkup(Buffer.from(block.filter((b) => b !== 0))));

/**
 * The image a logo's bytes hold, or why they are refused. Pure: used on upload, and again
 * on every read of a stored logo before it is served.
 */
export function inspectLogo(data: Buffer): LogoImage | LogoRefusal {
  if (data.length === 0) return 'empty';
  if (data.length > LOGO_MAX_BYTES) return 'too_large';
  const type = sniffLogoType(data);
  if (type === 'svg') return 'svg_not_allowed';
  if (!type) return 'type_mismatch';
  const walked = type === 'png' ? walkPng(data) : type === 'jpeg' ? walkJpeg(data) : walkWebp(data);
  if (!walked || walked.width < 1 || walked.height < 1) return 'not_an_image';
  if (hasMarkup(data.subarray(0, 1024)) || walked.metadata.some(metadataHasMarkup)) {
    return 'not_an_image';
  }
  if (walked.animated) return 'animated';
  if (
    walked.width > LOGO_MAX_DIMENSION ||
    walked.height > LOGO_MAX_DIMENSION ||
    walked.width * walked.height > LOGO_MAX_PIXELS
  ) {
    return 'too_many_pixels';
  }
  return { type, width: walked.width, height: walked.height };
}

const MESSAGES: Record<LogoRefusal, string> = {
  empty: 'The file is empty.',
  too_large: 'The logo is larger than 512 KB. Save it smaller and try again.',
  svg_not_allowed: 'SVG logos are not accepted. Save the logo as PNG, JPEG or WebP.',
  type_not_allowed: 'Choose a PNG, JPEG or WebP image.',
  type_mismatch: 'The file is not what its type says. Choose the file again.',
  not_an_image:
    'The file is not a plain image (it is damaged or carries other content). Export the logo again as PNG, JPEG or WebP.',
  animated: 'Animated logos are not accepted. Save a still image as PNG, JPEG or WebP.',
  too_many_pixels:
    'The logo is too large: at most 4096 pixels on a side and 4 million pixels in all. Save it smaller.',
};

/**
 * Checks an uploaded logo: its declared type (PNG, JPEG or WebP; SVG refused by name), its
 * size, and its bytes (`inspectLogo`), which must be the type it was sent as. 400 with
 * `fields.file` set to the reason otherwise.
 */
export function acceptLogo(file: UploadedFile): LogoImage {
  const refuse = (reason: LogoRefusal) =>
    new AppError(400, 'VALIDATION_FAILED', MESSAGES[reason], { file: reason });
  if (file.mediaType === 'image/svg+xml') throw refuse('svg_not_allowed');
  const declared = (Object.keys(LOGO_MEDIA_TYPES) as LogoType[]).find(
    (t) => LOGO_MEDIA_TYPES[t] === file.mediaType,
  );
  if (!declared) throw refuse('type_not_allowed');
  const image = inspectLogo(file.data);
  if (typeof image === 'string') throw refuse(image);
  if (image.type !== declared) throw refuse('type_mismatch');
  return image;
}
