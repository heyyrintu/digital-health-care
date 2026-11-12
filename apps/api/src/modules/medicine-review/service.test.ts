import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MedicineReviewBundle } from '@dhc/contracts';
import { validateReviewBundle } from './service';

const fixture = new URL(
  '../../../test/fixtures/cdci-synthetic/review-bundle.json',
  import.meta.url,
);
const fresh = () => MedicineReviewBundle.parse(JSON.parse(readFileSync(fixture, 'utf8')));
it('validates the reproducible synthetic bundle', () => {
  expect(validateReviewBundle(fresh()).catalogue.records).toHaveLength(2);
});
it('rejects conflicting names for the same source reference', () => {
  const b = fresh();
  b.catalogue.records[1]!.supplier = {
    ...b.catalogue.records[0]!.supplier,
    name: 'Conflicting fabricated supplier',
  };
  expect(() => validateReviewBundle(b)).toThrow('conflicting names');
});
it('rejects omitted source hashes and changed hashes without a matching fingerprint', () => {
  const b = fresh();
  b.provenance.fileSha256['BrandMaster.txt'] = '0'.repeat(64);
  expect(() => validateReviewBundle(b)).toThrow('fingerprint');
  const incomplete = JSON.parse(JSON.stringify(b));
  delete incomplete.provenance.fileSha256['BrandMaster.txt'];
  expect(() => validateReviewBundle(incomplete)).toThrow();
});
it('bounds review candidates and quarantine reports', () => {
  const b = fresh();
  b.catalogue.records = [];
  expect(() => validateReviewBundle(b)).toThrow();
  b.catalogue.records = Array.from({ length: 501 }, () => fresh().catalogue.records[0]!);
  expect(() => validateReviewBundle(b)).toThrow();
  const manyIssues = fresh();
  manyIssues.report.issues = Array.from({ length: 2001 }, () => fresh().report.issues[0]!);
  expect(() => validateReviewBundle(manyIssues)).toThrow();
});

it('rejects blank labels and contradictory indexed/quarantine evidence', () => {
  const blank = fresh();
  blank.catalogue.records[0]!.supplier.name = '   ';
  expect(() => validateReviewBundle(blank)).toThrow();
  const counts = fresh();
  counts.report.tables['BrandMaster.txt'].indexedRows = 0;
  expect(() => validateReviewBundle(counts)).toThrow('counts');
  const quarantined = fresh();
  quarantined.report.issues[0]!.sourceId = quarantined.catalogue.records[0]!.sourceId;
  expect(() => validateReviewBundle(quarantined)).toThrow('also be quarantined');
});
