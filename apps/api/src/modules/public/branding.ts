import {
  LOGO_MEDIA_TYPES,
  logoUrlOf,
  NO_BRANDING,
  type PublicBranding,
  type PublicOrganisationBranding,
} from '@dhc/contracts';
import { withPublic, type Tx } from '@dhc/db';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { inspectLogo } from '../branding/logo';

/** One body for an organisation with no branding, unknown, suspended or a malformed address. */
export const BRANDING_NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');

/** A row of `public_organisation_branding(slug)`: only the columns the function declares. */
export interface PublicBrandingRow {
  organisation_slug: string;
  organisation_name: string;
  display_name: string | null;
  accent_colour: string | null;
  tagline: string | null;
  logo_sha256: string | null;
}

/** The branding columns as the doctor page's header and the directory's cards carry them. */
export function toOrganisationBranding(
  row: Pick<PublicBrandingRow, 'display_name' | 'accent_colour' | 'logo_sha256'> | undefined,
): PublicOrganisationBranding {
  if (!row) return { ...NO_BRANDING };
  return {
    displayName: row.display_name,
    accentColour: row.accent_colour,
    logoUrl: row.logo_sha256 ? logoUrlOf(row.logo_sha256) : null,
  };
}

/** Maps the function's row to the public branding, field by field, as `toPublicDoctor` does. */
export function toPublicBranding(row: PublicBrandingRow): PublicBranding {
  return {
    organisation: { slug: row.organisation_slug, name: row.organisation_name },
    ...toOrganisationBranding(row),
    tagline: row.tagline,
  };
}

/** Reads an organisation's branding inside a `withPublic` transaction (none: undefined). */
export async function readPublicBranding(
  tx: Tx,
  slug: string,
): Promise<PublicBrandingRow | undefined> {
  const [row] = await tx.$queryRaw<
    PublicBrandingRow[]
  >`SELECT * FROM public_organisation_branding(${slug})`;
  return row;
}

export interface PublicLogo {
  data: Buffer;
  mediaType: string;
}

/** A row of `public_organisation_logo(sha256)`: one organisation's copy of the logo. */
interface LogoCopyRow {
  file_key: string;
  media_type: string;
  size_bytes: number;
}

/** Verified logos kept in memory, by hash: at most 64 (32 MB at the 512 KB limit). */
export const LOGO_CACHE_ENTRIES = 64;

/**
 * Organisation branding for the public pages, read without a user (`withPublic`) through
 * the `public_organisation_*` functions only (ADR 0017 addendum 2). Nothing is audited:
 * there is no actor, and a read changes nothing.
 */
export class PublicBrandingService {
  /**
   * Logos already read and verified, most recently used last. Only the file read and the
   * checks are skipped: every request still asks the database, so a suspended
   * organisation's or a removed logo stops at once. A hash names its bytes, so a kept copy
   * can never be the wrong file.
   */
  private readonly verified = new Map<string, PublicLogo>();

  constructor(private readonly s: Services) {}

  async get(slug: string): Promise<PublicBranding> {
    const row = await withPublic(this.s.db, (tx) => readPublicBranding(tx, slug));
    if (!row) throw BRANDING_NOT_FOUND();
    return toPublicBranding(row);
  }

  /**
   * A logo by its SHA-256, for an active organisation. Several organisations may hold the
   * same bytes; their copies are tried newest first, and the first whose stored bytes still
   * hash to the address, are still the image its row says (`inspectLogo`) and can be read
   * is served, with the type the bytes show. A copy that fails is logged; when none passes
   * the answer is a 404, like a missing logo.
   */
  async logo(sha256: string, log: { error: (obj: object, msg: string) => void }) {
    const rows = await withPublic(
      this.s.db,
      (tx) => tx.$queryRaw<LogoCopyRow[]>`
        SELECT file_key, media_type, size_bytes FROM public_organisation_logo(${sha256})`,
    );
    if (rows.length === 0) throw BRANDING_NOT_FOUND();
    const kept = this.verified.get(sha256);
    if (kept && rows.some((r) => r.media_type === kept.mediaType)) {
      this.verified.delete(sha256);
      this.verified.set(sha256, kept);
      return kept;
    }
    for (const row of rows) {
      const logo = await this.readCopy(row, sha256, log);
      if (!logo) continue;
      this.verified.set(sha256, logo);
      if (this.verified.size > LOGO_CACHE_ENTRIES) {
        this.verified.delete(this.verified.keys().next().value!);
      }
      return logo;
    }
    throw BRANDING_NOT_FOUND();
  }

  /** One organisation's copy, read and checked; null (logged) when it fails. */
  private async readCopy(
    row: LogoCopyRow,
    sha256: string,
    log: { error: (obj: object, msg: string) => void },
  ): Promise<PublicLogo | null> {
    let data: Buffer;
    try {
      data = await this.s.files.get(row.file_key);
    } catch (err) {
      log.error({ err, sha256 }, 'Stored logo could not be read');
      return null;
    }
    const image = inspectLogo(data);
    const digest = createHash('sha256').update(data).digest('hex');
    if (
      digest !== sha256 ||
      typeof image === 'string' ||
      LOGO_MEDIA_TYPES[image.type] !== row.media_type
    ) {
      log.error(
        { sha256, refused: typeof image === 'string' ? image : null },
        'Stored logo failed its checks',
      );
      return null;
    }
    return { data, mediaType: LOGO_MEDIA_TYPES[image.type] };
  }
}
