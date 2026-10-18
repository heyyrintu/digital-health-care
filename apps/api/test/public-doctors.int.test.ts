/**
 * Public doctor pages (Build Plan §5.1; ADR 0017): the doctor's settings, the public read
 * without a sign-in, and the `public_doctor_*` functions it goes through. A page answers only
 * when it is listed and verified; every other address gets the same 404. The functions run
 * as the owner, so these tests also pin what they may return and who may call them.
 */
import { DoctorProfile, ErrorResponse, PublicDoctor, PublicDoctorList } from '@dhc/contracts';
import { withAuth, withPlatform, withPublic, withTenant, type Tx } from '@dhc/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_DOCTOR_RATE_LIMIT } from '../src/modules/public/routes';
import {
  addStaff,
  bearer,
  createHarness,
  patientLogin,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let doctorA: { accessToken: string };
let doctorB: { accessToken: string };

const weekly = { mon: [{ start: '09:00', end: '12:00' }] };

/** A clinic, a consultation type and a schedule for the doctor, from 2026-01-01. */
async function schedule(
  organisationId: string,
  doctorUserId: string,
  clinic: { name: string; address?: string; active?: boolean },
  type: { name: string; feePaise: number; mode?: 'in_person' | 'video'; active?: boolean },
  { from = '2026-01-01', days = weekly as object } = {},
) {
  const place = await h.owner.clinic.create({
    data: { organisationId, name: clinic.name, address: clinic.address, active: clinic.active },
  });
  const kind = await h.owner.consultationType.create({
    data: {
      organisationId,
      name: type.name,
      mode: type.mode ?? 'in_person',
      defaultDurationMin: 15,
      feePaise: type.feePaise,
      active: type.active,
    },
  });
  await h.owner.availabilityVersion.create({
    data: {
      organisationId,
      doctorUserId,
      clinicId: place.id,
      consultationTypeId: kind.id,
      effectiveFrom: new Date(`${from}T00:00:00Z`),
      weekly: days,
      slotMinutes: 15,
      createdByUserId: doctorUserId,
    },
  });
  return { place, kind };
}

/** A complete, verified prescription pad, as the platform team leaves it. */
async function verifiedPad(organisationId: string, userId: string, rxPrefix: string) {
  await h.owner.doctorProfile.create({
    data: {
      organisationId,
      userId,
      registrationNumber: `TEST-${rxPrefix}`,
      council: 'Test Medical Council',
      qualifications: 'MBBS, MD',
      specialty: 'General medicine',
      rxPrefix,
      verification: 'verified',
      verifiedAt: new Date(),
      verifiedBy: 'ops@platform.test (SUP-1)',
      signingPinHash: 'not-a-real-hash',
    },
  });
}

const patch = (tokens: { accessToken: string }, payload: unknown) =>
  h.app.inject({
    method: 'PATCH',
    url: '/v1/doctor-profile/public',
    headers: bearer(tokens as never),
    payload: payload as object,
  });

const page = (slug: string, remoteAddress = '10.1.0.1') =>
  h.app.inject({ method: 'GET', url: `/v1/public/doctors/${slug}`, remoteAddress });

/** The error body without its request ID: the same for every page not shown. */
const notFoundBody = (res: { statusCode: number; json: () => unknown }) => {
  expect(res.statusCode).toBe(404);
  const { error } = ErrorResponse.parse(res.json());
  return { code: error.code, message: error.message, fields: error.fields };
};

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { displayName: 'Dr. Synthetic' },
  });
  await h.owner.organisation.update({
    where: { id: clinics.a.org.id },
    data: { name: 'Synthetic Clinic A' },
  });
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

