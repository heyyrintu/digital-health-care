import { istDate } from '@dhc/domain';
import { withTenant, type Tx, type Prisma } from '@dhc/db';
import {
  RightsItem,
  type RightsCreate,
  type RightsDecision,
  type RightsQuery,
  type Role,
} from '@dhc/contracts';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import {
  accountPhone,
  ownPatient,
  accountPatientsWhere,
  accountHistoryWhere,
} from '../portal/account';
import { requirePatientAccountOpen } from './access';
import { assertChartAccess } from '../clinical/access';
import { adultAt } from '../portal/profile';
import { writeAudit } from '../audit/write';
import { z } from 'zod';
import { normaliseIndianMobile } from '../../auth/phone';
export type RightsActor = { userId: string; organisationId: string; role: Role };
export const missing = () => new AppError(404, 'NOT_FOUND', 'Not found.');
export const conflict = () =>
  new AppError(409, 'CONFLICT', 'This request changed. Reload before continuing.');
const terminal = new Set(['fulfilled', 'declined', 'retained', 'withdrawn']);
type Row = Prisma.DataRightsRequestGetPayload<{ include: { events: true } }>;
export class DataRightsService {
  constructor(readonly s: Services) {}
  async event(tx: Tx, req: FastifyRequest, a: RightsActor, id: string, action: string) {
    await tx.dataRightsEvent.create({
      data: {
        organisationId: a.organisationId,
        requestId: id,
        actorUserId: a.userId,
        action,
        at: this.s.now(),
      },
    });
    await writeAudit(tx, req, {
      action: `data_rights.${action}`,
      organisationId: a.organisationId,
      actorUserId: a.userId,
      entityType: 'data_rights_request',
      entityId: id,
    });
  }
  async patients(a: RightsActor) {
    const phone = await accountPhone(this.s, a.userId);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await requirePatientAccountOpen(tx, a);
      return {
        data: await tx.patient.findMany({
          where: accountPatientsWhere(phone),
          select: { id: true, name: true, uhid: true },
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
      };
    });
  }
  async staff(tx: Tx, a: RightsActor) {
    if (
      a.role !== 'patient' &&
      !(await tx.membership.findFirst({
        where: { userId: a.userId, role: a.role, status: 'active' },
      }))
    )
      throw new AppError(403, 'FORBIDDEN', 'Your clinic role is no longer active.');
  }
  async visible(tx: Tx, a: RightsActor, r: Row) {
    await this.staff(tx, a);
    const full =
      a.role === 'patient'
        ? r.userId === a.userId
        : a.role === 'doctor'
          ? r.area === 'clinical' && r.assignedDoctorId === a.userId
          : r.area !== 'clinical';
    if (a.role === 'doctor') {
      if (!full || !r.patientId) throw missing();
      await assertChartAccess(tx, a, r.patientId);
    }
    if (a.role === 'patient' && !full) throw missing();
    const patient = r.patientId
      ? await tx.patient.findFirst({
          where: {
            id: r.patientId,
            ...(a.role === 'patient'
              ? accountHistoryWhere(await accountPhone(this.s, a.userId))
              : {}),
          },
          select: { id: true, name: true, uhid: true },
        })
      : null;
    return RightsItem.parse({
      ...r,
      patient,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      details: full ? JSON.parse(this.s.cipher.decrypt(r.detailsCipher)) : null,
      response: full && r.responseCipher ? this.s.cipher.decrypt(r.responseCipher) : null,
      policyReference: full ? r.policyReference : null,
      reviewAfter: full ? (r.reviewAfter?.toISOString().slice(0, 10) ?? null) : null,
      evidenceId: full ? r.evidenceId : null,
      events: r.events.map((e) => ({ action: e.action, at: e.at.toISOString() })),
    });
  }
  async list(a: RightsActor, q: RightsQuery) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      if (a.role === 'patient') await requirePatientAccountOpen(tx, a);
      else await this.staff(tx, a);
      const where: Prisma.DataRightsRequestWhereInput = {
        ...(a.role === 'patient'
          ? { userId: a.userId }
          : a.role === 'doctor'
            ? { assignedDoctorId: a.userId, area: 'clinical' }
            : {}),
        ...(q.state ? { state: q.state } : {}),
      };
      const rows = await tx.dataRightsRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        take: q.limit + 1,
        include: { events: { orderBy: { at: 'asc' } } },
      });
      const data: RightsItem[] = [];
      for (const r of rows.slice(0, q.limit)) {
        try {
          data.push(await this.visible(tx, a, r));
        } catch (e) {
          if (a.role !== 'doctor' || !(e instanceof AppError) || e.code !== 'CHART_RESTRICTED')
            throw e;
        }
      }
      return { data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
    });
  }
  async create(req: FastifyRequest, a: RightsActor, b: RightsCreate) {
    const phone = await accountPhone(this.s, a.userId);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await requirePatientAccountOpen(tx, a);
      await ownPatient(tx, phone, b.patientId);
      const { id, patientId, kind, area, ...details } = b;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rights:${id}`},0))`;
      if ((area !== 'profile' || kind !== 'correction') && (details.field || details.value))
        throw new AppError(400, 'VALIDATION_FAILED', 'Use the message for this request.');
      if (area === 'profile' && kind === 'correction' && (!details.field || !details.value))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Select a profile field and its corrected value.',
        );
      const prior = await tx.dataRightsRequest.findUnique({
        where: { id },
        include: { events: true },
      });
      if (prior) {
        if (
          prior.userId !== a.userId ||
          prior.patientId !== patientId ||
          prior.kind !== kind ||
          prior.area !== area ||
          this.s.cipher.decrypt(prior.detailsCipher) !== JSON.stringify(details)
        )
          throw conflict();
        return this.visible(tx, a, prior);
      }
      const recent = await tx.dataRightsRequest.count({
        where: { userId: a.userId, createdAt: { gt: new Date(this.s.now().getTime() - 3600000) } },
      });
      if (recent >= 20)
        throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try later.');
      await tx.dataRightsRequest.create({
        data: {
          id,
          organisationId: a.organisationId,
          userId: a.userId,
          patientId,
          kind,
          area,
          detailsCipher: this.s.cipher.encrypt(JSON.stringify(details)),
          createdAt: this.s.now(),
        },
      });
      await this.event(tx, req, a, id, 'requested');
      return this.visible(
        tx,
        a,
        await tx.dataRightsRequest.findUniqueOrThrow({ where: { id }, include: { events: true } }),
      );
    });
  }
  async assign(
    req: FastifyRequest,
    a: RightsActor,
    id: string,
    b: { revision: number; doctorId: string },
  ) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM data_rights_requests WHERE id=${id}::uuid FOR UPDATE`;
      const r = await tx.dataRightsRequest.findUnique({ where: { id } });
      if (!r || r.area !== 'clinical') throw missing();
      if (r.revision !== b.revision || terminal.has(r.state)) throw conflict();
      if (
        !(await tx.membership.findFirst({
          where: { userId: b.doctorId, role: 'doctor', status: 'active' },
        }))
      )
        throw missing();
      await assertChartAccess(tx, { ...a, userId: b.doctorId, role: 'doctor' }, r.patientId!);
      await tx.dataRightsRequest.update({
        where: { id },
        data: { assignedDoctorId: b.doctorId, revision: { increment: 1 } },
      });
      await this.event(tx, req, a, id, 'assigned');
      return this.visible(
        tx,
        a,
        await tx.dataRightsRequest.findUniqueOrThrow({ where: { id }, include: { events: true } }),
      );
    });
  }
  async withdraw(req: FastifyRequest, a: RightsActor, id: string, revision: number) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await requirePatientAccountOpen(tx, a);
      await tx.$queryRaw`SELECT id FROM data_rights_requests WHERE id=${id}::uuid FOR UPDATE`;
      const r = await tx.dataRightsRequest.findUnique({ where: { id } });
      if (!r || r.userId !== a.userId || !['correction', 'erasure'].includes(r.kind))
        throw missing();
      if (r.revision !== revision || terminal.has(r.state)) throw conflict();
      await tx.dataRightsRequest.update({
        where: { id },
        data: { state: 'withdrawn', revision: { increment: 1 } },
      });
      await this.event(tx, req, a, id, 'withdrawn');
      return this.visible(
        tx,
        a,
        await tx.dataRightsRequest.findUniqueOrThrow({ where: { id }, include: { events: true } }),
      );
    });
  }
  async decide(req: FastifyRequest, a: RightsActor, id: string, b: RightsDecision) {
    const requester = await withTenant(this.s.db, a.organisationId, (tx) =>
      tx.dataRightsRequest.findUnique({ where: { id }, select: { userId: true } }),
    );
    if (!requester) throw missing();
    const phone = await accountPhone(this.s, requester.userId);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      if (b.state === 'fulfilled')
        await requirePatientAccountOpen(tx, { ...a, userId: requester.userId });
      await tx.$queryRaw`SELECT id FROM data_rights_requests WHERE id=${id}::uuid FOR UPDATE`;
      const r = await tx.dataRightsRequest.findUnique({ where: { id }, include: { events: true } });
      if (!r || !r.patientId || !['correction', 'erasure'].includes(r.kind)) throw missing();
      if (
        r.area === 'clinical'
          ? a.role !== 'doctor' || r.assignedDoctorId !== a.userId
          : a.role !== 'clinic_admin'
      )
        throw new AppError(403, 'FORBIDDEN', 'This request needs its authorised reviewer.');
      await this.visible(tx, a, r);
      if (terminal.has(r.state) || r.revision !== b.revision) throw conflict();
      await tx.$queryRaw`SELECT id FROM patients WHERE id=${r.patientId}::uuid FOR UPDATE`;
      const p =
        b.state === 'fulfilled'
          ? await ownPatient(tx, phone, r.patientId)
          : await tx.patient.findUniqueOrThrow({ where: { id: r.patientId } }); // Applying corrections requires current ownership.
      if (b.state === 'retained' && !b.policyReference)
        throw new AppError(400, 'VALIDATION_FAILED', 'Give the clinic retention policy reference.');
      if (b.state === 'fulfilled' && r.kind === 'erasure') {
        const details = JSON.parse(this.s.cipher.decrypt(r.detailsCipher)) as {
          referenceId: string | null;
        };
        const erased = details.referenceId
          ? await tx.patientRecord.findFirst({
              where: {
                id: details.referenceId,
                patientId: p.id,
                usedAt: null,
                state: 'deleted',
                purgedAt: { not: null },
                fileKey: null,
              },
            })
          : null;
        if (!erased)
          throw new AppError(
            400,
            'VALIDATION_FAILED',
            'Reference an unused upload whose erasure has completed. Retained care and payment history need a policy decision.',
          );
        if (b.evidenceId !== erased.id)
          throw new AppError(
            400,
            'VALIDATION_FAILED',
            'Reference the erased upload in the decision.',
          );
      }
      if (b.state === 'fulfilled' && r.kind === 'correction') {
        if (r.area === 'profile') {
          const d = JSON.parse(this.s.cipher.decrypt(r.detailsCipher)) as {
            field: string;
            value: string;
          };
          let value: string | Date = d.value;
          if (d.field === 'name') value = z.string().trim().min(1).max(120).parse(value);
          else if (d.field === 'email') value = z.email().max(254).parse(value);
          else if (d.field === 'gender') value = z.enum(['male', 'female', 'other']).parse(value);
          else if (d.field === 'language') value = z.enum(['en', 'hi']).parse(value);
          else if (d.field === 'dob') {
            const date = z.iso.date().parse(value);
            value = new Date(date);
            if (
              date > istDate(this.s.now()) ||
              date < `${Number(istDate(this.s.now()).slice(0, 4)) - 130}-01-01` ||
              (!adultAt(value, this.s.now()) &&
                (!p.guardianPatientId ||
                  (await tx.patient.count({ where: { guardianPatientId: p.id } }))))
            )
              throw new AppError(
                400,
                'VALIDATION_FAILED',
                'This date needs a clinic guardian review.',
              );
          } else if (d.field === 'emergencyContactPhone') {
            const phone = normaliseIndianMobile(value);
            if (!phone || !p.emergencyContactName)
              throw new AppError(
                400,
                'VALIDATION_FAILED',
                'A valid paired emergency contact is needed.',
              );
            value = phone;
          } else if (d.field === 'emergencyContactName') {
            if (!p.emergencyContactPhone)
              throw new AppError(
                400,
                'VALIDATION_FAILED',
                'Add the emergency phone at the clinic first.',
              );
          } else if (d.field !== 'address')
            throw new AppError(400, 'VALIDATION_FAILED', 'Unsupported profile field.');
          await tx.patient.update({ where: { id: p.id }, data: { [d.field]: value } });
        } else if (r.area === 'clinical') {
          if (!b.evidenceId)
            throw new AppError(
              400,
              'VALIDATION_FAILED',
              'Reference the corrected clinical record.',
            );
          const evidence =
            (await tx.consultation.findFirst({
              where: {
                id: b.evidenceId,
                patientId: p.id,
                doctorUserId: a.userId,
                updatedAt: { gte: r.createdAt },
                revision: { gt: 1 },
              },
            })) ??
            (await tx.prescription.findFirst({
              where: {
                id: b.evidenceId,
                patientId: p.id,
                doctorUserId: a.userId,
                updatedAt: { gte: r.createdAt },
                OR: [
                  { amendsPrescriptionId: { not: null }, status: { not: 'draft' } },
                  { status: 'void' },
                ],
              },
            }));
          if (!evidence)
            throw new AppError(
              400,
              'VALIDATION_FAILED',
              'Reference an actual correction made after this request.',
            );
        } else {
          const evidence = b.evidenceId
            ? await tx.refundEntry.findFirst({
                where: {
                  refundId: b.evidenceId,
                  bill: { patientId: p.id },
                  postedAt: { gte: r.createdAt },
                },
              })
            : null;
          if (!evidence)
            throw new AppError(
              400,
              'VALIDATION_FAILED',
              'Reference the posted refund that corrects this patient payment. Other financial corrections need clinic review.',
            );
        }
      }
      await tx.dataRightsRequest.update({
        where: { id },
        data: {
          state: b.state,
          responseCipher: this.s.cipher.encrypt(b.response),
          policyReference: b.policyReference,
          reviewAfter: b.reviewAfter ? new Date(b.reviewAfter) : null,
          evidenceId: b.evidenceId,
          revision: { increment: 1 },
        },
      });
      await this.event(tx, req, a, id, b.state);
      return this.visible(
        tx,
        a,
        await tx.dataRightsRequest.findUniqueOrThrow({ where: { id }, include: { events: true } }),
      );
    });
  }
}
