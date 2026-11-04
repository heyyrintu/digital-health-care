/**
 * Attachments and the clinic document library through the API (PRD §7.3), part 1: clinic
 * admins and doctors upload sheets to the library and rename, replace, archive and restore
 * them; doctors share a sheet or a one-off upload with a patient under the chart model and
 * withdraw it; the patient's family sees and opens what was shared on the portal. Content
 * checks and the clinic's limits, immutability after a sheet changes, tenancy, the
 * database's own guards and the audit log. Personas and files are synthetic.
 */
import { createHash } from 'node:crypto';
import {
  CURRENT_CONSENT_VERSIONS,
  DocumentFile,
  LibraryDocument,
  LibraryDocumentList,
  PatientDocument,
  PatientDocumentList,
  PortalDocumentList,
  type TokenResponse,
} from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_SVG, samplePng, sampleWebp } from '../src/modules/branding/logo-samples';
import { samplePdf } from '../src/modules/documents/document-samples';
import { everyActiveContent } from '../src/modules/documents/pdf-attack-samples';
import { PDF_REBUILD_LIMITS, PdfRebuilder, rebuildPdf } from '../src/modules/documents/pdf-rebuild';
import {
  addStaff,
  bearer,
  createHarness,
  patientLogin,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  type StaffFixture,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let doctor: TokenResponse;
let second: StaffFixture;
let secondDoctor: TokenResponse;
let desk: TokenResponse;
let admin: TokenResponse;
let doctorB: TokenResponse;
let clinicId: string;
let typeId: string;

const SHEET = samplePdf({ text: 'Synthetic knee exercises, week 1' });
const SHEET_V2 = samplePdf({ text: 'Synthetic knee exercises, week 2' });
const REPORT = samplePdf({ text: 'Synthetic MRI report' });
/** What the API stores for each: the PDF rebuilt from its pages (the same bytes every time). */
async function rebuilt(pdf: Buffer) {
  const outcome = await rebuildPdf(pdf);
  if (!outcome.ok) throw new Error(outcome.detail);
  return Buffer.from(outcome.data);
}
const STORED = {
  sheet: await rebuilt(SHEET),
  sheetV2: await rebuilt(SHEET_V2),
  report: await rebuilt(REPORT),
};
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const NOTE = 'Synthetic note: do these twice a day.';

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const org = clinics.a.org.id;
  second = await addStaff(h, org, 'doctor', 'second@clinic-a.test');
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  secondDoctor = await staffLogin(h, 'clinic-a', second);
  desk = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, org, 'front_desk', 'desk@clinic-a.test'),
  );
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
  clinicId = (await h.owner.clinic.create({ data: { organisationId: org, name: 'Main clinic' } }))
    .id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: org,
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
      },
    })
  ).id;
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse | null, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: tokens ? bearer(tokens) : {},
    payload: payload as object,
  });

const send = (tokens: TokenResponse | null, file: Buffer, type = 'application/pdf') =>
  h.app.inject({
    method: 'POST',
    url: '/v1/document-files',
    headers: { ...(tokens ? bearer(tokens) : {}), 'content-type': type },
    payload: file,
  });

async function uploaded(tokens: TokenResponse, file: Buffer = SHEET, type = 'application/pdf') {
  const res = await send(tokens, file, type);
  expect(res.statusCode, res.body).toBe(201);
  return DocumentFile.parse(res.json());
}

