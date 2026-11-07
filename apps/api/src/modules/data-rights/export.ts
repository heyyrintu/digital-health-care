import { withTenant } from '@dhc/db';
import { AssessmentDefinition, AssessmentResult, ConsultationNotes } from '@dhc/contracts';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { accountPhone, ownPatient, ownHistory } from '../portal/account';
import { historyIds } from '../patients/merged';
import { SigningService } from '../prescribing/signing';
import { requirePatientAccountOpen } from './access';
import { DataRightsService, conflict, type RightsActor } from './service';
import { makeDataZip } from './zip';
const active = new Set<string>();
/** Held through the HTTP response's close/finish, bounding retained archive buffers. */
export function claimExport(a: RightsActor) {
  const key = `${a.organisationId}:${a.userId}`;
  if (active.has(key) || active.size >= 2)
    throw new AppError(409, 'CONFLICT', 'A download is already running. Please try again shortly.');
  active.add(key);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active.delete(key);
    }
  };
}
const cap = <T>(rows: T[]) => {
  if (rows.length > 2000) throw new Error('EXPORT_LIMIT');
  return rows;
};
export class DataExportService {
  constructor(readonly s: Services) {}
  async build(req: FastifyRequest, a: RightsActor, b: { id: string; patientId: string }) {
    const phone = await accountPhone(this.s, a.userId),
      rights = new DataRightsService(this.s);
    await withTenant(this.s.db, a.organisationId, async (tx) => {
      await requirePatientAccountOpen(tx, a);
      await ownPatient(tx, phone, b.patientId);
      const prior = await tx.dataRightsRequest.findUnique({ where: { id: b.id } });
      if (prior) {
        if (prior.kind !== 'export' || prior.patientId !== b.patientId || prior.userId !== a.userId)
          throw conflict();
        if (!['fulfilled', 'processing', 'failed'].includes(prior.state)) throw conflict();
        if (prior.state !== 'fulfilled')
          await tx.dataRightsRequest.update({
            where: { id: b.id },
            data: { state: 'processing', revision: { increment: 1 } },
          });
        return;
      }
      if (
        (await tx.dataRightsRequest.count({
          where: {
            userId: a.userId,
            kind: 'export',
            createdAt: { gt: new Date(this.s.now().getTime() - 3600000) },
          },
        })) >= 5
      )
        throw new AppError(429, 'RATE_LIMITED', 'Too many downloads. Please try later.');
      await tx.dataRightsRequest.create({
        data: {
          id: b.id,
          organisationId: a.organisationId,
          userId: a.userId,
          patientId: b.patientId,
          kind: 'export',
          area: 'account',
          state: 'processing',
          detailsCipher: this.s.cipher.encrypt(JSON.stringify({ scope: 'patient_facing_records' })),
          createdAt: this.s.now(),
        },
      });
      await rights.event(tx, req, a, b.id, 'export_requested');
    });
    try {
      const snapshot = await withTenant(this.s.db, a.organisationId, async (tx) => {
        await requirePatientAccountOpen(tx, a);
        await ownPatient(tx, phone, b.patientId);
        const ids = await historyIds(tx, b.patientId),
          where = { patientId: { in: ids } },
          take = 2001;
        const profiles = cap(
          await tx.patient.findMany({
            where: { id: { in: ids } },
            take,
            select: {
              id: true,
              uhid: true,
              name: true,
              phone: true,
              dob: true,
              gender: true,
              email: true,
              address: true,
              language: true,
              bloodGroup: true,
              reportedBloodGroup: true,
              emergencyContactName: true,
              emergencyContactPhone: true,
              guardianPatientId: true,
              mergedIntoId: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
        );
        const photos = await tx.patient.findMany({
          where: { id: { in: ids }, photoKey: { not: null } },
          select: { id: true, photoKey: true, photoMediaType: true },
          take,
        });
        const consents = cap(
          await tx.accountConsent.findMany({
            where: { userId: a.userId },
            select: { kind: true, version: true, acceptedAt: true, withdrawnAt: true },
            take,
          }),
        );
        const requests = cap(
          await tx.dataRightsRequest.findMany({
            where: { userId: a.userId, patientId: { in: ids } },
            take,
          }),
        ).map((r) => ({
          id: r.id,
          kind: r.kind,
          area: r.area,
          state: r.state,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          details: JSON.parse(this.s.cipher.decrypt(r.detailsCipher)),
          response: r.responseCipher ? this.s.cipher.decrypt(r.responseCipher) : null,
          policyReference: r.policyReference,
        }));
        const appointments = cap(
          await tx.appointment.findMany({
            where,
            take,
            select: {
              id: true,
              patientId: true,
              doctorUserId: true,
              date: true,
              status: true,
              createdAt: true,
            },
          }),
        );
        const consultations = cap(
          await tx.consultation.findMany({ where: { ...where, lockedAt: { not: null } }, take }),
        ).map((c) => ({
          id: c.id,
          patientId: c.patientId,
          appointmentId: c.appointmentId,
          doctorUserId: c.doctorUserId,
          followUpDate: c.followUpDate,
          updatedAt: c.updatedAt,
          notes: ConsultationNotes.omit({ privateNotes: true }).parse(
            JSON.parse(this.s.cipher.decrypt(c.notesCipher)),
          ),
        }));
        const prescriptions = cap(
          await tx.prescription.findMany({
            where: { ...where, status: { not: 'draft' } },
            take,
            select: {
              id: true,
              patientId: true,
              appointmentId: true,
              number: true,
              version: true,
              status: true,
              signedAt: true,
              amendsPrescriptionId: true,
            },
          }),
        );
        const allergies = cap(await tx.allergy.findMany({ where, take })),
          conditions = cap(await tx.medicalCondition.findMany({ where, take })),
          medications = cap(await tx.currentMedication.findMany({ where, take }));
        const vitals = cap(
          await tx.vitals.findMany({ where: { appointment: { patientId: { in: ids } } }, take }),
        );
        const bills = cap(
          await tx.bill.findMany({
            where,
            take,
            select: {
              id: true,
              patientId: true,
              appointmentId: true,
              totalPaise: true,
              discountPaise: true,
              paidPaise: true,
              status: true,
              items: { select: { name: true, unitPaise: true, quantity: true, amountPaise: true } },
              payments: {
                select: {
                  id: true,
                  mode: true,
                  amountPaise: true,
                  receiptNumber: true,
                  receivedAt: true,
                },
              },
              refundEntries: { select: { refundId: true, amountPaise: true, postedAt: true } },
            },
          }),
        );
        const orders = cap(
          await tx.testOrder.findMany({
            where: { ...where, orderedAt: { not: null } },
            take,
            include: { results: true },
          }),
        );
        const records = cap(
          await tx.patientRecord.findMany({ where: { ...where, state: 'ready' }, take }),
        );
        const letters = cap(
          await tx.referralLetter.findMany({
            where: { referral: { patientId: { in: ids } } },
            take,
            select: {
              id: true,
              referralId: true,
              pdfFileKey: true,
              pdfSha256: true,
              signedAt: true,
            },
          }),
        );
        const documents = cap(
          await tx.patientDocument.findMany({
            where: { ...where, withdrawnAt: null },
            take,
            include: { file: true },
          }),
        );
        const assessments = [];
        const assessmentRows = cap(await tx.patientAssessment.findMany({ where, take }));
        const assessmentForms = new Map(
          (
            await tx.assessmentForm.findMany({
              where: { id: { in: [...new Set(assessmentRows.map((r) => r.formId))] } },
            })
          ).map((f) => [f.id, f]),
        );
        for (const row of assessmentRows) {
          const form = assessmentForms.get(row.formId);
          if (!form) throw new Error('EXPORT_ASSESSMENT_INTEGRITY');
          assessments.push({
            id: row.id,
            patientId: row.patientId,
            formId: row.formId,
            definition: AssessmentDefinition.parse(form.definition),
            state: row.state,
            createdAt: row.createdAt,
            submittedAt: row.submittedAt,
            result: row.resultCipher
              ? AssessmentResult.parse(JSON.parse(this.s.cipher.decrypt(row.resultCipher)))
              : null,
          });
        }
        const reviewRequests = cap(
          await tx.reviewRequest.findMany({
            where,
            take,
            select: {
              id: true,
              appointmentId: true,
              patientId: true,
              createdAt: true,
              expiresAt: true,
              cancelledAt: true,
              openedAt: true,
            },
          }),
        );
        const reviewConsent = await tx.whatsAppOptIn.findMany({
          where: { category: 'reviews', changedByUserId: a.userId },
          select: {
            enabled: true,
            version: true,
            changedAt: true,
            phone: true,
            senderPhoneNumberId: true,
          },
          take,
        });
        return {
          profiles,
          reviewRequests,
          reviewConsent,
          assessments,
          photos,
          consents,
          requests,
          appointments,
          consultations,
          prescriptions,
          allergies,
          conditions,
          medications,
          vitals,
          bills,
          orders,
          records,
          letters,
          documents,
        };
      });
      const entries: { name: string; data: Buffer }[] = [];
      let bytes = 0;
      const add = (name: string, data: Buffer) => {
        bytes += data.length;
        if (entries.length >= 299 || bytes > 50 * 1048576) throw new Error('EXPORT_LIMIT');
        entries.push({ name, data });
      };
      const file = async (name: string, key: string, hash: string) => {
        const data = await this.s.files.get(key);
        if (createHash('sha256').update(data).digest('hex') !== hash)
          throw new Error('EXPORT_FILE_INTEGRITY');
        add(name, data);
        return name;
      };
      const extension = (type: string) =>
        type === 'application/pdf'
          ? 'pdf'
          : type === 'image/jpeg'
            ? 'jpg'
            : type === 'image/png'
              ? 'png'
              : 'bin';
      for (const p of snapshot.prescriptions) {
        const f = await new SigningService(this.s).pdf(req, a, p.id, async (tx, patientId) => {
          await requirePatientAccountOpen(tx, a);
          await ownHistory(tx, phone, patientId);
        });
        add(`prescriptions/${p.id}.pdf`, f.file);
      }
      const photos = [];
      for (const p of snapshot.photos) {
        const data = await this.s.files.get(p.photoKey!);
        if (data.length > 524288) throw new Error('EXPORT_FILE_INTEGRITY');
        const name = `profiles/${p.id}.${extension(p.photoMediaType ?? 'image/jpeg')}`;
        add(name, data);
        photos.push({ patientId: p.id, file: name });
      }
      const records = [];
      for (const r of snapshot.records) {
        if (!r.fileKey || !r.sha256 || !r.mediaType) throw new Error('EXPORT_FILE_INTEGRITY');
        records.push({
          id: r.id,
          patientId: r.patientId,
          category: r.category,
          recordDate: r.recordDate,
          usedAt: r.usedAt,
          hiddenAt: r.hiddenAt,
          details: r.detailsCipher ? JSON.parse(this.s.cipher.decrypt(r.detailsCipher)) : null,
          file: await file(`records/${r.id}.${extension(r.mediaType)}`, r.fileKey, r.sha256),
        });
      }
      const orders = [];
      for (const o of snapshot.orders) {
        const results = [];
        for (const r of o.results)
          results.push({
            id: r.id,
            uploadedAt: r.uploadedAt,
            file: await file(`results/${r.id}.${extension(r.mediaType)}`, r.fileKey, r.sha256),
          });
        orders.push({
          id: o.id,
          patientId: o.patientId,
          name: o.name,
          kind: o.kind,
          status: o.status,
          orderedAt: o.orderedAt,
          results,
        });
      }
      const letters = [];
      for (const l of snapshot.letters)
        letters.push({
          id: l.id,
          referralId: l.referralId,
          signedAt: l.signedAt,
          file: await file(`referrals/${l.id}.pdf`, l.pdfFileKey, l.pdfSha256),
        });
      const documents = [];
      for (const d of snapshot.documents)
        documents.push({
          id: d.id,
          title: d.title,
          note: d.note,
          sharedAt: d.sharedAt,
          file: await file(
            `documents/${d.id}.${extension(d.file.mediaType)}`,
            d.file.fileKey,
            d.file.sha256,
          ),
        });
      const {
        photos: _p,
        records: _r,
        orders: _o,
        letters: _l,
        documents: _d,
        ...metadata
      } = snapshot;
      add(
        'data.json',
        Buffer.from(
          JSON.stringify(
            {
              formatVersion: 1,
              requestId: b.id,
              generatedAt: this.s.now().toISOString(),
              ...metadata,
              photos,
              records,
              orders,
              letters,
              documents,
            },
            null,
            2,
          ),
        ),
      );
      add(
        'README.txt',
        Buffer.from(
          'Patient-facing records for the selected patient and merged history at this clinic. Files are private: store this download safely. Clinician private notes, drafts, withdrawn clinic documents, deleted uploads and internal provider/security data are excluded. Ask the clinic for a reviewed access request for other material. This download is a fresh snapshot; a retry may include newer records.\n',
        ),
      );
      const zip = makeDataZip(entries);
      await withTenant(this.s.db, a.organisationId, async (tx) => {
        await requirePatientAccountOpen(tx, a);
        const currentPhone = await accountPhone(this.s, a.userId);
        await ownPatient(tx, currentPhone, b.patientId);
        for (const p of snapshot.profiles) await ownHistory(tx, currentPhone, p.id);
        const r = await tx.dataRightsRequest.findUniqueOrThrow({ where: { id: b.id } });
        if (r.state !== 'fulfilled')
          await tx.dataRightsRequest.update({
            where: { id: b.id },
            data: { state: 'fulfilled', revision: { increment: 1 } },
          });
        await rights.event(tx, req, a, b.id, 'export_prepared');
      });
      return zip;
    } catch (e) {
      await withTenant(this.s.db, a.organisationId, async (tx) => {
        const r = await tx.dataRightsRequest.findUniqueOrThrow({ where: { id: b.id } });
        if (r.state !== 'fulfilled') {
          await tx.dataRightsRequest.update({
            where: { id: b.id },
            data: {
              state: 'failed',
              responseCipher: this.s.cipher.encrypt(
                e instanceof Error && e.message === 'EXPORT_LIMIT'
                  ? 'This export exceeds the online limit. Contact the clinic with this reference for assistance.'
                  : 'The download could not be completed. Please retry or contact the clinic.',
              ),
              revision: { increment: 1 },
            },
          });
          await rights.event(tx, req, a, b.id, 'export_failed');
        }
      });
      if (e instanceof AppError) throw e;
      throw new AppError(
        409,
        'CONFLICT',
        e instanceof Error && e.message === 'EXPORT_LIMIT'
          ? 'This export exceeds the online limit. Contact the clinic with this reference.'
          : 'The download could not be completed. Please retry or contact the clinic.',
      );
    }
  }
}
