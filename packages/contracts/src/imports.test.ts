import { expect, it } from 'vitest';
import { parseImportCsv, PreviewPatientImport } from './imports';
it('parses BOM, CRLF, quoted comma/newline and escaped quotes without executing spreadsheet content', () => {
  expect(parseImportCsv('\uFEFFid,name\r\n1,"A, B"\r\n2,"A\n""B"""\r\n3,=formula()')).toEqual([
    ['id', 'name'],
    ['1', 'A, B'],
    ['2', 'A\n"B"'],
    ['3', '=formula()'],
  ]);
});
it('rejects ambiguous or unbounded input', () => {
  for (const csv of [
    'id,id\n1,2',
    'id,name\n1',
    'id\n"open',
    'id\n"closed"x',
    'id\n' + 'x'.repeat(4001),
    'id\n' + Array(101).fill('1').join('\n'),
    'id\n\0',
  ])
    expect(() => parseImportCsv(csv)).toThrow();
  expect(() => PreviewPatientImport.parse({ id: 'invalid' })).toThrow();
});
