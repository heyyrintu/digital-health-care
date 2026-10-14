import {
  DEFAULT_ORGANISATION_SETTINGS,
  OrganisationSettings,
  type UpdateOrganisationSettingsBody,
} from '@dhc/contracts';
import { withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

interface Actor {
  userId: string;
  organisationId: string;
}

/**
 * The organisation's settings inside the caller's tenant transaction; the defaults until a
 * clinic admin saves them. Parsed, so a value the contracts no longer allow fails loudly.
 */
export async function readSettings(tx: Tx, organisationId: string): Promise<OrganisationSettings> {
  const row = await tx.organisationSettings.findUnique({ where: { organisationId } });
  if (!row) return DEFAULT_ORGANISATION_SETTINGS;
  return OrganisationSettings.parse({
    chartModel: row.chartModel,
    hiddenSafetyRules: row.hiddenSafetyRules,
    maxUploadMb: row.maxUploadMb,
    uploadTypes: row.uploadTypes,
  });
}

/** Clinic admin settings (PRD §9.2): chart model, safety tuning and upload limits. */
export class SettingsService {
  constructor(private readonly s: Services) {}

  get(actor: Actor): Promise<OrganisationSettings> {
    return withTenant(this.s.db, actor.organisationId, (tx) =>
      readSettings(tx, actor.organisationId),
    );
  }

  update(
    request: FastifyRequest,
    actor: Actor,
    body: UpdateOrganisationSettingsBody,
  ): Promise<OrganisationSettings> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const before = await readSettings(tx, actor.organisationId);
      await tx.organisationSettings.upsert({
        where: { organisationId: actor.organisationId },
        create: { organisationId: actor.organisationId, ...body },
        update: body,
      });
      const changed = (Object.keys(body) as (keyof OrganisationSettings)[]).filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(body[k]),
      );
      if (changed.length) {
        await writeAudit(tx, request, {
          action: 'settings.updated',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          metadata: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: body[k] }])),
        });
      }
      return readSettings(tx, actor.organisationId);
    });
  }
}
