import type { PublicDoctor } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { publicSiteUrl } from './config';
import { portalNext } from './patient';
import { isListedSlug } from './public-doctor-server';
import {
  bookingHref,
  doctorDescription,
  doctorPath,
  jsonLdScript,
  parseLanguages,
  physicianJsonLd,
  publicProfileErrors,
} from './public-doctor';

const doctor: PublicDoctor = {
  slug: 'dr-synthetic',
  name: 'Dr. Synthetic',
  qualifications: 'MBBS, MS (Ortho)',
  specialty: 'Orthopaedics',
  registration: { number: 'TEST-12345', council: 'Test Medical Council' },
  about: 'Synthetic about text.',
  languages: ['English', 'Hindi'],
  organisation: { slug: 'demo-clinic', name: 'Demo Clinic' },
  clinics: [{ name: 'Main clinic', address: '1 Test Road' }],
  consultationTypes: [
    { name: 'In-person consultation', mode: 'in_person', durationMin: 15, feePaise: 80000 },
  ],
  updatedAt: '2026-10-18T10:00:00.000Z',
};

describe('bookingHref', () => {
  it('signs in at the doctor’s clinic, then opens booking with the doctor picked', () => {
    const href = bookingHref(doctor);
    const url = new URL(href, 'https://site.test');
    expect(url.pathname).toBe('/app/login');
    expect(url.searchParams.get('clinic')).toBe('demo-clinic');
    expect(url.searchParams.get('next')).toBe('/app/book?doctor=dr-synthetic');
    // The sign-in page follows it.
    expect(portalNext(url.searchParams.get('next'))).toBe('/app/book?doctor=dr-synthetic');
  });
});

describe('physicianJsonLd', () => {
  it('describes a Physician with the verified registration and clinics', () => {
    expect(physicianJsonLd(doctor, 'https://site.test/doctor/dr-synthetic')).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Physician',
      name: 'Dr. Synthetic',
      url: 'https://site.test/doctor/dr-synthetic',
      description: 'Synthetic about text.',
      medicalSpecialty: 'Orthopaedics',
      knowsLanguage: ['English', 'Hindi'],
      hasCredential: {
        '@type': 'EducationalOccupationalCredential',
        credentialCategory: 'Medical registration',
        identifier: 'TEST-12345',
        recognizedBy: { '@type': 'Organization', name: 'Test Medical Council' },
      },
      parentOrganization: { '@type': 'MedicalOrganization', name: 'Demo Clinic' },
      location: [{ '@type': 'MedicalClinic', name: 'Main clinic', address: '1 Test Road' }],
    });
  });

  it('leaves out what the doctor did not fill in', () => {
    const bare = physicianJsonLd(
      { ...doctor, about: null, specialty: null, languages: [], clinics: [] },
      'https://site.test/doctor/dr-synthetic',
    );
    expect(Object.keys(bare)).not.toContain('description');
    expect(Object.keys(bare)).not.toContain('medicalSpecialty');
    expect(Object.keys(bare)).not.toContain('knowsLanguage');
    expect(Object.keys(bare)).not.toContain('location');
  });

  it('cannot close its script tag with text the doctor typed', () => {
    const script = jsonLdScript(
      physicianJsonLd({ ...doctor, about: '</script><script>alert(1)</script>' }, 'u'),
    );
    expect(script).not.toContain('<');
    expect(JSON.parse(script).description).toBe('</script><script>alert(1)</script>');
  });
});

describe('page text', () => {
  it('describes the doctor in English and Hindi', () => {
    expect(doctorDescription(doctor)).toBe(
      'Dr. Synthetic, Orthopaedics at Demo Clinic. Book an appointment online.',
    );
    expect(doctorDescription({ ...doctor, specialty: null })).toBe(
      'Dr. Synthetic at Demo Clinic. Book an appointment online.',
    );
    expect(doctorDescription(doctor, 'hi')).toContain('Demo Clinic');
  });

  it('builds the path and the site address', () => {
    expect(doctorPath('dr-synthetic')).toBe('/doctor/dr-synthetic');
    expect(publicSiteUrl({ PUBLIC_SITE_URL: 'https://site.test/' })).toBe('https://site.test');
    expect(publicSiteUrl({ WEB_BASE_URL: 'https://web.test' })).toBe('https://web.test');
    expect(publicSiteUrl({})).toBe('http://localhost:3000');
    expect(() => publicSiteUrl({ NODE_ENV: 'production' })).toThrow(/PUBLIC_SITE_URL/);
    expect(publicSiteUrl({ NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://site.test' })).toBe(
      'https://site.test',
    );
  });
});

describe('the doctor’s settings', () => {
  it('reads languages typed with commas', () => {
    expect(parseLanguages(' English, Hindi ,, Punjabi ')).toEqual(['English', 'Hindi', 'Punjabi']);
    expect(parseLanguages('')).toEqual([]);
  });

  it('maps refused fields to messages', () => {
    expect(publicProfileErrors({ slug: 'taken' })).toEqual({ slug: 'profile.publicSlugTaken' });
    expect(publicProfileErrors({ slug: 'That address is reserved.' })).toEqual({
      slug: 'profile.publicSlugReserved',
    });
    expect(publicProfileErrors({ slug: 'required' })).toEqual({
      slug: 'profile.publicSlugRequired',
    });
    expect(
      publicProfileErrors({
        slug: 'Use lowercase letters, digits and single hyphens.',
        about: 'Too big',
        'languages.2': 'Too big',
        listed: 'x',
      }),
    ).toEqual({
      slug: 'profile.publicSlugInvalid',
      about: 'profile.publicAboutInvalid',
      languages: 'profile.publicLanguagesInvalid',
    });
  });
});

describe('isListedSlug', () => {
  it('asks the API only about addresses the cached list has', () => {
    const listed = [{ slug: 'dr-synthetic' }];
    expect(isListedSlug('dr-synthetic', listed)).toBe(true);
    expect(isListedSlug('dr-probe', listed)).toBe(false);
  });
});
