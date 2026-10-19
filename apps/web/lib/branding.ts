import {
  ACCENT_PATTERN,
  contrastRatio,
  isReadableAccent,
  LOGO_MAX_BYTES,
  LOGO_MEDIA_TYPES,
  MIN_ACCENT_CONTRAST,
  type PublicOrganisationBranding,
} from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import type { CSSProperties } from 'react';

/**
 * Pure helpers for per-organisation branding (Build Plan §5.1; ADR 0017 addendum 2): the
 * doctor page, the portal's sign-in and frame, and the clinic admin's Branding card. The
 * branding never brings CSS of its own: only a validated `#rrggbb` accent, set as CSS
 * variables, and a logo address of one known shape.
 */

/** The only logo address the API gives: `public/logos/<sha256>`, relative to its base URL. */
const LOGO_URL = /^public\/logos\/[0-9a-f]{64}$/;

/**
 * The logo's full address for an `<img>`: the API's base URL and the relative address the
 * API gave. Anything not of the known shape gives no logo, so a bad value can never point
 * an image (or anything else) somewhere chosen by the data.
 */
export function logoSrc(apiBaseUrl: string, logoUrl: string | null | undefined): string | null {
  if (!logoUrl || !LOGO_URL.test(logoUrl)) return null;
  return `${apiBaseUrl.replace(/\/+$/, '')}/${logoUrl}`;
}

/**
 * The accent as CSS variables on a branded element: `--brand-accent`, and the theme's
 * `--primary` (with white text and the focus ring) inside that element, so its buttons
 * take the clinic's colour. Only a `#rrggbb` that keeps white text readable (4.5:1); for
 * anything else, or none, nothing is set and the platform theme stays.
 */
export function accentStyle(accent: string | null | undefined): CSSProperties | undefined {
  if (!accent || !isReadableAccent(accent)) return undefined;
  return {
    '--brand-accent': accent,
    '--primary': accent,
    '--primary-foreground': '#ffffff',
    '--ring': accent,
  } as CSSProperties;
}

/** The name the public pages show: the display name, else the organisation's own. */
export const brandName = (
  name: string,
  branding?: Pick<PublicOrganisationBranding, 'displayName'> | null,
) => branding?.displayName ?? name;

export type AccentCheck =
  | { status: 'empty' }
  | { status: 'invalid' }
  | { status: 'low_contrast' | 'ok'; colour: string; ratio: number };

/** The admin's colour as typed, checked as the API will: format, then contrast with white. */
export function checkAccent(value: string): AccentCheck {
  const colour = value.trim().toLowerCase();
  if (!colour) return { status: 'empty' };
  if (!ACCENT_PATTERN.test(colour)) return { status: 'invalid' };
  const ratio = contrastRatio(colour, '#ffffff');
  return { status: ratio >= MIN_ACCENT_CONTRAST ? 'ok' : 'low_contrast', colour, ratio };
}

/** "4.83:1", rounded down so a colour shown as 4.5:1 really passes. */
export const formatRatio = (ratio: number) => `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;

export type LogoFileCheck = 'ok' | 'svg_not_allowed' | 'type_not_allowed' | 'too_large';

/** The browser's check before an upload; the API checks the bytes themselves again. */
export function checkLogoFile(file: { type: string; size: number }): LogoFileCheck {
  if (file.type === 'image/svg+xml') return 'svg_not_allowed';
  if (!(Object.values(LOGO_MEDIA_TYPES) as string[]).includes(file.type)) return 'type_not_allowed';
  if (file.size > LOGO_MAX_BYTES) return 'too_large';
  return 'ok';
}

/** The message for each logo refusal, from the browser's check or the API's `fields.file`. */
export function logoErrorKey(code: string): MessageKey {
  switch (code) {
    case 'svg_not_allowed':
      return 'branding.logoSvg';
    case 'too_large':
      return 'branding.logoTooLarge';
    case 'too_many_pixels':
      return 'branding.logoTooManyPixels';
    case 'animated':
      return 'branding.logoAnimated';
    case 'type_not_allowed':
      return 'branding.logoType';
    default:
      return 'branding.logoNotImage';
  }
}

/**
 * The message for a refused logo upload: the API's `fields.file` reason, or by status when
 * the refusal came before the checks (413: over 1 MB, 415: not an image type, 429: too
 * many uploads). Null for anything else (shown as the API's message).
 */
export function logoUploadErrorKey(
  status: number,
  fields: Record<string, string>,
): MessageKey | null {
  if (status === 413) return 'branding.logoTooLarge';
  if (status === 415) return 'branding.logoType';
  if (status === 429) return 'patient.tests.rateLimited';
  if (fields.file) return logoErrorKey(fields.file);
  return null;
}

type BrandingField = 'displayName' | 'accentColour' | 'tagline';

/** Which message to show under each field for a refused save (the API's field errors). */
export function brandingErrors(
  fields: Record<string, string>,
  accent: string,
): Partial<Record<BrandingField, MessageKey>> {
  const out: Partial<Record<BrandingField, MessageKey>> = {};
  if ('displayName' in fields) out.displayName = 'branding.displayNameInvalid';
  if ('tagline' in fields) out.tagline = 'branding.taglineInvalid';
  if ('accentColour' in fields) {
    out.accentColour =
      checkAccent(accent).status === 'low_contrast'
        ? 'branding.accentLowContrast'
        : 'branding.accentInvalid';
  }
  return out;
}
