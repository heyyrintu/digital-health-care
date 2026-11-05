import {
  PortalProfile,
  type PatientReportedEntry,
  type UpdatePortalProfile,
  type Role,
} from '@dhc/contracts';
import { withTenant, type Tx } from '@dhc/db';
import { istDate } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import { normaliseIndianMobile } from '../../auth/phone';
import { uniqueSuffix } from '../../files';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { acceptLogo, logoExtension } from '../branding/logo';
import type { UploadedFile } from '../orders/upload';
import { historyIds, assertNotMerged } from '../patients/merged';
import { assertChartAccess } from '../clinical/access';
import { accountPhone, ownPatient } from './account';
import { PortalService } from './service';

type Actor = { userId: string; organisationId: string };
const missing = () => new AppError(404, 'NOT_FOUND', 'Not found.');
export const adultAt = (dob: Date | null, now: Date) =>
  !!dob &&
  dob.toISOString().slice(0, 10) <=
    `${Number(istDate(now).slice(0, 4)) - 18}${istDate(now).slice(4)}`;

export class PortalProfileService {
  constructor(private readonly s: Services) {}
  async owned(tx: Tx, actor: Actor, id: string, phone: string) {
    await new PortalService(this.s).requireConsents(tx, actor);
    return ownPatient(tx, phone, id);
  }
  async view(request: FastifyRequest, actor: Actor, id: string): Promise<PortalProfile> {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await this.owned(tx, actor, id, phone);
      await this.audit(tx, request, actor, id, 'patient.profile_viewed', []);
      return this.out(tx, row, phone);
    });
  }
  async update(request: FastifyRequest, actor: Actor, id: string, body: UpdatePortalProfile) {
    const phone = await accountPhone(this.s, actor.userId);
    const today = istDate(this.s.now());
    if (body.dob > today || body.dob < `${Number(today.slice(0, 4)) - 130}-01-01`)
      throw new AppError(400, 'VALIDATION_FAILED', 'Enter a valid date of birth.', {
        dob: 'invalid',
      });
    const emergency = body.emergencyContactPhone
      ? normaliseIndianMobile(body.emergencyContactPhone)
      : null;
    if (body.emergencyContactPhone && !emergency)
      throw new AppError(400, 'VALIDATION_FAILED', 'Enter a valid emergency mobile number.', {
        emergencyContactPhone: 'invalid',
      });
    if (!!body.emergencyContactName !== !!emergency)
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Add both the emergency contact name and number.',
        { emergencyContactName: 'required' },
      );
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM patients WHERE id=${id}::uuid FOR UPDATE`;
      const before = await this.owned(tx, actor, id, phone);
      if (before.updatedAt.toISOString() !== body.updatedAt)
        throw new AppError(409, 'CONFLICT', 'This profile changed. Reload before saving.', {
          updatedAt: 'stale',
        });
      const dob = new Date(body.dob + 'T00:00:00Z');
      if (
        !adultAt(dob, this.s.now()) &&
        (!before.guardianPatientId ||
          (await tx.patient.count({ where: { guardianPatientId: id, mergedIntoId: null } })))
      )
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'A child needs an adult guardian. Ask the clinic to update the family links.',
          { dob: 'guardian_required' },
        );
      const { updatedAt: _expected, reportedBloodGroup, ...fields } = body;
      const bloodChanged = reportedBloodGroup !== before.reportedBloodGroup;
      const row = await tx.patient.update({
        where: { id },
        data: {
          ...fields,
          name: body.name!.trim().replace(/\s+/g, ' '),
          dob,
          emergencyContactPhone: emergency,
          ...(bloodChanged
            ? {
                reportedBloodGroup,
                bloodGroupReportedAt: this.s.now(),
                bloodGroupConfirmedAt: null,
              }
            : {}),
        },
      });
      await this.audit(
        tx,
        request,
        actor,
        id,
        'patient.profile_updated',
        Object.keys(fields)
          .filter((key) => key !== 'updatedAt')
          .concat(bloodChanged ? ['reportedBloodGroup'] : []),
      );
      return this.out(tx, row, phone);
    });
  }
  async report(request: FastifyRequest, actor: Actor, id: string, body: PatientReportedEntry) {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM patients WHERE id=${id}::uuid FOR UPDATE`;
      await this.owned(tx, actor, id, phone);
      const base = {
        organisationId: actor.organisationId,
        patientId: id,
        source: 'patient' as const,
        recordedByUserId: actor.userId,
      };
      if (body.kind === 'allergies')
        await tx.allergy.create({
          data: { ...base, substance: body.substance, reaction: body.reaction },
        });
      else if (body.kind === 'conditions')
        await tx.medicalCondition.create({ data: { ...base, name: body.name } });
      else
        await tx.currentMedication.create({ data: { ...base, name: body.name, dose: body.dose } });
      await this.audit(tx, request, actor, id, 'patient.medical_basics_reported', [body.kind]);
      return this.out(tx, await tx.patient.findUniqueOrThrow({ where: { id } }), phone);
    });
  }
  async photo(request: FastifyRequest, actor: Actor, id: string, file?: UploadedFile) {
    const phone = await accountPhone(this.s, actor.userId);
    // Check ownership before doing file-store work, then recheck under the write lock.
    await withTenant(this.s.db, actor.organisationId, (tx) => this.owned(tx, actor, id, phone));
    const image = file ? this.acceptPhoto(file) : null;
    const key = image
      ? `organisations/${actor.organisationId}/patients/${id}/photo-${uniqueSuffix()}.${logoExtension(image.type)}`
      : null;
    let replaced: string | null = null;
    try {
      if (key && file) await this.s.files.put(key, file.data);
      const result = await withTenant(this.s.db, actor.organisationId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM patients WHERE id=${id}::uuid FOR UPDATE`;
        const before = await this.owned(tx, actor, id, phone);
        replaced = before.photoKey;
        const row = await tx.patient.update({
          where: { id },
          data: { photoKey: key, photoMediaType: file?.mediaType ?? null },
        });
        await this.audit(tx, request, actor, id, 'patient.profile_updated', ['photo']);
        return this.out(tx, row, phone);
      });
      if (replaced) await this.removeFile(request, replaced);
      return result;
    } catch (error) {
      // An uncertain commit keeps the referenced file; never break a committed photo.
      try {
        const current = await withTenant(this.s.db, actor.organisationId, (tx) =>
          tx.patient.findUnique({ where: { id }, select: { photoKey: true } }),
        );
        if (key && current?.photoKey !== key) await this.removeFile(request, key);
        else if (current?.photoKey === key && replaced) await this.removeFile(request, replaced);
      } catch {
        /* Storage uncertainty is left for orphan cleanup; no public photo URL exists. */
      }
      throw error;
    }
  }
  async photoBytes(request: FastifyRequest, actor: Actor, id: string) {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const p = await this.owned(tx, actor, id, phone);
      if (!p.photoKey || !p.photoMediaType) throw missing();
      const data = await this.s.files.get(p.photoKey);
      await this.audit(tx, request, actor, id, 'patient.profile_photo_viewed', []);
      return { data, mediaType: p.photoMediaType };
    });
  }
  async confirm(
    request: FastifyRequest,
    actor: Actor & { role: Role },
    id: string,
    kind: 'allergies' | 'conditions' | 'medications' | 'bloodGroup',
    entryId?: string,
    expectedUpdatedAt?: string,
  ) {
    if (actor.role !== 'doctor') throw new AppError(403, 'FORBIDDEN', 'Doctor access required.');
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM patients WHERE id=${id}::uuid FOR UPDATE`;
      const p = await tx.patient.findUnique({ where: { id } });
      if (!p) throw missing();
      assertNotMerged(p);
      await assertChartAccess(tx, actor, id);
      const now = this.s.now();
      const base = {
        organisationId: actor.organisationId,
        patientId: id,
        source: 'doctor' as const,
        recordedByUserId: actor.userId,
      };
      const where = { id: entryId!, patientId: id, source: 'patient' as const, removedAt: null };
      const removed = {
        removedAt: now,
        removedByUserId: actor.userId,
        removedReason: 'Confirmed by doctor; replaced with a doctor entry',
      };
      if (kind === 'bloodGroup') {
        if (p.updatedAt.toISOString() !== expectedUpdatedAt)
          throw new AppError(409, 'CONFLICT', 'This report changed. Reload it before confirming.');
        if (!p.reportedBloodGroup || p.bloodGroupConfirmedAt)
          throw new AppError(409, 'CONFLICT', 'No pending blood group report.');
        await tx.patient.update({
          where: { id },
          data: { bloodGroup: p.reportedBloodGroup, bloodGroupConfirmedAt: now },
        });
      } else if (kind === 'allergies') {
        const e = await tx.allergy.findFirst({ where });
        if (!e) throw missing();
        await tx.allergy.create({
          data: { ...base, substance: e.substance, reaction: e.reaction },
        });
        await tx.allergy.update({ where: { id: e.id }, data: removed });
      } else if (kind === 'conditions') {
        const e = await tx.medicalCondition.findFirst({ where });
        if (!e) throw missing();
        await tx.medicalCondition.create({
          data: { ...base, name: e.name, icd10Code: e.icd10Code },
        });
        await tx.medicalCondition.update({ where: { id: e.id }, data: removed });
      } else {
        const e = await tx.currentMedication.findFirst({ where });
        if (!e) throw missing();
        await tx.currentMedication.create({ data: { ...base, name: e.name, dose: e.dose } });
        await tx.currentMedication.update({ where: { id: e.id }, data: removed });
      }
      await this.audit(tx, request, actor, id, 'patient.medical_basics_confirmed', [
        kind,
        ...(entryId ? [entryId] : []),
      ]);
      return { confirmed: true };
    });
  }
  async doctorBlood(request: FastifyRequest, actor: Actor & { role: Role }, id: string) {
    if (actor.role !== 'doctor') throw new AppError(403, 'FORBIDDEN', 'Doctor access required.');
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const p = await tx.patient.findUnique({ where: { id } });
      if (!p) throw missing();
      await assertChartAccess(tx, actor, id);
      return {
        group: p.reportedBloodGroup,
        pending: !!p.reportedBloodGroup && !p.bloodGroupConfirmedAt,
        updatedAt: p.updatedAt.toISOString(),
      };
    });
  }
  private async out(
    tx: Tx,
    row: Awaited<ReturnType<Tx['patient']['findUniqueOrThrow']>>,
    phone: string,
  ): Promise<PortalProfile> {
    const ids = await historyIds(tx, row.id);
    const where = { patientId: { in: ids }, removedAt: null };
    const entry = (e: { id: string; source: string; createdAt: Date }) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
      recordedByName: null,
    });
    return PortalProfile.parse({
      ...row,
      dob: row.dob?.toISOString().slice(0, 10) ?? null,
      updatedAt: row.updatedAt.toISOString(),
      hasPhoto: !!row.photoKey,
      bloodGroupPending: !!row.reportedBloodGroup && !row.bloodGroupConfirmedAt,
      canChangePhone:
        row.phone === phone && !row.guardianPatientId && adultAt(row.dob, this.s.now()),
      allergies: (await tx.allergy.findMany({ where, orderBy: { createdAt: 'asc' } })).map(entry),
      conditions: (
        await tx.medicalCondition.findMany({ where, orderBy: { createdAt: 'asc' } })
      ).map(entry),
      medications: (
        await tx.currentMedication.findMany({ where, orderBy: { createdAt: 'asc' } })
      ).map(entry),
    });
  }
  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    id: string,
    action: string,
    fields: string[],
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'patient',
      entityId: id,
      metadata: { fields },
    });
  }
  private acceptPhoto(file: UploadedFile) {
    try {
      return acceptLogo(file);
    } catch (error) {
      if (error instanceof AppError)
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Choose a valid still JPEG, PNG or WebP profile photo up to 512 KB.',
          { file: 'invalid_photo' },
        );
      throw error;
    }
  }
  private async removeFile(request: FastifyRequest, key: string) {
    await this.s.files
      .delete(key)
      .catch(() =>
        request.log.error({ patientId: key.split('/')[3] }, 'Profile photo cleanup failed'),
      );
  }
}
