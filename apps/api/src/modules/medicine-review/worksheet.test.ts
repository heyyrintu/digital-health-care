import { readFileSync } from 'node:fs';
import { MedicineStageDetail, parseImportCsv } from '@dhc/contracts';
import { expect, it } from 'vitest';
import { medicineReviewWorksheet, WORKSHEET_COLUMNS } from './worksheet';

const sample = () =>
  MedicineStageDetail.parse({
    id: '00000000-0000-4000-8000-000000000001',
    datasetKey: 'synthetic-medicine-catalogue',
    sourceVersion: 'fixture-1',
    fingerprint: '6f4f3e710188875b7c015cebfd4397e39180b2361bee6d35a89df48a81818e9f',
    revision: 1,
    state: 'pending',
    candidateCount: 2,
    issueCount: 1,
    createdAt: '2026-11-13T00:00:00.000Z',
    reviewedAt: null,
    reviewerName: null,
    reviewNote: null,
    bundle: JSON.parse(
      readFileSync(
        new URL('../../../test/fixtures/cdci-synthetic/review-bundle.json', import.meta.url),
        'utf8',
      ),
    ),
  });
const at = (row: string[], key: (typeof WORKSHEET_COLUMNS)[number]) =>
  row[WORKSHEET_COLUMNS.indexOf(key)];

it('exports one row per accepted ingredient, with provenance, exact text IDs and blank clinical review fields', () => {
  const csv = medicineReviewWorksheet(sample());
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  const [header, ...rows] = parseImportCsv(csv);
  expect(header).toEqual([...WORKSHEET_COLUMNS]);
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row).toHaveLength(header!.length);
    expect(at(row, 'scope')).toBe('synthetic_sandbox_only');
    expect(at(row, 'clinical_safety')).toBe('not_assessed');
    expect(at(row, 'source_regulatory_status')).toBe('UNKNOWN');
    expect(at(row, 'brand_source_id')).toMatch(/^'99000000000000070[12]$/);
    expect(at(row, 'ingredient_source_id')).toMatch(/^'\d{18}$/);
    expect(at(row, 'source_fingerprint')).toBe("'" + sample().fingerprint);
    expect(
      row.slice(WORKSHEET_COLUMNS.indexOf('review_ingredient_system')).every((cell) => cell === ''),
    ).toBe(true);
  }
  expect(rows.map((r) => at(r, 'brand_name'))).toEqual([
    'Synthetic brand One',
    'Synthetic brand Two',
    'Synthetic brand Two',
  ]);
  expect(csv).not.toContain('990000000000000703'); // Quarantined brand never becomes a candidate.
  expect(at(rows[0]!, 'generic_name')).toContain('5 mg');
  expect(at(rows[0]!, 'review_strength_value')).toBe(''); // No inferred strength.
});

it('quotes delimiters and neutralizes source-controlled spreadsheet formulas', () => {
  const stage = sample();
  stage.bundle.catalogue.records[0]!.name = '  \t=HYPERLINK("https://example.test")';
  stage.bundle.catalogue.records[0]!.supplier.name = '@SUM(1)';
  stage.bundle.catalogue.records[0]!.ingredients[0]!.name = 'Example, "quoted"\nsubstance';
  stage.sourceVersion = '001';
  const [, row] = parseImportCsv(medicineReviewWorksheet(stage));
  expect(at(row!, 'brand_name')).toBe('\'  \t=HYPERLINK("https://example.test")');
  expect(at(row!, 'supplier_name')).toBe("'@SUM(1)");
  expect(at(row!, 'ingredient_name')).toBe('Example, "quoted"\nsubstance');
  expect(at(row!, 'source_version')).toBe("'001");
});

it('bounds row expansion and encoded UTF-8 size before returning an export', () => {
  expect(() => medicineReviewWorksheet(sample(), { bytes: 8 * 1024 * 1024, rows: 2 })).toThrow(
    'export limits',
  );
  expect(() => medicineReviewWorksheet(sample(), { bytes: 10, rows: 100 })).toThrow(
    'export limits',
  );
  const stage = sample();
  stage.bundle.catalogue.records[0]!.name = 'ह'.repeat(3000);
  expect(() => medicineReviewWorksheet(stage, { bytes: 8000, rows: 100 })).toThrow('export limits');
});
