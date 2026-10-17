import {
  checkUpload,
  MAX_UPLOAD_MB,
  UPLOAD_MEDIA_TYPES,
  type OrganisationSettings,
  type UploadType,
} from '@dhc/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../errors';

/** Every media type a clinic may accept (its settings choose among them). */
export const UPLOAD_CONTENT_TYPES = Object.values(UPLOAD_MEDIA_TYPES).flat();

/**
 * Uploads per client address per minute, staff and portal together (API guide §1:
 * stricter on uploads). `groupId` keeps the count apart from other limits on the same key.
 */
export const UPLOAD_RATE_LIMIT = { max: 60, timeWindow: '1 minute', groupId: 'uploads' };

// `config.rateLimit` gives every route its own in-memory counter (@fastify/rate-limit 11
// makes a child store per route), so one limiter is made per app and limit and shared by
// every upload route instead. Keyed by the app's services (which both route plugins
// receive) and then by the limit, so two limits never share a counter.
const limiters = new WeakMap<object, Map<number, ReturnType<FastifyInstance['rateLimit']>>>();

/** The one upload limiter of this app at this limit, for the upload routes' `onRequest`. */
export function uploadRateLimit(app: FastifyInstance, shared: object, max = UPLOAD_RATE_LIMIT.max) {
  let byMax = limiters.get(shared);
  if (!byMax) {
    byMax = new Map();
    limiters.set(shared, byMax);
  }
  let limiter = byMax.get(max);
  if (!limiter) {
    limiter = app.rateLimit({ ...UPLOAD_RATE_LIMIT, max });
    byMax.set(max, limiter);
  }
  return limiter;
}

const EXTENSIONS: Record<UploadType, string> = {
  pdf: 'pdf',
  jpeg: 'jpg',
  png: 'png',
  heic: 'heic',
};

/** HEIF brands used by phone cameras (HEIC photos and HEIF stills). */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
  'heif',
]);

/**
 * What the file's first bytes say it is, whatever the client called it: a PDF, a JPEG, a
 * PNG or a HEIC/HEIF photo; null for anything else.
 */
export function sniffUploadType(data: Buffer): UploadType | null {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (
    data.subarray(4, 8).toString('latin1') === 'ftyp' &&
    HEIF_BRANDS.has(data.subarray(8, 12).toString('latin1'))
  ) {
    return 'heic';
  }
  return null;
}

export interface UploadedFile {
  /** As sent in Content-Type, lower case, without parameters. */
  mediaType: string;
  data: Buffer;
}

/**
 * The raw request body as a file, for routes registered after `registerUploadParser`.
 * The body is the file itself (no multipart), up to the platform ceiling.
 */
export function uploadedFile(request: FastifyRequest): UploadedFile {
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (Buffer.isBuffer(request.body)) return { mediaType, data: request.body };
  // An upload type with no body at all is an empty file; anything else (JSON, text, which
  // Fastify parsed itself) is not a file this endpoint takes.
  if (request.body === undefined && UPLOAD_CONTENT_TYPES.includes(mediaType)) {
    return { mediaType, data: Buffer.alloc(0) };
  }
  throw new AppError(415, 'VALIDATION_FAILED', 'Send the file itself, as a PDF or a photo.', {
    file: 'type_not_allowed',
  });
}

/**
 * Accepts the upload media types as raw bodies in this plugin's routes (Fastify keeps
 * parsers per plugin, so JSON endpoints elsewhere are unaffected). Larger than the
 * platform ceiling is refused with 413 before the file is read in full.
 */
export function registerUploadParser(app: FastifyInstance) {
  app.addContentTypeParser(
    UPLOAD_CONTENT_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_MB * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
}

/**
 * Checks a file against the clinic's upload limits (`checkUpload`) and its content: it
 * must really be the type it was sent as. Returns the type and the file extension to store
 * it under. 400 with `fields.file` = `empty`, `type_not_allowed`, `too_large` or
 * `type_mismatch` otherwise.
 */
export function acceptUpload(
  settings: Pick<OrganisationSettings, 'maxUploadMb' | 'uploadTypes'>,
  file: UploadedFile,
): { type: UploadType; extension: string } {
  const refuse = (reason: string, message: string) =>
    new AppError(400, 'VALIDATION_FAILED', message, { file: reason });
  if (file.data.length === 0) throw refuse('empty', 'The file is empty.');
  const check = checkUpload(settings, { mediaType: file.mediaType, sizeBytes: file.data.length });
  if (check === 'type_not_allowed') {
    throw refuse('type_not_allowed', 'This clinic does not accept this type of file.');
  }
  if (check === 'too_large') {
    throw refuse(
      'too_large',
      `The file is larger than this clinic’s ${settings.maxUploadMb} MB limit.`,
    );
  }
  const sniffed = sniffUploadType(file.data);
  if (!sniffed || !UPLOAD_MEDIA_TYPES[sniffed].includes(file.mediaType)) {
    throw refuse('type_mismatch', 'The file is not what its type says. Choose the file again.');
  }
  return { type: sniffed, extension: EXTENSIONS[sniffed] };
}
