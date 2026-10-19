import {
  checkDocumentUpload,
  DOCUMENT_MEDIA_TYPES,
  MAX_UPLOAD_MB,
  type DocumentType,
  type OrganisationSettings,
} from '@dhc/contracts';
import { AppError } from '../../errors';
import { inspectImage, MARKUP } from '../branding/logo';
import type { UploadedFile } from '../orders/upload';
import { PDF_REBUILD_LIMITS, type PdfRebuilder } from './pdf-rebuild';

/**
 * Content checks for document files (threat model T27). A document is opened by patients
 * in their browser, so beyond the clinic's limits (`checkDocumentUpload`: type and size)
 * the API keeps only a file it can vouch for:
 *
 * - **Images** (JPEG, PNG, WebP) go through the logo checks (`inspectImage`): the whole
 *   structure is walked and must end where the image ends (a ZIP, PDF or HTML page appended
 *   to it, a polyglot, is refused), no markup or script in the first kilobyte or any
 *   metadata block, no animation, and at most 10,000 pixels on a side and 50 million in all
 *   (a phone camera's 48-megapixel photo fits), so a small file cannot decode to a huge
 *   image in a patient's browser. The image is stored as sent.
 * - **PDFs** are not stored as sent: they are rebuilt from their pages. Cheap checks first:
 *   the `%PDF-` header at the first byte (readers accept junk before it, which is where an
 *   HTML page would hide in a polyglot), no markup in the first kilobyte, and `%%EOF` at the
 *   end with nothing but whitespace after it. Then `rebuildPdf` (`pdf-rebuild.ts`), in a
 *   worker thread with capped memory and a time limit, copies only the pages (what draws
 *   them) into a new PDF the API writes itself, with no document actions, scripts,
 *   attachments, forms, links or other annotations, bookmarks or metadata of the upload, and
 *   checks that output (`pdf-scan.ts`). Only the rebuilt file is stored, hashed and served.
 *   Encrypted PDFs are refused as such (`encrypted`), as are PDFs over 500 pages
 *   (`too_many_pages`); a file the rebuild cannot read within its limits is
 *   `not_a_document`.
 * - **SVG and HTML** are refused by name (their media types) and by content (an image whose
 *   bytes start with markup).
 *
 * Not checked: what page content draws (content streams, fonts and images inside a PDF are
 * copied as they are) and image pixels. The web app opens files from `blob:` URLs, which do
 * not carry the API's `nosniff` and sandbox headers, so the browser's own PDF and image
 * viewers are the remaining control (threat model T27). Malware scanning comes with the
 * files module (Build Plan §6.6), as for results and logos.
 */

/** Why a document's bytes are refused. */
export type ContentRefusal =
  | 'empty'
  | 'type_mismatch'
  | 'not_a_document'
  | 'animated'
  | 'too_many_pixels'
  | 'too_many_pages'
  | 'encrypted';

/** Why an upload is refused: the clinic's limits, or its content. */
export type DocumentRefusal = ContentRefusal | 'too_large' | 'type_not_allowed';
/** Why an upload could not be checked now (503): `busy` (try again) or `unavailable`. */
export type DocumentUnavailable = 'busy' | 'unavailable';

/** How large a document image may decode to. */
export const DOCUMENT_IMAGE_LIMITS = { maxDimension: 10_000, maxPixels: 50_000_000 } as const;

/** Types sent only to be refused by name. */
export const REFUSED_DOCUMENT_MEDIA_TYPES = ['image/svg+xml', 'text/html'];

const EXTENSIONS: Record<DocumentType, string> = {
  pdf: 'pdf',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};
export const documentExtension = (type: DocumentType) => EXTENSIONS[type];

/** Markup in a PDF's head: the logo list, without the PDF header itself. */
const PDF_HEAD_MARKUP = MARKUP.filter((token) => token !== '%pdf-');
const pdfHeadHasMarkup = (head: Buffer) => {
  const text = head.toString('latin1').toLowerCase();
  return PDF_HEAD_MARKUP.some((token) => text.includes(token));
};

