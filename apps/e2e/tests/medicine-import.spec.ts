import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  stageImportCatalogue,
  FILES,
  type FileName,
} from '../../api/src/modules/medicine-staging/catalogue';
import { importMedicineRelease } from '../../api/src/modules/medicine-import/importer';
import { test, expect, signInToConsole } from '../fixtures';

test('reviews a full source import and preserves clinician mapping revisions without activating prescribing', async ({
  page,
  db,
  operator,
}) => {
  const fixture = new URL('../../api/test/fixtures/cdci-synthetic/', import.meta.url);
  const files = Object.fromEntries(
    Object.keys(FILES).map((f) => [f, readFileSync(new URL(f, fixture), 'utf8')]),
  ) as Record<FileName, string>;
  const owner = await db.platformOperator.findUniqueOrThrow({ where: { email: operator.email } });
  const source = {
    format: 'cdci-flat-files/v1',
    dataKind: 'synthetic',
    datasetKey: `private-test-${randomUUID()}`,
    version: 'fixture-1',
  };
  const before = await db.medicine.count({ where: { organisationId: null } });
  const imported = await importMedicineRelease(
    db,
    stageImportCatalogue(source, files, { includeSourceRows: true }),
    {
      operatorId: owner.id,
      packageSha256: 'a'.repeat(64),
      licenceTextSha256: 'b'.repeat(64),
      audit: {
        id: randomUUID(),
        ip: '127.0.0.1',
        headers: { 'user-agent': 'synthetic-browser-test' },
      },
    },
  );
  await signInToConsole(page, operator);
  await page.getByRole('link', { name: 'Imported medicines and mappings' }).click();
  await expect(
    page.getByText('Licence approval pending — prescribing activation is blocked.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open release', exact: true }).first().click();
  await page.getByRole('combobox', { name: 'Review status', exact: true }).selectOption('draft');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No matching generics.', { exact: true })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Review status', exact: true })
    .selectOption('untouched');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Edit mapping', exact: true }).first().click();
  await expect(page.getByLabel('Strength value', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Mapping saved. Publication requires separate owner approval.',
  );
  await expect(page.getByRole('button', { name: 'Edit mapping', exact: true })).toHaveCount(1);
  await page.getByLabel('Reviewed formulation', { exact: true }).fill('Synthetic tablet');
  await page.getByRole('combobox', { name: 'Reviewed route', exact: true }).selectOption('oral');
  await page
    .getByRole('combobox', { name: 'Strength mapping', exact: true })
    .selectOption('mapped');
  await page.getByLabel('Strength value', { exact: true }).fill('5');
  await page.getByRole('combobox', { name: 'Strength unit', exact: true }).selectOption('mg');
  await page.getByRole('combobox', { name: 'Denominator', exact: true }).selectOption('unit');
  await page
    .getByLabel('Regulatory evidence and source references', { exact: true })
    .fill('Synthetic fixture evidence only.');
  await page
    .getByLabel('Clinical review notes and evidence', { exact: true })
    .fill('Synthetic browser verification; no actual clinical approval.');
  await page.getByLabel('Reviewing clinician’s name', { exact: true }).fill('Synthetic reviewer');
  await page.getByLabel('Clinician registration number', { exact: true }).fill('Synthetic TEST-1');
  await page.getByRole('checkbox', { name: /I confirm that the named clinician supplied/ }).check();
  await page
    .getByRole('combobox', { name: 'Review record', exact: true })
    .selectOption('review_recorded');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Mapping saved. Publication requires separate owner approval.',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Open release', exact: true }).first().click();
  await page.getByRole('button', { name: 'Edit mapping', exact: true }).first().click();
  await expect(page.getByLabel('Strength value', { exact: true })).toHaveValue('5');
  await expect(page.getByRole('combobox', { name: 'Review record', exact: true })).toHaveValue(
    'review_recorded',
  );
  await expect(page.locator('details')).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/private/tmp/dhc-medicine-mapping-preview.png', fullPage: true });
  await page.getByLabel('Reviewed formulation', { exact: true }).fill('Synthetic revised tablet');
  await expect(
    page.getByRole('checkbox', { name: /I confirm that the named clinician supplied/ }),
  ).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Review record', exact: true })).toHaveValue(
    'draft',
  );
  await page.getByRole('combobox', { name: 'Strength unit', exact: true }).selectOption('percent');
  await expect(page.getByRole('combobox', { name: 'Denominator', exact: true })).toHaveCount(0);
  expect(await db.medicineImportMapping.count({ where: { releaseId: imported.releaseId } })).toBe(
    2,
  );
  expect(await db.medicine.count({ where: { organisationId: null } })).toBe(before);
});
