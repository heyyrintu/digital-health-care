import { describe, expect, it } from 'vitest';
import {
  accentStyle,
  brandingErrors,
  brandName,
  checkAccent,
  checkLogoFile,
  formatRatio,
  logoErrorKey,
  logoUploadErrorKey,
  logoSrc,
} from './branding';

const sha = 'ab'.repeat(32);

describe('logoSrc', () => {
  it('joins the API base URL and the logo address', () => {
    expect(logoSrc('https://api.test/v1', `public/logos/${sha}`)).toBe(
      `https://api.test/v1/public/logos/${sha}`,
    );
    expect(logoSrc('https://api.test/v1/', `public/logos/${sha}`)).toBe(
      `https://api.test/v1/public/logos/${sha}`,
    );
  });

  it.each([
    null,
    undefined,
    '',
    'https://evil.test/logo.png',
    '//evil.test/x',
    `public/logos/${sha}?x=1`,
    `public/logos/../../${sha}`,
    'javascript:alert(1)',
    `public/logos/${sha.toUpperCase()}`,
  ])('gives no logo for %s', (url) => {
    expect(logoSrc('https://api.test/v1', url)).toBeNull();
  });
});

describe('accentStyle', () => {
  it('sets the accent and the theme colour inside the branded element', () => {
    expect(accentStyle('#1a6b5c')).toEqual({
      '--brand-accent': '#1a6b5c',
      '--primary': '#1a6b5c',
      '--primary-foreground': '#ffffff',
      '--ring': '#1a6b5c',
    });
  });

  it.each([null, undefined, '', '#ffffff', '#7fdbca', 'red', '#1a6b5c;color:red', 'url(x)'])(
    'keeps the platform theme for %s',
    (accent) => {
      expect(accentStyle(accent)).toBeUndefined();
    },
  );
});

describe('brandName', () => {
  it('prefers the display name', () => {
    expect(brandName('Clinic A', { displayName: 'Care A' })).toBe('Care A');
    expect(brandName('Clinic A', { displayName: null })).toBe('Clinic A');
    expect(brandName('Clinic A', null)).toBe('Clinic A');
  });
});

describe('checkAccent', () => {
  it('checks the format, then the contrast with white', () => {
    expect(checkAccent('')).toEqual({ status: 'empty' });
    expect(checkAccent('teal')).toEqual({ status: 'invalid' });
    expect(checkAccent(' #1A6B5C ')).toMatchObject({ status: 'ok', colour: '#1a6b5c' });
    expect(checkAccent('#7fdbca')).toMatchObject({ status: 'low_contrast' });
  });

  it('shows the ratio rounded down', () => {
    expect(formatRatio(4.4999)).toBe('4.49:1');
    expect(formatRatio(21)).toBe('21.00:1');
  });
});

describe('checkLogoFile', () => {
  it('takes PNG, JPEG and WebP up to 512 KB, never SVG', () => {
    expect(checkLogoFile({ type: 'image/png', size: 1000 })).toBe('ok');
    expect(checkLogoFile({ type: 'image/webp', size: 512 * 1024 })).toBe('ok');
    expect(checkLogoFile({ type: 'image/jpeg', size: 512 * 1024 + 1 })).toBe('too_large');
    expect(checkLogoFile({ type: 'image/svg+xml', size: 10 })).toBe('svg_not_allowed');
    expect(checkLogoFile({ type: 'image/gif', size: 10 })).toBe('type_not_allowed');
    expect(checkLogoFile({ type: '', size: 10 })).toBe('type_not_allowed');
  });

  it('has a message for every refusal', () => {
    expect(logoErrorKey('svg_not_allowed')).toBe('branding.logoSvg');
    expect(logoErrorKey('too_many_pixels')).toBe('branding.logoTooManyPixels');
    expect(logoErrorKey('animated')).toBe('branding.logoAnimated');
    expect(logoErrorKey('not_an_image')).toBe('branding.logoNotImage');
    expect(logoErrorKey('type_mismatch')).toBe('branding.logoNotImage');
  });
});

describe('logoUploadErrorKey', () => {
  it('maps refusals before the checks by status, and the checks by reason', () => {
    expect(logoUploadErrorKey(413, {})).toBe('branding.logoTooLarge');
    expect(logoUploadErrorKey(415, { file: 'type_not_allowed' })).toBe('branding.logoType');
    expect(logoUploadErrorKey(429, {})).toBe('patient.tests.rateLimited');
    expect(logoUploadErrorKey(400, { file: 'animated' })).toBe('branding.logoAnimated');
    expect(logoUploadErrorKey(500, {})).toBeNull();
  });
});

describe('brandingErrors', () => {
  it('maps the API’s field errors to messages', () => {
    expect(
      brandingErrors({ displayName: 'Up to 80 characters.', accentColour: 'x' }, '#7fdbca'),
    ).toEqual({
      displayName: 'branding.displayNameInvalid',
      accentColour: 'branding.accentLowContrast',
    });
    expect(brandingErrors({ accentColour: 'x', tagline: 'y' }, 'teal')).toEqual({
      accentColour: 'branding.accentInvalid',
      tagline: 'branding.taglineInvalid',
    });
  });
});
