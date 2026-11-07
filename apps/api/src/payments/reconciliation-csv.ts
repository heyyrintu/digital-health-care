/** Quote RFC 4180 fields and neutralize spreadsheet formulas in provider-controlled text. */
export function csvCell(value: string | bigint | number | null): string {
  let text = value === null ? '' : String(value);
  // eslint-disable-next-line no-control-regex -- Provider text may hide a formula behind control characters.
  if (typeof value === 'string' && /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(text))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function reconciliationCsv(
  headers: string[],
  rows: (string | bigint | number | null)[][],
): string {
  return (
    '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
