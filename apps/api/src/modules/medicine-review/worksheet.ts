import type { MedicineStageDetail } from '@dhc/contracts';
import { AppError } from '../../errors';
import { csvCell } from '../../payments/reconciliation-csv';

export const WORKSHEET_COLUMNS = [
  'worksheet_format',
  'scope',
  'snapshot_id',
  'dataset_key',
  'source_version',
  'source_fingerprint',
  'snapshot_review_state',
  'brand_source_id',
  'brand_name',
  'product_source_id',
  'product_name',
  'supplier_source_id',
  'supplier_name',
  'generic_source_id',
  'generic_name',
  'ingredient_source_id',
  'ingredient_name',
  'source_form_id',
  'source_form_name',
  'source_route_ids',
  'source_route_names',
  'source_regulatory_status',
  'clinical_safety',
  'review_ingredient_system',
  'review_ingredient_code',
  'review_ingredient_name',
  'review_strength_value',
  'review_strength_unit',
  'review_strength_basis',
  'review_form',
  'review_routes',
  'review_regulatory_evidence',
  'clinical_reviewer_name',
  'reviewed_on',
  'review_decision',
  'review_notes',
] as const;
const REVIEW_COLUMNS =
  WORKSHEET_COLUMNS.length - WORKSHEET_COLUMNS.indexOf('review_ingredient_system');
const identifierText = (value: string) => "'" + value;

/** A human worksheet, never an import or clinical approval. IDs stay text in spreadsheets.
 * Rows are serialized one at a time, with both row and UTF-8 byte bounds before retaining
 * them, since a long source name can otherwise expand across many ingredient rows.
 */
export function medicineReviewWorksheet(
  stage: MedicineStageDetail,
  limits = { bytes: 8 * 1024 * 1024, rows: 10_000 },
) {
  const chunks = ['\uFEFF' + WORKSHEET_COLUMNS.map(csvCell).join(',') + '\r\n'];
  let bytes = Buffer.byteLength(chunks[0]!),
    rows = 0;
  const tooLarge = () =>
    new AppError(
      422,
      'BUSINESS_RULE',
      'The review worksheet exceeds export limits. Use a smaller staged snapshot.',
    );
  if (bytes > limits.bytes) throw tooLarge();
  for (const r of stage.bundle.catalogue.records) {
    for (const ingredient of r.ingredients) {
      if (++rows > limits.rows) throw tooLarge();
      const values = [
        'medicine-review-worksheet/v1',
        'synthetic_sandbox_only',
        stage.id,
        identifierText(stage.datasetKey),
        identifierText(stage.sourceVersion),
        identifierText(stage.fingerprint),
        stage.state,
        identifierText(r.sourceId),
        r.name,
        identifierText(r.product.sourceId),
        r.product.name,
        identifierText(r.supplier.sourceId),
        r.supplier.name,
        identifierText(r.generic.sourceId),
        r.generic.name,
        identifierText(ingredient.sourceId),
        ingredient.name,
        identifierText(r.form.sourceId),
        r.form.name,
        identifierText(r.routes.map((route) => route.sourceId).join(' | ')),
        r.routes.map((route) => route.name).join(' | '),
        r.regulatoryStatus,
        r.clinicalSafety,
        ...Array<string>(REVIEW_COLUMNS).fill(''),
      ];
      const line = values.map(csvCell).join(',') + '\r\n';
      bytes += Buffer.byteLength(line);
      if (bytes > limits.bytes) throw tooLarge();
      chunks.push(line);
    }
  }
  return chunks.join('');
}