describe('PATCH /v1/doctor-profile/public', () => {
  it('sets the page, lowercases the address and audits field names only', async () => {
    const res = await patch(doctorA, {
      slug: '  Dr-Synthetic ',
      listed: true,
      about: 'Family physician for synthetic tests.',
      languages: ['English', 'Hindi'],
    });
    expect(res.statusCode).toBe(200);
    const profile = DoctorProfile.parse(res.json());
    expect(profile.publicProfile).toEqual({
      slug: 'dr-synthetic',
      listed: true,
      about: 'Family physician for synthetic tests.',
      languages: ['English', 'Hindi'],
      // Not verified yet, so not shown.
      live: false,
    });
    const audit = await h.owner.auditLog.findMany({
      where: { action: 'doctor_profile.public_updated' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organisationId: clinics.a.org.id,
      actorUserId: clinics.a.doctor.userId,
      entityType: 'doctor_profile',
      metadata: { fields: ['slug', 'listed', 'about', 'languages'] },
    });
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/synthetic|English/i);

    // Only the fields sent change; an unchanged save writes no audit entry.
    const unlisted = DoctorProfile.parse((await patch(doctorA, { listed: false })).json());
    expect(unlisted.publicProfile).toMatchObject({ slug: 'dr-synthetic', listed: false });
    expect((await patch(doctorA, { listed: false })).statusCode).toBe(200);
    const entries = await h.owner.auditLog.findMany({
      where: { action: 'doctor_profile.public_updated' },
      orderBy: { at: 'asc' },
    });
    expect(entries.map((e) => e.metadata)).toEqual([
      { fields: ['slug', 'listed', 'about', 'languages'] },
      { fields: ['listed'] },
    ]);
    const stored = await h.owner.doctorProfile.findFirstOrThrow({
      where: { userId: clinics.a.doctor.userId },
    });
    expect(stored.publicUpdatedAt).not.toBeNull();
  });

  it('keeps the prescription pad and its verification as they were', async () => {
    await verifiedPad(clinics.a.org.id, clinics.a.doctor.userId, 'SA');
    const profile = DoctorProfile.parse(
      (await patch(doctorA, { slug: 'dr-synthetic', listed: true })).json(),
    );
    expect(profile).toMatchObject({
      registrationNumber: 'TEST-SA',
      rxPrefix: 'SA',
      verification: 'verified',
      pinSet: true,
      publicProfile: { slug: 'dr-synthetic', listed: true, live: true },
    });
  });

  it.each([
    [{ slug: 'ab' }, 'slug'],
    [{ slug: 'dr_synthetic' }, 'slug'],
    [{ slug: 'dr--x' }, 'slug'],
    [{ slug: 'x'.repeat(61) }, 'slug'],
    [{ about: 'a'.repeat(1001) }, 'about'],
    [{ languages: ['Hindi', 'hindi'] }, 'languages'],
    [{ languages: Array.from({ length: 9 }, (_, i) => `Language ${i}`) }, 'languages'],
    [{ listed: 'yes' }, 'listed'],
    [{ slug: 'admin' }, 'slug'],
    [{ slug: 'verify' }, 'slug'],
    [{}, '_'],
  ])('refuses %j', async (payload, field) => {
    const res = await patch(doctorA, payload);
    expect(res.statusCode).toBe(400);
    expect(Object.keys(ErrorResponse.parse(res.json()).error.fields ?? {})).toContain(field);
  });

  it('trims every kind of space the database refuses at the ends of a language', async () => {
    const res = await patch(doctorA, { languages: ['\u3000Hindi\u00a0', '\ufeffEnglish\u2028'] });
    expect(res.statusCode).toBe(200);
    expect(DoctorProfile.parse(res.json()).publicProfile.languages).toEqual(['Hindi', 'English']);
  });

  it('needs an address to list the page', async () => {
    const res = await patch(doctorA, { listed: true });
    expect(res.statusCode).toBe(400);
    expect(ErrorResponse.parse(res.json()).error.fields).toEqual({ slug: 'required' });
    // Nor may the address be cleared while listed.
    await patch(doctorA, { slug: 'dr-synthetic', listed: true });
    expect((await patch(doctorA, { slug: null })).json().error.fields).toEqual({
      slug: 'required',
    });
  });

  it('keeps addresses unique across organisations without saying whose it is', async () => {
    expect((await patch(doctorB, { slug: 'dr-taken' })).statusCode).toBe(200);
    const res = await patch(doctorA, { slug: 'dr-taken', listed: true, about: 'Hello' });
    expect(res.statusCode).toBe(409);
    const { error } = ErrorResponse.parse(res.json());
    expect(error.fields).toEqual({ slug: 'taken' });
    expect(res.body).not.toMatch(/clinic-b|Clinic B/);
    // Nothing of the refused save was kept.
    expect(
      await h.owner.doctorProfile.findFirst({ where: { userId: clinics.a.doctor.userId } }),
    ).toBeNull();
    // Another doctor in the same organisation is refused too, and the address can be reused
    // once its owner clears it.
    const second = await addStaff(h, clinics.b.org.id, 'doctor', 'second@clinic-b.test');
    const secondTokens = await staffLogin(h, 'clinic-b', second);
    expect((await patch(secondTokens, { slug: 'dr-taken' })).statusCode).toBe(409);
    expect((await patch(doctorB, { slug: null })).statusCode).toBe(200);
    expect((await patch(doctorA, { slug: 'dr-taken' })).statusCode).toBe(200);
  });

  it('is for doctors only', async () => {
    const admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    expect((await patch(admin, { slug: 'dr-synthetic' })).statusCode).toBe(403);
    const desk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
    expect((await patch(await staffLogin(h, 'clinic-a', desk), { listed: false })).statusCode).toBe(
      403,
    );
    const anonymous = await h.app.inject({
      method: 'PATCH',
      url: '/v1/doctor-profile/public',
      payload: { listed: false },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('GET /v1/public/doctors/:slug', () => {
  beforeEach(async () => {
    await verifiedPad(clinics.a.org.id, clinics.a.doctor.userId, 'SA');
    await verifiedPad(clinics.b.org.id, clinics.b.doctor.userId, 'SB');
  });

  it('shows a listed, verified doctor with exactly the public fields', async () => {
    const org = clinics.a.org.id;
    const doctor = clinics.a.doctor.userId;
    await schedule(
      org,
      doctor,
      { name: 'Main clinic', address: '1 Test Road, Testpur' },
      { name: 'In-person consultation', feePaise: 80000 },
    );
    await schedule(
      org,
      doctor,
      { name: 'Branch clinic' },
      { name: 'Video consultation', feePaise: 50000, mode: 'video' },
    );
    // Not shown: a schedule another version stopped, an inactive clinic, an inactive type,
    // and a clinic with no schedule for this doctor.
    const stopped = await schedule(
      org,
      doctor,
      { name: 'Old clinic' },
      { name: 'Old type', feePaise: 1000 },
    );
    await h.owner.availabilityVersion.create({
      data: {
        organisationId: org,
        doctorUserId: doctor,
        clinicId: stopped.place.id,
        consultationTypeId: stopped.kind.id,
        effectiveFrom: new Date('2026-02-01T00:00:00Z'),
        weekly: {},
        slotMinutes: 15,
        createdByUserId: doctor,
      },
    });
    await schedule(
      org,
      doctor,
      { name: 'Closed clinic', active: false },
      { name: 'Closed type', feePaise: 2000 },
    );
    await schedule(
      org,
      doctor,
      { name: 'Clinic with retired type' },
      { name: 'Retired type', feePaise: 3000, active: false },
    );
    await h.owner.clinic.create({ data: { organisationId: org, name: 'Unrelated clinic' } });
    // Another organisation's clinic and type, scheduled for its own doctor.
    await schedule(
      clinics.b.org.id,
      clinics.b.doctor.userId,
      { name: 'Clinic B main' },
      { name: 'Clinic B consult', feePaise: 99900 },
    );

    await patch(doctorA, {
      slug: 'dr-synthetic',
      listed: true,
      about: 'Synthetic about text.',
      languages: ['English', 'हिन्दी'],
    });
    const res = await page('dr-synthetic');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=300');
    const body = res.json();
    // Exactly these keys: nothing the function or the row has besides.
    expect(Object.keys(body).sort()).toEqual(Object.keys(PublicDoctor.shape).sort());
    expect(PublicDoctor.parse(body)).toEqual({
      slug: 'dr-synthetic',
      name: 'Dr. Synthetic',
      qualifications: 'MBBS, MD',
      specialty: 'General medicine',
      registration: { number: 'TEST-SA', council: 'Test Medical Council' },
      about: 'Synthetic about text.',
      languages: ['English', 'हिन्दी'],
      organisation: { slug: 'clinic-a', name: 'Synthetic Clinic A' },
      clinics: [
        { name: 'Branch clinic', address: null },
        { name: 'Clinic with retired type', address: null },
        { name: 'Main clinic', address: '1 Test Road, Testpur' },
      ],
      consultationTypes: [
        { name: 'Video consultation', mode: 'video', durationMin: 15, feePaise: 50000 },
        { name: 'In-person consultation', mode: 'in_person', durationMin: 15, feePaise: 80000 },
      ],
      updatedAt: expect.any(String),
    });
    // No internal IDs, contact details, PIN or patient data anywhere in the answer.
    const raw = res.body;
    for (const secret of [
      clinics.a.org.id,
      clinics.a.doctor.userId,
      clinics.a.doctor.email,
      'not-a-real-hash',
      'SUP-1',
      'Clinic B',
      ...clinics.a.patients.map((p) => p.name),
      ...clinics.b.patients.map((p) => p.name),
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('includes a schedule that starts later', async () => {
    await schedule(
      clinics.a.org.id,
      clinics.a.doctor.userId,
      { name: 'New clinic' },
      { name: 'New type', feePaise: 60000 },
      { from: '2099-01-01' },
    );
    await patch(doctorA, { slug: 'dr-synthetic', listed: true });
    expect(PublicDoctor.parse((await page('dr-synthetic')).json()).clinics).toEqual([
      { name: 'New clinic', address: null },
    ]);
  });

  it('answers every page not shown with the same 404', async () => {
    await patch(doctorA, { slug: 'dr-synthetic', listed: true });
    const nobody = await page('dr-nobody');
    // Never cached: a page listed a moment later must show.
    expect(nobody.headers['cache-control']).toBe('no-store');
    const missing = notFoundBody(nobody);
    expect(missing).toEqual({ code: 'NOT_FOUND', message: 'Not found.', fields: undefined });

    // Malformed addresses: the same answer, not a validation error.
    for (const bad of ['DR-SYNTHETIC', 'ab', 'dr_synthetic', 'x'.repeat(61), '%20dr-synthetic']) {
      expect(notFoundBody(await page(bad))).toEqual(missing);
    }

    // Unlisted.
    await patch(doctorA, { listed: false });
    expect(notFoundBody(await page('dr-synthetic'))).toEqual(missing);
    await patch(doctorA, { listed: true });
    expect((await page('dr-synthetic')).statusCode).toBe(200);

    // Waiting for verification (a changed registration sends it back to pending).
    await h.owner.doctorProfile.updateMany({
      where: { userId: clinics.a.doctor.userId },
      data: { verification: 'pending', verifiedAt: null, verifiedBy: null },
    });
    expect(notFoundBody(await page('dr-synthetic'))).toEqual(missing);
    await h.owner.doctorProfile.updateMany({
      where: { userId: clinics.a.doctor.userId },
      data: { verification: 'verified', verifiedAt: new Date(), verifiedBy: 'ops (SUP-2)' },
    });

    // A doctor whose membership was revoked, whose account is disabled, or whose
    // organisation is suspended.
    await h.owner.membership.updateMany({
      where: { userId: clinics.a.doctor.userId, role: 'doctor' },
      data: { status: 'revoked' },
    });
    expect(notFoundBody(await page('dr-synthetic'))).toEqual(missing);
    await h.owner.membership.updateMany({
      where: { userId: clinics.a.doctor.userId, role: 'doctor' },
      data: { status: 'active' },
    });
    await h.owner.user.update({
      where: { id: clinics.a.doctor.userId },
      data: { status: 'disabled' },
    });
    expect(notFoundBody(await page('dr-synthetic'))).toEqual(missing);
    await h.owner.user.update({
      where: { id: clinics.a.doctor.userId },
      data: { status: 'active' },
    });
    await h.owner.organisation.update({
      where: { id: clinics.a.org.id },
      data: { status: 'suspended' },
    });
    expect(notFoundBody(await page('dr-synthetic'))).toEqual(missing);
  });

  it('lists the pages shown for a sitemap', async () => {
    await patch(doctorA, { slug: 'dr-synthetic', listed: true });
    await patch(doctorB, { slug: 'dr-unlisted' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/public/doctors',
      remoteAddress: '10.1.0.2',
    });
    expect(res.statusCode).toBe(200);
    const list = PublicDoctorList.parse(res.json());
    expect(list.data.map((d) => d.slug)).toEqual(['dr-synthetic']);
    expect(Object.keys(res.json().data[0]).sort()).toEqual(['slug', 'updatedAt']);
  });

  it('limits requests per address', async () => {
    await patch(doctorA, { slug: 'dr-synthetic', listed: true });
    const statuses: number[] = [];
    for (let i = 0; i <= PUBLIC_DOCTOR_RATE_LIMIT.max; i++) {
      statuses.push((await page('dr-synthetic', '10.9.9.9')).statusCode);
    }
    expect(statuses.slice(0, PUBLIC_DOCTOR_RATE_LIMIT.max).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another address is not held back.
    expect((await page('dr-synthetic', '10.9.9.10')).statusCode).toBe(200);
  });
});

describe('the patient portal', () => {
  it('names a listed, verified doctor’s page address in the booking options', async () => {
    const phone = '9876500001';
    await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'CL-000101',
        name: 'Pooja Singh',
        phone: `+91${phone}`,
      },
    });
    await patch(doctorA, { slug: 'dr-synthetic', listed: true });
    const tokens = await patientLogin(h, 'clinic-a', phone);
    const options = () =>
      h.app.inject({ method: 'GET', url: '/v1/portal/booking-options', headers: bearer(tokens) });
    // Listed but not verified: not shown publicly, so not named either.
    expect((await options()).json().doctors[0].publicSlug).toBeNull();
    await h.owner.doctorProfile.updateMany({
      where: { userId: clinics.a.doctor.userId },
      data: {
        registrationNumber: 'TEST-SA',
        council: 'Test Medical Council',
        verification: 'verified',
        verifiedAt: new Date(),
        verifiedBy: 'ops (SUP-3)',
      },
    });
    const res = await options();
    expect(res.statusCode).toBe(200);
    expect(res.json().doctors).toEqual([
      { userId: clinics.a.doctor.userId, displayName: 'Dr. Synthetic', publicSlug: 'dr-synthetic' },
    ]);
    await patch(doctorA, { listed: false });
    const unlisted = await h.app.inject({
      method: 'GET',
      url: '/v1/portal/booking-options',
      headers: bearer(tokens),
    });
    expect(unlisted.json().doctors[0].publicSlug).toBeNull();
  });
});

describe('in the database', () => {
  beforeEach(async () => {
    await verifiedPad(clinics.a.org.id, clinics.a.doctor.userId, 'SA');
    await patch(doctorA, { slug: 'dr-synthetic', listed: true });
    await patch(doctorB, { slug: 'dr-hidden', listed: true }); // never verified
  });

  const asPublic = <T>(fn: (tx: Tx) => Promise<T>) => withPublic(h.services.db, fn);

  it('returns a row only for a listed, verified page', async () => {
    const shown = await asPublic(
      (tx) => tx.$queryRaw<{ slug: string }[]>`SELECT * FROM public_doctor_profile('dr-synthetic')`,
    );
    expect(shown.map((r) => r.slug)).toEqual(['dr-synthetic']);
    for (const slug of ['dr-hidden', 'dr-nobody', '', "' OR 1=1 --"]) {
      expect(
        await asPublic((tx) => tx.$queryRaw`SELECT * FROM public_doctor_profile(${slug})`),
      ).toEqual([]);
    }
    expect(
      await asPublic((tx) => tx.$queryRaw<{ slug: string }[]>`SELECT * FROM public_doctor_slugs()`),
    ).toEqual([{ slug: 'dr-synthetic', updated_at: expect.any(Date) }]);
  });

  it('sees no tenant row with no organisation set', async () => {
    for (const table of [
      'patients',
      'appointments',
      'doctor_profiles',
      'clinics',
      'consultation_types',
      'memberships',
      'organisations',
      'audit_logs',
    ]) {
      const [row] = await asPublic((tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
      );
      expect({ table, n: row!.n }).toEqual({ table, n: 0 });
    }
    await expect(asPublic((tx) => tx.$queryRawUnsafe('SELECT 1 FROM users'))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('lets only dhc_app call the functions', async () => {
    const functions = await h.owner.$queryRaw<
      { name: string; definer: boolean; app: boolean; auth: boolean; platform: boolean }[]
    >`
      SELECT proname AS name, prosecdef AS definer,
             has_function_privilege('dhc_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('dhc_auth', p.oid, 'EXECUTE') AS auth,
             has_function_privilege('dhc_platform', p.oid, 'EXECUTE') AS platform
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE proname LIKE 'public\\_%' ORDER BY proname`;
    expect(functions).toEqual([
      { name: 'public_doctor_profile', definer: true, app: true, auth: false, platform: false },
      { name: 'public_doctor_slugs', definer: true, app: true, auth: false, platform: false },
    ]);
    await expect(
      withAuth(h.services.db, (tx) => tx.$queryRawUnsafe('SELECT * FROM public_doctor_slugs()')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withPlatform(h.services.db, (tx) =>
        tx.$queryRawUnsafe('SELECT * FROM public_doctor_slugs()'),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('returns exactly the published columns, and in a tenant the same as anonymously', async () => {
    const columns = await h.owner.$queryRaw<{ name: string; columns: string[] }[]>`
      SELECT p.proname AS name,
             array(
               SELECT a.arg FROM unnest(p.proargnames, p.proargmodes::text[]) AS a(arg, mode)
               WHERE a.mode IN ('o', 't')
             ) AS columns
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname LIKE 'public\\_%' ORDER BY p.proname`;
    expect(columns).toEqual([
      {
        name: 'public_doctor_profile',
        columns: [
          'slug',
          'display_name',
          'qualifications',
          'specialty',
          'registration_number',
          'council',
          'about',
          'languages',
          'organisation_slug',
          'organisation_name',
          'clinics',
          'consultation_types',
          'updated_at',
        ],
      },
      { name: 'public_doctor_slugs', columns: ['slug', 'updated_at'] },
    ]);
    // Called from inside another organisation, the function still answers only for the
    // page asked about: it widens nothing for a signed-in clinic.
    const fromB = await withTenant(
      h.services.db,
      clinics.b.org.id,
      (tx) =>
        tx.$queryRaw<{ organisation_slug: string }[]>`
        SELECT organisation_slug FROM public_doctor_profile('dr-synthetic')`,
    );
    expect(fromB).toEqual([{ organisation_slug: 'clinic-a' }]);
  });

  it('enforces the formats with CHECK constraints', async () => {
    const where = { userId: clinics.a.doctor.userId };
    for (const data of [
      { publicSlug: 'Dr-Upper' },
      { publicSlug: 'ab' },
      { publicSlug: '-dr' },
      { publicSlug: 'x'.repeat(61) },
      { about: '' },
      { about: 'a'.repeat(1001) },
      { languages: ['Hindi', 'HINDI'] },
      { languages: [' Hindi'] },
      { languages: ['Hindi\u00a0'] },
      { languages: ['\u3000Hindi'] },
      { languages: Array.from({ length: 9 }, (_, i) => `L${i}`) },
      { listed: true, publicSlug: null },
    ]) {
      await expect(h.owner.doctorProfile.updateMany({ where, data })).rejects.toThrow(
        /check constraint/i,
      );
    }
  });
});
