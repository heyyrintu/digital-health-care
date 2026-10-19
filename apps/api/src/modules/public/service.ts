import {
  PUBLIC_DIRECTORY_MAX,
  type PublicDoctor,
  type PublicDoctorCard,
  type PublicDoctorDirectory,
  type PublicDoctorList,
} from '@dhc/contracts';
import { withPublic } from '@dhc/db';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { readPublicBranding, toOrganisationBranding, type PublicBrandingRow } from './branding';

/** One body for a page that does not exist, is not listed or is not verified (ADR 0017). */
export const PAGE_NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');

/** A row of `public_doctor_profile(slug)`: only the columns the function declares. */
export interface PublicDoctorRow {
  slug: string;
  display_name: string | null;
  qualifications: string | null;
  specialty: string | null;
  registration_number: string | null;
  council: string | null;
  about: string | null;
  languages: string[];
  organisation_slug: string;
  organisation_name: string;
  clinics: { name: string; address: string | null }[];
  consultation_types: {
    name: string;
    mode: PublicDoctor['consultationTypes'][number]['mode'];
    durationMin: number;
    feePaise: number;
  }[];
  updated_at: Date;
}

/**
 * Maps the function's row to the page, field by field, so nothing else can slip through.
 * `branding` is the organisation's row of `public_organisation_branding` (none: undefined).
 */
export function toPublicDoctor(row: PublicDoctorRow, branding?: PublicBrandingRow): PublicDoctor {
  return {
    slug: row.slug,
    name: row.display_name,
    qualifications: row.qualifications,
    specialty: row.specialty,
    registration: { number: row.registration_number, council: row.council },
    about: row.about,
    languages: [...row.languages],
    organisation: {
      slug: row.organisation_slug,
      name: row.organisation_name,
      branding: toOrganisationBranding(branding),
    },
    clinics: row.clinics.map((c) => ({ name: c.name, address: c.address })),
    consultationTypes: row.consultation_types.map((t) => ({
      name: t.name,
      mode: t.mode,
      durationMin: t.durationMin,
      feePaise: t.feePaise,
    })),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A row of `public_doctor_directory()`: only the columns the function declares. */
export interface PublicDoctorCardRow {
  slug: string;
  display_name: string | null;
  qualifications: string | null;
  specialty: string | null;
  organisation_name: string;
  clinics: { name: string; addressLine: string | null }[];
  languages: string[];
  fee_from_paise: number | null;
  organisation_display_name: string | null;
}

/** Maps a directory row to its card, field by field, as `toPublicDoctor` does. */
export function toPublicDoctorCard(row: PublicDoctorCardRow): PublicDoctorCard {
  return {
    slug: row.slug,
    name: row.display_name,
    qualifications: row.qualifications,
    specialty: row.specialty,
    organisationName: row.organisation_name,
    organisationDisplayName: row.organisation_display_name,
    clinics: row.clinics.map((c) => ({ name: c.name, addressLine: c.addressLine })),
    languages: [...row.languages],
    feeFromPaise: row.fee_from_paise,
  };
}

/**
 * Public doctor pages, read without a user across organisations. Runs as `dhc_app` with no
 * organisation set (`withPublic`), where no tenant row is visible, and reads only through
 * the `public_doctor_*` functions (ADR 0017). Nothing is audited: there is no actor, and a
 * page view changes nothing.
 */
export class PublicDoctorService {
  constructor(private readonly s: Services) {}

  /** The page, with its organisation's branding read in the same transaction. */
  async get(slug: string): Promise<PublicDoctor> {
    const found = await withPublic(this.s.db, async (tx) => {
      const [row] = await tx.$queryRaw<
        PublicDoctorRow[]
      >`SELECT * FROM public_doctor_profile(${slug})`;
      return row ? { row, branding: await readPublicBranding(tx, row.organisation_slug) } : null;
    });
    if (!found) throw PAGE_NOT_FOUND();
    return toPublicDoctor(found.row, found.branding);
  }

  async list(): Promise<PublicDoctorList> {
    const rows = await withPublic(
      this.s.db,
      (tx) => tx.$queryRaw<{ slug: string; updated_at: Date }[]>`
        SELECT slug, updated_at FROM public_doctor_slugs()`,
    );
    return { data: rows.map((r) => ({ slug: r.slug, updatedAt: r.updated_at.toISOString() })) };
  }

  /**
   * The home page's directory: a card per page shown, by name, at most 500. A full list
   * means doctors may be missing from the home page, so it is logged for the team (ADR 0017
   * addendum: time to move the search into the API).
   */
  async directory(log?: { warn: (msg: string) => void }): Promise<PublicDoctorDirectory> {
    const rows = await withPublic(
      this.s.db,
      (tx) => tx.$queryRaw<PublicDoctorCardRow[]>`SELECT * FROM public_doctor_directory()`,
    );
    if (rows.length >= PUBLIC_DIRECTORY_MAX) {
      log?.warn(
        `Public doctor directory is at its cap of ${PUBLIC_DIRECTORY_MAX}: ` +
          'doctors last by name are left out of the home page',
      );
    }
    return { data: rows.map(toPublicDoctorCard) };
  }
}
