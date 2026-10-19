import {
  checkDocumentUpload,
  DOCUMENT_MEDIA_TYPES,
  type DocumentType,
  type OrganisationSettings,
} from '@dhc/contracts';
import { AppError } from '../../errors';
import { inspectImage, MARKUP } from '../branding/logo';
import type { UploadedFile } from '../orders/upload';
import { scanPdf } from './pdf-scan';

/**
 * Content checks for document files (threat model T27). A document is opened by patients
 * in their browser, so beyond the clinic's limits (`checkDocumentUpload`: type and size)
 * the API accepts only a file whose bytes are, from start to end, the PDF or still image
 * it was sent as:
 *
 * - **Images** (JPEG, PNG, WebP) go through the logo checks (`inspectImage`): the whole
 *   structure is walked and must end where the image ends (a ZIP, PDF or HTML page appended
 *   to it, a polyglot, is refused), no markup or script in the first kilobyte or any
 *   metadata block, no animation, and at most 10,000 pixels on a side and 50 million in all
 *   (a phone camera's 48-megapixel photo fits), so a small file cannot decode to a huge
 *   image in a patient's browser.
 * - **PDFs** must start with the `%PDF-` header at the first byte (readers accept junk
 *   before it, which is where an HTML page would hide in a polyglot), hold no markup in the
 *   first kilobyte, and end with `%%EOF` and nothing but whitespace after it (anything
 *   appended is refused). The file is then read in one linear pass (`pdf-scan.ts`): its
 *   syntax is tokenised strictly (comments, strings, stream lengths; stray delimiters,
 *   run-together tokens, names over 256 bytes and streams not opened by their object are
 *   refused), its cross-reference is checked so that every object a reader can reach is
 *   one the scan read, and active content is refused: JavaScript, launch actions, embedded
 *   files, rich media, XFA, additional actions (`/AA`), form submission and data import,
 *   remote go-to actions, and an `/OpenAction` that is an action, also inside
 *   Flate-compressed object streams (bounded in number, size and header). Encrypted PDFs
 *   are refused as such (`encrypted`).
 * - **SVG and HTML** are refused by name (their media types) and by content (an image whose
 *   bytes start with markup).
 *
 * Not checked: content streams themselves (page drawing), fonts and images inside a PDF.
 * The web app opens files from `blob:` URLs, which do not carry the API's `nosniff` and
 * sandbox headers, so for the in-app viewer these checks are the server's main control and
 * the browser's own PDF and image viewers are the remaining one (threat model T27). Malware
 * scanning comes with the files module (Build Plan §6.6), as for results and logos.
 */

/** Why a document's bytes are refused. */
export type ContentRefusal =
  | 'empty'
  | 'type_mismatch'
  | 'not_a_document'
  | 'animated'
  | 'too_many_pixels'
  | 'active_content'
  | 'encrypted';

/** Why an upload is refused: the clinic's limits, or its content. */
export type DocumentRefusal = ContentRefusal | 'too_large' | 'type_not_allowed';

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

/** Checks a PDF's bytes (above); 'ok' or why it is refused. */
export function inspectPdf(
  data: Buffer,
): 'ok' | 'type_mismatch' | 'not_a_document' | 'active_content' | 'encrypted' {
  if (!/^%PDF-[12]\.\d/.test(data.subarray(0, 8).toString('latin1'))) return 'type_mismatch';
  if (pdfHeadHasMarkup(data.subarray(0, 1024))) return 'not_a_document';
  // Nothing but whitespace after the last end-of-file marker.
  const tail = data.subarray(Math.max(0, data.length - 1024)).toString('latin1');
  const eof = tail.lastIndexOf('%%EOF');
  if (eof < 0 || !/^[\s\0]*$/.test(tail.slice(eof + 5))) return 'not_a_document';
  // Structure, cross-reference and active content, in one linear pass (`pdf-scan.ts`).
  return scanPdf(data);
}

/**
 * What a document's bytes are, or why they are refused, given the type it was sent as.
 * Pure: the clinic's limits are checked separately (`acceptDocument`).
 */
export function inspectDocument(
  declared: DocumentType,
  data: Buffer,
): DocumentType | ContentRefusal {
  if (data.length === 0) return 'empty';
  if (declared === 'pdf') {
    const pdf = inspectPdf(data);
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
  active_content:
    'The PDF contains scripts, attachments or interactive forms, which are not accepted. Print it to a new PDF and try again.',
};

/**
 * Checks an uploaded document against the clinic's limits (`checkDocumentUpload`: one of
 * its document types, within its largest file) and its content (`inspectDocument`). SVG and
 * HTML are refused by name. Returns the type and the extension to store it under; 400 with
 * `fields.file` set to the reason otherwise.
 */
export function acceptDocument(
  settings: Pick<OrganisationSettings, 'maxUploadMb' | 'uploadTypes'>,
  file: UploadedFile,
): { type: DocumentType; extension: string } {
  const refuse = (reason: DocumentRefusal, message: string) =>
    new AppError(400, 'VALIDATION_FAILED', message, { file: reason });
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
  if (check === 'too_large') {
    throw refuse(
      'too_large',
      `The file is larger than this clinic’s ${settings.maxUploadMb} MB limit.`,
    );
  }
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
  return { type: declared, extension: documentExtension(declared) };
}
