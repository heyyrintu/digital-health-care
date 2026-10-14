import type {
  Role,
  SyncMedicine,
  SyncMedicinesQuery,
  SyncMedicinesResponse,
  SyncTodayQuery,
  SyncTodayResponse,
} from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { istDate } from '@dhc/domain';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { PrescribingService } from '../prescribing/service';
import { QueueService } from '../queue/service';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

/**
 * Changes this recent are held back for one more round: a transaction that started
 * earlier can still commit with an older `updated_at`, and a cursor past it would skip it.
 */
const SETTLE_MS = 5_000;

const BAD_CURSOR = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Start the download again.', { cursor: 'invalid' });

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');
  if (!id || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) throw BAD_CURSOR();
  return { at, id };
}

/**
 * The read side of the Clinic app's offline mode (ADR 0009). The app keeps a copy of the
 * medicine master (fetching only what changed) and today's working set; writes made
 * offline replay through the normal endpoints when the network is back.
 */
export class SyncService {
  private readonly queue: QueueService;
  private readonly prescribing: PrescribingService;

  constructor(private readonly s: Services) {
    this.queue = new QueueService(s);
    this.prescribing = new PrescribingService(s);
  }

  async medicines(actor: Actor, query: SyncMedicinesQuery): Promise<SyncMedicinesResponse> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    // `updated_at` is stamped with the real clock (by Prisma and column defaults), so the
    // settle window uses it too, not the injectable service clock.
    const settled = new Date(Date.now() - SETTLE_MS);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const rows = await tx.medicine.findMany({
        where: {
          updatedAt: { lte: settled },
          // Without a cursor this is the full download, so only medicines still in use.
          ...(after
            ? {
                OR: [
                  { updatedAt: { gt: after.at } },
                  { updatedAt: after.at, id: { gt: after.id } },
                ],
              }
            : { active: true }),
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const aliases = await tx.medicineRequest.findMany({
        where: { decision: 'approved', medicineId: { not: null } },
        select: { name: true, medicineId: true },
        orderBy: { name: 'asc' },
      });
      const data: SyncMedicine[] = page.map((m) => ({
        id: m.id,
        name: m.name,
        genericName: m.genericName,
        composition: m.composition,
        form: m.form,
        defaultRoute: m.defaultRoute,
        source: m.source,
        active: m.active,
        updatedAt: m.updatedAt.toISOString(),
      }));
      return {
        data,
        cursor: last
          ? encodeCursor(last.updatedAt, last.id)
          : after
            ? query.cursor!
            : // An empty first download still gives a starting point.
              encodeCursor(settled, '00000000-0000-0000-0000-000000000000'),
        hasMore: rows.length > query.limit,
        aliases: aliases.map((a) => ({ name: a.name, medicineId: a.medicineId! })),
      };
    });
  }

  async today(actor: Actor, query: SyncTodayQuery): Promise<SyncTodayResponse> {
    const now = this.s.now();
    const isDoctor = actor.role === 'doctor';
    const [queue, templates] = await Promise.all([
      this.queue.queue(actor, {
        date: istDate(now),
        clinicId: query.clinicId,
        doctorId: isDoctor ? actor.userId : undefined,
      }),
      isDoctor ? this.prescribing.templates(actor) : Promise.resolve([]),
    ]);
    return { serverTime: now.toISOString(), queue, templates };
  }
}
