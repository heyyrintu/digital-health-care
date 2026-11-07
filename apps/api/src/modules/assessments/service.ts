import {
  AssessmentDefinition,
  AssessmentResult,
  scoreAssessment,
  type CreateAssessmentForm,
  type AssignAssessment,
  type PatientAssessment,
  type Role,
  type AssessmentForm,
} from '@dhc/contracts';
import { withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { writeAudit } from '../audit/write';
import { assertChartAccess } from '../clinical/access';
import { historyIds, liveId, assertNotMerged } from '../patients/merged';
import { accountPhone, ownHistory } from '../portal/account';
import { PortalService } from '../portal/service';

type Actor = { userId: string; organisationId: string; role: Role };
const missing = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const conflict = () =>
  new AppError(409, 'CONFLICT', 'This assessment has changed. Reload the latest details.');
const formView = (r: {
  id: string;
  definition: unknown;
  active: boolean;
  createdAt: Date;
}): AssessmentForm => ({
  id: r.id,
  definition: AssessmentDefinition.parse(r.definition),
  active: r.active,
  createdAt: r.createdAt.toISOString(),
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export class AssessmentsService {
  constructor(readonly s: Services) {}
  private async audit(tx: Tx, req: FastifyRequest, a: Actor, action: string, id: string) {
    await writeAudit(tx, req, {
      organisationId: a.organisationId,
      actorUserId: a.userId,
      action: 'assessment.' + action,
      entityType: 'assessment',
      entityId: id,
    });
  }
  async forms(a: Actor, cursor?: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const rows = await tx.assessmentForm.findMany({
        where: cursor ? { id: { gt: cursor } } : {},
        orderBy: { id: 'asc' },
        take: 51,
      });
      return {
        data: rows.slice(0, 50).map(formView),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }
  async create(req: FastifyRequest, a: Actor, b: CreateAssessmentForm) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${b.id}, 81))`;
      const prior = await tx.assessmentForm.findUnique({ where: { id: b.id } });
      if (prior) {
        if (!same(AssessmentDefinition.parse(prior.definition), b.definition)) throw conflict();
        return formView(prior);
      }
      const row = await tx.assessmentForm.create({
        data: {
          id: b.id,
          organisationId: a.organisationId,
          createdByUserId: a.userId,
          definition: b.definition,
          createdAt: this.s.now(),
        },
      });
      await this.audit(tx, req, a, 'form_published', row.id);
      return formView(row);
    });
  }
  async archive(req: FastifyRequest, a: Actor, id: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const row = await tx.assessmentForm.findUnique({ where: { id } });
      if (!row) throw missing();
      const saved = await tx.assessmentForm.update({ where: { id }, data: { active: false } });
      await this.audit(tx, req, a, 'form_archived', id);
      return formView(saved);
    });
  }
  private async check(tx: Tx, a: Actor, patientId: string, phone?: string) {
    await tx.$queryRaw`SELECT id FROM patients WHERE id=${patientId}::uuid FOR SHARE`;
    const p = await tx.patient.findUnique({ where: { id: patientId } });
    if (!p) throw missing();
    if (a.role === 'patient') {
      await new PortalService(this.s).requireConsents(tx, a);
      await ownHistory(tx, phone!, patientId);
    } else await assertChartAccess(tx, a, liveId(p));
    return p;
  }
  async assign(req: FastifyRequest, a: Actor, patientId: string, b: AssignAssessment) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const p = await this.check(tx, a, patientId);
      assertNotMerged(p);
      if (p.portalClosedAt)
        throw new AppError(409, 'CONFLICT', 'This patient portal account is closed.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${b.id}, 82))`;
      const prior = await tx.patientAssessment.findUnique({ where: { id: b.id } });
      if (prior) {
        if (
          prior.patientId !== patientId ||
          prior.formId !== b.formId ||
          prior.assignedByUserId !== a.userId
        )
          throw conflict();
        return this.view(tx, prior);
      }
      await tx.$queryRaw`SELECT id FROM assessment_forms WHERE id=${b.formId}::uuid FOR SHARE`;
      const form = await tx.assessmentForm.findUnique({ where: { id: b.formId } });
      if (!form?.active) throw new AppError(409, 'CONFLICT', 'Choose an active assessment form.');
      const row = await tx.patientAssessment.create({
        data: {
          id: b.id,
          organisationId: a.organisationId,
          patientId,
          formId: b.formId,
          assignedByUserId: a.userId,
          createdAt: this.s.now(),
        },
      });
      await this.audit(tx, req, a, 'assigned', row.id);
      return this.view(tx, row);
    });
  }
  async list(req: FastifyRequest, a: Actor, patientId: string, cursor?: string) {
    const phone = a.role === 'patient' ? await accountPhone(this.s, a.userId) : undefined;
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const p = await this.check(tx, a, patientId, phone);
      const rows = await tx.patientAssessment.findMany({
        where: {
          patientId: { in: await historyIds(tx, liveId(p)) },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 51,
      });
      const data: PatientAssessment[] = [];
      for (const row of rows.slice(0, 50)) data.push(await this.view(tx, row));
      await this.audit(tx, req, a, 'history_viewed', patientId);
      return { data, nextCursor: rows.length > 50 ? rows[49]!.id : null };
    });
  }
  private async view(
    tx: Tx,
    row: {
      id: string;
      patientId: string;
      formId: string;
      state: string;
      resultCipher: string | null;
      submittedAt: Date | null;
      createdAt: Date;
    },
  ): Promise<PatientAssessment> {
    const form = await tx.assessmentForm.findUnique({ where: { id: row.formId } });
    if (!form) throw missing();
    return {
      id: row.id,
      patientId: row.patientId,
      formId: row.formId,
      definition: AssessmentDefinition.parse(form.definition),
      state: row.state as PatientAssessment['state'],
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      result: row.resultCipher
        ? AssessmentResult.parse(JSON.parse(this.s.cipher.decrypt(row.resultCipher)))
        : null,
    };
  }
  async act(req: FastifyRequest, a: Actor, id: string, answers?: Record<string, number>) {
    const phone = a.role === 'patient' ? await accountPhone(this.s, a.userId) : undefined;
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM patient_assessments WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.patientAssessment.findUnique({ where: { id } });
      if (!row) throw missing();
      await this.check(tx, a, row.patientId, phone);
      const current = await this.view(tx, row);
      if (a.role === 'patient') {
        let result: AssessmentResult;
        try {
          result = scoreAssessment(current.definition, answers!);
        } catch {
          throw new AppError(
            400,
            'VALIDATION_FAILED',
            'Answer every question within its displayed range.',
          );
        }
        if (row.state === 'submitted') {
          if (
            current.result &&
            Object.entries(result.answers).every(([k, v]) => current.result!.answers[k] === v)
          )
            return current;
          throw conflict();
        }
        if (row.state !== 'pending') throw conflict();
        const updated = await tx.patientAssessment.update({
          where: { id },
          data: {
            state: 'submitted',
            resultCipher: this.s.cipher.encrypt(JSON.stringify(result)),
            submittedByUserId: a.userId,
            submittedAt: this.s.now(),
          },
        });
        await this.audit(tx, req, a, 'submitted', id);
        return this.view(tx, updated);
      }
      if (row.state === 'cancelled') return current;
      if (row.state !== 'pending') throw conflict();
      const updated = await tx.patientAssessment.update({
        where: { id },
        data: { state: 'cancelled' },
      });
      await this.audit(tx, req, a, 'cancelled', id);
      return this.view(tx, updated);
    });
  }
}
