import { z } from 'zod';
import { CursorQuery, page } from './pagination';
import type { OrganisationSettings, UploadType } from './settings';

// ---- Attachments and the clinic document library (PRD §7.3; API guide §3x) --------------
//
// Clinic admins and doctors keep a library of reusable sheets (exercise sheets, diet
// charts, information leaflets): a title, an optional category, a language and a file. A
// doctor shares a sheet, or a one-off upload such as a report, with a patient, with an
// optional note; the patient sees it on the portal's Documents page (and the family's
// members theirs). A share keeps its own title and points at the exact stored file it was
// made with, so renaming, replacing or archiving the sheet later never changes what the
// patient received. A doctor may withdraw a share: the patient stops seeing it, and the
// record stays. Uploading is two steps: the file first (`POST /document-files`, the body is
// the file), then the sheet or the share naming it by ID, so titles and notes never travel
// in a URL. Not built yet: sending on WhatsApp, SMS or email, push notifications, the
// mobile apps, malware scanning and sharing a library across organisations.

/** What a document is about. */
export const DocumentCategory = z.enum(['exercise', 'diet', 'information', 'other']);
export type DocumentCategory = z.infer<typeof DocumentCategory>;

/** The language a document is written in. */
export const DocumentLanguage = z.enum(['en', 'hi', 'other']);
export type DocumentLanguage = z.infer<typeof DocumentLanguage>;

/** Where a shared document came from. */
export const PatientDocumentSource = z.enum(['library', 'upload']);
export type PatientDocumentSource = z.infer<typeof PatientDocumentSource>;

/** The limits the database checks too. */
export const DOCUMENT_LIMITS = { title: 120, note: 500 } as const;

/** Sheets a clinic's library holds, active or archived; one more is 409 `library: full`. */
export const MAX_LIBRARY_DOCUMENTS = 500;

/**
 * A fresh upload must be used (for a sheet or a share) within this long, by the person who
 * uploaded it; after that it is refused as `fileId: expired`.
 */
export const DOCUMENT_UPLOAD_TTL_HOURS = 24;

/**
 * File types a document may have: PDF and still images a browser shows (JPEG, PNG, WebP).
 * Never SVG or HTML (they can carry script), and never HEIC, which browsers do not show.
 */
export const DocumentType = z.enum(['pdf', 'jpeg', 'png', 'webp']);
export type DocumentType = z.infer<typeof DocumentType>;
export const DOCUMENT_MEDIA_TYPES = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const satisfies Record<DocumentType, string>;
export const DocumentMediaType = z.enum([
  DOCUMENT_MEDIA_TYPES.pdf,
  DOCUMENT_MEDIA_TYPES.jpeg,
  DOCUMENT_MEDIA_TYPES.png,
  DOCUMENT_MEDIA_TYPES.webp,
]);
export type DocumentMediaType = z.infer<typeof DocumentMediaType>;

/**
 * The document types a clinic accepts, from its upload settings (§3l): PDF, JPEG and PNG
 * follow the clinic's own switches; WebP has no switch there (results never take it) and
 * is always accepted; HEIC is never a document type.
 */
export function documentTypesFor(
  settings: Pick<OrganisationSettings, 'uploadTypes'>,
): DocumentType[] {
  const switched = ['pdf', 'jpeg', 'png'] as const satisfies readonly UploadType[];
  return [...switched.filter((t) => settings.uploadTypes.includes(t)), 'webp'];
}

/**
 * Whether a document file fits the clinic's limits: one of its document types, within its
 * largest file. The server checks this on every upload; clients check it first so people
 * are told before a long upload.
 */
export function checkDocumentUpload(
  settings: Pick<OrganisationSettings, 'maxUploadMb' | 'uploadTypes'>,
  file: { mediaType: string; sizeBytes: number },
): 'ok' | 'too_large' | 'type_not_allowed' {
  const mediaType = file.mediaType.split(';')[0]!.trim().toLowerCase();
  if (!documentTypesFor(settings).some((t) => DOCUMENT_MEDIA_TYPES[t] === mediaType)) {
    return 'type_not_allowed';
  }
  if (file.sizeBytes > settings.maxUploadMb * 1024 * 1024) return 'too_large';
  return 'ok';
}