/**
 * The cheap checks on an uploaded PDF, before it is rebuilt (above): 'ok' or why it is
 * refused.
 */
export function precheckPdf(data: Buffer): 'ok' | 'type_mismatch' | 'not_a_document' {
  if (!/^%PDF-[12]\.\d/.test(data.subarray(0, 8).toString('latin1'))) return 'type_mismatch';
  if (pdfHeadHasMarkup(data.subarray(0, 1024))) return 'not_a_document';
  // Nothing but whitespace after the last end-of-file marker.
  const tail = data.subarray(Math.max(0, data.length - 1024)).toString('latin1');
  const eof = tail.lastIndexOf('%%EOF');
  if (eof < 0 || !/^[\s\0]*$/.test(tail.slice(eof + 5))) return 'not_a_document';
  return 'ok';
}

/**
 * What a document's bytes are, or why they are refused, given the type it was sent as: for
 * a PDF, only the cheap checks (the rebuild is `acceptDocument`'s). Pure: the clinic's
 * limits are checked separately.
 */
export function inspectDocument(
  declared: DocumentType,
  data: Buffer,
): DocumentType | ContentRefusal {
  if (data.length === 0) return 'empty';
  if (declared === 'pdf') {
    const pdf = precheckPdf(data);
    return pdf === 'ok' ? 'pdf' : pdf;
  }
  const image = inspectImage(data, DOCUMENT_IMAGE_LIMITS);
  if (typeof image === 'string') {
    return image === 'not_an_image' || image === 'svg_not_allowed' ? 'not_a_document' : image;
  }
  return image.type === declared ? image.type : 'type_mismatch';
}

const MESSAGES: Record<ContentRefusal, string> = {
  empty: 'The file is empty.',
  type_mismatch: 'The file is not what its type says. Choose the file again.',
  not_a_document:
    'The file is not a plain PDF or image (it is damaged or carries other content). Save it again as PDF, JPEG, PNG or WebP.',
  animated: 'Animated images are not accepted. Save a still image.',
  too_many_pixels:
    'The image is too large: at most 10,000 pixels on a side and 50 million pixels in all. Save it smaller.',
  encrypted:
    'This PDF is password-protected or encrypted; save or print it as an unprotected PDF and upload that.',
  too_many_pages: `The PDF has more than ${PDF_REBUILD_LIMITS.maxPages} pages. Split it into smaller files.`,
};

/** Logs why the rebuild refused a PDF (never the file or its name). */
export interface RebuildLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/** What `acceptDocument` needs to rebuild a PDF. */
export interface RebuildContext {
  /** The process's rebuilder (`Services.pdf`). */
  pdf: PdfRebuilder;
  log?: RebuildLog;
  /** The uploader's organisation: it has at most two rebuilds running or waiting. */
  organisationId?: string;
  /** Aborts when the request closes: a waiting rebuild then leaves the queue. */
  signal?: AbortSignal;
}

/** A 503 the client should retry (`busy`) or that is ours to fix (`unavailable`). */
const unavailable = (reason: 'busy' | 'unavailable') =>
  reason === 'busy'
    ? new AppError(
        503,
        'UNAVAILABLE',
        'Too many files are being checked right now; try again in a minute.',
        { file: 'busy' },
        { 'retry-after': '60' },
      )
    : new AppError(
        503,
        'UNAVAILABLE',
        'PDFs cannot be checked right now. Try again later, or upload the document as an image.',
        { file: 'unavailable' },
      );

/**
 * Checks an uploaded document against the clinic's limits (`checkDocumentUpload`: one of
 * its document types, within its largest file) and its content (`inspectDocument`), and
 * rebuilds a PDF (`context.pdf`). SVG and HTML are refused by name. Returns the type, the
 * extension to store it under and the bytes to store: the upload for an image, the rebuilt
 * file for a PDF (refused as `too_large` when the rebuilt file is over the clinic's limit).
 * 400 with `fields.file` set to the reason otherwise; 503 when the rebuild is busy or broken.
 */
