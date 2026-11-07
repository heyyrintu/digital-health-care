import { z } from 'zod';
export const IMPORT_FIELDS = [
  'externalId',
  'name',
  'phone',
  'dob',
  'gender',
  'email',
  'address',
  'uhid',
] as const;
export const ImportMapping = z
  .object({
    externalId: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    phone: z.string().min(1).max(120),
    dob: z.string().max(120).optional(),
    gender: z.string().max(120).optional(),
    email: z.string().max(120).optional(),
    address: z.string().max(120).optional(),
    uhid: z.string().max(120).optional(),
  })
  .strict();
export const PreviewPatientImport = z
  .object({
    id: z.uuid(),
    source: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/),
    csv: z.string().min(1).max(262144),
    mapping: ImportMapping,
  })
  .strict();
export type PreviewPatientImport = z.infer<typeof PreviewPatientImport>;
export const ApplyPatientImport = z.object({ acknowledged: z.literal(true) }).strict();
export const ImportRow = z.object({
  row: z.number().int(),
  externalId: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  dob: z.string().nullable(),
  gender: z.enum(['male', 'female', 'other']).nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  uhid: z.string().nullable(),
  issues: z.array(z.string()),
  warnings: z.array(z.string()),
  state: z.enum(['new', 'already_imported', 'error']),
  patientId: z.uuid().nullable(),
  rowHash: z.string(),
});
export type ImportRow = z.infer<typeof ImportRow>;
export const PatientImport = z.object({
  id: z.uuid(),
  source: z.string(),
  status: z.enum(['preview', 'applied', 'cancelled']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  createdByUserId: z.uuid(),
  appliedAt: z.iso.datetime().nullable(),
  rows: z.array(ImportRow),
  newCount: z.number().int(),
  skippedCount: z.number().int(),
  errorCount: z.number().int(),
});
export type PatientImport = z.infer<typeof PatientImport>;
export const PatientImportList = z.object({
  data: z.array(
    z.object({
      id: z.uuid(),
      source: z.string(),
      status: z.enum(['preview', 'applied', 'cancelled']),
      createdAt: z.iso.datetime(),
    }),
  ),
});
/** Bounded RFC 4180-style UTF-8 CSV. Reject ambiguous quoting instead of guessing. */
export function parseImportCsv(input: string): string[][] {
  if (input.length > 262144 || input.includes('\0'))
    throw new Error('CSV must be at most 256 KiB and contain no null characters.');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const field = () => {
    row.push(cell.trim());
    cell = '';
    closed = false;
    if (row.length > 40) throw new Error('Use at most 40 columns.');
  };
  const line = () => {
    field();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > 101) throw new Error('Use at most 100 patient rows per file.');
  };
  const text = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new Error('Invalid CSV quoting.');
      quoted = true;
    } else if (c === ',') field();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line();
    } else {
      if (closed) throw new Error('Unexpected text after a closing quote.');
      cell += c;
    }
    if (cell.length > 4000) throw new Error('A CSV cell exceeds 4,000 characters.');
  }
  if (quoted) throw new Error('An enclosed CSV field was not closed.');
  if (cell || closed || row.length) line();
  const header = rows[0];
  if (
    !header ||
    rows.length < 2 ||
    header.some((x) => !x || x.length > 120) ||
    new Set(header).size !== header.length
  )
    throw new Error('Use a unique, nonempty header and at least one data row.');
  if (rows.some((r) => r.length !== header.length))
    throw new Error('Every row must have the same number of columns as the header.');
  return rows;
}
export type PatientImportList = z.infer<typeof PatientImportList>;
