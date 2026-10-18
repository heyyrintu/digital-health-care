import {
  checkUpload,
  MAX_RESULTS_PER_ORDER,
  MAX_UPLOAD_MB,
  UploadType,
  type PortalTestOrder,
  type TestOrder,
} from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { ApiError } from './client';

/**
 * The patient's Tests screen, on the web portal and in the Patient app (PRD §4.4, §7.1):
 * which tests take an upload, the rows after an upload or a refusal, the picked file's
 * checks and every refusal's wording, and how a result's type, size and file name read.
 * Pure, so both apps behave alike and it is unit tested once.
 */

/**
 * A patient cannot read the clinic's upload settings, so the app checks a file against every
 * type a clinic may accept and the platform's 25 MB ceiling; the server then applies the
 * clinic's own limits and says which one a file broke.
 */
const ANY_CLINIC = { maxUploadMb: MAX_UPLOAD_MB, uploadTypes: [...UploadType.options] };

/** What the file picker offers: PDFs and photos (HEIC/HEIF come under `image/*`). */
export const PICK_TYPES = ['application/pdf', 'image/*'];

/** A review is final, and a test holds at most 10 results (the API's rules). */
export function canUploadResult(order: Pick<PortalTestOrder, 'status' | 'results'>): boolean {
  return order.status !== 'reviewed' && order.results.length < MAX_RESULTS_PER_ORDER;
}

/**
 * The upload answers with the order alone; the row keeps whose test it is, the visit and
 * the doctor from the list, and takes the new status and results.
 */
export function withUploaded(row: PortalTestOrder, updated: TestOrder): PortalTestOrder {
  return {
    ...row,
    status: updated.status,
    reviewedAt: updated.reviewedAt,
    results: updated.results,
  };
}

/** Swaps one row for its newer copy; the rest stay as they are. */
export function replaceRow(rows: PortalTestOrder[], next: PortalTestOrder): PortalTestOrder[] {
  return rows.map((o) => (o.id === next.id ? next : o));
}

/** The next page under the rows shown, without repeating one that moved between pages. */
export function appendPage(rows: PortalTestOrder[], page: PortalTestOrder[]): PortalTestOrder[] {
  const shown = new Set(rows.map((o) => o.id));
  return [...rows, ...page.filter((o) => !shown.has(o.id))];
}

/**
 * The order as the server has it now, after a refusal left the row out of date: the pages
 * are fetched again, newest first, until it turns up. `gone` when the last page passed
 * without it; `unknown` when `maxPages` ran out first, which says nothing about the order.
 */
export async function findOrder(
  fetchPage: (cursor?: string) => Promise<{ data: PortalTestOrder[]; nextCursor: string | null }>,
  id: string,
  maxPages = 20,
): Promise<PortalTestOrder | 'gone' | 'unknown'> {
  let cursor: string | undefined;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await fetchPage(cursor);
    const found = page.data.find((o) => o.id === id);
    if (found) return found;
    if (!page.nextCursor) return 'gone';
    cursor = page.nextCursor;
  }
  return 'unknown';
}

const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * The media type to send a picked file as: the picker's, when it names one, else read from
 * the file name. Android pickers sometimes say `image/jpg` or nothing at all.
 */
export function pickedMediaType(file: { name: string; mimeType?: string | null }): string {
  const given = file.mimeType?.trim().toLowerCase() ?? '';
  if (given === 'image/jpg') return 'image/jpeg';
  if (given && given !== 'application/octet-stream') return given;
  const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  return BY_EXTENSION[extension] ?? given;
}

export type FileCheck =
  | { ok: true; mediaType: string }
  | { ok: false; reason: 'type_not_allowed' | 'too_large' | 'empty' };

/**
 * Checks a picked file before a long upload: a PDF or a photo, not empty and within 25 MB.
 * A size the picker could not tell is left to the server.
 */
