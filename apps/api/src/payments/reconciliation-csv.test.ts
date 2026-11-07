import { expect, it } from 'vitest';
import { csvCell, reconciliationCsv } from './reconciliation-csv';
it('quotes CSV delimiters and neutralizes provider-controlled formulas, including whitespace prefixes', () => {
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  for (const value of [
    '=HYPERLINK("https://example.test")',
    '+1+1',
    '-1+2',
    '@SUM(1)',
    '\t=1+1',
    ' \r\n=1+1',
  ])
    expect(csvCell(value).startsWith('"\'')).toBe(true);
  expect(csvCell(-500n)).toBe('"-500"');
  expect(csvCell(1234567890123456789n)).toBe('"1234567890123456789"');
  expect(csvCell(null)).toBe('""');
});
it('writes headers for empty reports and uses UTF-8 BOM and CRLF', () => {
  expect(reconciliationCsv(['value'], [])).toBe('\uFEFF"value"\r\n');
  expect(reconciliationCsv(['value'], [[10n]])).toBe('\uFEFF"value"\r\n"10"\r\n');
});
