import type { Db } from '@dhc/db';
import type { Browser } from '@playwright/test';
import {
  expect,
  setUpFromInvite,
  signInAsPatient,
  syntheticMobile,
  test,
  type Clinic,
} from '../fixtures';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** A tiny, well-formed one-page PDF whose only text says it is synthetic. */
function syntheticPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += [
    'xref',
    `0 ${bodies.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${bodies.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xref),
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.from(out, 'latin1');
}

/** Asha Verma (synthetic persona) on a fresh number, in consultation with the doctor today. */
async function ashaWithTheDoctor(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  const place = await db.clinic.create({ data: { organisationId: org.id, name: 'Main clinic' } });
  const type = await db.consultationType.create({
    data: {
      organisationId: org.id,
      name: 'In-person consultation',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
    },
  });
  const phone = syntheticMobile();
  const asha = await db.patient.findFirstOrThrow({
    where: { organisationId: org.id, name: 'Asha Verma' },
  });
  await db.patient.update({ where: { id: asha.id }, data: { phone: `+91${phone}` } });
  const now = new Date();
  const visit = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: asha.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${today()}T00:00:00Z`),
      startAt: now,
      endAt: new Date(now.getTime() + 15 * 60_000),
      status: 'in_consultation',
      source: 'walk_in',
      tokenNumber: 1,
      checkedInAt: now,
      consultationStartedAt: now,
      createdByUserId: doctor.id,
    },
  });
  return { org, asha, phone, visitId: visit.id };
}

async function newPage(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    ...(viewport ? { viewport } : {}),
  });
  return context.newPage();
}

const SHEET = 'Knee exercises (synthetic)';
const REPORT = 'MRI report (synthetic)';
const NOTE = 'Synthetic note: twice a day for two weeks.';

