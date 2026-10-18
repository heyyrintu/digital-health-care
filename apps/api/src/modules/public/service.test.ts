import { PublicDoctor } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { toPublicDoctor, type PublicDoctorRow } from './service';

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
      organisation: { slug: 'demo-clinic', name: 'Demo Clinic' },
      clinics: [{ name: 'Main clinic', address: null }],
      consultationTypes: [
        { name: 'In person', mode: 'in_person', durationMin: 15, feePaise: 50000 },
      ],
      updatedAt: '2026-10-18T10:00:00.000Z',
    });
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
