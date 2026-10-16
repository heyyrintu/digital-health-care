/** The cache folder the Patient app keeps opened prescription PDFs in; emptied on sign-out. */
export const PDF_FOLDER = 'prescriptions';

/**
 * A safe file name for a prescription PDF, e.g. `SG-00042-v2.pdf`: the number with anything
 * but letters, digits, `-` and `_` turned into `-`, so it can never leave the cache folder or
 * trip a viewer app. The share sheet shows it, so it says which prescription and version.
 */
export function prescriptionPdfName(number: string, version: number): string {
  const base =
    number
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 60) || 'prescription';
  const v = Number.isInteger(version) && version > 0 ? version : 1;
  return `${base}-v${v}.pdf`;
}