/**
 * Characters a title or note may not hold: control characters (C0, DEL and C1; a note may
 * keep line breaks and tabs), the line and paragraph separators, bidirectional marks,
 * embeddings, overrides and isolates (and the Arabic letter mark), and invisible ones
 * (zero-width spaces and joiners, the word joiner, the byte-order mark), as for branding
 * text. The database's CHECKs spell out the same lists.
 */
const UNSAFE_LINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const UNSAFE_NOTE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

/** A title: one line (whitespace runs, line breaks included, become one space), 1–120. */
export const DocumentTitle = z
  .string()
  .overwrite((s) => s.replace(/[ \t\r\n]+/g, ' ').trim())
  .min(1, 'Enter a title.')
  .max(DOCUMENT_LIMITS.title, `Up to ${DOCUMENT_LIMITS.title} characters.`)
  .refine((s) => !UNSAFE_LINE.test(s), 'Remove control and invisible characters.');

/** A note to the patient: several lines allowed, trimmed, up to 500; blank is none. */
export const DocumentNote = z
  .string()
  .trim()
  .max(DOCUMENT_LIMITS.note, `Up to ${DOCUMENT_LIMITS.note} characters.`)
  .refine((s) => !UNSAFE_NOTE.test(s), 'Remove control and invisible characters.')
  .nullish()
  .transform((s) => (s ? s : null));

/** An optional category: missing, null or "" is none. */
const optionalCategory = z
  .union([z.literal('').transform(() => null), DocumentCategory])
  .nullish()
  .transform((c) => c ?? null);

// ---- Files ------------------------------------------------------------------------------

/** `POST /document-files` answers with the stored file; use its `id` within 24 hours. */
export const DocumentFile = z.object({
  id: z.uuid(),
  mediaType: DocumentMediaType,
  sizeBytes: z.number().int().positive(),
  uploadedAt: z.iso.datetime(),
});
export type DocumentFile = z.infer<typeof DocumentFile>;

// ---- The clinic library -----------------------------------------------------------------

export const LibraryDocument = z.object({
  id: z.uuid(),
  title: z.string(),
  category: DocumentCategory.nullable(),
  language: DocumentLanguage,
  /** The current file (its type and size); shares keep the file they were made with. */
  mediaType: DocumentMediaType,
  sizeBytes: z.number().int().positive(),
  archived: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** How many times it has been shared with patients (withdrawn shares included). */
  shareCount: z.number().int().min(0),
});
export type LibraryDocument = z.infer<typeof LibraryDocument>;

export const LibraryDocumentList = z.object({ data: z.array(LibraryDocument) });
export type LibraryDocumentList = z.infer<typeof LibraryDocumentList>;

/** `GET /library-documents?q&status&category`: newest first. */
export const LibraryDocumentQuery = z.object({
  /** Words in the title, in any case. */
  q: z.string().trim().max(DOCUMENT_LIMITS.title).optional(),
  status: z.enum(['active', 'archived']).default('active'),
  category: DocumentCategory.optional(),
});
export type LibraryDocumentQuery = z.infer<typeof LibraryDocumentQuery>;

/** `POST /library-documents`: a fresh upload of the signed-in user's, with its details. */
export const CreateLibraryDocumentBody = z.object({
  fileId: z.uuid(),
  title: DocumentTitle,
  category: optionalCategory,
  language: DocumentLanguage,
});
export type CreateLibraryDocumentBody = z.infer<typeof CreateLibraryDocumentBody>;

/**
 * `PATCH /library-documents/{id}`: rename, recategorise, change the language, replace the
 * file (a fresh upload), archive or restore. At least one field.
 */