export async function acceptDocument(
  settings: Pick<OrganisationSettings, 'maxUploadMb' | 'uploadTypes'>,
  file: UploadedFile,
  context: RebuildContext,
): Promise<{ type: DocumentType; extension: string; mediaType: string; data: Buffer }> {
  const refuse = (reason: DocumentRefusal, message: string) =>
    new AppError(400, 'VALIDATION_FAILED', message, { file: reason });
  const tooLarge = () =>
    refuse('too_large', `The file is larger than this clinic’s ${settings.maxUploadMb} MB limit.`);
  if (REFUSED_DOCUMENT_MEDIA_TYPES.includes(file.mediaType)) {
    throw refuse(
      'type_not_allowed',
      'SVG and web pages are not accepted. Save the document as PDF, JPEG, PNG or WebP.',
    );
  }
  if (file.data.length === 0) throw refuse('empty', MESSAGES.empty);
  const check = checkDocumentUpload(settings, {
    mediaType: file.mediaType,
    sizeBytes: file.data.length,
  });
  if (check === 'type_not_allowed') {
    throw refuse('type_not_allowed', 'This clinic does not accept this type of file.');
  }
  if (check === 'too_large') throw tooLarge();
  const declared = (Object.keys(DOCUMENT_MEDIA_TYPES) as DocumentType[]).find(
    (t) => DOCUMENT_MEDIA_TYPES[t] === file.mediaType,
  )!;
  const found = inspectDocument(declared, file.data);
  if (found !== declared) {
    const reason =
      found === 'pdf' || found === 'jpeg' || found === 'png' || found === 'webp'
        ? 'type_mismatch'
        : found;
    throw refuse(reason, MESSAGES[reason]);
  }
  const accepted = {
    type: declared,
    extension: documentExtension(declared),
    mediaType: DOCUMENT_MEDIA_TYPES[declared],
  };
  if (declared !== 'pdf') return { ...accepted, data: file.data };
  const { log } = context;
  const rebuilt = await context.pdf.rebuild(file.data, {
    organisationId: context.organisationId,
    signal: context.signal,
  });
  if (!rebuilt.ok) {
    const details = {
      reason: rebuilt.reason,
      detail: rebuilt.detail.slice(0, 200),
      sizeBytes: file.data.length,
    };
    if (rebuilt.reason === 'unavailable') {
      // The rebuild itself is broken (worker missing, pdf-lib changed): ours, not the user's.
      log?.error(details, 'PDF rebuild failed');
      throw unavailable('unavailable');
    }
    if (rebuilt.reason === 'busy' || rebuilt.reason === 'aborted') {
      log?.info(details, 'PDF rebuild not run');
      throw unavailable('busy');
    }
    // A rebuilt file failing its own check is a gap in the rebuild: worth a warning.
    log?.[rebuilt.detail.startsWith('post-check') ? 'warn' : 'info'](
      details,
      'Uploaded PDF refused by the rebuild',
    );
    if (rebuilt.reason === 'too_large') throw tooLarge();
    throw refuse(rebuilt.reason, MESSAGES[rebuilt.reason]);
  }
  // The rebuilt file can be larger than the upload (object streams written out).
  const limit = Math.min(settings.maxUploadMb, MAX_UPLOAD_MB) * 1024 * 1024;
  if (rebuilt.data.byteLength > limit) {
    log?.info(
      { sizeBytes: file.data.length, rebuiltBytes: rebuilt.data.byteLength },
      'Rebuilt PDF over the limit',
    );
    throw tooLarge();
  }
  return {
    ...accepted,
    data: Buffer.from(rebuilt.data.buffer, rebuilt.data.byteOffset, rebuilt.data.byteLength),
  };
}
