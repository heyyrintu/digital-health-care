/** Separate disposable database: fabricated approvals and facts, never real clinical data. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LocalFileStore } from '../../api/src/files';
import { importMedicineRelease } from '../../api/src/modules/medicine-import/importer';
import {
  recordCatalogueEvidence,
  publishCatalogue,
  revokeCatalogueEvidence,
} from '../../api/src/modules/medicine-import/publication';
import {
  stageImportCatalogue,
  FILES,
  type FileName,
} from '../../api/src/modules/medicine-staging/catalogue';
import { E2E_FILE_STORE_DIR } from '../env';
import { test, expect, setUpFromInvite, setUpPrescriptionPad, signInToConsole } from '../fixtures';

test('approved source mapping becomes a versioned prescription choice and revocation preserves its signed history', async ({
  page,
  browser,
  db,
  clinic,
  operator,
}) => {
  test.setTimeout(120000);
  expect(await db.medicineCataloguePublication.count()).toBe(0);
  const password = 'synthetic catalogue clinician passphrase',
    pin = '482916';
  await setUpFromInvite(page, clinic.inviteLink('doctor'), password);
  await setUpPrescriptionPad(page, db, clinic, { prefix: 'CAT', password, pin });
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  const profile = await db.doctorProfile.findUniqueOrThrow({
    where: { organisationId_userId: { organisationId: org.id, userId: doctor.id } },
  });
  const owner = await db.platformOperator.findUniqueOrThrow({ where: { email: operator.email } });
  const patient = await db.patient.findFirstOrThrow({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
  });
  await db.patient.update({
    where: { id: patient.id },
    data: { dob: new Date('1985-01-01T00:00:00Z'), gender: 'male' },
  });
  await db.drugMolecule.create({ data: { name: 'Catalogue synthetic Alpha', maxDailyMg: 1000 } });
  await db.drugDatabase.update({
    where: { id: 1 },
    data: { version: 'fabricated-browser-clinical-v1' },
  });
  const fixture = new URL('../../api/test/fixtures/cdci-synthetic/', import.meta.url);
  const files = Object.fromEntries(
    Object.keys(FILES).map((f) => [f, readFileSync(new URL(f, fixture), 'utf8')]),
  ) as Record<FileName, string>;
  const manifest = {
    format: 'cdci-flat-files/v1',
    dataKind: 'real',
    datasetKey: 'fabricated-browser-catalogue',
    version: 'fixture-1',
  };
  const source = {
    id: randomUUID(),
    ip: '127.0.0.1',
    headers: { 'user-agent': 'fabricated-catalogue-browser-test' },
  };
  const imported = await importMedicineRelease(
    db,
    stageImportCatalogue(manifest, files, { includeSourceRows: true }),
    {
      operatorId: owner.id,
      packageSha256: 'a'.repeat(64),
      licenceTextSha256: 'b'.repeat(64),
      audit: source,
    },
  );
  const consolePage = await browser.newPage();
  await signInToConsole(consolePage, operator);
  await consolePage.goto('/platform/medicine-imports');
  await consolePage.getByRole('button', { name: 'Open release', exact: true }).click();
  await consolePage.getByRole('button', { name: 'Edit mapping', exact: true }).first().click();
  await consolePage
    .getByLabel('Search clinical ingredient records', { exact: true })
    .fill('Catalogue synthetic Alpha');
  await consolePage.getByRole('button', { name: 'Find clinical ingredient', exact: true }).click();
  await consolePage
    .getByRole('button', { name: 'Use Catalogue synthetic Alpha', exact: true })
    .click();
  await consolePage.getByLabel('Reviewed formulation', { exact: true }).fill('tablet');
  await consolePage
    .getByRole('combobox', { name: 'Reviewed route', exact: true })
    .selectOption('oral');
  await consolePage
    .getByRole('combobox', { name: 'Strength mapping', exact: true })
    .selectOption('mapped');
  await consolePage.getByLabel('Strength value', { exact: true }).fill('5');
  await consolePage
    .getByRole('combobox', { name: 'Strength unit', exact: true })
    .selectOption('mg');
  await consolePage
    .getByRole('combobox', { name: 'Denominator', exact: true })
    .selectOption('unit');
  await consolePage
    .getByLabel('Regulatory evidence and source references', { exact: true })
    .fill('Fabricated regulatory source for isolated browser test only.');
  await consolePage
    .getByLabel('Clinical review notes and evidence', { exact: true })
    .fill('Fabricated clinician review for isolated browser test only.');
  await consolePage
    .getByLabel('Reviewing clinician’s name', { exact: true })
    .fill(doctor.displayName!);
  await consolePage
    .getByLabel('Clinician registration number', { exact: true })
    .fill(profile.registrationNumber!);
  await consolePage
    .getByRole('checkbox', { name: /I confirm that the named clinician supplied/ })
    .check();
  await consolePage
    .getByRole('combobox', { name: 'Review record', exact: true })
    .selectOption('review_recorded');
  await consolePage.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(consolePage.getByRole('status')).toHaveText(
    'Mapping saved. Publication requires separate owner approval.',
  );

  const store = new LocalFileStore(E2E_FILE_STORE_DIR),
    validity = { validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2040-01-01T00:00:00.000Z' };
  const proof = (input: unknown) =>
    recordCatalogueEvidence(
      db,
      store,
      owner.id,
      source,
      input,
      Buffer.from('FABRICATED TEST EVIDENCE: NOT A REAL LICENCE OR CLINICAL APPROVAL'),
    );
  const licence = await proof({
    kind: 'licence',
    datasetKey: manifest.datasetKey,
    affiliateReference: 'FABRICATED-TEST-ONLY',
    licensee: 'Synthetic test entity',
    licenceTextSha256: 'b'.repeat(64),
    territory: 'IN',
    useWithinIndiaConfirmed: true,
    ...validity,
  });
  const safety = await proof({
    kind: 'safety',
    databaseVersion: 'fabricated-browser-clinical-v1',
    doctorProfileId: profile.id,
    reviewEvidenceConfirmed: true,
    ...validity,
  });
  const clinical = await proof({
    kind: 'clinical',
    releaseId: imported.releaseId,
    sourceId: '990000000000000201',
    revision: 1,
    doctorProfileId: profile.id,
    reviewEvidenceConfirmed: true,
    brandIds: ['990000000000000701'],
    brandRegulatoryReviewConfirmed: true,
    ...validity,
  });
  const request = {
    releaseId: imported.releaseId,
    sourceId: '990000000000000201',
    revision: 1,
    licenceId: licence.id,
    safetyId: safety.id,
    clinicalId: clinical.id,
    brandIds: ['990000000000000701'],
    expectedRevisions: { '990000000000000701': null },
    confirmLegacyRetirement: true,
  };
  expect(await publishCatalogue(db, store, owner.id, source, request)).toMatchObject({
    executed: false,
    changed: 1,
  });
  expect(await db.medicine.count({ where: { catalogueRevision: { not: null } } })).toBe(0);
  await publishCatalogue(db, store, owner.id, source, request, true);
  await consolePage.reload();
  await consolePage.getByRole('button', { name: 'Open release', exact: true }).click();
  await expect(
    consolePage.getByText(
      'Licence evidence recorded. Publication still requires exact clinician review and independent safety approval.',
    ),
  ).toBeVisible();

  const place = await db.clinic.create({
    data: { organisationId: org.id, name: 'Synthetic consultation room' },
  });
  const type = await db.consultationType.create({
    data: {
      organisationId: org.id,
      name: 'Synthetic in-person',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 0,
    },
  });
  const visit = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) + 'T00:00:00Z'),
      startAt: new Date(),
      endAt: new Date(Date.now() + 900000),
      source: 'walk_in',
      status: 'in_consultation',
      tokenNumber: 1,
      createdByUserId: doctor.id,
    },
  });
  await page.goto(`/clinic/consultations/${visit.id}`);
  const rx = page.getByTestId('prescription');
  await rx.getByLabel('Add medicine: search name or composition').fill('Synthetic brand');
  await rx.getByRole('option', { name: /^Synthetic brand One/ }).click();
  const savedRequest = page.waitForRequest(
    (r) => r.method() === 'PUT' && r.url().endsWith(`/appointments/${visit.id}/prescription`),
  );
  await rx.getByTestId('rx-line-0').getByLabel('Frequency').fill('1-0-1');
  expect((await savedRequest).postDataJSON().items[0].catalogueRevision).toBe(1);
  await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
  const panel = rx.getByTestId('sign-panel');
  await panel.getByRole('button', { name: 'Sign prescription' }).click();
  await panel.getByLabel('Signing PIN').fill(pin);
  await panel.getByRole('button', { name: 'Sign now' }).click();
  await expect(panel).toContainText('Rx CAT-00001, version 1');
  await revokeCatalogueEvidence(
    db,
    owner.id,
    source,
    licence.id,
    'Fabricated revocation test after signing',
  );
  await page.reload();
  await expect(page.getByTestId('sign-panel')).toContainText('Signed');
  const pdf = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/prescriptions\/[^/]+\/pdf$/.test(r.url()),
  );
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open PDF' }).click();
  expect((await pdf).status()).toBe(200);
  await (await popup).close();
  await consolePage.close();
});
