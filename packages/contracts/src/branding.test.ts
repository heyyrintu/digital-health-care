import { describe, expect, it } from 'vitest';
import {
  AccentColour,
  LOGO_MEDIA_TYPES,
  LogoMediaType,
  MIN_ACCENT_CONTRAST,
  OrganisationBranding,
  PublicBranding,
  PublicBrandingParams,
  PublicLogoParams,
  UpdateOrganisationBrandingBody,
  buildOpenApiDocument,
  contrastRatio,
  isReadableAccent,
  logoUrlOf,
} from './index';

describe('contrastRatio', () => {
  it('gives the WCAG ratios for known pairs', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Order does not matter.
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(contrastRatio('#767676', '#ffffff'));
    // #767676 is the classic lightest grey that passes AA on white; #777777 just fails.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('refuses anything but #rrggbb', () => {
    expect(() => contrastRatio('#fff', '#ffffff')).toThrow();
    expect(() => contrastRatio('red', '#ffffff')).toThrow();
  });
});

describe('AccentColour', () => {
  it('lowercases and trims, and keeps colours readable with white text', () => {
    expect(AccentColour.parse(' #1A6B5C ')).toBe('#1a6b5c');
    expect(isReadableAccent('#1a6b5c')).toBe(true);
    expect(isReadableAccent('#767676')).toBe(true);
  });

  it.each(['#ffffff', '#ffff00', '#777777', '#7fdbca', '#00b3a4'])(
    'refuses %s: below %d:1 with white',
    (colour) => {
      expect(contrastRatio(colour, '#ffffff')).toBeLessThan(MIN_ACCENT_CONTRAST);
      expect(AccentColour.safeParse(colour).success).toBe(false);
    },
  );

  it.each([
    '#123',
    '123456',
    '#12345g',
    'rgb(0,0,0)',
    'red',
    '#1a6b5c; background:url(x)',
    'var(--x)',
    '#1a6b5c00',
  ])('refuses %s: only a plain #rrggbb, never CSS', (colour) => {
    expect(AccentColour.safeParse(colour).success).toBe(false);
  });
});

describe('UpdateOrganisationBrandingBody', () => {
  it('trims text, treats an empty text as none and keeps null', () => {
    expect(
      UpdateOrganisationBrandingBody.parse({
        displayName: '  Synthetic Care  ',
        accentColour: null,
        tagline: '   ',
      }),
    ).toEqual({ displayName: 'Synthetic Care', accentColour: null, tagline: null });
  });

  it('treats an emptied colour as none', () => {
    expect(
      UpdateOrganisationBrandingBody.parse({ displayName: null, accentColour: '', tagline: null })
        .accentColour,
    ).toBeNull();
    expect(
      UpdateOrganisationBrandingBody.safeParse({
        displayName: null,
        accentColour: ' ',
        tagline: null,
      }).success,
    ).toBe(false);
  });

  it('needs every field (a PUT)', () => {
    expect(UpdateOrganisationBrandingBody.safeParse({ displayName: 'X' }).success).toBe(false);
  });

  it('caps the name at 80 and the tagline at 120 characters', () => {
    const body = (displayName: string, tagline: string) =>
      UpdateOrganisationBrandingBody.safeParse({ displayName, accentColour: null, tagline });
    expect(body('x'.repeat(80), 'y'.repeat(120)).success).toBe(true);
    expect(body('x'.repeat(81), 'y').success).toBe(false);
    expect(body('x', 'y'.repeat(121)).success).toBe(false);
  });

  it.each([
    'Line\nbreak',
    'Tab\tbed',
    'Null\u0000',
    'Reversed \u202egnp.exe',
    'Isolate\u2066x',
    'Zero\u200bwidth',
    'Joiner\u200dx',
    'Mark\u200fx',
    'Arabic\u061cmark',
    'Word\u2060joiner',
    'Bom\ufeffx',
  ])('refuses control, direction and invisible characters: %j', (displayName) => {
    expect(
      UpdateOrganisationBrandingBody.safeParse({ displayName, accentColour: null, tagline: null })
        .success,
    ).toBe(false);
  });

  it('accepts Hindi and other scripts', () => {
    expect(
      UpdateOrganisationBrandingBody.parse({
        displayName: 'सिंथेटिक क्लिनिक',
        accentColour: '#1a6b5c',
        tagline: 'परिवार के लिए देखभाल',
      }).displayName,
    ).toBe('सिंथेटिक क्लिनिक');
  });
});

describe('logos', () => {
  it('are PNG, JPEG or WebP, never SVG', () => {
    expect(LogoMediaType.options.sort()).toEqual(Object.values(LOGO_MEDIA_TYPES).sort());
    expect(LogoMediaType.safeParse('image/svg+xml').success).toBe(false);
  });

  it('are addressed by their hash, relative to the API', () => {
    const sha = 'a'.repeat(64);
    expect(logoUrlOf(sha)).toBe(`public/logos/${sha}`);
    expect(PublicLogoParams.safeParse({ sha256: sha }).success).toBe(true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), '../etc/passwd', `${sha}.png`]) {
      expect(PublicLogoParams.safeParse({ sha256: bad }).success).toBe(false);
    }
  });
});

describe('public branding', () => {
  it('carries only the published fields', () => {
    expect(Object.keys(PublicBranding.shape).sort()).toEqual([
      'accentColour',
      'displayName',
      'logoUrl',
      'organisation',
      'tagline',
    ]);
    expect(Object.keys(OrganisationBranding.shape).sort()).toEqual([
      'accentColour',
      'displayName',
      'logo',
      'organisation',
      'tagline',
      'updatedAt',
    ]);
  });

  it('takes an organisation slug as it is, never transformed', () => {
    expect(PublicBrandingParams.safeParse({ slug: 'demo-clinic' }).success).toBe(true);
    expect(PublicBrandingParams.safeParse({ slug: 'Demo-Clinic' }).success).toBe(false);
  });

  it('is in the OpenAPI document, public routes without auth', () => {
    const doc = buildOpenApiDocument({ version: 'test' });
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/public/organisations/{slug}/branding']?.get?.security).toEqual([]);
    expect(paths['/public/logos/{sha256}']?.get?.security).toEqual([]);
    expect(paths['/organisation-branding']?.put?.security).toBeUndefined();
    const upload = paths['/organisation-branding/logo']?.post?.requestBody as {
      content: Record<string, unknown>;
    };
    expect(Object.keys(upload.content).sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});