export function checkPickedFile(file: {
  name: string;
  mimeType?: string | null;
  size?: number | null;
}): FileCheck {
  const mediaType = pickedMediaType(file);
  if (file.size === 0) return { ok: false, reason: 'empty' };
  const check = checkUpload(ANY_CLINIC, { mediaType, sizeBytes: file.size ?? 0 });
  return check === 'ok' ? { ok: true, mediaType } : { ok: false, reason: check };
}

export interface Message {
  key: MessageKey;
  params?: Record<string, string | number>;
}

/** The app's own wording for a file it refused before uploading. */
export function fileCheckMessage(reason: 'type_not_allowed' | 'too_large' | 'empty'): Message {
  switch (reason) {
    case 'type_not_allowed':
      return { key: 'patient.tests.file.type' };
    case 'too_large':
      return { key: 'patient.tests.file.tooLarge', params: { mb: MAX_UPLOAD_MB } };
    case 'empty':
      return { key: 'orders.file.empty' };
  }
}

/**
 * The wording for an upload the server refused, from its status and `fields`; null for
 * anything else, which shows the API's own message (or the network one).
 */
export function uploadErrorMessage(error: unknown): Message | null {
  if (!(error instanceof ApiError)) return null;
  const file = error.fields.file;
  if (error.status === 409 && error.fields.status === 'reviewed') {
    return { key: 'orders.alreadyReviewed' };
  }
  if (file === 'too_many') {
    return { key: 'orders.file.too_many', params: { max: MAX_RESULTS_PER_ORDER } };
  }
  // 413: over the platform ceiling, refused before the body is read; 400: the clinic's limit.
  if (error.status === 413) {
    return { key: 'patient.tests.file.tooLarge', params: { mb: MAX_UPLOAD_MB } };
  }
  if (file === 'too_large') return { key: 'patient.tests.file.clinicTooLarge' };
  if (file === 'type_not_allowed') {
    return {
      key: error.status === 415 ? 'patient.tests.file.type' : 'patient.tests.file.clinicType',
    };
  }
  if (file === 'type_mismatch') return { key: 'orders.file.type_mismatch' };
  if (file === 'empty') return { key: 'orders.file.empty' };
  if (error.status === 429) return { key: 'patient.tests.rateLimited' };
  return null;
}

/** A 409 means the row on screen is out of date: fetch it again. */
export const isStale = (error: unknown) => error instanceof ApiError && error.status === 409;

const SHARE_TYPES: Record<string, { label: string; extension: string; uti: string }> = {
  'application/pdf': { label: 'PDF', extension: 'pdf', uti: 'com.adobe.pdf' },
  'image/jpeg': { label: 'JPEG', extension: 'jpg', uti: 'public.jpeg' },
  'image/png': { label: 'PNG', extension: 'png', uti: 'public.png' },
  'image/heic': { label: 'HEIC', extension: 'heic', uti: 'public.heic' },
  'image/heif': { label: 'HEIF', extension: 'heif', uti: 'public.heif' },
};

/**
 * How a result's type reads on screen, its file extension and its iOS type identifier. The
 * label is null for a type not listed: the screen shows its own word for "File"
 * (`patient.tests.fileType`), in the person's language.
 */
export function shareTypeOf(mediaType: string): {
  label: string | null;
  extension: string;
  uti: string;
} {
  return SHARE_TYPES[mediaType] ?? { label: null, extension: 'bin', uti: 'public.data' };
}

/**
 * The file name a result is shared under, e.g. `test-result-2.pdf`. It says nothing about
 * the test (another app, or anyone looking at the phone, sees it); the share sheet's title
 * names the test.
 */
export function resultFileName(n: number, mediaType: string): string {
  const index = Number.isInteger(n) && n > 0 ? n : 1;
  return `test-result-${index}.${shareTypeOf(mediaType).extension}`;
}

/** "340 KB", "1.2 MB": a result's size, rounded the way people read it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * The tests with an upload under way. Checked and set synchronously, so two taps or clicks
 * in one frame (before React re-renders the busy button) cannot start two pickers or uploads.
 */
export class InFlight {
  private readonly ids = new Set<string>();

  /** False when this test already has an upload under way. */
  start(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }

  end(id: string): void {
    this.ids.delete(id);
  }
}
