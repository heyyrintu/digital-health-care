import { Prisma, type Tx } from '@dhc/db';
import { AppError } from '../../errors';

const changed = () =>
  new AppError(
    400,
    'VALIDATION_FAILED',
    'A medicine changed or its approval is unavailable. Select it again from the current catalogue before saving or signing.',
    { items: 'catalogue_changed' },
  );
interface Line {
  medicineId: string | null;
  catalogueRevision?: number | null;
  name?: string;
  composition?: string | null;
  form?: string | null;
  route?: string | null;
}
/** Shared with signing: freeze catalogue publication/revocation and recheck picked revisions. */
export async function assertCatalogueMedicines(tx: Tx, items: Line[]) {
  if (items.some((i) => !i.medicineId && i.catalogueRevision != null)) throw changed();
  const ids = [...new Set(items.flatMap((i) => (i.medicineId ? [i.medicineId] : [])))];
  if (!ids.length) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('clinical-medicine-catalogue',0))`;
  await tx.$queryRaw`SELECT id FROM medicines WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
  const medicines = await tx.medicine.findMany({ where: { id: { in: ids }, active: true } });
  if (medicines.length !== ids.length)
    throw new AppError(400, 'VALIDATION_FAILED', 'A medicine is not in the list.', {
      items: 'invalid',
    });
  const rejected = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM medicines WHERE id=ANY(${ids}::uuid[]) AND NOT catalogue_medicine_eligible(id)`;
  if (rejected.length) throw changed();
  for (const line of items) {
    if (!line.medicineId) continue;
    const medicine = medicines.find((m) => m.id === line.medicineId)!;
    if ((line.catalogueRevision ?? null) !== medicine.catalogueRevision) throw changed();
    if (
      medicine.catalogueRevision !== null &&
      (('name' in line && line.name !== medicine.name) ||
        ('composition' in line && line.composition !== medicine.composition) ||
        ('form' in line && line.form !== medicine.form) ||
        ('route' in line && line.route !== medicine.defaultRoute))
    )
      throw changed();
  }
}

/** Apply eligibility before LIMIT, so expired entries cannot crowd out valid search results. */
export function catalogueSearchIds(
  tx: Tx,
  options: {
    q?: string;
    source?: 'reference' | 'clinic';
    includeInactive?: boolean;
    aliases?: boolean;
    limit: number;
  },
) {
  const pattern = '%' + (options.q ?? '').replace(/[\\%_]/g, '\\$&') + '%';
  const match = options.q
    ? Prisma.sql`AND (m.name ILIKE ${pattern} OR m.generic_name ILIKE ${pattern} OR m.composition ILIKE ${pattern}
    ${options.aliases ? Prisma.sql`OR EXISTS(SELECT 1 FROM medicine_requests r WHERE r.medicine_id=m.id AND r.decision='approved' AND r.name ILIKE ${pattern})` : Prisma.empty})`
    : Prisma.empty;
  return tx.$queryRaw<{ id: string }[]>`SELECT m.id FROM medicines m WHERE true ${match}
    ${options.source ? Prisma.sql`AND m.source::text=${options.source}` : Prisma.empty}
    ${options.includeInactive ? Prisma.empty : Prisma.sql`AND m.active AND catalogue_medicine_eligible(m.id)`}
    ORDER BY m.name,m.id LIMIT ${options.limit}`;
}
