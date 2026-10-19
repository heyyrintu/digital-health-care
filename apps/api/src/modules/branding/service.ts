import {
  LOGO_MEDIA_TYPES,
  logoUrlOf,
  OrganisationBranding,
  type LogoMediaType,
  type UpdateOrganisationBrandingBody,
} from '@dhc/contracts';
import { withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { uniqueSuffix } from '../../files';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import type { UploadedFile } from '../orders/upload';
import { acceptLogo, logoExtension } from './logo';

interface Actor {
  userId: string;
  organisationId: string;
}

/** The branding row as stored (`organisation_branding`). */
export interface BrandingRow {
  displayName: string | null;
  accentColour: string | null;
  tagline: string | null;
  logoKey: string | null;
  logoMediaType: string | null;
  logoSizeBytes: number | null;
  logoSha256: string | null;
  updatedAt: Date;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** The admin's view of the branding: the organisation, the row (or none yet), the logo's address. */
export function brandingOut(
  organisation: { slug: string; name: string },
  row: BrandingRow | null,
): OrganisationBranding {
  return OrganisationBranding.parse({
    organisation: { slug: organisation.slug, name: organisation.name },
    displayName: row?.displayName ?? null,
    accentColour: row?.accentColour ?? null,
    tagline: row?.tagline ?? null,
    logo:
      row?.logoSha256 && row.logoMediaType && row.logoSizeBytes !== null
        ? {
            url: logoUrlOf(row.logoSha256),
            mediaType: row.logoMediaType as LogoMediaType,
            sizeBytes: row.logoSizeBytes,
          }
        : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  });
}

/** Which of the text fields an update changes (the audit names these, never the values). */
export function changedBrandingFields(
  before: Pick<BrandingRow, 'displayName' | 'accentColour' | 'tagline'> | null,
  body: UpdateOrganisationBrandingBody,
): (keyof UpdateOrganisationBrandingBody)[] {
  return (['displayName', 'accentColour', 'tagline'] as const).filter(
    (k) => (before?.[k] ?? null) !== body[k],
  );
}

/**
 * The organisation's branding (Build Plan §5.1), for its clinic admins: display name,
 * accent colour, tagline and logo. Runs inside the organisation (`withTenant`); the public
 * pages read it only through the `public_organisation_*` functions (ADR 0017 addendum 2).
 * Every change is audited as `organisation.branding_updated` with the changed field names.
 */
export class BrandingService {
  constructor(private readonly s: Services) {}

  get(actor: Actor): Promise<OrganisationBranding> {
    return withTenant(this.s.db, actor.organisationId, async (tx) =>
      brandingOut(await this.organisation(tx, actor), await this.row(tx, actor)),
    );
  }

  update(
    request: FastifyRequest,
    actor: Actor,
    body: UpdateOrganisationBrandingBody,
  ): Promise<OrganisationBranding> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      const before = await this.row(tx, actor);
      const changed = changedBrandingFields(before, body);
      // Nothing changed (or an empty form with no branding yet): no write, no audit.
      const row = changed.length
        ? await tx.organisationBranding.upsert({
            where: { organisationId: actor.organisationId },
            create: { organisationId: actor.organisationId, ...body },
            update: body,
          })
        : before;
      if (changed.length) await this.audit(tx, request, actor, changed);
      return brandingOut(await this.organisation(tx, actor), row);
    });
  }

  /**
   * Stores a new logo (PNG, JPEG or WebP, checked byte by byte: `acceptLogo`) and points
   * the branding at it. The file is written before the row; if the transaction then fails
   * it is removed again, unless the row turns out to point at it (`cleanUpFailedUpload`).
   * The replaced logo's file is removed after the commit: a logo is not a clinical record,
   * and its old address stops answering anyway. A file whose removal fails stays as an
   * orphan (logged; ADR 0017 addendum 2).
   */
  async uploadLogo(
    request: FastifyRequest,
    actor: Actor,
    file: UploadedFile,
  ): Promise<OrganisationBranding> {
    const image = acceptLogo(file);
    const digest = sha256(file.data);
    const key = `organisations/${actor.organisationId}/branding/logo-${uniqueSuffix()}.${logoExtension(image.type)}`;
    let stored = false;
    let replaced: string | null = null;
    try {
      // The file goes first, outside the transaction, so a slow store holds no connection
      // or lock; its key is new, and a row that never commits gets it removed below.
      await this.s.files.put(key, file.data);
      stored = true;
      const out = await withTenant(this.s.db, actor.organisationId, async (tx) => {
        await this.lock(tx, actor);
        const before = await this.row(tx, actor);
        const logo = {
          logoKey: key,
          logoMediaType: LOGO_MEDIA_TYPES[image.type],
          logoSizeBytes: file.data.length,
          logoSha256: digest,
        };
        const row = await tx.organisationBranding.upsert({
          where: { organisationId: actor.organisationId },
          create: { organisationId: actor.organisationId, ...logo },
          update: logo,
        });
        await this.audit(tx, request, actor, ['logo']);
        replaced = before?.logoKey ?? null;
        return brandingOut(await this.organisation(tx, actor), row);
      });
      await this.removeFile(request, replaced, 'replaced logo');
      return out;
    } catch (error) {
      if (stored) await this.cleanUpFailedUpload(request, actor, key, replaced);
      throw error;
    }
  }

  /**
   * After an upload whose transaction failed: the failure may have come after the commit
   * (a lost connection while committing), so the row is read again. If it points at the new
   * file, the change did happen: the replaced file goes. Otherwise the new file goes. If the
   * row cannot be read, both files stay (an orphan at worst, never a logo without its file).
   */
  private async cleanUpFailedUpload(
    request: FastifyRequest,
    actor: Actor,
    key: string,
    replaced: string | null,
  ) {
    let current: BrandingRow | null;
    try {
      current = await withTenant(this.s.db, actor.organisationId, (tx) => this.row(tx, actor));
    } catch (err) {
      request.log.error({ err, key }, 'Could not check a failed logo upload; its file stays');
      return;
    }
    if (current?.logoKey === key) await this.removeFile(request, replaced, 'replaced logo');
    else await this.removeFile(request, key, 'logo of a failed upload');
  }

  /** Removes the logo (the rest of the branding stays). No logo: nothing changes. */
  async deleteLogo(request: FastifyRequest, actor: Actor): Promise<OrganisationBranding> {
    let removed: string | null = null;
    const out = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      const before = await this.row(tx, actor);
      if (!before?.logoKey) return brandingOut(await this.organisation(tx, actor), before);
      const row = await tx.organisationBranding.update({
        where: { organisationId: actor.organisationId },
        data: { logoKey: null, logoMediaType: null, logoSizeBytes: null, logoSha256: null },
      });
      await this.audit(tx, request, actor, ['logo']);
      removed = before.logoKey;
      return brandingOut(await this.organisation(tx, actor), row);
    });
    await this.removeFile(request, removed, 'removed logo');
    return out;
  }

  // ---- Helpers ----------------------------------------------------------------------

  private row(tx: Tx, actor: Actor): Promise<BrandingRow | null> {
    return tx.organisationBranding.findUnique({ where: { organisationId: actor.organisationId } });
  }

  private organisation(tx: Tx, actor: Actor) {
    return tx.organisation.findUniqueOrThrow({
      where: { id: actor.organisationId },
      select: { slug: true, name: true },
    });
  }

  /** One branding change per organisation at a time, so a replaced logo is never lost track of. */
  private async lock(tx: Tx, actor: Actor) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`organisation-branding:${actor.organisationId}`}, 0))`;
  }

  private audit(tx: Tx, request: FastifyRequest, actor: Actor, fields: string[]) {
    return writeAudit(tx, request, {
      action: 'organisation.branding_updated',
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'organisation',
      entityId: actor.organisationId,
      // Field names only: the values are on the public pages, not in the audit log.
      metadata: { fields },
    });
  }

  private async removeFile(request: FastifyRequest, key: string | null, what: string) {
    if (!key) return;
    await this.s.files
      .delete(key)
      .catch((err: unknown) => request.log.error({ err, key }, `Could not remove the ${what}`));
  }
}
