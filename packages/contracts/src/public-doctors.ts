import { z } from 'zod';
import { ConsultationMode } from './scheduling';

// ---- Public doctor pages (Build Plan §5.1; ADR 0017; API guide §3u) -------------------

/** Lowercase letters, digits and single hyphens between them, 3–60 characters. */
export const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PUBLIC_SLUG_MIN = 3;
export const PUBLIC_SLUG_MAX = 60;
export const ABOUT_MAX = 1000;
export const LANGUAGES_MAX = 8;
export const LANGUAGE_MAX = 40;

/**
 * Addresses no doctor may take: they read like the site's own pages or staff, so a page
 * there could pass for the platform speaking (threat model T25).
 */
export const RESERVED_PUBLIC_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'clinic',
  'doctor',
  'doctors',
  'help',
  'login',
  'platform',
  'robots',
  'sitemap',
  'support',
  'verify',
  'www',
];

/** Whether a string is a well-formed public address (already lowercased and trimmed). */
export const isPublicSlug = (value: string) =>
  value.length >= PUBLIC_SLUG_MIN &&
  value.length <= PUBLIC_SLUG_MAX &&
  PUBLIC_SLUG_PATTERN.test(value);

/** A page address as typed: trimmed and lowercased, then checked. */
export const PublicSlug = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(
    z
      .string()
      .min(PUBLIC_SLUG_MIN)
      .max(PUBLIC_SLUG_MAX)
      .regex(PUBLIC_SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens.')
      .refine((v) => !RESERVED_PUBLIC_SLUGS.includes(v), 'That address is reserved.'),
  );

/** The path parameter: never transformed, so `/doctor/Dr-X` is not the same page. */
export const PublicDoctorParams = z.object({
  slug: z.string().max(PUBLIC_SLUG_MAX).refine(isPublicSlug),
});

/** Up to 8 languages, each 1–40 characters, each once whatever the case. */
export const DoctorLanguages = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(LANGUAGE_MAX)
      // As the database's CHECK: no whitespace at either end (JavaScript's \s, which is what
      // trim() removes and what the CHECK spells out).
      .regex(/^\S(?:.*\S)?$/su),
  )
  .max(LANGUAGES_MAX)
  .refine(
    (list) => new Set(list.map((l) => l.toLowerCase())).size === list.length,
    'List each language once.',
  );

/**
 * The doctor's public page settings (PATCH: only the fields sent change). `slug` and
 * `about` may be cleared with null; a listed page needs a slug.
 */
export const SaveDoctorPublicProfileBody = z
  .object({
    slug: PublicSlug.nullable().optional(),
    listed: z.boolean().optional(),
    about: z
      .string()
      .trim()
      .max(ABOUT_MAX)
      .transform((v) => v || null)
      .nullable()
      .optional(),
    languages: DoctorLanguages.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Send at least one field.');
export type SaveDoctorPublicProfileBody = z.infer<typeof SaveDoctorPublicProfileBody>;

/** What the doctor sees of their own page settings (part of DoctorProfile). */
export const DoctorPublicProfile = z.object({
  slug: z.string().nullable(),
  listed: z.boolean(),
  about: z.string().nullable(),
  languages: z.array(z.string()),
  /** Listed and verified: the page answers at `/doctor/<slug>`. */
  live: z.boolean(),
});
export type DoctorPublicProfile = z.infer<typeof DoctorPublicProfile>;

/**
 * A public doctor page: exactly what the doctor chose to publish, their registration as the
 * platform team verified it, the organisation (its slug starts a booking in the portal),
 * and the clinics and consultation types they are scheduled for. No internal IDs.
 */
export const PublicDoctor = z.object({
  slug: z.string(),
  name: z.string().nullable(),
  qualifications: z.string().nullable(),
  specialty: z.string().nullable(),
  /** Only ever a verified registration: unverified pages are not shown at all. */
  registration: z.object({ number: z.string().nullable(), council: z.string().nullable() }),
  about: z.string().nullable(),
  languages: z.array(z.string()),
  organisation: z.object({ slug: z.string(), name: z.string() }),
  clinics: z.array(z.object({ name: z.string(), address: z.string().nullable() })),
  consultationTypes: z.array(
    z.object({
      name: z.string(),
      mode: ConsultationMode,
      durationMin: z.number().int(),
      feePaise: z.number().int(),
    }),
  ),
  updatedAt: z.iso.datetime(),
});
export type PublicDoctor = z.infer<typeof PublicDoctor>;

/** Every page shown, for a sitemap. */
export const PublicDoctorList = z.object({
  data: z.array(z.object({ slug: z.string(), updatedAt: z.iso.datetime() })),
});
export type PublicDoctorList = z.infer<typeof PublicDoctorList>;
