import { PublicBranding } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { toOrganisationBranding, toPublicBranding, type PublicBrandingRow } from './branding';

const row: PublicBrandingRow = {
  organisation_slug: 'demo-clinic',
  organisation_name: 'Demo Clinic',
  display_name: 'Demo Care',
  accent_colour: '#1a6b5c',
  tagline: 'Care for the whole family',
  logo_sha256: 'ef'.repeat(32),
};

describe('toPublicBranding', () => {
  it('maps the function row to the public branding', () => {
    expect(PublicBranding.parse(toPublicBranding(row))).toEqual({
      organisation: { slug: 'demo-clinic', name: 'Demo Clinic' },
      displayName: 'Demo Care',
      accentColour: '#1a6b5c',
      tagline: 'Care for the whole family',
      logoUrl: `public/logos/${'ef'.repeat(32)}`,
    });
  });

  it('gives no logo address without a logo', () => {
    expect(toPublicBranding({ ...row, logo_sha256: null }).logoUrl).toBeNull();
  });

  it('copies only the known fields, even if a row grew more', () => {
    const grown = {
      ...row,
      organisation_id: '7a4f0d6c-5b8e-4f1c-9d54-6e7f8091a2b3',
      logo_key: 'organisations/7a4f0d6c/branding/logo-0123456789ab.png',
    } as unknown as PublicBrandingRow;
    const json = JSON.stringify(toPublicBranding(grown));
    for (const leaked of ['7a4f0d6c', 'organisations/', 'logo_key']) {
      expect(json).not.toContain(leaked);
    }
  });
});

describe('toOrganisationBranding', () => {
  it('is all null when the organisation has no branding', () => {
    expect(toOrganisationBranding(undefined)).toEqual({
      displayName: null,
      accentColour: null,
      logoUrl: null,
    });
  });
});
