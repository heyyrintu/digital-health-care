import { z } from 'zod';
import { OrganisationSlug } from './auth';

// ---- Organisation branding (Build Plan §5.1; ADR 0017 addendum 2; API guide §3v) ---------

export const BRAND_DISPLAY_NAME_MAX = 80;
export const BRAND_TAGLINE_MAX = 120;
/** 512 KB: a logo is shown small, and every visitor of a branded page downloads it. */
export const LOGO_MAX_BYTES = 512 * 1024;
/** Wider or taller is refused: a small file can still decode to a huge image. */
export const LOGO_MAX_DIMENSION = 4096;
/** And at most this many pixels in all (4 million, about 2000 × 2000). */
export const LOGO_MAX_PIXELS = 4_000_000;

/** `#rrggbb`, as stored (lowercase). */
export const ACCENT_PATTERN = /^#[0-9a-f]{6}$/;
/**
 * WCAG AA for normal text. The accent is the colour of buttons with white labels (Book an
 * appointment, Send code), so a colour below this against white is refused, not warned.
 */
export const MIN_ACCENT_CONTRAST = 4.5;

/** Logo file types: PNG, JPEG and WebP. Never SVG, which can carry script. */
export const LogoType = z.enum(['png', 'jpeg', 'webp']);
export type LogoType = z.infer<typeof LogoType>;
export const LOGO_MEDIA_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const satisfies Record<LogoType, string>;
export const LogoMediaType = z.enum([
  LOGO_MEDIA_TYPES.png,
  LOGO_MEDIA_TYPES.jpeg,
  LOGO_MEDIA_TYPES.webp,
]);
export type LogoMediaType = z.infer<typeof LogoMediaType>;

/** WCAG relative luminance of a `#rrggbb` colour (sRGB). */
export function relativeLuminance(hex: string): number {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** Whether white text on this colour meets WCAG AA (4.5:1). */
export const isReadableAccent = (hex: string) =>
  ACCENT_PATTERN.test(hex) && contrastRatio(hex, '#ffffff') >= MIN_ACCENT_CONTRAST;

/**
 * Characters a branding text may not hold: control characters (C0, DEL and C1) and the
 * line and paragraph separators, which would break it across lines; the bidirectional
 * marks, embeddings, overrides and isolates (and the Arabic letter mark) that could make a
 * name read as something else; and invisible ones (zero-width spaces and joiners, the word
 * joiner, the byte-order mark) that could hide text in it. The database's CHECK spells
 * out the same list.
 */
const UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

/** A branding text as typed: trimmed, empty means none, up to `max` characters. */
const brandText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Up to ${max} characters.`)
    .refine((v) => !UNSAFE_TEXT.test(v), 'Remove line breaks, control and invisible characters.')
    .transform((v) => v || null)
    .nullable();

/** An accent colour as typed (`#RRGGBB` in any case): lowercased, readable with white text. */
export const AccentColour = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ACCENT_PATTERN, 'Use a colour like #1a6b5c.')
  .refine(
    isReadableAccent,
    `Too light for white text: choose a darker colour (at least ${MIN_ACCENT_CONTRAST}:1).`,
  );

/** The admin's branding text and colour (PUT: all three; null or "" clears one). */
export const UpdateOrganisationBrandingBody = z.object({
  displayName: brandText(BRAND_DISPLAY_NAME_MAX),
  /** `""` (an emptied field) is none, like null. */
  accentColour: z.union([z.literal('').transform(() => null), AccentColour.nullable()]),
  tagline: brandText(BRAND_TAGLINE_MAX),
});
export type UpdateOrganisationBrandingBody = z.infer<typeof UpdateOrganisationBrandingBody>;

/**
 * Where a logo is served, relative to the API's base URL (`…/v1/` + this): by the file's
 * SHA-256, so the address names no organisation and changes whenever the logo does.
 */
export const logoUrlOf = (sha256: string) => `public/logos/${sha256}`;

/** What the clinic admin sees and edits. */
export const OrganisationBranding = z.object({
  organisation: z.object({ slug: z.string(), name: z.string() }),
  displayName: z.string().nullable(),
  accentColour: z.string().regex(ACCENT_PATTERN).nullable(),
  tagline: z.string().nullable(),
  logo: z
    .object({
      /** Relative to the API's base URL (`logoUrlOf`). */
      url: z.string(),
      mediaType: LogoMediaType,
      sizeBytes: z.number().int(),
    })
    .nullable(),
  /** Null until an admin first saves branding (the platform look until then). */
  updatedAt: z.iso.datetime().nullable(),
});
export type OrganisationBranding = z.infer<typeof OrganisationBranding>;

/**
 * An organisation's branding as the public pages carry it: the display name (null: use the
 * organisation's name), the accent (null: the platform colour) and the logo's address
 * relative to the API's base URL (null: none).
 */
export const PublicOrganisationBranding = z.object({
  displayName: z.string().nullable(),
  accentColour: z.string().regex(ACCENT_PATTERN).nullable(),
  logoUrl: z.string().nullable(),
});
export type PublicOrganisationBranding = z.infer<typeof PublicOrganisationBranding>;

/** No branding saved: the platform look. */
export const NO_BRANDING: PublicOrganisationBranding = {
  displayName: null,
  accentColour: null,
  logoUrl: null,
};

/** `GET /public/organisations/{slug}/branding`: the portal's sign-in and frame. */
export const PublicBranding = PublicOrganisationBranding.extend({
  organisation: z.object({ slug: z.string(), name: z.string() }),
  tagline: z.string().nullable(),
});
export type PublicBranding = z.infer<typeof PublicBranding>;

/** The path parameter: an organisation slug, never transformed. */
export const PublicBrandingParams = z.object({ slug: OrganisationSlug });

/** The logo route's parameter: a SHA-256 in lowercase hex. */
export const PublicLogoParams = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });
