import { PublicDoctor, PublicDoctorCard } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import {
  toPublicDoctor,
  toPublicDoctorCard,
  type PublicDoctorCardRow,
  type PublicDoctorRow,
} from './service';

const row: PublicDoctorRow = {
  slug: 'dr-synthetic',
  display_name: 'Dr. Synthetic',
  qualifications: 'MBBS',
  specialty: null,
  registration_number: 'TEST-1',
  council: 'Test Medical Council',
  about: null,
  languages: ['English'],
  organisation_slug: 'demo-clinic',
  organisation_name: 'Demo Clinic',
  clinics: [{ name: 'Main clinic', address: null }],
  consultation_types: [{ name: 'In person', mode: 'in_person', durationMin: 15, feePaise: 50000 }],
  updated_at: new Date('2026-10-18T10:00:00Z'),
};

describe('toPublicDoctor', () => {
  it('maps the function row to the page', () => {
    expect(PublicDoctor.parse(toPublicDoctor(row))).toEqual({
      slug: 'dr-synthetic',
      name: 'Dr. Synthetic',
      qualifications: 'MBBS',
      specialty: null,
      registration: { number: 'TEST-1', council: 'Test Medical Council' },
      about: null,
      languages: ['English'],
      organisation: {
        slug: 'demo-clinic',
        name: 'Demo Clinic',
        branding: { displayName: null, accentColour: null, logoUrl: null },
      },
      clinics: [{ name: 'Main clinic', address: null }],
      consultationTypes: [
        { name: 'In person', mode: 'in_person', durationMin: 15, feePaise: 50000 },
      ],
      updatedAt: '2026-10-18T10:00:00.000Z',
    });
  });

  it('adds the organisation’s branding, with the logo’s address', () => {
    const sha = 'ab'.repeat(32);
    const page = toPublicDoctor(row, {
      organisation_slug: 'demo-clinic',
      organisation_name: 'Demo Clinic',
      display_name: 'Demo Care',
      accent_colour: '#1a6b5c',
      tagline: 'Not on the doctor page',
      logo_sha256: sha,
    });
    expect(PublicDoctor.parse(page).organisation.branding).toEqual({
      displayName: 'Demo Care',
      accentColour: '#1a6b5c',
      logoUrl: `public/logos/${sha}`,
    });
    expect(JSON.stringify(page)).not.toContain('Not on the doctor page');
  });

  it('copies only the known fields, even if a row or its JSON grew more', () => {
    const grown = {
      ...row,
      user_id: '7a4f0d6c-5b8e-4f1c-9d54-6e7f8091a2b3',
      phone: '+910000000000',
      clinics: [{ name: 'Main clinic', address: null, id: 'c1', phone: '+910000000000' }],
      consultation_types: [
        { ...row.consultation_types[0]!, id: 't1', followUpFeePaise: 1, requiresPrepayment: true },
      ],
    } as unknown as PublicDoctorRow;
    const json = JSON.stringify(toPublicDoctor(grown));
    for (const leaked of ['7a4f0d6c', '+91', '"id"', 'followUp', 'Prepayment']) {
      expect(json).not.toContain(leaked);
    }
  });
});

describe('toPublicDoctorCard', () => {
  const card: PublicDoctorCardRow = {
    slug: 'dr-synthetic',
    display_name: 'Dr. Synthetic',
    qualifications: 'MBBS',
    specialty: 'General medicine',
    organisation_name: 'Demo Clinic',
    clinics: [
      { name: 'Main clinic', addressLine: '1 Test Road, Testpur' },
      { name: 'Branch clinic', addressLine: null },
    ],
    languages: ['English', 'Hindi'],
    fee_from_paise: 50000,
    organisation_display_name: null,
  };

  it('maps the directory row to the card', () => {
    expect(PublicDoctorCard.parse(toPublicDoctorCard(card))).toEqual({
      slug: 'dr-synthetic',
      name: 'Dr. Synthetic',
      qualifications: 'MBBS',
      specialty: 'General medicine',
      organisationName: 'Demo Clinic',
      clinics: [
        { name: 'Main clinic', addressLine: '1 Test Road, Testpur' },
        { name: 'Branch clinic', addressLine: null },
      ],
      languages: ['English', 'Hindi'],
      feeFromPaise: 50000,
      organisationDisplayName: null,
    });
  });

  it('carries the organisation’s display name, never its colour or logo', () => {
    const out = toPublicDoctorCard({
      ...card,
      organisation_display_name: 'Demo Care',
      accent_colour: '#1a6b5c',
      logo_sha256: 'cd'.repeat(32),
    } as unknown as PublicDoctorCardRow);
    expect(out.organisationDisplayName).toBe('Demo Care');
    expect(JSON.stringify(out)).not.toMatch(/1a6b5c|cdcd|logo/);
  });

  it('keeps a doctor with no name, clinic or fee', () => {
    expect(
      toPublicDoctorCard({ ...card, display_name: null, clinics: [], fee_from_paise: null }),
    ).toMatchObject({ name: null, clinics: [], feeFromPaise: null });
  });

  it('copies only the known fields, even if a row or its JSON grew more', () => {
    const grown = {
      ...card,
      user_id: '7a4f0d6c-5b8e-4f1c-9d54-6e7f8091a2b3',
      organisation_slug: 'demo-clinic',
      registration_number: 'TEST-1',
      clinics: [{ name: 'Main clinic', addressLine: null, id: 'c1', phone: '+910000000000' }],
    } as unknown as PublicDoctorCardRow;
    const json = JSON.stringify(toPublicDoctorCard(grown));
    for (const leaked of ['7a4f0d6c', '+91', '"id"', 'demo-clinic', 'TEST-1']) {
      expect(json).not.toContain(leaked);
    }
  });
});
