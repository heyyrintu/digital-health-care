import { describe, expect, it } from 'vitest';
import { brandingOut, changedBrandingFields, type BrandingRow } from './service';

const row: BrandingRow = {
  displayName: 'Demo Care',
  accentColour: '#1a6b5c',
  tagline: null,
  logoKey: 'organisations/00000000-0000-4000-8000-000000000000/branding/logo-0123456789ab.png',
  logoMediaType: 'image/png',
  logoSizeBytes: 1234,
  logoSha256: '12'.repeat(32),
  updatedAt: new Date('2026-10-19T09:00:00Z'),
};
const org = { slug: 'demo-clinic', name: 'Demo Clinic' };

describe('brandingOut', () => {
  it('maps the row, with the logo’s address and never its file key', () => {
    const out = brandingOut(org, row);
    expect(out).toEqual({
      organisation: org,
      displayName: 'Demo Care',
      accentColour: '#1a6b5c',
      tagline: null,
      logo: { url: `public/logos/${'12'.repeat(32)}`, mediaType: 'image/png', sizeBytes: 1234 },
      updatedAt: '2026-10-19T09:00:00.000Z',
    });
    expect(JSON.stringify(out)).not.toContain('organisations/');
  });

  it('is empty until an admin saves branding', () => {
    expect(brandingOut(org, null)).toEqual({
      organisation: org,
      displayName: null,
      accentColour: null,
      tagline: null,
      logo: null,
      updatedAt: null,
    });
  });
});

describe('changedBrandingFields', () => {
  it('names the fields that change, compared with what is stored', () => {
    expect(
      changedBrandingFields(row, { displayName: 'Demo Care', accentColour: null, tagline: 'New' }),
    ).toEqual(['accentColour', 'tagline']);
    expect(
      changedBrandingFields(null, { displayName: null, accentColour: null, tagline: null }),
    ).toEqual([]);
    expect(
      changedBrandingFields(null, { displayName: 'X', accentColour: null, tagline: null }),
    ).toEqual(['displayName']);
  });
});