export const UpdateLibraryDocumentBody = z
  .object({
    title: DocumentTitle.optional(),
    category: z
      .union([z.literal('').transform(() => null), DocumentCategory.nullable()])
      .optional(),
    language: DocumentLanguage.optional(),
    fileId: z.uuid().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Change at least one field.');
export type UpdateLibraryDocumentBody = z.infer<typeof UpdateLibraryDocumentBody>;

// ---- Shared with a patient --------------------------------------------------------------

const shareFields = {
  /** The visit it is shared at (the consultation screen); the patient's own visit. */
  appointmentId: z
    .uuid()
    .nullish()
    .transform((id) => id ?? null),
  note: DocumentNote,
};

/** `POST /patients/{id}/documents`: a library sheet, or a fresh upload with its details. */
export const ShareDocumentBody = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('library'),
    libraryDocumentId: z.uuid(),
    ...shareFields,
  }),
  z.object({
    source: z.literal('upload'),
    fileId: z.uuid(),
    title: DocumentTitle,
    category: optionalCategory,
    language: DocumentLanguage.nullish().transform((l) => l ?? null),
    ...shareFields,
  }),
]);
export type ShareDocumentBody = z.infer<typeof ShareDocumentBody>;

const StaffRef = z.object({ userId: z.uuid(), name: z.string().nullable() });

/** A document shared with a patient, as doctors see it on the patient page and the visit. */
export const PatientDocument = z.object({
  id: z.uuid(),
  /** The record it was shared with (a merged duplicate's shares show under the kept one). */
  patientId: z.uuid(),
  appointmentId: z.uuid().nullable(),
  source: PatientDocumentSource,
  /** The sheet it came from (library shares); the sheet may since be renamed or archived. */
  libraryDocumentId: z.uuid().nullable(),
  /** As shared; renaming the sheet later does not change it. */
  title: z.string(),
  category: DocumentCategory.nullable(),
  language: DocumentLanguage.nullable(),
  note: z.string().nullable(),
  mediaType: DocumentMediaType,
  sizeBytes: z.number().int().positive(),
  sharedAt: z.iso.datetime(),
  sharedBy: StaffRef,
  /** When the patient (or someone on their account) first opened it. */
  openedAt: z.iso.datetime().nullable(),
  withdrawnAt: z.iso.datetime().nullable(),
  withdrawnBy: StaffRef.nullable(),
});
export type PatientDocument = z.infer<typeof PatientDocument>;

/** `GET /patients/{id}/documents?appointmentId&limit&cursor`: newest first. */
export const PatientDocumentListQuery = CursorQuery.extend({
  /** Only the documents shared at this visit. */
  appointmentId: z.uuid().optional(),
});
export type PatientDocumentListQuery = z.infer<typeof PatientDocumentListQuery>;

export const PatientDocumentList = page(PatientDocument);
export type PatientDocumentList = z.infer<typeof PatientDocumentList>;

// ---- The patient portal -----------------------------------------------------------------

/** A document shared with someone on the account, as the portal lists it (not withdrawn). */
export const PortalDocument = z.object({
  id: z.uuid(),
  /** The record in use: the kept one when the shared-with record was merged. */
  patient: z.object({ id: z.uuid(), name: z.string() }),
  title: z.string(),
  category: DocumentCategory.nullable(),
  language: DocumentLanguage.nullable(),
  note: z.string().nullable(),
  mediaType: DocumentMediaType,
  sizeBytes: z.number().int().positive(),
  sharedAt: z.iso.datetime(),
  doctorName: z.string().nullable(),
  /** Not opened yet by anyone on the account. */
  isNew: z.boolean(),
});
export type PortalDocument = z.infer<typeof PortalDocument>;

/** `GET /portal/documents?limit&cursor`: newest first. */
export const PortalDocumentListQuery = CursorQuery;
export type PortalDocumentListQuery = z.infer<typeof PortalDocumentListQuery>;

export const PortalDocumentList = page(PortalDocument);
export type PortalDocumentList = z.infer<typeof PortalDocumentList>;

/**
 * The name a document is saved under, e.g. `document-2.pdf`. It says nothing about the
 * document (anyone looking at the downloads folder sees it); the page names it.
 */
export function documentFileName(n: number, mediaType: string): string {
  const index = Number.isInteger(n) && n > 0 ? n : 1;
  const type = (Object.keys(DOCUMENT_MEDIA_TYPES) as DocumentType[]).find(
    (t) => DOCUMENT_MEDIA_TYPES[t] === mediaType.split(';')[0]!.trim().toLowerCase(),
  );
  const extension = type ? { pdf: 'pdf', jpeg: 'jpg', png: 'png', webp: 'webp' }[type] : 'bin';
  return `document-${index}.${extension}`;
}
