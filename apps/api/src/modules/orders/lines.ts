import { UploadMediaType, type Role, type TestOrder, type TestOrderLine } from '@dhc/contracts';
import { Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import { writeAudit } from '../audit/write';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

export const orderInclude = {
  results: { orderBy: { uploadedAt: 'asc' } },
} as const satisfies Prisma.TestOrderInclude;
export type OrderRow = Prisma.TestOrderGetPayload<{ include: typeof orderInclude }>;

const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

/**
 * An order as the API returns it. The front desk never gets the doctor's notes (clinical
 * content); the doctor and the patient do.
 */
export function orderOut(row: OrderRow, options: { notes: boolean } = { notes: true }): TestOrder {
  return {
    id: row.id,
    catalogueItemId: row.catalogueItemId,
    kind: row.kind,
    name: row.name,
    region: row.region,
    side: row.side,
    views: row.views,
    notes: options.notes ? row.notes : null,
    status: row.status,
    orderedAt: row.orderedAt?.toISOString() ?? null,
    resultUploadedAt: row.resultUploadedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    results: row.results.map((r) => ({
      id: r.id,
      mediaType: UploadMediaType.parse(r.mediaType),
      sizeBytes: r.sizeBytes,
      uploadedAt: r.uploadedAt.toISOString(),
      uploadedBy: r.uploadedByRole === 'patient' ? 'patient' : 'clinic',
    })),
  };
}

/** A visit's tests in print order: those already ordered first, then the draft's. */
export function visitOrders(tx: Tx, appointmentId: string): Promise<OrderRow[]> {
  return tx.testOrder.findMany({
    where: { appointmentId },
    include: orderInclude,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

const clinical = (l: {
  catalogueItemId: string | null;
  kind: string;
  name: string;
  region: string | null;
  side: string;
  views: string[];
  notes: string | null;
}) =>
  JSON.stringify([l.catalogueItemId, l.kind, l.name, l.region, l.side, l.views, l.notes || null]);

type StoredLine = {
  catalogueItemId: string | null;
  kind: string;
  name: string;
  region: string | null;
  views: string[];
};

/**
 * Catalogue tests must be active in this clinic's catalogue and match it: the same kind
 * and name, a region from its list (imaging with regions needs one) and views from its list.
 *
 * A draft line the visit already holds (`previous`, by line ID) is checked only for what
 * changed: the clinic may since have renamed the test, dropped a region or view, or
 * deactivated it, and a doctor changing only the side or notes must still be able to save.
 * Its stored test, name, region and views stand while unchanged; a new region, or a view
 * it did not have, must be valid in today's catalogue.
 */
async function checkCatalogue(
  tx: Tx,
  lines: TestOrderLine[],
  previous: Map<string, StoredLine>,
): Promise<void> {
  type Check = { line: TestOrderLine; region: boolean; views: string[]; whole: boolean };
  const checks: Check[] = [];
  for (const line of lines) {
    if (!line.catalogueItemId) continue;
    const old = previous.get(line.id);
    const sameTest =
      old !== undefined &&
      old.catalogueItemId === line.catalogueItemId &&
      old.kind === line.kind &&
      old.name === line.name;
    if (!sameTest) {
      checks.push({ line, region: true, views: line.views, whole: true });
      continue;
    }
    const region = old.region !== line.region;
    const views = line.views.filter((v) => !old.views.includes(v));
    if (region || views.length > 0) checks.push({ line, region, views, whole: false });
  }
  if (checks.length === 0) return;
  const ids = [...new Set(checks.map((c) => c.line.catalogueItemId!))];
  const items = new Map(
    (await tx.testCatalogueItem.findMany({ where: { id: { in: ids }, active: true } })).map((i) => [
      i.id,
      i,
    ]),
  );
  for (const { line, region, views, whole } of checks) {
    const item = items.get(line.catalogueItemId!);
    if (!item) throw invalid('tests', 'A test is not in the catalogue.');
    if (whole && (item.kind !== line.kind || item.name !== line.name)) {
      throw invalid('tests', 'A test does not match the catalogue.');
    }
    if (region) {
      if (
        item.regions.length > 0 &&
        (line.region === null || !item.regions.includes(line.region))
      ) {
        throw invalid('tests', 'Pick a region from the list.');
      }
      if (item.regions.length === 0 && line.region !== null) {
        throw invalid('tests', 'This test has no region.');
      }
    }
    if (views.some((v) => !item.views.includes(v))) {
      throw invalid('tests', 'Pick views from the list.');
    }
  }
}

/**
 * Replaces the visit's draft tests with `lines` (the prescription save, inside its visit
 * lock, after the caller checked the draft may be written). Tests a signed version already
 * ordered must be in the list unchanged: 409 `tests: locked` otherwise. Each added,
 * changed and removed draft test is audited.
 */
export async function saveDraftTests(
  tx: Tx,
  request: FastifyRequest,
  actor: Actor,
  visit: { id: string; patientId: string; doctorUserId: string },
  lines: TestOrderLine[],
): Promise<void> {
  const ids = lines.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw invalid('tests', 'Each test needs its own ID.');

  const existing = await tx.testOrder.findMany({ where: { appointmentId: visit.id } });
  const byId = new Map(existing.map((o) => [o.id, o]));
  // Only new and changed lines are checked against today's catalogue, and a changed draft
  // line only for what changed: an ordered test is pinned by `clinical()` below, and a
  // draft line keeps what it stored even if the clinic has since renamed, narrowed or
  // deactivated its catalogue entry.
  const drafts = new Map(existing.filter((o) => !o.orderedAt).map((o) => [o.id, o]));
  await checkCatalogue(
    tx,
    lines.filter((l) => {
      const old = byId.get(l.id);
      return !old || (!old.orderedAt && clinical(old) !== clinical(l));
    }),
    drafts,
  );
  const wanted = new Set(ids);
  const locked = () =>
    new AppError(
      409,
      'PRESCRIPTION_LOCKED',
      'A test on the signed prescription can no longer change.',
      { tests: 'locked' },
    );
  if (existing.some((o) => o.orderedAt && !wanted.has(o.id))) throw locked();

  const ordered = existing.filter((o) => o.orderedAt);
  const firstDraftSort = ordered.reduce((max, o) => Math.max(max, o.sortOrder + 1), 0);
  const audit = (action: string, id: string, metadata?: Prisma.InputJsonValue) =>
    writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'test_order',
      entityId: id,
      metadata: { appointmentId: visit.id, ...(metadata as object) },
    });

  for (const old of existing) {
    if (!old.orderedAt && !wanted.has(old.id)) {
      await tx.testOrder.delete({ where: { id: old.id } });
      await audit('test_order.deleted', old.id);
    }
  }
  let draftIndex = 0;
  for (const line of lines) {
    const old = byId.get(line.id);
    if (old?.orderedAt) {
      if (clinical(old) !== clinical(line)) throw locked();
      continue;
    }
    const sortOrder = firstDraftSort + draftIndex++;
    const data = {
      catalogueItemId: line.catalogueItemId,
      kind: line.kind,
      name: line.name,
      region: line.region,
      side: line.side,
      views: line.views,
      notes: line.notes || null,
      sortOrder,
    };
    if (old) {
      if (clinical(old) === clinical(data) && old.sortOrder === sortOrder) continue;
      await tx.testOrder.update({ where: { id: old.id }, data });
      if (clinical(old) !== clinical(data)) {
        await audit('test_order.updated', old.id, { kind: line.kind });
      }
      continue;
    }
    try {
      await tx.testOrder.create({
        data: {
          ...data,
          id: line.id,
          organisationId: actor.organisationId,
          appointmentId: visit.id,
          patientId: visit.patientId,
          doctorUserId: visit.doctorUserId,
        },
      });
    } catch (error) {
      // The ID is another visit's test (or another clinic's, invisible here).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw invalid('tests', 'A test ID is already in use.');
      }
      throw error;
    }
    await audit('test_order.created', line.id, {
      kind: line.kind,
      catalogue: line.catalogueItemId !== null,
    });
  }
}

/**
 * Before signing: the client must name every draft test it showed the doctor (`testIds`),
 * so a client that does not show tests cannot sign tests nobody reviewed. IDs may also name
 * tests the visit already ordered; anything else, or a draft test left out, is 409
 * `tests: review`. Omitting `testIds` declares none.
 */
export function assertTestsReviewed(
  orders: { id: string; orderedAt: Date | null }[],
  testIds: string[] | undefined,
): void {
  const declared = new Set(testIds ?? []);
  const known = new Set(orders.map((o) => o.id));
  const unseen = orders.some((o) => !o.orderedAt && !declared.has(o.id));
  if (unseen || [...declared].some((id) => !known.has(id))) {
    throw new AppError(
      409,
      'CONFLICT',
      'The tests on this prescription changed. Review them before signing.',
      { tests: 'review' },
    );
  }
}

/**
 * At signing: the visit's draft tests become orders of the version being signed. Returns
 * how many were ordered.
 */
export async function placeDraftOrders(
  tx: Tx,
  appointmentId: string,
  prescriptionId: string,
  at: Date,
): Promise<number> {
  const { count } = await tx.testOrder.updateMany({
    where: { appointmentId, orderedAt: null },
    data: { orderedAt: at, prescriptionId },
  });
  return count;
}
