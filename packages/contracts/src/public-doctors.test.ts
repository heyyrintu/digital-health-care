import { describe, expect, it } from 'vitest';
import {
  DoctorProfile,
  PublicDoctor,
  PublicDoctorParams,
  SaveDoctorPublicProfileBody,
  buildOpenApiDocument,
  isPublicSlug,
} from './index';

describe('public page address', () => {
  it.each(['dr-synthetic', 'abc', 'a1-b2-c3', 'x'.repeat(60)])('accepts %s', (slug) => {
    expect(isPublicSlug(slug)).toBe(true);
    expect(SaveDoctorPublicProfileBody.parse({ slug }).slug).toBe(slug);
  });

  it.each(['ab', 'x'.repeat(61), '-dr', 'dr-', 'dr--x', 'dr_x', 'dr x', 'डॉक्टर', 'dr.x'])(
    'refuses %s',
    (slug) => {
      expect(isPublicSlug(slug)).toBe(false);
      expect(SaveDoctorPublicProfileBody.safeParse({ slug }).success).toBe(false);
    },
  );

  it.each(['admin', 'Doctor', 'verify', 'app'])('refuses the reserved address %s', (slug) => {
    expect(SaveDoctorPublicProfileBody.safeParse({ slug }).success).toBe(false);
  });

  it('lowercases and trims what the doctor types, but never the path', () => {
    expect(SaveDoctorPublicProfileBody.parse({ slug: '  Dr-Synthetic ' }).slug).toBe(
      'dr-synthetic',
    );
    expect(PublicDoctorParams.safeParse({ slug: 'Dr-Synthetic' }).success).toBe(false);
    expect(PublicDoctorParams.safeParse({ slug: 'dr-synthetic' }).success).toBe(true);
  });
});

describe('SaveDoctorPublicProfileBody', () => {
  it('needs at least one field', () => {
    expect(SaveDoctorPublicProfileBody.safeParse({}).success).toBe(false);
    expect(SaveDoctorPublicProfileBody.parse({ listed: false })).toEqual({ listed: false });
  });

  it('clears about with an empty text or null, and keeps it under 1000 characters', () => {
    expect(SaveDoctorPublicProfileBody.parse({ about: '   ' }).about).toBeNull();
    expect(SaveDoctorPublicProfileBody.parse({ about: null }).about).toBeNull();
    expect(SaveDoctorPublicProfileBody.parse({ about: 'a'.repeat(1000) }).about).toHaveLength(1000);
    expect(SaveDoctorPublicProfileBody.safeParse({ about: 'a'.repeat(1001) }).success).toBe(false);
  });

  it('takes up to 8 languages, each once whatever the case', () => {
    expect(
      SaveDoctorPublicProfileBody.parse({ languages: [' English', 'हिन्दी '] }).languages,
    ).toEqual(['English', 'हिन्दी']);
    expect(SaveDoctorPublicProfileBody.safeParse({ languages: ['Hindi', 'hindi'] }).success).toBe(
      false,
    );
    expect(SaveDoctorPublicProfileBody.safeParse({ languages: [''] }).success).toBe(false);
    expect(
      SaveDoctorPublicProfileBody.safeParse({
        languages: Array.from({ length: 9 }, (_, i) => `L${i}`),
      }).success,
    ).toBe(false);
    expect(SaveDoctorPublicProfileBody.safeParse({ languages: ['x'.repeat(41)] }).success).toBe(
      false,
    );
  });
});

describe('PublicDoctor', () => {
  it('carries no internal IDs, contact details or unverified registration fields', () => {
    const keys = Object.keys(PublicDoctor.shape).sort();
    expect(keys).toEqual([
      'about',
      'clinics',
      'consultationTypes',
      'languages',
      'name',
      'organisation',
      'qualifications',
      'registration',
      'slug',
      'specialty',
      'updatedAt',
    ]);
    expect(Object.keys(PublicDoctor.shape.organisation.shape).sort()).toEqual(['name', 'slug']);
    expect(Object.keys(PublicDoctor.shape.clinics.element.shape).sort()).toEqual([
      'address',
      'name',
    ]);
  });

  it('is part of the doctor’s own profile as publicProfile', () => {
    expect(Object.keys(DoctorProfile.shape.publicProfile.shape).sort()).toEqual([
      'about',
      'languages',
      'listed',
      'live',
      'slug',
    ]);
  });

  it('documents the slug path parameter as a pattern, not a UUID', () => {
    const doc = buildOpenApiDocument({ version: '0.0.0' });
    const get = doc.paths['/public/doctors/{slug}']!.get as {
      parameters: { name: string; schema: { pattern?: string; format?: string } }[];
    };
    expect(get.parameters[0]).toMatchObject({
      name: 'slug',
      schema: { pattern: expect.any(String) },
    });
    expect(get.parameters[0]!.schema.format).toBeUndefined();
  });
});
