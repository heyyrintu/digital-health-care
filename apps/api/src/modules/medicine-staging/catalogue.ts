import { createHash } from 'node:crypto';
import { z } from 'zod';

export const FILES = {
  'SubstanceMaster.txt': ['Identifier', 'Substance Name'],
  'ProductMaster.txt': ['Identifier', 'Product Name'],
  'SupplierMaster.txt': ['Identifier', 'Supplier Name'],
  'DrugFormMaster.txt': ['Id', 'Dose Form'],
  'RouteOfAdministrationMaster.txt': ['Identifier', 'RouteOfAdministration'],
  'GenericMaster.txt': [
    'Identifier',
    'Generic Name',
    'Substance Identifier',
    'Route of Administration',
    'Dose Form',
  ],
  'BrandMaster.txt': [
    'Identifier',
    'Brand Name',
    'Product Identifier',
    'Supplier Identifier',
    'Generic Identifier',
    'License Status',
  ],
} as const;
export type FileName = keyof typeof FILES;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ROWS = 200_000;
export const Manifest = z
  .object({
    format: z.literal('cdci-flat-files/v1'),
    dataKind: z.literal('synthetic'),
    datasetKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
    version: z.string().trim().min(1).max(80),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;
export const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const identifier = z.string().regex(/^\d{1,18}$/);
const namedReference = z.object({ sourceId: identifier, name: z.string().min(1) }).strict();
export const Candidate = z
  .object({
    sourceId: identifier,
    name: z.string().min(1),
    product: namedReference,
    supplier: namedReference,
    generic: namedReference,
    ingredients: z.array(namedReference).min(1),
    routes: z.array(namedReference).min(1),
    form: namedReference,
    sourceUpdatedAt: z.iso.date().nullable(),
    regulatoryStatus: z.string().min(1),
    clinicalSafety: z.literal('not_assessed'),
    reviewRequired: z.tuple([
      z.literal('strength_mapping'),
      z.literal('route_mapping'),
      z.literal('clinical_review'),
      z.literal('regulatory_review'),
    ]),
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;
export const Catalogue = z
  .object({
    schemaVersion: z.literal(1),
    source: Manifest,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    publicationAllowed: z.literal(false),
    records: z.array(Candidate).max(MAX_ROWS),
  })
  .strict();
export type Catalogue = z.infer<typeof Catalogue>;
type Row = { line: number; values: Record<string, string> };
export type Issue = { file: FileName; line: number; sourceId: string; reason: string };

/** Quoted TSV, including embedded tabs/newlines; no evaluation or formula handling. */
function parseTsv(text: string): { line: number; cells: string[] }[] {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Source file exceeds 32 MiB.');
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const cell = () => {
    cells.push(field);
    if (cells.length > 100) throw new Error('Source column limit exceeded.');
    field = '';
    closed = false;
  };
  const row = () => {
    cell();
    if (cells.some((v) => v.trim())) rows.push({ line: start, cells });
    cells = [];
    if (rows.length > MAX_ROWS + 1) throw new Error('Source file exceeds the row limit.');
  };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\0') throw new Error('NUL bytes are not allowed.');
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += c;
        if (c === '\n') line++;
      }
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else if (c === '\t') cell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row();
      line++;
      start = line;
    } else {
      if (closed) throw new Error('Unexpected text after a quoted field.');
      field += c;
    }
    if (field.length > 100_000 || cells.length > 100)
      throw new Error('Source field or column limit exceeded.');
  }
  if (quoted) throw new Error('Unclosed quoted field.');
  if (field || cells.length || closed) row();
  return rows;
}

function table(file: FileName, text: string, issues: Issue[]) {
  const parsed = parseTsv(text),
    header = parsed.shift()?.cells.map((v) => v.trim());
  if (
    !header?.length ||
    header.some((v) => !v) ||
    new Set(header).size !== header.length ||
    FILES[file].some((c) => !header.includes(c))
  )
    throw new Error(`${file}: missing, empty or duplicate column headers.`);
  const rows: Row[] = [],
    counts = new Map<string, number>();
  for (const r of parsed) {
    const values = Object.fromEntries(header.map((h, i) => [h, (r.cells[i] ?? '').trim()]));
    const id = values[FILES[file][0]] ?? '';
    const issue = (reason: string) => issues.push({ file, line: r.line, sourceId: id, reason });
    if (!identifier.safeParse(id).success) {
      issue('invalid_identifier');
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (r.cells.length < header.length || r.cells.slice(header.length).some((v) => v.trim())) {
      issue('column_count');
      continue;
    }
    rows.push({ line: r.line, values });
  }
  const index = new Map<string, Row>();
  for (const r of rows) {
    const id = r.values[FILES[file][0]]!;
    if (counts.get(id)! > 1)
      issues.push({ file, line: r.line, sourceId: id, reason: 'duplicate_identifier' });
    else if (!r.values[FILES[file][1]]!)
      issues.push({ file, line: r.line, sourceId: id, reason: 'missing_name' });
    else index.set(id, r);
  }
  return { inputRows: parsed.length, index };
}

function sourceDate(value: string | undefined): string | null | false {
  if (!value) return null;
  if (!/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  return z.iso.date().safeParse(iso).success ? iso : false;
}

export function stageCatalogue(rawManifest: unknown, files: Record<FileName, string>) {
  const source = Manifest.parse(rawManifest),
    issues: Issue[] = [];
  const hashes = Object.fromEntries(
    (Object.keys(FILES) as FileName[]).map((f) => [f, digest(files[f])]),
  );
  const fingerprint = digest(JSON.stringify({ schemaVersion: 1, source, hashes }));
  const tables = Object.fromEntries(
    (Object.keys(FILES) as FileName[]).map((f) => [f, table(f, files[f], issues)]),
  ) as Record<FileName, ReturnType<typeof table>>;
  const ref = (file: FileName, id: string) => {
    const row = tables[file].index.get(id);
    return row ? { sourceId: id, name: row.values[FILES[file][1]]! } : null;
  };
  const refs = (file: FileName, ids: string) => {
    const parts = ids.split('+').map((v) => v.trim());
    if (new Set(parts).size !== parts.length) return null;
    const result = parts.map((id) => ref(file, id));
    return result.every((r): r is NonNullable<typeof r> => r !== null) ? result : null;
  };
  const generics = new Map<
    string,
    {
      generic: Candidate['generic'];
      ingredients: Candidate['ingredients'];
      routes: Candidate['routes'];
      form: Candidate['form'];
    }
  >();
  for (const [id, r] of tables['GenericMaster.txt'].index) {
    const ingredients = refs('SubstanceMaster.txt', r.values['Substance Identifier']!),
      routes = refs('RouteOfAdministrationMaster.txt', r.values['Route of Administration']!),
      form = ref('DrugFormMaster.txt', r.values['Dose Form']!);
    if (!ingredients || !routes || !form || sourceDate(r.values.last_updated_on) === false) {
      issues.push({
        file: 'GenericMaster.txt',
        line: r.line,
        sourceId: id,
        reason: 'invalid_generic_references_or_date',
      });
      continue;
    }
    generics.set(id, { generic: ref('GenericMaster.txt', id)!, ingredients, routes, form });
  }
  const records: Candidate[] = [];
  for (const [id, r] of tables['BrandMaster.txt'].index) {
    const product = ref('ProductMaster.txt', r.values['Product Identifier']!),
      supplier = ref('SupplierMaster.txt', r.values['Supplier Identifier']!),
      generic = generics.get(r.values['Generic Identifier']!),
      date = sourceDate(r.values.last_updated_on);
    if (!product || !supplier || !generic || date === false) {
      const reasons = [
        !product && 'product_reference',
        !supplier && 'supplier_reference',
        !generic && 'generic_reference',
        date === false && 'source_date',
      ].filter(Boolean);
      issues.push({
        file: 'BrandMaster.txt',
        line: r.line,
        sourceId: id,
        reason: reasons.join(','),
      });
      continue;
    }
    records.push({
      sourceId: id,
      name: r.values['Brand Name']!,
      product,
      supplier,
      ...generic,
      sourceUpdatedAt: date,
      regulatoryStatus: r.values['License Status'] || 'UNKNOWN',
      clinicalSafety: 'not_assessed',
      reviewRequired: ['strength_mapping', 'route_mapping', 'clinical_review', 'regulatory_review'],
    });
  }
  records.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  const catalogue = Catalogue.parse({
    schemaVersion: 1,
    source,
    fingerprint,
    publicationAllowed: false,
    records,
  });
  return {
    catalogue,
    report: {
      fingerprint,
      source,
      publicationAllowed: false,
      tables: Object.fromEntries(
        (Object.keys(FILES) as FileName[]).map((f) => [
          f,
          { inputRows: tables[f].inputRows, indexedRows: tables[f].index.size },
        ]),
      ),
      candidateBrands: records.length,
      rejectedBrands: tables['BrandMaster.txt'].inputRows - records.length,
      issues,
      clinicalSafety: 'not_assessed' as const,
    },
    provenance: { schemaVersion: 1, source, fingerprint, fileSha256: hashes },
  };
}

/** Missing rows are a review signal, never an instruction to deactivate live medicines. */
export function compareCatalogues(current: Catalogue, untrustedPrevious: unknown) {
  const previous = Catalogue.parse(untrustedPrevious);
  if (previous.source.datasetKey !== current.source.datasetKey)
    throw new Error('Cannot compare different source datasets.');
  if (
    previous.source.version === current.source.version &&
    previous.fingerprint !== current.fingerprint
  )
    throw new Error(
      'Source version reused for different input bytes. Choose a new source version.',
    );
  const indexed = (rows: Candidate[]) => {
    const map = new Map(rows.map((r) => [r.sourceId, r]));
    if (map.size !== rows.length)
      throw new Error('Previous catalogue contains duplicate source identifiers.');
    return map;
  };
  const before = indexed(previous.records),
    after = indexed(current.records);
  const added: string[] = [],
    changed: string[] = [],
    unchanged: string[] = [];
  for (const [id, row] of after) {
    const old = before.get(id);
    if (!old) added.push(id);
    else if (JSON.stringify(old) !== JSON.stringify(row)) changed.push(id);
    else unchanged.push(id);
  }
  return {
    previousFingerprint: previous.fingerprint,
    currentFingerprint: current.fingerprint,
    added,
    changed,
    unchanged,
    missingForReview: [...before.keys()].filter((id) => !after.has(id)),
    automaticDeactivationAllowed: false,
  };
}