test.describe('documents', () => {
  test('the clinic admin adds a library sheet; the doctor shares it and a report; the patient opens both; a withdrawn one disappears', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    // Three people in their own browsers: allow for slow CI runners.
    test.setTimeout(150_000);

    // The clinic admin adds a sheet to the library.
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    await page.getByRole('link', { name: 'Library', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Document library' })).toBeVisible();
    await expect(page.getByText('No sheets yet. Add the first one.')).toBeVisible();
    await page.getByRole('button', { name: 'Add sheet' }).click();
    const form = page.getByTestId('library-form');
    // An SVG is refused before anything is sent.
    await form.getByLabel('File').setInputFiles({
      name: 'sheet.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    await form.getByLabel('Title').fill(SHEET);
    await form.getByRole('button', { name: 'Add to library' }).click();
    await expect(form.getByRole('alert')).toContainText(
      'Choose a PDF or an image this clinic accepts',
    );
    await form.getByLabel('File').setInputFiles({
      name: 'knee-exercises.pdf',
      mimeType: 'application/pdf',
      buffer: syntheticPdf('Synthetic knee exercises'),
    });
    await form.getByLabel('Category').selectOption({ label: 'Exercise' });
    await form.getByRole('button', { name: 'Add to library' }).click();
    await expect(page.getByRole('status')).toHaveText('Sheet added.');
    const item = page.getByTestId('library-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(SHEET);
    await expect(item).toContainText('Exercise');
    await expect(item).toContainText('Shared with patients: 0');

    const doctor = await newPage(browser);
    const patient = await newPage(browser, { width: 390, height: 844 });
    try {
      // The doctor shares the sheet from the consultation screen, with a note.
      await setUpFromInvite(doctor, clinic.inviteLink('doctor'), 'doctor synthetic passphrase', 1);
      const { asha, phone, visitId } = await ashaWithTheDoctor(db, clinic);
      await doctor.goto(`/clinic/consultations/${visitId}`);
      const visitCard = doctor.getByTestId('patient-documents');
      await expect(visitCard).toContainText('No documents shared at this visit.');
      await visitCard.getByRole('button', { name: 'Share document' }).click();
      const dialog = doctor.getByRole('dialog');
      await expect(
        dialog.getByRole('heading', { name: 'Share a document with Asha Verma' }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText('Choose a sheet.');
      await dialog.getByLabel('Sheet').selectOption({ label: `${SHEET} · Exercise · English` });
      await dialog.getByLabel('Note to the patient (optional)').fill(NOTE);
      await dialog.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(visitCard.getByRole('status')).toHaveText('Document shared.');
      await expect(visitCard.getByTestId('patient-document')).toContainText(SHEET);
      await expect(visitCard.getByTestId('patient-document')).toContainText('Not opened yet');

      // And a one-off report from the patient page.
      await doctor.goto(`/clinic/patients/${asha.id}`);
      const card = doctor.getByTestId('patient-documents');
      await expect(card.getByTestId('patient-document')).toHaveCount(1);
      await card.getByRole('button', { name: 'Share document' }).click();
      await dialog.getByRole('radio', { name: 'Upload a file (such as a report)' }).check();
      await dialog.getByLabel('File', { exact: true }).setInputFiles({
        name: 'mri-report.pdf',
        mimeType: 'application/pdf',
        buffer: syntheticPdf('Synthetic MRI report'),
      });
      await dialog.getByLabel('Title', { exact: true }).fill(REPORT);
      await dialog.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(card.getByRole('status')).toHaveText('Document shared.');
      await expect(card.getByTestId('patient-document')).toHaveCount(2);
      await expect(card.getByTestId('patient-document').first()).toContainText(REPORT);

      // The patient sees both on the portal, new, and opens the report.
      await signInAsPatient(patient, db, clinic, phone);
      await patient.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
      await patient.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
      await patient.getByRole('checkbox', { name: /health records/i }).check();
      await patient.getByRole('button', { name: 'Accept and continue' }).click();
      await expect(patient.getByRole('heading', { name: 'Welcome, Asha Verma' })).toBeVisible();
      await patient.getByRole('navigation').getByRole('link', { name: 'Documents' }).click();
      await expect(patient.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
      const docs = patient.getByTestId('portal-document');
      await expect(docs).toHaveCount(2);
      const report = docs.filter({ hasText: REPORT });
      const sheet = docs.filter({ hasText: SHEET });
      await expect(report.getByTestId('document-new')).toHaveText('New');
      await expect(sheet).toContainText(`Doctor’s note: ${NOTE}`);
      await expect(sheet).toContainText('Exercise');

      const file = patient.waitForResponse(
        (r) => r.request().method() === 'GET' && /\/portal\/documents\/[^/]+\/file$/.test(r.url()),
      );
      const tab = patient.waitForEvent('popup');
      await report.getByRole('button', { name: `View ${REPORT}` }).click();
      const response = await file;
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe('application/pdf');
      expect(response.headers()['x-content-type-options']).toBe('nosniff');
      expect(response.request().headers()['authorization']).toMatch(/^Bearer /);
      await (await tab).close();
      await expect(report.getByTestId('document-new')).toHaveCount(0);
      await expect(sheet.getByTestId('document-new')).toHaveText('New');

      // The doctor sees it was opened, and withdraws it.
      await doctor.reload();
      const shared = doctor.getByTestId('patient-document').filter({ hasText: REPORT });
      await expect(shared).toContainText('Opened by the patient');
      await shared.getByRole('button', { name: `Withdraw ${REPORT}` }).click();
      await expect(shared).toContainText('The patient will no longer see it.');
      await shared.getByRole('button', { name: 'Withdraw', exact: true }).click();
      await expect(card.getByRole('status')).toHaveText('Document withdrawn.');
      await expect(shared).toContainText('Withdrawn');

      // The patient no longer sees it; the sheet stays.
      await patient.reload();
      await expect(patient.getByTestId('portal-document')).toHaveCount(1);
      await expect(patient.getByTestId('portal-document')).toContainText(SHEET);

      // The admin's library counts the share; the audit log holds IDs only.
      await page.reload();
      await expect(page.getByTestId('library-item')).toContainText('Shared with patients: 1');
      await expectAudit(db, clinic);
    } finally {
      await doctor.context().close();
      await patient.context().close();
    }
  });
});

async function expectAudit(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const entries = await db.auditLog.findMany({
    where: { organisationId: org.id, action: { startsWith: 'document.' } },
  });
  const count = (action: string) => entries.filter((e) => e.action === action).length;
  expect(count('document.file_uploaded')).toBe(2);
  expect(count('document.library_created')).toBe(1);
  expect(count('document.shared')).toBe(2);
  expect(count('document.withdrawn')).toBe(1);
  expect(
    entries.some(
      (e) => e.action === 'document.viewed' && (e.metadata as { by?: string })?.by === 'patient',
    ),
  ).toBe(true);
  for (const e of entries) {
    expect(JSON.stringify(e.metadata)).not.toMatch(/synthetic|Knee|MRI/i);
  }
}
