/**
 * Organisation branding (Build Plan §5.1; ADR 0017 addendum 2): the clinic admin's editing,
 * the logo checks, and the public read through `public_organisation_*` functions and the
 * directory. Branding shows only for an active organisation that saved it; logos are served
 * only from verified bytes; and one organisation's admin never reaches another's branding.
 */
import {
  ErrorResponse,
  LOGO_MAX_BYTES,
  OrganisationBranding,
  PublicBranding,
  PublicDoctor,
  PublicDoctorDirectory,
  type TokenResponse,
} from '@dhc/contracts';
import { withPublic, withTenant } from '@dhc/db';
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAMPLE_SVG,
  sampleJpeg,
  samplePng,
  sampleWebp,
} from '../src/modules/branding/logo-samples';
import { PUBLIC_DOCTOR_RATE_LIMIT, PUBLIC_LOGO_RATE_LIMIT } from '../src/modules/public/routes';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let adminB: TokenResponse;

const API = 'http://localhost/v1/';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const getBranding = (tokens: TokenResponse) =>
  h.app.inject({ method: 'GET', url: '/v1/organisation-branding', headers: bearer(tokens) });
const putBranding = (tokens: TokenResponse, payload: object) =>
  h.app.inject({
    method: 'PUT',
    url: '/v1/organisation-branding',
    headers: bearer(tokens),
    payload,
  });
const uploadLogo = (tokens: TokenResponse | null, type: string, data: Buffer | string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/organisation-branding/logo',
    headers: { ...(tokens ? bearer(tokens) : {}), 'content-type': type },
    payload: data,
  });
const deleteLogo = (tokens: TokenResponse) =>
  h.app.inject({
    method: 'DELETE',
    url: '/v1/organisation-branding/logo',
    headers: bearer(tokens),
  });
const publicBranding = (slug: string, remoteAddress = '10.3.0.1') =>
  h.app.inject({
    method: 'GET',
    url: `/v1/public/organisations/${slug}/branding`,
    remoteAddress,
  });
/** The logo route, from a logo URL as the API gives it (relative to `/v1/`). */
const fetchLogo = (logoUrl: string) =>
  h.app.inject({ method: 'GET', url: new URL(logoUrl, API).pathname, remoteAddress: '10.3.0.2' });

const fieldOf = (res: { statusCode: number; json: () => unknown }) =>
  ErrorResponse.parse(res.json()).error.fields;

const brandingAudits = (organisationId: string) =>
  h.owner.auditLog.findMany({
    where: { organisationId, action: 'organisation.branding_updated' },
    orderBy: { at: 'asc' },
  });

const fullBranding = {
  displayName: 'Synthetic Care A',
  accentColour: '#1A6B5C',
  tagline: 'Family care, synthetic data only',
};

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

