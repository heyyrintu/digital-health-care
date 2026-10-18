import type { PublicDoctor } from '@dhc/contracts';
import { t, type Locale, type MessageKey } from '@dhc/i18n';

/**
 * Pure helpers behind the public doctor page (`/doctor/[slug]`, Build Plan §5.1), kept out
 * of the components so they can be unit tested.
 */

/** The page's own path. */
export const doctorPath = (slug: string) => `/doctor/${encodeURIComponent(slug)}`;

/**
 * Where **Book an appointment** goes: the portal's sign-in for the doctor's organisation,
 * which then opens the booking page with this doctor picked. Already signed in, sign-in
 * moves straight on.
 */
export function bookingHref(doctor: Pick<PublicDoctor, 'slug' | 'organisation'>): string {
  const next = `/app/book?doctor=${encodeURIComponent(doctor.slug)}`;
  return `/app/login?${new URLSearchParams({ clinic: doctor.organisation.slug, next })}`;
}

/** The meta description and OpenGraph description. */
export function doctorDescription(doctor: PublicDoctor, locale: Locale = 'en'): string {
  const name = doctor.name ?? doctor.organisation.name;
  return doctor.specialty
    ? t(locale, 'doctorPage.description', {
        name,
        specialty: doctor.specialty,
        organisation: doctor.organisation.name,
      })
    : t(locale, 'doctorPage.descriptionNoSpecialty', {
        name,
        organisation: doctor.organisation.name,
      });
}

/**
 * schema.org `Physician` markup (https://schema.org/Physician): the doctor, where they see
 * patients, their verified registration and languages. Only what the page itself shows.
 */
export function physicianJsonLd(doctor: PublicDoctor, url: string): Record<string, unknown> {
  const clinics = doctor.clinics.map((c) => ({
    '@type': 'MedicalClinic',
    name: c.name,
    ...(c.address ? { address: c.address } : {}),
  }));
  return {
    '@context': 'https://schema.org',
    '@type': 'Physician',
    name: doctor.name ?? doctor.organisation.name,
    url,
    ...(doctor.about ? { description: doctor.about } : {}),
    ...(doctor.specialty ? { medicalSpecialty: doctor.specialty } : {}),
    ...(doctor.languages.length ? { knowsLanguage: doctor.languages } : {}),
    ...(doctor.registration.number
      ? {
          hasCredential: {
            '@type': 'EducationalOccupationalCredential',
            credentialCategory: 'Medical registration',
            identifier: doctor.registration.number,
            ...(doctor.registration.council
              ? { recognizedBy: { '@type': 'Organization', name: doctor.registration.council } }
              : {}),
          },
        }
      : {}),
    parentOrganization: { '@type': 'MedicalOrganization', name: doctor.organisation.name },
    ...(clinics.length ? { location: clinics } : {}),
  };
}

/**
 * JSON for a `<script type="application/ld+json">`: `<` is escaped so text the doctor
 * typed ("</script>") can never close the tag.
 */
export const jsonLdScript = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

// ---- The doctor's settings (clinic dashboard profile page) ---------------------------

/** "English, Hindi" as typed → ['English', 'Hindi']: trimmed, empty entries dropped. */
export const parseLanguages = (text: string) =>
  text
    .split(/[,،、]/)
    .map((l) => l.trim())
    .filter(Boolean);

type PublicField = 'slug' | 'about' | 'languages';

/**
 * Which message to show under each field for a refused save: the API's field codes
 * (`slug: taken`, `slug: required`) and, for anything else it refused in a field, that
 * field's rule.
 */
export function publicProfileErrors(
  fields: Record<string, string>,
): Partial<Record<PublicField, MessageKey>> {
  const out: Partial<Record<PublicField, MessageKey>> = {};
  for (const [key, code] of Object.entries(fields)) {
    const field = key.split('.')[0];
    if (field === 'slug') {
      out.slug =
        code === 'taken'
          ? 'profile.publicSlugTaken'
          : code === 'required'
            ? 'profile.publicSlugRequired'
            : /reserved/i.test(code)
              ? 'profile.publicSlugReserved'
              : 'profile.publicSlugInvalid';
    } else if (field === 'about') {
      out.about = 'profile.publicAboutInvalid';
    } else if (field === 'languages') {
      out.languages = 'profile.publicLanguagesInvalid';
    }
  }
  return out;
}
