import type {
  CreatePatientBody,
  Gender,
  Language,
  DuplicateCheckBody,
  PatientDetail,
  PatientListQuery,
  PatientSummary,
  UhidSettings,
  UpdatePatientBody,
  UpdateUhidSettingsBody,
} from '@dhc/contracts';
import { withTenant, type Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { normaliseIndianMobile } from '../../auth/phone';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { assertNotMerged } from './merged';

interface Actor {
  userId: string;
  organisationId: string;
}

/** Where numbering starts until a clinic admin sets its own prefix and number. */
export const DEFAULT_UHID_START = 10001;

export const withTags = {
  tags: { include: { tag: true }, orderBy: { createdAt: 'asc' } },
} as const;
type PatientWithTags = Prisma.PatientGetPayload<{ include: typeof withTags }>;

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

/** Collapses runs of spaces so duplicate checks and search treat "Asha  Verma" as "Asha Verma". */
const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');

export function toSummary(p: PatientWithTags): PatientSummary {
  return {
    id: p.id,
    uhid: p.uhid,
    name: p.name,
    phone: p.phone,
    dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
    gender: p.gender,
    tags: p.tags.map(({ tag }) => ({
      id: tag.id,
      name: tag.name,
      colour: tag.colour,
      sortToTop: tag.sortToTop,
    })),
    mergedIntoId: p.mergedIntoId,
  };
}

const ref = { id: true, uhid: true, name: true } as const;

const uhidOf = (prefix: string, n: number) => `${prefix}${n}`;

interface PatientFieldData {
  name?: string;
  phone?: string | null;
  dob?: Date | null;
  gender?: Gender | null;
  email?: string | null;
  address?: string | null;
  bloodGroup?: string | null;
  language?: Language;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  guardianPatientId?: string | null;
}

/**
 * The patient register (PRD §4.1, §5.3, §5.4): registration with UHIDs, demographics,
 * families and tags. Demographics only; nothing here is clinical, so front desk may use
 * all of it. Every query runs inside the caller's organisation (RLS).
 */
export class PatientService {
  constructor(private readonly s: Services) {}

  async list(actor: Actor, query: PatientListQuery, decodeCursor: (c: string) => string) {
    const { limit, cursor, q, tagId } = query;
    const where: Prisma.PatientWhereInput = {
      AND: [
        q
          ? {
              OR: [
                { name: { contains: cleanName(q), mode: 'insensitive' } },
                { uhid: { contains: q.toUpperCase() } },
                { phone: { contains: q.replace(/[\s\-()]/g, '') } },
              ],
            }
          : {},
        // Merged duplicates stay out of lists, except by their exact old UHID (on old
        // papers), where they lead to the record they were merged into.
        { OR: [{ mergedIntoId: null }, ...(q ? [{ uhid: q.trim().toUpperCase() }] : [])] },
      ],
      ...(tagId ? { tags: { some: { tagId } } } : {}),
    };
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.patient.findMany({
        where,
        include: withTags,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: decodeCursor(cursor) }, skip: 1 } : {}),
      }),
    );
    const pageRows = rows.slice(0, limit);
    return {
      data: pageRows.map(toSummary),
      lastId: rows.length > limit ? pageRows[pageRows.length - 1]!.id : null,
    };
  }

  /** Demographics and family; each view is audited. */
  async view(request: FastifyRequest, actor: Actor, id: string): Promise<PatientDetail> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const detail = await this.detail(tx, id);
      await writeAudit(tx, request, {
        action: 'patient.viewed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'patient',
        entityId: id,
      });
      return detail;
    });
  }

  async duplicates(actor: Actor, body: DuplicateCheckBody): Promise<PatientSummary[]> {
    const phone = body.phone ? this.phone(body.phone, 'phone') : null;
    return withTenant(this.s.db, actor.organisationId, async (tx) =>
      (await this.findDuplicates(tx, cleanName(body.name), phone, body.dob ?? null)).map(toSummary),
    );
  }

  async create(
    request: FastifyRequest,
    actor: Actor,
    body: CreatePatientBody,
  ): Promise<PatientDetail> {
    const fields = this.fields(body);
    const name = cleanName(body.name);
    const tagIds = [...new Set(body.tagIds ?? [])];

    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      if (!fields.phone && !fields.guardianPatientId) {
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Add a mobile number, or link the patient to a guardian who has one.',
          { phone: 'required' },
        );
      }
      if (fields.guardianPatientId) await this.checkGuardian(tx, fields.guardianPatientId, null);

      const duplicates = await this.findDuplicates(
        tx,
        name,
        fields.phone ?? null,
        body.dob ?? null,
      );
      if (duplicates.length > 0 && !body.allowDuplicate) {
        throw new AppError(
          409,
          'CONFLICT',
          'This patient may already be registered. Check the matches before registering again.',
          { duplicates: duplicates.map((d) => d.id).join(',') },
        );
      }
      if (tagIds.length > 0) await this.assignableTags(tx, tagIds);

      const uhid = await this.allocateUhid(tx, actor.organisationId);
      const created = await tx.patient.create({
        data: {
          ...fields,
          name,
          uhid,
          organisationId: actor.organisationId,
          createdByUserId: actor.userId,
          tags: {
            create: tagIds.map((tagId) => ({
              tagId,
              organisationId: actor.organisationId,
              addedByUserId: actor.userId,
            })),
          },
        },
      });
      await writeAudit(tx, request, {
        action: 'patient.created',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'patient',
        entityId: created.id,
        metadata: { duplicateOverride: duplicates.length > 0, tagCount: tagIds.length },
      });
      return this.detail(tx, created.id);
    });
  }

  async update(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: UpdatePatientBody,
  ): Promise<PatientDetail> {
    const fields = this.fields(body);
    if (body.name !== undefined) fields.name = cleanName(body.name);

    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const current = await tx.patient.findUnique({ where: { id } });
      if (!current) throw NOT_FOUND();
      assertNotMerged(current);
      if (fields.guardianPatientId) await this.checkGuardian(tx, fields.guardianPatientId, id);

      const phone = fields.phone === undefined ? current.phone : fields.phone;
      const guardian =
        fields.guardianPatientId === undefined
          ? current.guardianPatientId
          : fields.guardianPatientId;
      if (!phone && !guardian) {
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Keep a mobile number, or link the patient to a guardian who has one.',
          { phone: 'required' },
        );
      }

      const changed = Object.keys(fields).filter(
        (key) => fields[key as keyof typeof fields] !== undefined,
      );
      await tx.patient.update({ where: { id }, data: fields });
      await writeAudit(tx, request, {
        action: 'patient.updated',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'patient',
        entityId: id,
        // Field names only: never the values.
        metadata: { fields: changed },
      });
      return this.detail(tx, id);
    });
  }

  async setTags(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    tagIds: string[],
  ): Promise<PatientDetail> {
    const wanted = new Set(tagIds);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id }, include: withTags });
      if (!patient) throw NOT_FOUND();
      assertNotMerged(patient);
      const current = new Set(patient.tags.map((t) => t.tagId));
      const added = [...wanted].filter((t) => !current.has(t));
      const removed = [...current].filter((t) => !wanted.has(t));
      // Archived tags already on the patient may stay; only new ones must be assignable.
      if (added.length > 0) await this.assignableTags(tx, added);

      if (removed.length > 0) {
        await tx.patientTag.deleteMany({ where: { patientId: id, tagId: { in: removed } } });
      }
      if (added.length > 0) {
        await tx.patientTag.createMany({
          data: added.map((tagId) => ({
            patientId: id,
            tagId,
            organisationId: actor.organisationId,
            addedByUserId: actor.userId,
          })),
        });
      }
      if (added.length > 0 || removed.length > 0) {
        await writeAudit(tx, request, {
          action: 'patient.tags.changed',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'patient',
          entityId: id,
          metadata: { added, removed },
        });
      }
      return this.detail(tx, id);
    });
  }

  // ---- UHID numbering ---------------------------------------------------------------

  async uhidSettings(actor: Actor): Promise<UhidSettings> {
    const row = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.uhidSettings.findUnique({ where: { organisationId: actor.organisationId } }),
    );
    const prefix = row?.prefix ?? '';
    const nextNumber = row?.nextNumber ?? DEFAULT_UHID_START;
    return { prefix, nextNumber, nextUhid: uhidOf(prefix, nextNumber) };
  }

  async updateUhidSettings(
    request: FastifyRequest,
    actor: Actor,
    body: UpdateUhidSettingsBody,
  ): Promise<UhidSettings> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await tx.uhidSettings.upsert({
        where: { organisationId: actor.organisationId },
        create: { organisationId: actor.organisationId, ...body },
        update: body,
      });
      await writeAudit(tx, request, {
        action: 'uhid_settings.updated',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        metadata: { prefix: body.prefix, nextNumber: body.nextNumber },
      });
    });
    return this.uhidSettings(actor);
  }

  // ---- Internals ----------------------------------------------------------------------

  /**
   * Takes the next number under a row lock, so concurrent registrations never share a
   * UHID. Numbers already in use (imported patients keep their UHIDs, or an admin moved
   * the counter back) are skipped.
   */
  private async allocateUhid(tx: Tx, organisationId: string): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO uhid_settings (organisation_id, prefix, next_number, updated_at)
      VALUES (${organisationId}::uuid, '', ${DEFAULT_UHID_START}, now())
      ON CONFLICT (organisation_id) DO NOTHING`;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const [row] = await tx.$queryRaw<{ prefix: string; n: number }[]>`
        UPDATE uhid_settings SET next_number = next_number + 1, updated_at = now()
        WHERE organisation_id = ${organisationId}::uuid
        RETURNING prefix, next_number - 1 AS n`;
      const uhid = uhidOf(row!.prefix, row!.n);
      const taken = await tx.patient.findUnique({
        where: { organisationId_uhid: { organisationId, uhid } },
        select: { id: true },
      });
      if (!taken) return uhid;
    }
    throw new AppError(
      409,
      'CONFLICT',
      'No free UHID near the next number. Ask a clinic admin to check the UHID settings.',
    );
  }

  private async findDuplicates(tx: Tx, name: string, phone: string | null, dob: string | null) {
    const or: Prisma.PatientWhereInput[] = [];
    // Families share a number, so the same phone alone is not a duplicate.
    if (phone) or.push({ phone, name: { equals: name, mode: 'insensitive' } });
    if (dob)
      or.push({ dob: new Date(`${dob}T00:00:00Z`), name: { equals: name, mode: 'insensitive' } });
    if (or.length === 0) return [];
    return tx.patient.findMany({
      where: { OR: or, mergedIntoId: null },
      include: withTags,
      take: 5,
    });
  }

  /** A guardian is an adult record without a guardian of their own (one level only). */
  private async checkGuardian(tx: Tx, guardianId: string, patientId: string | null) {
    if (guardianId === patientId) {
      throw invalid('guardianPatientId', 'A patient cannot be their own guardian.');
    }
    const guardian = await tx.patient.findUnique({ where: { id: guardianId } });
    if (!guardian) throw invalid('guardianPatientId', 'Guardian not found.');
    if (guardian.mergedIntoId) {
      throw invalid(
        'guardianPatientId',
        'That record was merged into another one; choose that one.',
      );
    }
    if (guardian.guardianPatientId) {
      throw invalid('guardianPatientId', 'The guardian must not have a guardian themselves.');
    }
    if (patientId && (await tx.patient.count({ where: { guardianPatientId: patientId } })) > 0) {
      throw invalid(
        'guardianPatientId',
        'This patient is a guardian for others, so they cannot have a guardian.',
      );
    }
  }

  private async assignableTags(tx: Tx, tagIds: string[]) {
    const found = await tx.tag.count({ where: { id: { in: tagIds }, archivedAt: null } });
    if (found !== tagIds.length) throw invalid('tagIds', 'One or more tags are not available.');
  }

  private async detail(tx: Tx, id: string): Promise<PatientDetail> {
    const p = await tx.patient.findUnique({
      where: { id },
      include: {
        ...withTags,
        guardian: { select: ref },
        mergedInto: { select: ref },
        mergedFrom: { select: ref, orderBy: { mergedAt: 'asc' } },
      },
    });
    if (!p) throw NOT_FOUND();
    const pendingMerge = await tx.patientMergeRequest.findFirst({
      where: { status: 'pending', OR: [{ sourcePatientId: id }, { targetPatientId: id }] },
      select: { id: true, source: { select: ref }, target: { select: ref } },
    });

    const related = await tx.patient.findMany({
      where: {
        id: { not: p.id },
        mergedIntoId: null,
        OR: [
          { guardianPatientId: p.id },
          ...(p.phone ? [{ phone: p.phone }] : []),
          ...(p.guardianPatientId ? [{ id: p.guardianPatientId }] : []),
        ],
      },
      select: { id: true, uhid: true, name: true, guardianPatientId: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    return {
      ...toSummary(p),
      email: p.email,
      address: p.address,
      bloodGroup: p.bloodGroup as PatientDetail['bloodGroup'],
      language: p.language,
      emergencyContactName: p.emergencyContactName,
      emergencyContactPhone: p.emergencyContactPhone,
      guardian: p.guardian,
      family: related.map((r) => ({
        id: r.id,
        uhid: r.uhid,
        name: r.name,
        relation:
          r.id === p.guardianPatientId
            ? 'guardian'
            : r.guardianPatientId === p.id
              ? 'dependant'
              : 'same_phone',
      })),
      createdAt: p.createdAt.toISOString(),
      mergedInto: p.mergedInto,
      mergedFrom: p.mergedFrom,
      pendingMerge,
    };
  }

  /** Validates and normalises the demographic fields present in a create or update body. */
  private fields(body: UpdatePatientBody) {
    const data: PatientFieldData = {};
    if (body.phone !== undefined) data.phone = body.phone ? this.phone(body.phone, 'phone') : null;
    if (body.emergencyContactPhone !== undefined) {
      data.emergencyContactPhone = body.emergencyContactPhone
        ? this.phone(body.emergencyContactPhone, 'emergencyContactPhone')
        : null;
    }
    if (body.dob !== undefined) data.dob = body.dob ? this.dob(body.dob) : null;
    if (body.gender !== undefined) data.gender = body.gender;
    if (body.email !== undefined) data.email = body.email?.toLowerCase() ?? null;
    if (body.address !== undefined) data.address = body.address;
    if (body.bloodGroup !== undefined) data.bloodGroup = body.bloodGroup;
    if (body.language !== undefined) data.language = body.language;
    if (body.emergencyContactName !== undefined) {
      data.emergencyContactName = body.emergencyContactName;
    }
    if (body.guardianPatientId !== undefined) data.guardianPatientId = body.guardianPatientId;
    return data;
  }

  private phone(raw: string, field: string): string {
    const phone = normaliseIndianMobile(raw);
    if (!phone) throw invalid(field, 'Enter a 10-digit Indian mobile number.');
    return phone;
  }

  private dob(raw: string): Date {
    const dob = new Date(`${raw}T00:00:00Z`);
    const now = this.s.now();
    const oldest = new Date(Date.UTC(now.getUTCFullYear() - 130, 0, 1));
    if (dob > now || dob < oldest) throw invalid('dob', 'Enter a real date of birth.');
    return dob;
  }
}