describe('clinic admin editing', () => {
  it('starts with no branding, then saves it and audits the field names only', async () => {
    expect(OrganisationBranding.parse((await getBranding(adminA)).json())).toEqual({
      organisation: { slug: 'clinic-a', name: 'Clinic A' },
      displayName: null,
      accentColour: null,
      tagline: null,
      logo: null,
      updatedAt: null,
    });

    const res = await putBranding(adminA, fullBranding);
    expect(res.statusCode).toBe(200);
    expect(OrganisationBranding.parse(res.json())).toMatchObject({
      displayName: 'Synthetic Care A',
      accentColour: '#1a6b5c', // lowercased
      tagline: 'Family care, synthetic data only',
      logo: null,
      updatedAt: expect.any(String),
    });

    const [audit] = await brandingAudits(clinics.a.org.id);
    expect(audit).toMatchObject({
      actorUserId: clinics.a.admin.userId,
      entityType: 'organisation',
      entityId: clinics.a.org.id,
      metadata: { fields: ['displayName', 'accentColour', 'tagline'] },
    });
    // Names only: never the values.
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/Synthetic Care|1a6b5c|Family care/);

    // Saving the same again changes nothing and audits nothing; clearing one field names it.
    await putBranding(adminA, fullBranding);
    expect(await brandingAudits(clinics.a.org.id)).toHaveLength(1);
    await putBranding(adminA, { ...fullBranding, tagline: '' });
    const audits = await brandingAudits(clinics.a.org.id);
    expect(audits.map((a) => a.metadata)).toEqual([
      { fields: ['displayName', 'accentColour', 'tagline'] },
      { fields: ['tagline'] },
    ]);
  });

  it('clears the colour with an emptied field', async () => {
    await putBranding(adminA, fullBranding);
    const res = await putBranding(adminA, { ...fullBranding, accentColour: '' });
    expect(res.statusCode).toBe(200);
    expect(OrganisationBranding.parse(res.json()).accentColour).toBeNull();
  });

  it('refuses a colour too light for white text, and anything but #rrggbb', async () => {
    for (const accentColour of ['#ffffff', '#7fdbca', '#777777']) {
      const res = await putBranding(adminA, { ...fullBranding, accentColour });
      expect(res.statusCode, accentColour).toBe(400);
      expect(fieldOf(res)?.accentColour).toMatch(/darker colour/);
    }
    for (const accentColour of ['red', '#123', '#1a6b5c;color:red', 'url(x)', '#1a6b5c80']) {
      const res = await putBranding(adminA, { ...fullBranding, accentColour });
      expect(res.statusCode, accentColour).toBe(400);
      expect(fieldOf(res)?.accentColour).toBeDefined();
    }
    for (const displayName of ['x'.repeat(81), 'Line\nbreak', 'Right\u202eto left']) {
      expect((await putBranding(adminA, { ...fullBranding, displayName })).statusCode).toBe(400);
    }
    expect(
      (await putBranding(adminA, { ...fullBranding, tagline: 'y'.repeat(121) })).statusCode,
    ).toBe(400);
    expect(await h.owner.organisationBranding.count()).toBe(0);
  });

  it('is for clinic admins only', async () => {
    const doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const desk = await staffLogin(
      h,
      'clinic-a',
      await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test'),
    );
    for (const tokens of [doctor, desk]) {
      expect((await getBranding(tokens)).statusCode).toBe(403);
      expect((await putBranding(tokens, fullBranding)).statusCode).toBe(403);
      expect((await uploadLogo(tokens, 'image/png', samplePng())).statusCode).toBe(403);
      expect((await deleteLogo(tokens)).statusCode).toBe(403);
    }
    expect((await uploadLogo(null, 'image/png', samplePng())).statusCode).toBe(401);
    expect(
      (
        await h.app.inject({
          method: 'PUT',
          url: '/v1/organisation-branding',
          payload: fullBranding,
        })
      ).statusCode,
    ).toBe(401);
    expect(await h.owner.organisationBranding.count()).toBe(0);
    expect(await brandingAudits(clinics.a.org.id)).toHaveLength(0);
  });

  it('keeps each organisation’s branding to itself', async () => {
    await putBranding(adminA, fullBranding);
    await putBranding(adminB, {
      displayName: 'Synthetic Care B',
      accentColour: null,
      tagline: null,
    });
    expect(OrganisationBranding.parse((await getBranding(adminA)).json()).displayName).toBe(
      'Synthetic Care A',
    );
    expect(OrganisationBranding.parse((await getBranding(adminB)).json())).toMatchObject({
      organisation: { slug: 'clinic-b' },
      displayName: 'Synthetic Care B',
      accentColour: null,
    });
    // Inside clinic B the database shows B's row only, and refuses a row naming clinic A.
    const seen = await withTenant(h.services.db, clinics.b.org.id, (tx) =>
      tx.organisationBranding.findMany({ select: { organisationId: true } }),
    );
    expect(seen).toEqual([{ organisationId: clinics.b.org.id }]);
    await expect(
      withTenant(h.services.db, clinics.b.org.id, (tx) =>
        tx.organisationBranding.update({
          where: { organisationId: clinics.a.org.id },
          data: { displayName: 'Taken over' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(
        h.services.db,
        clinics.b.org.id,
        (tx) =>
          tx.$executeRaw`INSERT INTO organisation_branding (organisation_id, display_name, updated_at)
                       VALUES (${clinics.a.org.id}::uuid, 'Taken over', now())
                       ON CONFLICT (organisation_id) DO UPDATE SET display_name = 'Taken over'`,
      ),
    ).rejects.toThrow(/row-level security/);
    const a = await h.owner.organisationBranding.findUniqueOrThrow({
      where: { organisationId: clinics.a.org.id },
    });
    expect(a.displayName).toBe('Synthetic Care A');
  });
});

describe('logo upload', () => {
  it('stores a PNG, JPEG or WebP under the organisation and serves it from its hash', async () => {
    for (const [type, data] of [
      ['image/jpeg', sampleJpeg()],
      ['image/webp', sampleWebp()],
      ['image/png', samplePng()],
    ] as const) {
      const res = await uploadLogo(adminA, type, data);
      expect(res.statusCode, type).toBe(200);
      const body = OrganisationBranding.parse(res.json());
      expect(body.logo).toEqual({
        url: `public/logos/${sha256(data)}`,
        mediaType: type,
        sizeBytes: data.length,
      });
      const row = await h.owner.organisationBranding.findUniqueOrThrow({
        where: { organisationId: clinics.a.org.id },
      });
      expect(row.logoKey).toMatch(
        new RegExp(
          `^organisations/${clinics.a.org.id}/branding/logo-[0-9a-f]{12}\\.(png|jpg|webp)$`,
        ),
      );
      expect(await h.services.files.get(row.logoKey!)).toEqual(data);

      const served = await fetchLogo(body.logo!.url);
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toBe(type);
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
      expect(served.headers['content-security-policy']).toBe(
        "default-src 'none'; img-src 'self'; sandbox",
      );
      expect(served.rawPayload).toEqual(data);
    }
    expect((await brandingAudits(clinics.a.org.id)).map((a) => a.metadata)).toEqual([
      { fields: ['logo'] },
      { fields: ['logo'] },
      { fields: ['logo'] },
    ]);
  });

  it('removes the replaced logo: its old address stops answering', async () => {
    const first = samplePng({ rgb: [0x10, 0x20, 0x30] });
    const second = samplePng({ rgb: [0x40, 0x50, 0x60] });
    await uploadLogo(adminA, 'image/png', first);
    const firstKey = (await h.owner.organisationBranding.findFirstOrThrow()).logoKey!;
    await uploadLogo(adminA, 'image/png', second);
    expect((await fetchLogo(`public/logos/${sha256(first)}`)).statusCode).toBe(404);
    expect((await fetchLogo(`public/logos/${sha256(second)}`)).statusCode).toBe(200);
    await expect(h.services.files.get(firstKey)).rejects.toThrow();

    const removed = await deleteLogo(adminA);
    expect(OrganisationBranding.parse(removed.json()).logo).toBeNull();
    const gone = await fetchLogo(`public/logos/${sha256(second)}`);
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['cache-control']).toBe('no-store');
    // Deleting again changes nothing.
    expect((await deleteLogo(adminA)).statusCode).toBe(200);
    expect(await brandingAudits(clinics.a.org.id)).toHaveLength(3);
  });

  it('refuses SVG, polyglots and files that are not what they say, storing nothing', async () => {
    const html = Buffer.from('<html><script>alert(document.domain)</script></html>');
    const cases: [string, Buffer | string, string][] = [
      ['image/svg+xml', SAMPLE_SVG, 'svg_not_allowed'],
      // SVG bytes sent as a PNG: refused by content.
      ['image/png', SAMPLE_SVG, 'svg_not_allowed'],
      // A PNG with a page appended, and one with script in a text chunk.
      ['image/png', Buffer.concat([samplePng(), html]), 'not_an_image'],
      ['image/png', samplePng({ extra: [['tEXt', html]] }), 'not_an_image'],
      // A JPEG with a PDF inside its comment.
      ['image/jpeg', sampleJpeg({ comment: '%PDF-1.7 synthetic' }), 'not_an_image'],
      ['image/jpeg', samplePng(), 'type_mismatch'],
      ['image/webp', Buffer.from('RIFF\0\0\0\0WEBPjunk'), 'not_an_image'],
      ['image/png', Buffer.alloc(0), 'empty'],
      ['image/png', samplePng({ extra: [['tEXt', Buffer.alloc(LOGO_MAX_BYTES)]] }), 'too_large'],
      ['image/webp', sampleWebp({ width: 5000, height: 10 }), 'too_many_pixels'],
      ['image/webp', sampleWebp({ width: 2500, height: 2500 }), 'too_many_pixels'],
      // Animation: APNG and animated WebP.
      ['image/png', samplePng({ extra: [['acTL', Buffer.alloc(8)]] }), 'animated'],
      ['image/webp', sampleWebp({ extended: { flags: 0x02 } }), 'animated'],
      // A JPEG with a second frame header.
      ['image/jpeg', sampleJpeg({ layout: 'two_frames' }), 'not_an_image'],
    ];
    for (const [type, data, reason] of cases) {
      const res = await uploadLogo(adminA, type, data);
      expect(res.statusCode, reason).toBe(400);
      expect(fieldOf(res)?.file, reason).toBe(reason);
    }
    // Not an image type at all: refused before any check.
    expect((await uploadLogo(adminA, 'image/gif', Buffer.from('GIF89a'))).statusCode).toBe(415);
    expect((await uploadLogo(adminA, 'text/html', html)).statusCode).toBe(415);
    const json = await h.app.inject({
      method: 'POST',
      url: '/v1/organisation-branding/logo',
      headers: bearer(adminA),
      payload: { logo: 'x' },
    });
    expect(json.statusCode).toBe(415);
    // More than twice the limit is refused before it is read in full.
    const huge = await uploadLogo(adminA, 'image/png', Buffer.alloc(2 * LOGO_MAX_BYTES + 1));
    expect(huge.statusCode).toBe(413);

    expect(await h.owner.organisationBranding.count()).toBe(0);
    expect(await brandingAudits(clinics.a.org.id)).toHaveLength(0);
  });

  it('serves nothing whose stored bytes no longer match or are no longer a plain image', async () => {
    // Bytes of its own: the logo route keeps logos it already verified, by hash.
    const logo = samplePng({ rgb: [0x31, 0x41, 0x59] });
    await uploadLogo(adminA, 'image/png', logo);
    const url = `public/logos/${sha256(logo)}`;
    const get = vi.spyOn(h.services.files, 'get');
    try {
      get.mockResolvedValueOnce(Buffer.concat([logo, Buffer.from('<html>')]));
      expect((await fetchLogo(url)).statusCode).toBe(404);
      get.mockResolvedValueOnce(SAMPLE_SVG);
      expect((await fetchLogo(url)).statusCode).toBe(404);
      get.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      expect((await fetchLogo(url)).statusCode).toBe(404);
    } finally {
      get.mockRestore();
    }
    expect((await fetchLogo(url)).statusCode).toBe(200);
    // Malformed addresses: the same 404.
    for (const bad of ['public/logos/abc', `public/logos/${sha256(logo).toUpperCase()}`]) {
      expect((await fetchLogo(bad)).statusCode).toBe(404);
    }
  });

  it('serves another organisation’s copy of the same logo when one copy is lost', async () => {
    const logo = samplePng({ rgb: [0x22, 0x44, 0x66] });
    await uploadLogo(adminA, 'image/png', logo);
    await uploadLogo(adminB, 'image/png', logo);
    const keyOf = async (organisationId: string) =>
      (await h.owner.organisationBranding.findUniqueOrThrow({ where: { organisationId } }))
        .logoKey!;
    const keyA = await keyOf(clinics.a.org.id);
    const keyB = await keyOf(clinics.b.org.id);
    expect(keyA).not.toBe(keyB);
    // B saved last, so its copy is tried first: lose it, and A's is served.
    await h.services.files.delete(keyB);
    const served = await fetchLogo(`public/logos/${sha256(logo)}`);
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(logo);

    // A suspended organisation's copy is never used, even when it is the only one left.
    const other = samplePng({ rgb: [0x66, 0x44, 0x22] });
    await uploadLogo(adminA, 'image/png', other);
    await uploadLogo(adminB, 'image/png', other);
    await h.services.files.delete(await keyOf(clinics.b.org.id));
    await h.owner.organisation.update({
      where: { id: clinics.a.org.id },
      data: { status: 'suspended' },
    });
    const get = vi.spyOn(h.services.files, 'get');
    try {
      expect((await fetchLogo(`public/logos/${sha256(other)}`)).statusCode).toBe(404);
      expect(get.mock.calls.map(([key]) => key)).not.toContain(await keyOf(clinics.a.org.id));
    } finally {
      get.mockRestore();
    }
  });

  it('keeps one logo when two uploads race, and removes every other file', async () => {
    const first = samplePng({ rgb: [1, 2, 3] });
    await uploadLogo(adminA, 'image/png', first);
    const before = (await h.owner.organisationBranding.findFirstOrThrow()).logoKey!;
    const put = vi.spyOn(h.services.files, 'put');
    let written: string[];
    try {
      const results = await Promise.all([
        uploadLogo(adminA, 'image/png', samplePng({ rgb: [4, 5, 6] })),
        uploadLogo(adminA, 'image/webp', sampleWebp({ width: 3 })),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      written = put.mock.calls.map(([key]) => key);
    } finally {
      put.mockRestore();
    }
    const rows = await h.owner.organisationBranding.findMany();
    expect(rows).toHaveLength(1);
    const kept = rows[0]!.logoKey!;
    expect(written).toContain(kept);
    for (const key of [before, ...written.filter((k) => k !== kept)]) {
      await expect(h.services.files.get(key), key).rejects.toThrow();
    }
    expect(await h.services.files.get(kept)).toBeDefined();
  });

  it('still answers 200 when the replaced file cannot be removed', async () => {
    await uploadLogo(adminA, 'image/png', samplePng({ rgb: [7, 8, 9] }));
    const remove = vi.spyOn(h.services.files, 'delete').mockRejectedValue(new Error('store down'));
    try {
      expect((await uploadLogo(adminA, 'image/png', samplePng())).statusCode).toBe(200);
      expect((await deleteLogo(adminA)).statusCode).toBe(200);
    } finally {
      remove.mockRestore();
    }
  });

  it('stores and audits nothing when the file cannot be written', async () => {
    const put = vi.spyOn(h.services.files, 'put').mockRejectedValue(new Error('store down'));
    try {
      expect((await uploadLogo(adminA, 'image/png', samplePng())).statusCode).toBe(500);
    } finally {
      put.mockRestore();
    }
    expect(await h.owner.organisationBranding.count()).toBe(0);
    expect(await brandingAudits(clinics.a.org.id)).toHaveLength(0);
  });

  it('cleans up after a transaction that fails, whether or not it committed', async () => {
    const db = h.services.db;
    const original = db.$transaction.bind(db) as (fn: unknown) => Promise<unknown>;
    const old = samplePng({ rgb: [9, 9, 9] });
    await uploadLogo(adminA, 'image/png', old);
    const oldKey = (await h.owner.organisationBranding.findFirstOrThrow()).logoKey!;
    const put = vi.spyOn(h.services.files, 'put');
    // Only the transaction that writes a logo file fails, the way `mode` says.
    let mode: 'rollback' | 'lost_after_commit' = 'rollback';
    const tx = vi.spyOn(db, '$transaction').mockImplementation(((
      fn: (t: unknown) => Promise<unknown>,
    ) => {
      const writes = put.mock.calls.length;
      const wrote = () => put.mock.calls.length > writes;
      if (mode === 'rollback') {
        return original(async (t: unknown) => {
          const result = await fn(t);
          if (wrote()) throw new Error('rolled back');
          return result;
        });
      }
      return original(fn).then((result) => {
        if (wrote()) throw new Error('connection lost after commit');
        return result;
      });
    }) as never);
    try {
      // Rolled back after the file was written: the new file goes, the old logo stays.
      const rolled = await uploadLogo(adminA, 'image/png', samplePng({ rgb: [1, 1, 1] }));
      expect(rolled.statusCode).toBe(500);
      const rolledBack = put.mock.calls.at(-1)![0];
      await expect(h.services.files.get(rolledBack)).rejects.toThrow();
      expect((await h.owner.organisationBranding.findFirstOrThrow()).logoKey).toBe(oldKey);
      expect(await h.services.files.get(oldKey)).toEqual(old);

      // Committed, but the answer was lost: the new logo stays and the old file goes.
      mode = 'lost_after_commit';
      const fresh = samplePng({ rgb: [2, 2, 2] });
      expect((await uploadLogo(adminA, 'image/png', fresh)).statusCode).toBe(500);
      const committed = put.mock.calls.at(-1)![0];
      expect((await h.owner.organisationBranding.findFirstOrThrow()).logoKey).toBe(committed);
      expect(await h.services.files.get(committed)).toEqual(fresh);
      await expect(h.services.files.get(oldKey)).rejects.toThrow();
    } finally {
      tx.mockRestore();
      put.mockRestore();
    }
  });

  it('limits logo requests per address', async () => {
    const logo = samplePng();
    await uploadLogo(adminA, 'image/png', logo);
    const url = `/v1/public/logos/${sha256(logo)}`;
    const statuses: number[] = [];
    for (let i = 0; i <= PUBLIC_LOGO_RATE_LIMIT.max; i++) {
      statuses.push(
        (await h.app.inject({ method: 'GET', url, remoteAddress: '10.9.7.1' })).statusCode,
      );
    }
    expect(statuses.slice(0, -1).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await h.app.inject({ method: 'GET', url, remoteAddress: '10.9.7.2' })).statusCode).toBe(
      200,
    );
  });
});

describe('public read', () => {
  it('gives an active organisation’s saved branding, and the same 404 otherwise', async () => {
    await putBranding(adminA, fullBranding);
    const logo = samplePng();
    await uploadLogo(adminA, 'image/png', logo);

    const res = await publicBranding('clinic-a');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=300');
    expect(PublicBranding.parse(res.json())).toEqual({
      organisation: { slug: 'clinic-a', name: 'Clinic A' },
      displayName: 'Synthetic Care A',
      accentColour: '#1a6b5c',
      tagline: 'Family care, synthetic data only',
      logoUrl: `public/logos/${sha256(logo)}`,
    });
    expect(Object.keys(res.json()).sort()).toEqual(Object.keys(PublicBranding.shape).sort());
    // No IDs, file keys or anything of the organisation besides.
    expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(res.body).not.toContain('organisations/');

    // No branding saved (clinic B), unknown, malformed: the same 404, never cached.
    const bodies = [];
    for (const slug of ['clinic-b', 'clinic-nobody', 'Clinic-A', 'a', '-x']) {
      const missing = await publicBranding(slug);
      expect(missing.statusCode, slug).toBe(404);
      expect(missing.headers['cache-control']).toBe('no-store');
      const { error } = ErrorResponse.parse(missing.json());
      bodies.push({ code: error.code, message: error.message });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

    // A suspended organisation shows nothing: neither its branding nor its logo.
    await h.owner.organisation.update({
      where: { id: clinics.a.org.id },
      data: { status: 'suspended' },
    });
    expect((await publicBranding('clinic-a')).statusCode).toBe(404);
    expect((await fetchLogo(`public/logos/${sha256(logo)}`)).statusCode).toBe(404);
  });

  it('limits requests per address', async () => {
    await putBranding(adminA, fullBranding);
    const statuses: number[] = [];
    for (let i = 0; i <= PUBLIC_DOCTOR_RATE_LIMIT.max; i++) {
      statuses.push((await publicBranding('clinic-a', '10.9.8.1')).statusCode);
    }
    expect(statuses.slice(0, -1).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await publicBranding('clinic-a', '10.9.8.2')).statusCode).toBe(200);
  });

  it('puts the branding on the doctor page and the directory card', async () => {
    const doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await h.owner.doctorProfile.create({
      data: {
        organisationId: clinics.a.org.id,
        userId: clinics.a.doctor.userId,
        registrationNumber: 'TEST-SA',
        council: 'Test Medical Council',
        rxPrefix: 'SA',
        verification: 'verified',
        verifiedAt: new Date(),
        verifiedBy: 'ops@platform.test (SUP-1)',
      },
    });
    await h.app.inject({
      method: 'PATCH',
      url: '/v1/doctor-profile/public',
      headers: bearer(doctor),
      payload: { slug: 'dr-branded', listed: true },
    });
    const logo = sampleWebp();
    await putBranding(adminA, fullBranding);
    await uploadLogo(adminA, 'image/webp', logo);
    const branding = {
      displayName: 'Synthetic Care A',
      accentColour: '#1a6b5c',
      logoUrl: `public/logos/${sha256(logo)}`,
    };

    const page = await h.app.inject({ method: 'GET', url: '/v1/public/doctors/dr-branded' });
    expect(PublicDoctor.parse(page.json()).organisation).toEqual({
      slug: 'clinic-a',
      name: 'Clinic A',
      branding,
    });
    // The tagline is for the portal's sign-in only.
    expect(page.body).not.toContain('Family care');

    const directory = await h.app.inject({
      method: 'GET',
      url: '/v1/public/doctor-directory',
      remoteAddress: '10.3.0.9',
    });
    const [card] = PublicDoctorDirectory.parse(directory.json()).data;
    // The card has the display name only: the home page stays unbranded.
    expect(card).toMatchObject({ slug: 'dr-branded', organisationDisplayName: 'Synthetic Care A' });
    for (const absent of ['clinic-a', 'Family care', '1a6b5c', sha256(logo)]) {
      expect(directory.body).not.toContain(absent);
    }
  });
});

describe('in the database', () => {
  it('returns branding and logos only for active organisations that saved them', async () => {
    await putBranding(adminA, fullBranding);
    const logo = samplePng();
    await uploadLogo(adminA, 'image/png', logo);
    const asPublic = <T>(sql: TemplateStringsArray, ...values: unknown[]) =>
      withPublic(h.services.db, (tx) => tx.$queryRaw<T[]>(sql, ...values));

    expect(await asPublic`SELECT * FROM public_organisation_branding('clinic-a')`).toHaveLength(1);
    expect(await asPublic`SELECT * FROM public_organisation_branding('clinic-b')`).toEqual([]);
    expect(
      await asPublic<{
        media_type: string;
      }>`SELECT media_type FROM public_organisation_logo(${sha256(logo)})`,
    ).toEqual([{ media_type: 'image/png' }]);
    for (const bad of ['', 'x', "' OR 1=1 --", sha256(Buffer.from('other'))]) {
      expect(await asPublic`SELECT * FROM public_organisation_logo(${bad})`).toEqual([]);
    }
    // With no organisation set, the table itself shows nothing.
    expect(await asPublic`SELECT * FROM organisation_branding`).toEqual([]);

    await h.owner.organisation.update({
      where: { id: clinics.a.org.id },
      data: { status: 'suspended' },
    });
    expect(await asPublic`SELECT * FROM public_organisation_branding('clinic-a')`).toEqual([]);
    expect(await asPublic`SELECT * FROM public_organisation_logo(${sha256(logo)})`).toEqual([]);
  });

  it('enforces the formats with CHECK constraints', async () => {
    const organisationId = clinics.a.org.id;
    const other = clinics.b.org.id;
    const sha = 'a'.repeat(64);
    const logo = (key: string, mediaType = 'image/png', size = 10) => ({
      logoKey: key,
      logoMediaType: mediaType,
      logoSizeBytes: size,
      logoSha256: sha,
    });
    const okKey = `organisations/${organisationId}/branding/logo-0123456789ab.png`;
    await h.owner.organisationBranding.create({ data: { organisationId, ...logo(okKey) } });
    for (const data of [
      { displayName: '' },
      { displayName: 'x'.repeat(81) },
      { displayName: ' padded' },
      { displayName: 'Line\nbreak' },
      { displayName: 'Bidi\u202eoverride' },
      { displayName: 'Zero\u200bwidth' },
      { displayName: 'Mark\u200fx' },
      { displayName: 'Arabic\u061cmark' },
      { tagline: 'Word\u2060joiner' },
      { tagline: 'Bom\ufeffx' },
      { tagline: 'y'.repeat(121) },
      { accentColour: '#1A6B5C' },
      { accentColour: 'red' },
      { accentColour: '#1a6b5c;x' },
      logo(okKey, 'image/svg+xml'),
      logo(okKey, 'image/gif'),
      logo(okKey, 'image/png', LOGO_MAX_BYTES + 1),
      logo(okKey, 'image/png', 0),
      logo(`organisations/${other}/branding/logo-0123456789ab.png`),
      logo(`organisations/${organisationId}/test-results/x.png`),
      logo(`organisations/${organisationId}/branding/logo-0123456789ab.svg`),
      { ...logo(okKey), logoSha256: 'not-a-hash' },
      { logoKey: null },
    ]) {
      await expect(
        h.owner.organisationBranding.update({ where: { organisationId }, data }),
        JSON.stringify(data),
      ).rejects.toThrow(/check constraint/i);
    }
  });
});