async function sheet(
  tokens: TokenResponse = admin,
  body: Record<string, unknown> = {},
  file: Buffer = SHEET,
) {
  const { id: fileId } = await uploaded(tokens, file);
  const res = await call('POST', '/library-documents', tokens, {
    fileId,
    title: 'Knee exercises',
    category: 'exercise',
    language: 'en',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return LibraryDocument.parse(res.json());
}

const patientId = (i = 0) => clinics.a.patients[i]!.id;

async function share(body: Record<string, unknown>, tokens = doctor, patient = patientId()) {
  // A minute apart, so "newest first" is well defined.
  h.clock.advance(60);
  const res = await call('POST', `/patients/${patient}/documents`, tokens, body);
  expect(res.statusCode, res.body).toBe(201);
  return PatientDocument.parse(res.json());
}

async function staffList(tokens = doctor, patient = patientId(), query = '') {
  const res = await call('GET', `/patients/${patient}/documents${query}`, tokens);
  expect(res.statusCode, res.body).toBe(200);
  return PatientDocumentList.parse(res.json());
}

let token = 0;
async function visit(
  patient = patientId(),
  doctorUser = clinics.a.doctor,
  status: 'in_consultation' | 'confirmed' = 'in_consultation',
) {
  const startAt = new Date(
    status === 'confirmed' ? '2026-10-20T04:30:00.000Z' : '2026-10-06T04:30:00.000Z',
  );
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: patient,
      doctorUserId: doctorUser.userId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date(`${startAt.toISOString().slice(0, 10)}T00:00:00.000Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status,
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: doctorUser.userId,
    },
  });
  return row.id;
}

const audits = (action: string) =>
  h.owner.auditLog.findMany({ where: { action }, orderBy: { at: 'asc' } });

const ALL_CONSENTS = Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
  kind,
  version,
}));
async function signedUp(phone: string) {
  const tokens = await patientLogin(h, 'clinic-a', phone);
  expect(
    (await call('POST', '/portal/consents', tokens, { accept: ALL_CONSENTS })).statusCode,
  ).toBe(200);
  return tokens;
}
async function portalList(tokens: TokenResponse) {
  const res = await call('GET', '/portal/documents', tokens);
  expect(res.statusCode, res.body).toBe(200);
  return PortalDocumentList.parse(res.json()).data;
}

describe('the clinic library', () => {
  it('lets clinic admins and doctors add, rename, replace, archive and restore sheets', async () => {
    const made = await sheet(admin);
    expect(made).toMatchObject({
      title: 'Knee exercises',
      category: 'exercise',
      language: 'en',
      mediaType: 'application/pdf',
      sizeBytes: STORED.sheet.length,
      archived: false,
      shareCount: 0,
    });
    const byDoctor = await sheet(doctor, {
      title: ' Diabetic   diet chart ',
      category: null,
      language: 'hi',
    });
    expect(byDoctor).toMatchObject({
      title: 'Diabetic diet chart',
      category: null,
      language: 'hi',
    });

    const list = async (query = '', tokens = doctor) => {
      const res = await call('GET', `/library-documents${query}`, tokens);
      expect(res.statusCode, res.body).toBe(200);
      return LibraryDocumentList.parse(res.json()).data;
    };
    expect((await list()).map((d) => d.title)).toEqual(['Diabetic diet chart', 'Knee exercises']);
    expect((await list('?q=KNEE ex')).map((d) => d.id)).toEqual([made.id]);
    expect((await list('?category=exercise', admin)).map((d) => d.id)).toEqual([made.id]);

    // Rename and recategorise; then a new file (a fresh upload) for the same sheet.
    const renamed = await call('PATCH', `/library-documents/${made.id}`, doctor, {
      title: 'Knee exercises (week 1)',
      category: 'information',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const { id: v2 } = await uploaded(admin, SHEET_V2);
    const replaced = LibraryDocument.parse(
      (await call('PATCH', `/library-documents/${made.id}`, admin, { fileId: v2 })).json(),
    );
    expect(replaced.sizeBytes).toBe(STORED.sheetV2.length);
    const file = await call('GET', `/library-documents/${made.id}/file`, doctor);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.rawPayload.equals(STORED.sheetV2)).toBe(true);

    // Archive: out of the active list, into the archive; changing it needs a restore first.
    const archived = LibraryDocument.parse(
      (await call('PATCH', `/library-documents/${made.id}`, admin, { archived: true })).json(),
    );
    expect(archived.archived).toBe(true);
    expect((await list()).map((d) => d.id)).toEqual([byDoctor.id]);
    expect((await list('?status=archived')).map((d) => d.id)).toEqual([made.id]);
    const locked = await call('PATCH', `/library-documents/${made.id}`, admin, { title: 'New' });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.fields).toEqual({ status: 'archived' });
    const restored = await call('PATCH', `/library-documents/${made.id}`, doctor, {
      archived: false,
    });
    expect(LibraryDocument.parse(restored.json()).archived).toBe(false);
    // An empty change is refused; nothing else is accepted in the body.
    expect((await call('PATCH', `/library-documents/${made.id}`, admin, {})).statusCode).toBe(400);

    // Audited by ID, with no titles.
    const created = await audits('document.library_created');
    expect(created.map((a) => a.entityId).sort()).toEqual([made.id, byDoctor.id].sort());
    expect(created[0]!.metadata).toMatchObject({ category: 'exercise', language: 'en' });
    const updated = await audits('document.library_updated');
    expect(updated.map((a) => a.metadata)).toEqual([
      { fields: ['title', 'category'] },
      { fields: ['file'], fileId: v2, previousFileId: expect.any(String) },
    ]);
    expect((await audits('document.library_archived')).length).toBe(1);
    expect((await audits('document.library_restored')).length).toBe(1);
    const uploads = await audits('document.file_uploaded');
    expect(uploads[0]!.metadata).toMatchObject({
      mediaType: 'application/pdf',
      sizeBytes: STORED.sheet.length,
      // The hash of the rebuilt file, not of the upload.
      sha256: sha256(STORED.sheet),
      by: 'clinic_admin',
    });
    for (const entry of [...created, ...updated, ...uploads]) {
      expect(JSON.stringify(entry.metadata)).not.toMatch(/Knee|diet|exercises/i);
    }
  });

  it('keeps the front desk, patients and other clinics out', async () => {
    const made = await sheet(admin);
    for (const [method, url] of [
      ['GET', '/library-documents'],
      ['GET', `/library-documents/${made.id}/file`],
      ['PATCH', `/library-documents/${made.id}`],
      ['POST', '/library-documents'],
    ] as const) {
      expect((await call(method, url, desk, { title: 'x' })).statusCode, url).toBe(403);
      expect((await call(method, url, null, { title: 'x' })).statusCode, url).toBe(401);
    }
    expect((await send(desk, SHEET)).statusCode).toBe(403);
    expect((await send(null, SHEET)).statusCode).toBe(401);

    // Clinic B sees none of clinic A's sheets, and A's IDs are unknown there.
    expect(
      LibraryDocumentList.parse((await call('GET', '/library-documents', doctorB)).json()).data,
    ).toEqual([]);
    expect((await call('GET', `/library-documents/${made.id}/file`, doctorB)).statusCode).toBe(404);
    expect(
      (await call('PATCH', `/library-documents/${made.id}`, doctorB, { archived: true }))
        .statusCode,
    ).toBe(404);
    // Nor can B use A's upload, or A another person's.
    const { id: fileOfA } = await uploaded(admin);
    for (const tokens of [doctorB, doctor]) {
      const res = await call('POST', '/library-documents', tokens, {
        fileId: fileOfA,
        title: 'Borrowed',
        language: 'en',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.fields).toEqual({ fileId: 'invalid' });
    }
  });

  it('uses a fresh upload once, within 24 hours, and holds at most 500 sheets', async () => {
    const { id: fileId } = await uploaded(admin);
    const body = { fileId, title: 'Sheet', language: 'other' };
    expect((await call('POST', '/library-documents', admin, body)).statusCode).toBe(201);
    const again = await call('POST', '/library-documents', admin, body);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.fields).toEqual({ fileId: 'used' });

    const { id: old } = await uploaded(admin);
    h.clock.advance(24 * 3600 + 60);
    admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    const expired = await call('POST', '/library-documents', admin, { ...body, fileId: old });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.fields).toEqual({ fileId: 'expired' });

    const fileRows = Array.from({ length: 499 }, (_, i) => ({
      organisationId: clinics.a.org.id,
      fileKey: `organisations/${clinics.a.org.id}/documents/${i.toString(16).padStart(12, '0')}.pdf`,
      mediaType: 'application/pdf',
      sizeBytes: 1,
      sha256: '0'.repeat(64),
      uploadedByUserId: clinics.a.admin.userId,
      uploadedByRole: 'clinic_admin' as const,
      uploadedAt: new Date(h.clock.ms),
    }));
    await h.owner.documentFile.createMany({ data: fileRows });
    const files = await h.owner.documentFile.findMany({ where: { sizeBytes: 1 } });
    await h.owner.libraryDocument.createMany({
      data: files.map((f) => ({
        organisationId: clinics.a.org.id,
        title: 'Filler',
        language: 'en' as const,
        fileId: f.id,
        createdByUserId: clinics.a.admin.userId,
      })),
    });
    const { id: last } = await uploaded(admin);
    const full = await call('POST', '/library-documents', admin, { ...body, fileId: last });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.fields).toEqual({ library: 'full' });
  });
});

describe('uploads', () => {
  it('takes PDF, JPEG, PNG and WebP within the clinic’s limits and refuses everything else', async () => {
    expect((await uploaded(doctor, samplePng(), 'image/png')).mediaType).toBe('image/png');
    expect((await uploaded(doctor, sampleWebp(), 'image/webp')).mediaType).toBe('image/webp');

    const refused = async (file: Buffer, type: string, status = 400) => {
      const res = await send(doctor, file, type);
      expect(res.statusCode, `${type}: ${res.body}`).toBe(status);
      return res.json().error.fields?.file;
    };
    expect(await refused(SAMPLE_SVG, 'image/svg+xml')).toBe('type_not_allowed');
    expect(await refused(Buffer.from('<html><body>synthetic</body></html>'), 'text/html')).toBe(
      'type_not_allowed',
    );
    // Polyglots and disguises, whatever they claim to be.
    expect(await refused(Buffer.concat([samplePng(), SHEET]), 'image/png')).toBe('not_a_document');
    expect(await refused(Buffer.concat([SHEET, Buffer.from('<html>')]), 'application/pdf')).toBe(
      'not_a_document',
    );
    expect(await refused(SAMPLE_SVG, 'image/png')).toBe('not_a_document');
    expect(await refused(samplePng(), 'application/pdf')).toBe('type_mismatch');
    expect(
      await refused(
        samplePdf({ trailerExtra: '/Encrypt << /Filter /Standard >> ' }),
        'application/pdf',
      ),
    ).toBe('encrypted');
    expect(await refused(Buffer.alloc(0), 'application/pdf')).toBe('empty');
    expect((await send(doctor, Buffer.from('GIF89a'), 'image/gif')).statusCode).toBe(415);
    expect((await send(doctor, Buffer.from('{}'), 'application/json')).statusCode).toBe(415);
    expect((await send(doctor, Buffer.alloc(26 * 1024 * 1024))).statusCode).toBe(413);

    // The clinic's limits: 1 MB, and PDFs only (WebP has no switch and stays accepted).
    await h.owner.organisationSettings.create({
      data: { organisationId: clinics.a.org.id, maxUploadMb: 1, uploadTypes: ['pdf'] },
    });
    expect(await refused(samplePng(), 'image/png')).toBe('type_not_allowed');
    expect(
      await refused(Buffer.concat([SHEET, Buffer.alloc(1024 * 1024, 0x20)]), 'application/pdf'),
    ).toBe('too_large');
    expect((await uploaded(doctor, sampleWebp(), 'image/webp')).mediaType).toBe('image/webp');

    // Only the accepted ones were stored and audited.
    expect(await h.owner.documentFile.count()).toBe(3);
    expect((await audits('document.file_uploaded')).length).toBe(3);
  });

  it('answers 503 busy, with Retry-After, when the clinic already has rebuilds in progress', async () => {
    const pdf = h.services.pdf;
    h.services.pdf = new PdfRebuilder({ ...PDF_REBUILD_LIMITS, perOrganisation: 0 });
    try {
      const res = await send(doctor, SHEET);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.json().error).toMatchObject({ code: 'UNAVAILABLE', fields: { file: 'busy' } });
      // Images do not wait for the rebuild.
      expect((await uploaded(doctor, samplePng(), 'image/png')).mediaType).toBe('image/png');
    } finally {
      h.services.pdf = pdf;
    }
    expect(await h.owner.documentFile.count()).toBe(1);
  });

  it('stores and serves a PDF rebuilt from its pages, never the upload', async () => {
    // A script that runs on open, page actions, a link and an attachment.
    const upload = everyActiveContent();
    expect(upload.toString('latin1')).toMatch(/\/OpenAction/);
    const made = await sheet(admin, {}, upload);
    const row = await h.owner.documentFile.findFirstOrThrow({ orderBy: { uploadedAt: 'desc' } });
    expect(row.sha256).not.toBe(sha256(upload));
    expect(row.mediaType).toBe('application/pdf');
    const file = await call('GET', `/library-documents/${made.id}/file`, doctor);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    const served = file.rawPayload;
    expect(sha256(served)).toBe(row.sha256);
    expect(served.length).toBe(row.sizeBytes);
    expect(served.equals(await rebuilt(upload))).toBe(true);
    const text = served.toString('latin1');
    expect(text).not.toMatch(
      /OpenAction|JavaScript|\/JS\b|\/AA\b|\/Annots|\/EmbeddedFile|app\.alert/,
    );
    const [audit] = await audits('document.file_uploaded');
    expect(audit!.metadata).toMatchObject({
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      originalSha256: sha256(upload),
      originalSizeBytes: upload.length,
    });
  });
});

describe('sharing with a patient', () => {
  it('shares a sheet and a one-off report from a visit, lists them and opens the files', async () => {
    const made = await sheet(admin);
    const visitId = await visit();
    const fromLibrary = await share({
      source: 'library',
      libraryDocumentId: made.id,
      appointmentId: visitId,
      note: NOTE,
    });
    expect(fromLibrary).toMatchObject({
      patientId: patientId(),
      appointmentId: visitId,
      source: 'library',
      libraryDocumentId: made.id,
      title: 'Knee exercises',
      category: 'exercise',
      language: 'en',
      note: NOTE,
      mediaType: 'application/pdf',
      sharedBy: { userId: clinics.a.doctor.userId },
      openedAt: null,
      withdrawnAt: null,
    });
    const { id: reportFile } = await uploaded(doctor, REPORT);
    const report = await share({
      source: 'upload',
      fileId: reportFile,
      title: 'MRI report',
      category: 'other',
    });
    expect(report).toMatchObject({ source: 'upload', libraryDocumentId: null, language: null });

    const all = await staffList();
    expect(all.data.map((d) => d.id)).toEqual([report.id, fromLibrary.id]);
    expect((await staffList(doctor, patientId(), `?appointmentId=${visitId}`)).data).toHaveLength(
      1,
    );
    const paged = await staffList(doctor, patientId(), '?limit=1');
    expect(paged.data.map((d) => d.id)).toEqual([report.id]);
    const next = await staffList(doctor, patientId(), `?limit=1&cursor=${paged.nextCursor}`);
    expect(next.data.map((d) => d.id)).toEqual([fromLibrary.id]);

    const file = await call('GET', `/patient-documents/${report.id}/file`, doctor);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(STORED.report)).toBe(true);
    expect(file.headers['content-disposition']).toMatch(
      /^inline; filename="document-[0-9a-f]{8}\.pdf"$/,
    );
    expect(
      LibraryDocumentList.parse((await call('GET', '/library-documents', admin)).json()).data[0]!
        .shareCount,
    ).toBe(1);

    // The audit log names IDs, never the title, the note or the file's name.
    const shared = await audits('document.shared');
    expect(shared.map((a) => a.metadata)).toEqual([
      {
        patientId: patientId(),
        source: 'library',
        fileId: expect.any(String),
        libraryDocumentId: made.id,
        appointmentId: visitId,
        withNote: true,
      },
      { patientId: patientId(), source: 'upload', fileId: reportFile, withNote: false },
    ]);
    const listed = await audits('document.listed');
    expect(listed[0]).toMatchObject({ entityType: 'patient', entityId: patientId() });
    expect(listed[0]!.metadata).toEqual({ count: 2 });
    const viewed = await audits('document.viewed');
    expect(viewed[0]!.metadata).toEqual({
      patientId: patientId(),
      fileId: reportFile,
      by: 'doctor',
    });
    const everything = await h.owner.auditLog.findMany({
      where: { action: { startsWith: 'document.' } },
    });
    for (const entry of everything) {
      expect(JSON.stringify(entry.metadata)).not.toMatch(/Knee|MRI|Synthetic note|report/i);
    }
  });

  it('is for doctors only, under the chart model, and never for another clinic', async () => {
    const made = await sheet(admin);
    const body = { source: 'library', libraryDocumentId: made.id };
    for (const tokens of [desk, admin]) {
      expect(
        (await call('POST', `/patients/${patientId()}/documents`, tokens, body)).statusCode,
      ).toBe(403);
      expect((await call('GET', `/patients/${patientId()}/documents`, tokens)).statusCode).toBe(
        403,
      );
    }
    const shared = await share(body);
    for (const tokens of [desk, admin]) {
      expect((await call('GET', `/patient-documents/${shared.id}/file`, tokens)).statusCode).toBe(
        403,
      );
      expect(
        (await call('POST', `/patient-documents/${shared.id}/withdraw`, tokens)).statusCode,
      ).toBe(403);
    }
    // Another clinic: unknown patient, unknown document.
    expect((await call('GET', `/patients/${patientId()}/documents`, doctorB)).statusCode).toBe(404);
    expect((await call('GET', `/patient-documents/${shared.id}/file`, doctorB)).statusCode).toBe(
      404,
    );
    expect(
      (await call('POST', `/patient-documents/${shared.id}/withdraw`, doctorB)).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `/patients/${clinics.b.patients[0]!.id}/documents`, doctor, body))
        .statusCode,
    ).toBe(404);
    expect(
      await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.patientDocument.count()),
    ).toBe(0);

    // "Own patients only": the second doctor has not seen the patient.
    await h.owner.organisationSettings.create({
      data: { organisationId: clinics.a.org.id, chartModel: 'own_patients' },
    });
    await visit(patientId(), clinics.a.doctor);
    for (const res of [
      await call('POST', `/patients/${patientId()}/documents`, secondDoctor, body),
      await call('GET', `/patients/${patientId()}/documents`, secondDoctor),
      await call('GET', `/patient-documents/${shared.id}/file`, secondDoctor),
      await call('POST', `/patient-documents/${shared.id}/withdraw`, secondDoctor),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CHART_RESTRICTED');
    }
    expect((await staffList(doctor)).data).toHaveLength(1);
  });

  it('refuses another patient’s visit, an archived sheet, a used upload and a merged record', async () => {
    const made = await sheet(admin);
    const otherVisit = await visit(patientId(1));
    const wrongVisit = await call('POST', `/patients/${patientId()}/documents`, doctor, {
      source: 'library',
      libraryDocumentId: made.id,
      appointmentId: otherVisit,
    });
    expect(wrongVisit.statusCode).toBe(400);
    expect(wrongVisit.json().error.fields).toEqual({ appointmentId: 'invalid' });

    await call('PATCH', `/library-documents/${made.id}`, admin, { archived: true });
    const archived = await call('POST', `/patients/${patientId()}/documents`, doctor, {
      source: 'library',
      libraryDocumentId: made.id,
    });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.fields).toEqual({ libraryDocumentId: 'archived' });

    const { id: fileId } = await uploaded(doctor, REPORT);
    await share({ source: 'upload', fileId, title: 'MRI report' });
    const reused = await call('POST', `/patients/${patientId(1)}/documents`, doctor, {
      source: 'upload',
      fileId,
      title: 'MRI report',
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.fields).toEqual({ fileId: 'used' });

    await h.owner.patient.update({
      where: { id: patientId(1) },
      data: { mergedIntoId: patientId(), mergedAt: new Date() },
    });
    const { id: another } = await uploaded(doctor, REPORT);
    const merged = await call('POST', `/patients/${patientId(1)}/documents`, doctor, {
      source: 'upload',
      fileId: another,
      title: 'MRI report',
    });
    expect(merged.statusCode).toBe(409);
    expect(merged.json().error.code).toBe('PATIENT_MERGED');
  });

  it('shares at a visit that took place, not a booking to come, so a later merge still works', async () => {
    const made = await sheet(admin);
    const [kept, duplicate] = clinics.a.patients;
    const seen = await visit(duplicate!.id);
    const booking = await visit(duplicate!.id, clinics.a.doctor, 'confirmed');
    const atBooking = await call('POST', `/patients/${duplicate!.id}/documents`, doctor, {
      source: 'library',
      libraryDocumentId: made.id,
      appointmentId: booking,
    });
    expect(atBooking.statusCode).toBe(422);
    expect(atBooking.json().error).toMatchObject({
      code: 'BUSINESS_RULE',
      fields: { appointmentId: 'not_seen' },
    });
    const shared = await share(
      { source: 'library', libraryDocumentId: made.id, appointmentId: seen },
      doctor,
      duplicate!.id,
    );
    // The database refuses the booking too, whoever writes.
    const row = await h.owner.patientDocument.findUniqueOrThrow({ where: { id: shared.id } });
    await expect(
      h.owner.patientDocument.create({
        data: {
          ...row,
          id: undefined,
          appointmentId: booking,
          openedAt: null,
          createdAt: undefined,
          updatedAt: undefined,
        },
      }),
    ).rejects.toThrow(/visit that took place/);

    // The merge moves the booking to the kept record and leaves the treated visit in place.
    const asked = await call('POST', '/patient-merges', doctor, {
      sourcePatientId: duplicate!.id,
      targetPatientId: kept!.id,
      reason: 'Registered twice at the front desk',
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const approved = await call('POST', `/patient-merges/${asked.json().id}/approve`, admin, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(
      (await h.owner.appointment.findUniqueOrThrow({ where: { id: booking } })).patientId,
    ).toBe(kept!.id);
    expect((await staffList(doctor, kept!.id)).data.map((d) => d.id)).toEqual([shared.id]);
  });

  it('keeps what the patient received when the sheet is renamed, replaced or archived', async () => {
    const made = await sheet(admin);
    const shared = await share({ source: 'library', libraryDocumentId: made.id });
    const { id: v2 } = await uploaded(admin, SHEET_V2);
    await call('PATCH', `/library-documents/${made.id}`, admin, {
      title: 'Knee exercises (new)',
      language: 'hi',
      fileId: v2,
    });
    await call('PATCH', `/library-documents/${made.id}`, admin, { archived: true });

    const [kept] = (await staffList()).data;
    expect(kept).toMatchObject({
      id: shared.id,
      title: 'Knee exercises',
      language: 'en',
      sizeBytes: STORED.sheet.length,
    });
    const file = await call('GET', `/patient-documents/${shared.id}/file`, doctor);
    expect(file.rawPayload.equals(STORED.sheet)).toBe(true);
    const library = await call('GET', `/library-documents/${made.id}/file`, admin);
    expect(library.rawPayload.equals(STORED.sheetV2)).toBe(true);
  });

  it('withdraws a share: the record stays for the clinic, and the patient stops seeing it', async () => {
    await h.owner.patient.update({ where: { id: patientId() }, data: { phone: '+919000000001' } });
    const made = await sheet(admin);
    const shared = await share({ source: 'library', libraryDocumentId: made.id, note: NOTE });
    const app = await signedUp('9000000001');
    expect((await portalList(app)).map((d) => d.id)).toEqual([shared.id]);

    const res = await call('POST', `/patient-documents/${shared.id}/withdraw`, secondDoctor);
    expect(res.statusCode, res.body).toBe(200);
    expect(PatientDocument.parse(res.json())).toMatchObject({
      withdrawnAt: expect.any(String),
      withdrawnBy: { userId: second.userId },
    });
    const again = await call('POST', `/patient-documents/${shared.id}/withdraw`, doctor);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.fields).toEqual({ status: 'withdrawn' });

    expect(await portalList(app)).toEqual([]);
    expect((await call('GET', `/portal/documents/${shared.id}/file`, app)).statusCode).toBe(404);
    // The clinic's record keeps it, and the doctor can still open it.
    expect((await staffList()).data[0]!.withdrawnAt).not.toBeNull();
    expect((await call('GET', `/patient-documents/${shared.id}/file`, doctor)).statusCode).toBe(
      200,
    );
    const withdrawn = await audits('document.withdrawn');
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]).toMatchObject({ entityId: shared.id, actorUserId: second.userId });
    expect(withdrawn[0]!.metadata).toEqual({ patientId: patientId() });
  });
});

describe('the patient portal', () => {
  it('shows the family’s documents only, after the consents, and marks them opened', async () => {
    const [asha, kamla] = clinics.a.patients;
    await h.owner.patient.update({ where: { id: asha!.id }, data: { phone: '+919000000001' } });
    await h.owner.patient.update({ where: { id: kamla!.id }, data: { phone: '+919000000002' } });
    const child = await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'CL-000099',
        name: 'Meera Verma',
        guardianPatientId: asha!.id,
      },
    });
    const made = await sheet(admin);
    const forAsha = await share({ source: 'library', libraryDocumentId: made.id, note: NOTE });
    const { id: reportFile } = await uploaded(doctor, sampleWebp(), 'image/webp');
    const forChild = await share(
      { source: 'upload', fileId: reportFile, title: 'Growth chart', language: 'en' },
      doctor,
      child.id,
    );
    const forKamla = await share(
      { source: 'library', libraryDocumentId: made.id },
      doctor,
      kamla!.id,
    );

    const unconsented = await patientLogin(h, 'clinic-a', '9000000001');
    const blocked = await call('GET', '/portal/documents', unconsented);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('CONSENT_REQUIRED');
    expect(
      (await call('GET', `/portal/documents/${forAsha.id}/file`, unconsented)).statusCode,
    ).toBe(403);

    const ashaApp = await signedUp('9000000001');
    const list = await portalList(ashaApp);
    expect(list.map((d) => [d.patient.name, d.title, d.isNew])).toEqual([
      ['Meera Verma', 'Growth chart', true],
      ['Asha Verma', 'Knee exercises', true],
    ]);
    expect(list[1]).toMatchObject({ note: NOTE, doctorName: null, mediaType: 'application/pdf' });

    const file = await call('GET', `/portal/documents/${forChild.id}/file`, ashaApp);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.rawPayload.equals(sampleWebp())).toBe(true);
    expect((await portalList(ashaApp)).map((d) => d.isNew)).toEqual([false, true]);
    // The doctor sees when it was first opened; opening again keeps that time.
    h.clock.advance(60);
    await call('GET', `/portal/documents/${forChild.id}/file`, ashaApp);
    const opened = (await staffList(doctor, child.id)).data[0]!.openedAt;
    expect(opened).toBe(new Date(h.clock.ms - 60_000).toISOString());

    // Another family: neither the list nor the file.
    const kamlaApp = await signedUp('9000000002');
    expect((await portalList(kamlaApp)).map((d) => d.id)).toEqual([forKamla.id]);
    expect((await call('GET', `/portal/documents/${forAsha.id}/file`, kamlaApp)).statusCode).toBe(
      404,
    );
    // Staff tokens cannot use the portal; patient tokens not the staff routes.
    expect((await call('GET', '/portal/documents', doctor)).statusCode).toBe(403);
    expect((await call('GET', `/patient-documents/${forAsha.id}/file`, ashaApp)).statusCode).toBe(
      403,
    );
    expect((await call('GET', '/library-documents', ashaApp)).statusCode).toBe(403);

    const viewed = (await audits('document.viewed')).filter((a) => a.metadata);
    expect(viewed[0]!.metadata).toEqual({ patientId: child.id, fileId: reportFile, by: 'patient' });
    const listed = (await audits('document.listed')).filter((a) => a.entityType === 'account');
    expect(listed[0]!.metadata).toEqual({ count: 2, source: 'patient_app' });
  });

  it('shows a merged duplicate’s documents under the record that was kept', async () => {
    const [kept, duplicate] = clinics.a.patients;
    await h.owner.patient.update({ where: { id: kept!.id }, data: { phone: '+919000000001' } });
    const made = await sheet(admin);
    const shared = await share(
      { source: 'library', libraryDocumentId: made.id },
      doctor,
      duplicate!.id,
    );
    await h.owner.patient.update({
      where: { id: duplicate!.id },
      data: { mergedIntoId: kept!.id, mergedAt: new Date() },
    });
    const app = await signedUp('9000000001');
    expect((await portalList(app)).map((d) => [d.id, d.patient.id])).toEqual([
      [shared.id, kept!.id],
    ]);
    expect((await call('GET', `/portal/documents/${shared.id}/file`, app)).statusCode).toBe(200);
    expect((await staffList(doctor, kept!.id)).data.map((d) => d.id)).toEqual([shared.id]);
  });
});

describe('the database', () => {
  it('never changes a stored file, a shared document or deletes either', async () => {
    const made = await sheet(admin);
    const shared = await share({ source: 'library', libraryDocumentId: made.id, note: NOTE });
    const row = await h.owner.patientDocument.findUniqueOrThrow({ where: { id: shared.id } });

    await expect(
      h.owner.patientDocument.update({ where: { id: shared.id }, data: { title: 'Changed' } }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      h.owner.patientDocument.update({ where: { id: shared.id }, data: { note: null } }),
    ).rejects.toThrow(/cannot change/);
    await expect(h.owner.patientDocument.delete({ where: { id: shared.id } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      h.owner.documentFile.update({ where: { id: row.fileId }, data: { sha256: 'f'.repeat(64) } }),
    ).rejects.toThrow(/cannot change/);
    await expect(h.owner.documentFile.delete({ where: { id: row.fileId } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(h.owner.libraryDocument.delete({ where: { id: made.id } })).rejects.toThrow(
      /never deleted/,
    );
    // Withdrawal is recorded once.
    await call('POST', `/patient-documents/${shared.id}/withdraw`, doctor);
    await expect(
      h.owner.patientDocument.update({
        where: { id: shared.id },
        data: { withdrawnAt: null, withdrawnByUserId: null },
      }),
    ).rejects.toThrow(/recorded once/);
  });

  it('refuses rows that cross clinics, name a merged record or point outside the clinic’s folder', async () => {
    const made = await sheet(admin);
    const sheetRow = await h.owner.libraryDocument.findUniqueOrThrow({ where: { id: made.id } });
    const base = {
      organisationId: clinics.a.org.id,
      patientId: patientId(),
      source: 'library' as const,
      libraryDocumentId: made.id,
      fileId: sheetRow.fileId,
      title: 'Knee exercises',
      sharedByUserId: clinics.a.doctor.userId,
      sharedAt: new Date(h.clock.ms),
    };
    // Clinic B's patient, a clinic admin as sharer, a stale file and a visit of someone else.
    await expect(
      h.owner.patientDocument.create({ data: { ...base, patientId: clinics.b.patients[0]!.id } }),
    ).rejects.toThrow(/does not match/);
    await expect(
      h.owner.patientDocument.create({ data: { ...base, sharedByUserId: clinics.a.admin.userId } }),
    ).rejects.toThrow(/not a doctor/);
    const { id: otherFile } = await uploaded(admin, SHEET_V2);
    await expect(
      h.owner.patientDocument.create({ data: { ...base, fileId: otherFile } }),
    ).rejects.toThrow(/active library document/);
    await expect(
      h.owner.patientDocument.create({
        data: { ...base, appointmentId: await visit(patientId(1)) },
      }),
    ).rejects.toThrow(/does not match its visit/);
    await h.owner.patient.update({
      where: { id: patientId(1) },
      data: { mergedIntoId: patientId(), mergedAt: new Date() },
    });
    await expect(
      h.owner.patientDocument.create({ data: { ...base, patientId: patientId(1) } }),
    ).rejects.toThrow(/merged/);
    await expect(
      h.owner.documentFile.create({
        data: {
          organisationId: clinics.a.org.id,
          fileKey: `organisations/${clinics.b.org.id}/documents/0123456789ab.pdf`,
          mediaType: 'application/pdf',
          sizeBytes: 1,
          sha256: '0'.repeat(64),
          uploadedByUserId: clinics.a.admin.userId,
          uploadedByRole: 'clinic_admin',
          uploadedAt: new Date(h.clock.ms),
        },
      }),
    ).rejects.toThrow(/document_files_key_check/);
    await expect(
      h.owner.documentFile.create({
        data: {
          organisationId: clinics.a.org.id,
          fileKey: `organisations/${clinics.a.org.id}/documents/0123456789ab.svg`,
          mediaType: 'image/svg+xml',
          sizeBytes: 1,
          sha256: '0'.repeat(64),
          uploadedByUserId: clinics.a.admin.userId,
          uploadedByRole: 'clinic_admin',
          uploadedAt: new Date(h.clock.ms),
        },
      }),
    ).rejects.toThrow(/check/);
    // A doctor whose membership was revoked can no longer share or withdraw.
    await h.owner.membership.updateMany({
      where: { userId: second.userId, organisationId: clinics.a.org.id },
      data: { status: 'revoked' },
    });
    await expect(
      h.owner.patientDocument.create({ data: { ...base, sharedByUserId: second.userId } }),
    ).rejects.toThrow(/not a doctor/);
    const live = await share({ source: 'library', libraryDocumentId: made.id });
    await expect(
      h.owner.patientDocument.update({
        where: { id: live.id },
        data: { withdrawnAt: new Date(h.clock.ms + 1000), withdrawnByUserId: second.userId },
      }),
    ).rejects.toThrow(/not a doctor/);
    // A patient with documents keeps its organisation.
    await expect(
      h.owner.patient.update({
        where: { id: patientId() },
        data: { organisationId: clinics.b.org.id },
      }),
    ).rejects.toThrow();
  });
});
