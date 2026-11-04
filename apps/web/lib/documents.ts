import { ApiError } from '@dhc/api-client';
import {
  checkDocumentUpload,
  DOCUMENT_MEDIA_TYPES,
  documentTypesFor,
  MAX_LIBRARY_DOCUMENTS,
  MAX_UPLOAD_MB,
  type DocumentType,
  type OrganisationSettings,
} from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';

/**
 * Pure helpers behind the clinic library, the Share document dialog and the documents
 * cards (PRD §7.3), kept out of the components so they can be unit tested.
 */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
type Limits = Pick<OrganisationSettings, 'maxUploadMb' | 'uploadTypes'>;

/** Until the clinic's settings load: every document type, up to the platform ceiling. */
const ANY: Limits = { maxUploadMb: MAX_UPLOAD_MB, uploadTypes: ['pdf', 'jpeg', 'png'] };

const EXTENSION_TYPES: Record<string, DocumentType> = {
  pdf: 'pdf',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
};

/** The file picker's `accept`: the clinic's document types, as media types. */
export const documentAccept = (settings: Limits | null) =>
  documentTypesFor(settings ?? ANY)
    .map((t) => DOCUMENT_MEDIA_TYPES[t])
    .join(',');

/** "PDF, JPEG, PNG, WebP": the clinic's document types, for messages. */
export const documentTypeNames = (settings: Limits | null) =>
  documentTypesFor(settings ?? ANY)
    .map((t) => (t === 'webp' ? 'WebP' : t.toUpperCase()))
    .join(', ');

/**
 * A chosen file before it is sent: refused with the reason in the screen's language (not a
 * type the clinic takes, empty, or over its limit), or the media type to send it as (read
 * from the name when the browser gives none). The server checks again, and the content.
 */
export function checkDocumentFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  settings: Limits | null,
  t: Translate,
): { text: string } | { mediaType: string } {
  const limits = settings ?? ANY;
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const fromName = EXTENSION_TYPES[extension];
  const mediaType =
    file.type.trim().toLowerCase() || (fromName ? DOCUMENT_MEDIA_TYPES[fromName] : '');
  if (file.size === 0) return { text: t('documents.file.empty') };
  const check = checkDocumentUpload(limits, { mediaType, sizeBytes: file.size });
  if (check === 'type_not_allowed') {
    return { text: t('documents.file.type_not_allowed', { types: documentTypeNames(settings) }) };
  }
  if (check === 'too_large')
    return { text: t('documents.file.too_large', { mb: limits.maxUploadMb }) };
  return { mediaType };
}

const FILE_REASONS = [
  'empty',
  'too_large',
  'type_not_allowed',
  'type_mismatch',
  'not_a_document',
  'animated',
  'too_many_pixels',
  'too_many_pages',
  'encrypted',
  'busy',
  'unavailable',
] as const;

/**
 * What to show for a refused upload, sheet or share: our wording for the file's reasons
 * (which need the clinic's limits for two of them), the chart model, and otherwise the
 * server's own message, which says what to do.
 */
export function documentErrorText(e: unknown, t: Translate, settings: Limits | null): string {
  if (!(e instanceof ApiError)) return t('error.network');
  if (e.code === 'CHART_RESTRICTED') return t('chart.restricted');
  const reason = e.fields.file;
  if (reason && (FILE_REASONS as readonly string[]).includes(reason)) {
    if ((reason === 'too_large' || reason === 'type_not_allowed') && !settings) return e.message;
    return t(`documents.file.${reason as (typeof FILE_REASONS)[number]}`, {
      mb: settings?.maxUploadMb ?? MAX_UPLOAD_MB,
      types: documentTypeNames(settings),
    });
  }
  if (e.fields.fileId === 'expired') return t('documents.error.fileExpired');
  if (e.fields.fileId === 'used') return t('documents.error.fileUsed');
  if (e.fields.fileId === 'invalid') return t('documents.error.fileInvalid');
  if (e.fields.library === 'full') {
    return t('documents.error.libraryFull', { max: MAX_LIBRARY_DOCUMENTS });
  }
  if (e.fields.status === 'archived' || e.fields.libraryDocumentId === 'archived') {
    return t('documents.error.archived');
  }
  if (e.fields.appointmentId === 'not_seen') return t('documents.error.notSeen');
  return e.status >= 500 ? t('error.generic') : e.message;
}
