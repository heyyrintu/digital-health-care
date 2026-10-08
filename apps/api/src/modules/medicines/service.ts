import type {
  ApproveMedicineRequestBody,
  DrugMoleculeList,
  MasterMedicine,
  MasterMedicineList,
  MasterMedicineQuery,
  MedicineDecisionRow,
  MedicineQueue,
  RejectMedicineRequestBody,
  Role,
  SaveMedicineBody,
  UpdateMedicineBody,
} from '@dhc/contracts';
import type { Prisma } from '@dhc/db';
import { withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { staffNames } from '../prescribing/shared';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

/** The master list shows this many matches; more means "narrow the search". */
const LIST_LIMIT = 100;

/** Lower case with single spaces, as the database checks. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');

const withIngredients = {
  ingredients: { include: { molecule: { select: { name: true } } } },
} as const;
type MedicineRow = Prisma.MedicineGetPayload<{ include: typeof withIngredients }>;

const medicineOut = (m: MedicineRow): MasterMedicine => ({
  id: m.id,
  name: m.name,
  genericName: m.genericName,
  composition: m.composition,
  form: m.form,
  defaultRoute: m.defaultRoute,
  source: m.source,
  active: m.active,
  ingredients: m.ingredients
    .map((i) => ({
      moleculeId: i.moleculeId,
      moleculeName: i.molecule.name,
      strengthMg: i.strengthMg === null ? null : Number(i.strengthMg),
      per: i.per,
    }))
    .sort((a, b) => a.moleculeName.localeCompare(b.moleculeName)),
});

interface UsageRow {
  name_key: string;
  name: string;
  prescriptions: number;
  doctors: number;
  last_used_at: Date | null;
}

/**
 * The medicine master (PRD §9.2): the platform's reference list, read-only, and the
 * clinic's own medicines, which clinic admins add, edit and deactivate; and the approval
 * queue for medicines doctors typed as free text.
 */
export class MedicineMasterService {
  constructor(private readonly s: Services) {}

  async list(actor: Actor, query: MasterMedicineQuery): Promise<MasterMedicineList> {
    const q = query.q?.trim();
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.medicine.findMany({
        where: {
          ...(query.includeInactive ? {} : { active: true }),
          ...(query.source ? { source: query.source } : {}),
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { genericName: { contains: q, mode: 'insensitive' } },
                  { composition: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        include: withIngredients,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: LIST_LIMIT + 1,
      }),
    );
    return {
      data: rows.slice(0, LIST_LIMIT).map(medicineOut),
      hasMore: rows.length > LIST_LIMIT,
    };
  }

  async molecules(actor: Actor, q: string): Promise<DrugMoleculeList> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.drugMolecule.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { drugClass: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, name: true, drugClass: true },
        orderBy: { name: 'asc' },
        take: 20,
      }),
    );
    return { data: rows };
  }

  async create(
    request: FastifyRequest,
    actor: Actor,
    body: SaveMedicineBody,
  ): Promise<MasterMedicine> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await this.createIn(tx, actor, body);
      await this.audit(tx, request, actor, 'medicine.created', row.id, {
        ingredients: body.ingredients.length,
      });
      return medicineOut(row);
    });
  }

  /** Replaces a clinic medicine's details and ingredients. Reference medicines are read-only. */
  async update(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: UpdateMedicineBody,
  ): Promise<MasterMedicine> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const existing = await tx.medicine.findUnique({ where: { id } });
      if (!existing) throw NOT_FOUND();
      if (existing.organisationId === null) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Medicines from the reference list cannot be changed.',
        );
      }
      await this.checkName(tx, actor, body.name, id);
      await this.checkMolecules(tx, body);
      await tx.medicine.update({
        where: { id },
        data: {
          name: body.name,
          genericName: body.genericName,
          composition: body.composition,
          form: body.form,
          defaultRoute: body.defaultRoute,
          active: body.active,
        },
      });
      await tx.medicineIngredient.deleteMany({ where: { medicineId: id } });
      await this.addIngredients(tx, id, body);
      await this.audit(tx, request, actor, 'medicine.updated', id, {
        active: body.active,
        ingredients: body.ingredients.length,
      });
      return medicineOut(
        await tx.medicine.findUniqueOrThrow({ where: { id }, include: withIngredients }),
      );
    });
  }

  /**
   * The queue: free-text names from this clinic's prescriptions, grouped by name key, with
   * how many prescriptions and doctors used them. Names without a decision are pending.
   */
  async queue(actor: Actor): Promise<MedicineQueue> {
    const { usage, decisions } = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const usage = await tx.$queryRaw<UsageRow[]>`
        SELECT lower(regexp_replace(btrim(i.name), '\\s+', ' ', 'g')) AS name_key,
               (array_agg(btrim(i.name) ORDER BY p.updated_at DESC))[1] AS name,
               count(DISTINCT i.prescription_id)::int AS prescriptions,
               count(DISTINCT p.doctor_user_id)::int AS doctors,
               max(p.updated_at) AS last_used_at
        FROM prescription_items i
        JOIN prescriptions p ON p.id = i.prescription_id
        WHERE i.medicine_id IS NULL AND btrim(i.name) <> ''
        GROUP BY 1`;
      const decisions = await tx.medicineRequest.findMany({
        include: { medicine: { select: { id: true, name: true, composition: true } } },
        orderBy: { decidedAt: 'desc' },
      });
      return { usage, decisions };
    });
    const byKey = new Map(usage.map((u) => [u.name_key, u]));
    const decided = new Set(decisions.map((d) => d.nameKey));
    const names = await staffNames(
      this.s.db,
      decisions.map((d) => d.decidedByUserId),
    );
    const pending = usage
      .filter((u) => !decided.has(u.name_key))
      .sort(
        (a, b) =>
          b.prescriptions - a.prescriptions ||
          (b.last_used_at?.getTime() ?? 0) - (a.last_used_at?.getTime() ?? 0) ||
          a.name_key.localeCompare(b.name_key),
      )
      .map((u) => this.usageOut(u.name_key, u.name, u));
    return {
      pending,
      decided: decisions.map((d) => ({
        id: d.id,
        ...this.usageOut(d.nameKey, d.name, byKey.get(d.nameKey)),
        decision: d.decision,
        medicine: d.medicine,
        reason: d.reason,
        decidedAt: d.decidedAt.toISOString(),
        decidedByName: names.get(d.decidedByUserId) ?? null,
      })),
    };
  }

  /**
   * Approves a free-text name: maps it to a medicine the clinic can use, or adds a new
   * clinic medicine first. Doctors then find that medicine by the name they typed.
   * Prescriptions already written keep their lines as they are.
   */
  async approve(
    request: FastifyRequest,
    actor: Actor,
    body: ApproveMedicineRequestBody,
  ): Promise<MedicineDecisionRow> {
    return this.decide(request, actor, body.name, async (tx) => {
      if (body.medicine) {
        const created = await this.createIn(tx, actor, body.medicine);
        await this.audit(tx, request, actor, 'medicine.created', created.id, {
          ingredients: body.medicine.ingredients.length,
        });
        return { decision: 'approved' as const, medicineId: created.id, reason: null };
      }
      const medicine = await tx.medicine.findUnique({ where: { id: body.medicineId! } });
      if (!medicine || !medicine.active) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active medicine from the list.', {
          medicineId: 'invalid',
        });
      }
      return { decision: 'approved' as const, medicineId: medicine.id, reason: null };
    });
  }

  async reject(
    request: FastifyRequest,
    actor: Actor,
    body: RejectMedicineRequestBody,
  ): Promise<MedicineDecisionRow> {
    return this.decide(request, actor, body.name, async () => ({
      decision: 'rejected' as const,
      medicineId: null,
      reason: body.reason,
    }));
  }

  /** Withdraws a decision: the name goes back to the queue. A medicine it added stays. */
  async undo(request: FastifyRequest, actor: Actor, id: string): Promise<void> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await tx.medicineRequest.findUnique({ where: { id } });
      if (!row) throw NOT_FOUND();
      await tx.medicineRequest.delete({ where: { id } });
      await writeAudit(tx, request, {
        action: 'medicine_request.undone',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'medicine_request',
        entityId: id,
        metadata: { decision: row.decision, medicineId: row.medicineId },
      });
    });
  }

  // ---- Helpers ----------------------------------------------------------------------

  private async decide(
    request: FastifyRequest,
    actor: Actor,
    name: string,
    resolve: (tx: Tx) => Promise<{
      decision: 'approved' | 'rejected';
      medicineId: string | null;
      reason: string | null;
    }>,
  ): Promise<MedicineDecisionRow> {
    const key = nameKey(name);
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      // Serialises decisions on the same name, so two admins cannot both decide it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`medicine-request:${key}`}))`;
      if (await tx.medicineRequest.findFirst({ where: { nameKey: key } })) {
        throw new AppError(409, 'CONFLICT', 'This medicine has already been decided.', {
          name: 'decided',
        });
      }
      const outcome = await resolve(tx);
      const created = await tx.medicineRequest.create({
        data: {
          organisationId: actor.organisationId,
          nameKey: key,
          name: name.trim().replace(/\s+/g, ' '),
          decision: outcome.decision,
          medicineId: outcome.medicineId,
          reason: outcome.reason,
          decidedByUserId: actor.userId,
          decidedAt: this.s.now(),
        },
        include: { medicine: { select: { id: true, name: true, composition: true } } },
      });
      await writeAudit(tx, request, {
        action: `medicine_request.${outcome.decision}`,
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'medicine_request',
        entityId: created.id,
        metadata: { medicineId: outcome.medicineId },
      });
      return created;
    });
    const names = await staffNames(this.s.db, [actor.userId]);
    return {
      id: row.id,
      ...this.usageOut(row.nameKey, row.name, undefined),
      decision: row.decision,
      medicine: row.medicine,
      reason: row.reason,
      decidedAt: row.decidedAt.toISOString(),
      decidedByName: names.get(actor.userId) ?? null,
    };
  }

  private async createIn(tx: Tx, actor: Actor, body: SaveMedicineBody): Promise<MedicineRow> {
    await this.checkName(tx, actor, body.name);
    await this.checkMolecules(tx, body);
    const created = await tx.medicine.create({
      data: {
        organisationId: actor.organisationId,
        name: body.name,
        genericName: body.genericName,
        composition: body.composition,
        form: body.form,
        defaultRoute: body.defaultRoute,
        source: 'clinic',
      },
    });
    await this.addIngredients(tx, created.id, body);
    return tx.medicine.findUniqueOrThrow({ where: { id: created.id }, include: withIngredients });
  }

  /**
   * The clinic's own medicine names are unique, ignoring case. The lock on the clinic and
   * name lasts until the transaction ends, so two admins saving the same name at once
   * cannot both pass the check.
   */
  private async checkName(tx: Tx, actor: Actor, name: string, exceptId?: string) {
    const key = `medicine-name:${actor.organisationId}:${name.trim().toLowerCase()}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const clash = await tx.medicine.findFirst({
      where: {
        organisationId: actor.organisationId,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new AppError(409, 'CONFLICT', 'The clinic already has a medicine with this name.', {
        name: 'taken',
      });
    }
  }

  private async checkMolecules(tx: Tx, body: SaveMedicineBody) {
    const ids = body.ingredients.map((i) => i.moleculeId);
    if (ids.length === 0) return;
    const found = await tx.drugMolecule.count({ where: { id: { in: ids } } });
    if (found !== ids.length) {
      throw new AppError(400, 'VALIDATION_FAILED', 'A molecule is not in the drug data.', {
        ingredients: 'invalid',
      });
    }
  }

  private async addIngredients(tx: Tx, medicineId: string, body: SaveMedicineBody) {
    if (body.ingredients.length === 0) return;
    await tx.medicineIngredient.createMany({
      data: body.ingredients.map((i) => ({
        medicineId,
        moleculeId: i.moleculeId,
        strengthMg: i.strengthMg,
        per: i.per,
      })),
    });
  }

  private usageOut(key: string, name: string, usage: UsageRow | undefined) {
    return {
      name,
      nameKey: key,
      prescriptions: usage?.prescriptions ?? 0,
      doctors: usage?.doctors ?? 0,
      lastUsedAt: usage?.last_used_at?.toISOString() ?? null,
    };
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    medicineId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'medicine',
      entityId: medicineId,
      metadata,
    });
  }
}
