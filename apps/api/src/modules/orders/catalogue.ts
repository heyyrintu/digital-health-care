import {
  MAX_CATALOGUE_ITEMS,
  catalogueShapeIssues,
  type AdminTestCatalogueItem,
  type CreateTestCatalogueItemBody,
  type ReorderTestCatalogueBody,
  type Role,
  type UpdateTestCatalogueItemBody,
} from '@dhc/contracts';
import { Prisma, withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

type ItemRow = Prisma.TestCatalogueItemGetPayload<object>;

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
/** How far apart new tests are placed, so the seeded order (10, 20, …) keeps its gaps. */
const SORT_STEP = 10;

const itemOut = (row: ItemRow): AdminTestCatalogueItem => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  regions: row.regions,
  views: row.views,
  active: row.active,
  sortOrder: row.sortOrder,
});

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The clinic admin's side of the test catalogue (PRD §7.1, §9.2): every test, active or
 * not; adding, renaming, editing regions and views, reordering within a kind, and
 * (de)activating. Nothing is deleted, since orders point at items, and nothing here
 * touches an order: each ordered test holds its own copy of what the doctor picked, and
 * draft lines are only checked against the catalogue when they are new or change
 * (`lines.ts`). Writes to one clinic's catalogue run one at a time (an advisory lock), so
 * the size limit and new sort positions hold under concurrent requests.
 */
export class TestCatalogueService {
  constructor(private readonly s: Services) {}

  async list(actor: Actor): Promise<AdminTestCatalogueItem[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.testCatalogueItem.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    );
    return rows.map(itemOut);
  }

  async create(
    request: FastifyRequest,
    actor: Actor,
    body: CreateTestCatalogueItemBody,
  ): Promise<AdminTestCatalogueItem> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      if ((await tx.testCatalogueItem.count()) >= MAX_CATALOGUE_ITEMS) {
        throw new AppError(
          409,
          'CONFLICT',
          `A catalogue holds up to ${MAX_CATALOGUE_ITEMS} tests. Reuse one you no longer offer.`,
          { catalogue: 'full' },
        );
      }
      const last = await tx.testCatalogueItem.aggregate({ _max: { sortOrder: true } });
      const row = await uniqueName(() =>
        tx.testCatalogueItem.create({
          data: {
            organisationId: actor.organisationId,
            kind: body.kind,
            name: body.name,
            regions: body.regions,
            views: body.views,
            sortOrder: (last._max.sortOrder ?? 0) + SORT_STEP,
          },
        }),
      );
      await this.audit(tx, request, actor, 'test_catalogue.created', row.id, {
        kind: row.kind,
        regions: row.regions.length,
        views: row.views.length,
      });
      return itemOut(row);
    });
  }

  /**
   * Changes what is sent. Regions and views are checked against the stored kind (which
   * never changes). Names stay unique among active tests: renaming an active test to the
   * name of another active one, or reactivating a test while an active one has its name, is
   * 409 `name: taken`. An inactive test may take any name, an active test's included.
   */
  async update(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: UpdateTestCatalogueItemBody,
  ): Promise<AdminTestCatalogueItem> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      const existing = await tx.testCatalogueItem.findUnique({ where: { id } });
      if (!existing) throw NOT_FOUND();
      const issues = catalogueShapeIssues({ kind: existing.kind, ...body });
      if (issues.length > 0) {
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          issues[0]!.message,
          Object.fromEntries(issues.map((i) => [i.path, 'invalid'])),
        );
      }

      const changed = {
        name: body.name !== undefined && body.name !== existing.name,
        regions: body.regions !== undefined && !sameList(body.regions, existing.regions),
        views: body.views !== undefined && !sameList(body.views, existing.views),
        active: body.active !== undefined && body.active !== existing.active,
      };
      const fields = (['name', 'regions', 'views'] as const).filter((f) => changed[f]);
      if (fields.length === 0 && !changed.active) return itemOut(existing);

      const row = await uniqueName(() =>
        tx.testCatalogueItem.update({
          where: { id },
          data: {
            ...(changed.name ? { name: body.name } : {}),
            ...(changed.regions ? { regions: body.regions } : {}),
            ...(changed.views ? { views: body.views } : {}),
            ...(changed.active ? { active: body.active } : {}),
          },
        }),
      );
      // Which fields changed, never their values (no free text: the entity ID names the
      // test, as for the price list and the medicine list).
      if (fields.length > 0) {
        await this.audit(tx, request, actor, 'test_catalogue.updated', id, {
          kind: row.kind,
          fields,
        });
      }
      if (changed.active) {
        await this.audit(
          tx,
          request,
          actor,
          row.active ? 'test_catalogue.activated' : 'test_catalogue.deactivated',
          id,
          { kind: row.kind },
        );
      }
      return itemOut(row);
    });
  }

  /**
   * Puts one kind's tests in the order given. `ids` must be exactly that kind's tests,
   * active or not; otherwise the screen is out of date: 409 `ids: stale`. The kind keeps
   * the sort positions it had (so kinds stay where they were relative to one another),
   * handed out in the new order.
   */
  async reorder(
    request: FastifyRequest,
    actor: Actor,
    body: ReorderTestCatalogueBody,
  ): Promise<AdminTestCatalogueItem[]> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      const rows = await tx.testCatalogueItem.findMany({ where: { kind: body.kind } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      if (rows.length !== body.ids.length || body.ids.some((i) => !byId.has(i))) {
        throw new AppError(
          409,
          'CONFLICT',
          'The test catalogue changed since this screen loaded. Reload and try again.',
          { ids: 'stale' },
        );
      }
      // Strictly increasing, so the new order never depends on the name tie-break.
      const slots: number[] = [];
      for (const slot of rows.map((r) => r.sortOrder).sort((a, b) => a - b)) {
        slots.push(Math.max(slot, (slots[slots.length - 1] ?? -1) + 1));
      }
      let moved = 0;
      for (const [i, id] of body.ids.entries()) {
        if (byId.get(id)!.sortOrder === slots[i]) continue;
        await tx.testCatalogueItem.update({ where: { id }, data: { sortOrder: slots[i]! } });
        moved += 1;
      }
      if (moved > 0) {
        await writeAudit(tx, request, {
          action: 'test_catalogue.reordered',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'test_catalogue',
          entityId: actor.organisationId,
          metadata: { kind: body.kind, count: body.ids.length, moved },
        });
      }
      const all = await tx.testCatalogueItem.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return all.map(itemOut);
    });
  }

  // ---- Helpers ----------------------------------------------------------------------

  private lock(tx: Tx, actor: Actor) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`test-catalogue:${actor.organisationId}`}))`;
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    id: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'test_catalogue_item',
      entityId: id,
      metadata,
    });
  }
}

/** Another active test has this name (any case): the partial unique index refuses it. */
async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'CONFLICT', 'Another active test already has this name.', {
        name: 'taken',
      });
    }
    throw error;
  }
}
