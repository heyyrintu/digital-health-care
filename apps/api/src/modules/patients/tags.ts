import { DEFAULT_TAGS, type CreateTagBody, type Tag, type UpdateTagBody } from '@dhc/contracts';
import { Prisma, withTenant } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

interface Actor {
  userId: string;
  organisationId: string;
}

type TagRow = Prisma.TagGetPayload<object>;

const toTag = (t: TagRow): Tag => ({
  id: t.id,
  name: t.name,
  colour: t.colour.toLowerCase(),
  sortToTop: t.sortToTop,
  archived: t.archivedAt !== null,
});

const DUPLICATE_NAME = () =>
  new AppError(409, 'CONFLICT', 'A tag with this name already exists.', { name: 'taken' });

/** Clinic-configured patient tags (PRD §5.4). Archived, never deleted. */
export class TagService {
  constructor(private readonly s: Services) {}

  async list(actor: Actor): Promise<Tag[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.tag.findMany({ orderBy: [{ sortToTop: 'desc' }, { name: 'asc' }] }),
    );
    return rows.map(toTag);
  }

  async create(request: FastifyRequest, actor: Actor, body: CreateTagBody): Promise<Tag> {
    try {
      return await withTenant(this.s.db, actor.organisationId, async (tx) => {
        const tag = await tx.tag.create({
          data: { ...body, organisationId: actor.organisationId },
        });
        await writeAudit(tx, request, {
          action: 'tag.created',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'tag',
          entityId: tag.id,
        });
        return toTag(tag);
      });
    } catch (error) {
      throw isUniqueViolation(error) ? DUPLICATE_NAME() : error;
    }
  }

  async update(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: UpdateTagBody,
  ): Promise<Tag> {
    const { archived, ...rest } = body;
    try {
      return await withTenant(this.s.db, actor.organisationId, async (tx) => {
        const current = await tx.tag.findUnique({ where: { id } });
        if (!current) throw new AppError(404, 'NOT_FOUND', 'Not found.');
        const tag = await tx.tag.update({
          where: { id },
          data: {
            ...rest,
            ...(archived === undefined
              ? {}
              : { archivedAt: archived ? (current.archivedAt ?? this.s.now()) : null }),
          },
        });
        await writeAudit(tx, request, {
          action: 'tag.updated',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'tag',
          entityId: id,
          metadata: { fields: Object.keys(body) },
        });
        return toTag(tag);
      });
    } catch (error) {
      throw isUniqueViolation(error) ? DUPLICATE_NAME() : error;
    }
  }

  /** Adds whichever default tags the clinic does not have yet (by name). */
  async addDefaults(request: FastifyRequest, actor: Actor): Promise<Tag[]> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const created = await tx.tag.createMany({
        data: DEFAULT_TAGS.map((t) => ({ ...t, organisationId: actor.organisationId })),
        skipDuplicates: true,
      });
      if (created.count > 0) {
        await writeAudit(tx, request, {
          action: 'tag.defaults_added',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          metadata: { count: created.count },
        });
      }
    });
    return this.list(actor);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
