import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { expect, pageAlert, signInToConsole, test } from '../fixtures';

// Prepared entirely from the fabricated offline fixture; no patient or licensed data.
const fixture = new URL(
  '../../api/test/fixtures/cdci-synthetic/review-bundle.json',
  import.meta.url,
);
test('reviews and publishes a synthetic catalogue only to the platform sandbox', async ({
  page,
  operator,
  db,
}) => {
  const bundle = JSON.parse(readFileSync(fixture, 'utf8'));
  const source = { ...bundle.catalogue.source, datasetKey: `synthetic-${randomUUID()}` };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, source, hashes: bundle.provenance.fileSha256 }))
    .digest('hex');
  for (const part of [bundle.catalogue, bundle.report, bundle.provenance]) {
    part.source = source;
    part.fingerprint = fingerprint;
  }
  // Other parallel browser tests may create clinic-owned medicines. Compare only
  // the shared reference catalogue, and check that no staged brand was inserted anywhere.
  const referenceBefore = await db.medicine.count({ where: { organisationId: null } });
  const stagedNames = bundle.catalogue.records.map((r: { name: string }) => r.name);
  await signInToConsole(page, operator);
  await page.getByRole('link', { name: 'Medicine catalogue review' }).click();
  await expect(page.getByRole('heading', { name: 'Medicine catalogue review' })).toBeVisible();
  await page.getByLabel('Synthetic review-bundle.json (up to 2 MiB)').setInputFiles({
    name: 'review-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await page.getByRole('button', { name: 'Upload review bundle', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Snapshot uploaded.');
  await expect(page.getByRole('table')).toContainText(bundle.catalogue.records[0].name);
  await page.getByText('Source details', { exact: true }).first().click();
  await expect(
    page.getByText(new RegExp(bundle.catalogue.records[0].supplier.name)).first(),
  ).toBeVisible();
  await page.getByText('Quarantine report (1)', { exact: true }).click();
  await expect(page.getByText(/generic_reference/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeDisabled();
  await page
    .getByLabel('Review note (10–1,000 characters)')
    .fill('Reviewed fabricated records and quarantine reasons for sandbox only.');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish to sandbox', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish to sandbox', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: new RegExp(`${source.datasetKey} / fixture-1 — Published to sandbox`),
    }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('Active sandbox:', { exact: false })).toContainText(
    source.datasetKey,
  );
  expect(await db.medicine.count({ where: { organisationId: null } })).toBe(referenceBefore);
  expect(await db.medicine.count({ where: { name: { in: stagedNames } } })).toBe(0);
  const otherDataset = structuredClone(bundle);
  const otherSource = { ...source, datasetKey: `${source.datasetKey}-other` };
  const otherFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        source: otherSource,
        hashes: otherDataset.provenance.fileSha256,
      }),
    )
    .digest('hex');
  for (const part of [otherDataset.catalogue, otherDataset.report, otherDataset.provenance]) {
    part.source = otherSource;
    part.fingerprint = otherFingerprint;
  }
  await page
    .getByLabel('Synthetic review-bundle.json (up to 2 MiB)')
    .setInputFiles({
      name: 'other.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(otherDataset)),
    });
  await page.getByRole('button', { name: 'Upload review bundle', exact: true }).click();
  await expect(
    page.getByText(
      'The active snapshot belongs to another dataset; release differences cannot be compared.',
      { exact: true },
    ),
  ).toBeVisible();
  // The client refuses an explicitly real manifest before making an upload request.
  bundle.catalogue.source.dataKind = 'real';
  await page.getByLabel('Synthetic review-bundle.json (up to 2 MiB)').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await page.getByRole('button', { name: 'Upload review bundle', exact: true }).click();
  await expect(pageAlert(page)).toHaveText('Choose a valid synthetic review bundle, up to 2 MiB.');
});
