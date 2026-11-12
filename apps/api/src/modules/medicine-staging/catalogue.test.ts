import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FILES, compareCatalogues, stageCatalogue, type FileName } from './catalogue';

const fixture = new URL('../../../test/fixtures/cdci-synthetic/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixture), 'utf8'));
const source = () =>
  Object.fromEntries(
    (Object.keys(FILES) as FileName[]).map((f) => [f, readFileSync(new URL(f, fixture), 'utf8')]),
  ) as Record<FileName, string>;
const stage = (files = source()) => stageCatalogue(manifest, files);

it('stages linked catalogue entries without turning source text into clinical rules', () => {
  const r = stage();
  expect(r.catalogue.publicationAllowed).toBe(false);
  expect(r.catalogue.records).toHaveLength(2);
  expect(r.report.rejectedBrands).toBe(1);
  expect(r.report.issues).toContainEqual(
    expect.objectContaining({ sourceId: '990000000000000703', reason: 'generic_reference' }),
  );
  const one = r.catalogue.records[0]!;
  expect(one.sourceId).toBe('990000000000000701'); // Beyond JS's safe integer range.
  expect(one.generic.sourceId).toBe('990000000000000201');
  expect(one.clinicalSafety).toBe('not_assessed');
  expect(one.regulatoryStatus).toBe('UNKNOWN');
  expect(one).not.toHaveProperty('strengthMg');
  expect(JSON.stringify(r.catalogue)).not.toContain('Synthetic narrative');
  expect(r.catalogue.records[1]!.ingredients).toHaveLength(2);
  expect(r.catalogue.records[1]!.routes).toHaveLength(2);
});

it('preserves a reproducible fingerprint and detects changed source bytes', () => {
  const a = stage(),
    b = stage();
  expect(a).toEqual(b);
  const files = source();
  files['BrandMaster.txt'] += '\n';
  expect(stage(files).catalogue.fingerprint).not.toBe(a.catalogue.fingerprint);
});

it('rejects real-data declarations before preparing records', () => {
  expect(() => stageCatalogue({ ...manifest, dataKind: 'licensed' }, source())).toThrow();
  expect(() =>
    stageCatalogue({ ...manifest, dataKind: 'real', licenseApproved: true }, source()),
  ).toThrow();
});

it('handles BOM, CRLF, quoted tabs, escaped quotes, embedded newlines and empty trailing cells', () => {
  const files = source();
  files['ProductMaster.txt'] =
    '\uFEFFIdentifier\tProduct Name\r\n990000000000000601\t"Synthetic\t""quoted""\nname"\t\r\n990000000000000602\tSynthetic second\t\r\n';
  expect(stage(files).catalogue.records[0]!.product.name).toBe('Synthetic\t"quoted"\nname');
});

it.each([
  'Identifier\tIdentifier\n',
  'Identifier\tWrong Name\n',
  'Identifier\tProduct Name\n1\t"unclosed',
])('fails closed for malformed source tables', (bad) => {
  const files = source();
  files['ProductMaster.txt'] = bad;
  expect(() => stage(files)).toThrow();
});

it('resolves explicit header names when a source reorders columns', () => {
  const files = source();
  files['ProductMaster.txt'] =
    'Product Name\tIdentifier\nSynthetic first\t990000000000000601\nSynthetic second\t990000000000000602\n';
  expect(stage(files).catalogue.records[0]!.product.name).toBe('Synthetic first');
});

it('quarantines every duplicate identifier and the brands that depend on it', () => {
  const files = source();
  files['GenericMaster.txt'] += files['GenericMaster.txt'].split('\n')[1] + '\n';
  const r = stage(files);
  expect(r.report.issues.filter((i) => i.reason === 'duplicate_identifier')).toHaveLength(2);
  expect(r.catalogue.records.map((r) => r.sourceId)).toEqual(['990000000000000702']);
});

it('does not accept a valid row whose duplicate has malformed extra columns', () => {
  const files = source();
  files['GenericMaster.txt'] += files['GenericMaster.txt'].split('\n')[1] + '\tunexpected\n';
  expect(stage(files).catalogue.records.map((r) => r.sourceId)).toEqual(['990000000000000702']);
});

it.each(['Substance Identifier', 'Route of Administration', 'Dose Form'])(
  'propagates invalid %s references to brand quarantine',
  (column) => {
    const files = source(),
      lines = files['GenericMaster.txt'].split('\n'),
      index = lines[0]!.split('\t').indexOf(column);
    const cells = lines[1]!.split('\t');
    cells[index] = '990000000000000999';
    lines[1] = cells.join('\t');
    files['GenericMaster.txt'] = lines.join('\n');
    expect(stage(files).catalogue.records.map((r) => r.sourceId)).toEqual(['990000000000000702']);
  },
);

it('rejects invalid dates instead of coercing them to another calendar day', () => {
  const files = source();
  files['BrandMaster.txt'] = files['BrandMaster.txt'].replaceAll('20260103', '20260231');
  expect(stage(files).catalogue.records).toHaveLength(0);
  expect(stage(files).report.issues.some((i) => i.reason.includes('source_date'))).toBe(true);
});

it('diffs stable source identifiers without issuing deactivation instructions', () => {
  const previous = stage().catalogue,
    files = source();
  files['BrandMaster.txt'] = files['BrandMaster.txt'].replace(
    'Synthetic brand One',
    'Synthetic renamed brand',
  );
  const current = stageCatalogue({ ...manifest, version: 'fixture-2' }, files).catalogue;
  current.records = current.records.filter((r) => r.sourceId !== '990000000000000702');
  const diff = compareCatalogues(current, previous);
  expect(diff.changed).toEqual(['990000000000000701']);
  expect(diff.missingForReview).toEqual(['990000000000000702']);
  expect(diff.automaticDeactivationAllowed).toBe(false);
  expect(previous.records[0]!.name).toBe('Synthetic brand One');
  expect(() =>
    compareCatalogues(current, {
      ...previous,
      source: { ...previous.source, datasetKey: 'different' },
    }),
  ).toThrow('different source');
  expect(() =>
    compareCatalogues(current, {
      ...previous,
      records: [previous.records[0], previous.records[0]],
    }),
  ).toThrow('duplicate');
});

it('rejects reusing a release version for a different input', () => {
  const previous = stage().catalogue,
    files = source();
  files['BrandMaster.txt'] += '\n';
  expect(() => compareCatalogues(stage(files).catalogue, previous)).toThrow(
    'Source version reused',
  );
});

it('reports additions and unchanged rows by identifier', () => {
  const previous = stage().catalogue,
    files = source();
  files['BrandMaster.txt'] = files['BrandMaster.txt'].replace(
    '990000000000000299',
    '990000000000000201',
  );
  const current = stageCatalogue({ ...manifest, version: 'fixture-2' }, files).catalogue;
  const delta = compareCatalogues(current, previous);
  expect(delta.added).toEqual(['990000000000000703']);
  expect(delta.unchanged).toEqual(['990000000000000701', '990000000000000702']);
  expect(delta.changed).toEqual([]);
});

it('keeps the browser review fixture reproducible from the seven synthetic source tables', () => {
  const prepared = JSON.parse(readFileSync(new URL('review-bundle.json', fixture), 'utf8'));
  expect(prepared).toEqual(stage());
});
