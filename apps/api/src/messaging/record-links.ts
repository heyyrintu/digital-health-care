import { PortalReferralLetters, RecordLinkTarget } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { verifyRecordLinkToken } from '@dhc/secure-links';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors';
import { authOf, authenticate, requireRole } from '../plugins/authenticate';
import type { Services } from '../services';
import { accountHistoryWhere, accountPhone, ownHistory } from '../modules/portal/account';
import { PortalService } from '../modules/portal/service';
import { sendPdf } from '../modules/prescribing/routes';
import { sha256 } from '../modules/prescribing/signing';
import { writeAudit } from '../modules/audit/write';

const missing = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'This record link is unavailable. Open your records from the patient portal.',
  );
export const recordLinkRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services: s },
) => {
  const patient = { preHandler: [authenticate(s), requireRole('patient')] };
  const portal = new PortalService(s);
  app.get(
    '/portal/record-links/:token',
    { ...patient, logLevel: 'silent' },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      const { token } = z.object({ token: z.string().max(180) }).parse(request.params);
      const verified = s.recordLinkSecret
        ? verifyRecordLinkToken(token, s.recordLinkSecret, s.now())
        : null;
      if (!verified) throw missing();
      const actor = authOf(request),
        phone = await accountPhone(s, actor.userId);
      return withTenant(s.db, actor.organisationId, async (tx) => {
        await portal.requireConsents(tx, actor);
        const d = await tx.whatsAppDelivery.findUnique({ where: { id: verified.deliveryId } });
        if (
          !d?.recipientPatientId ||
          !d.linkExpiresAt ||
          Math.floor(d.linkExpiresAt.getTime() / 1000) !== verified.expiresAt ||
          !d.attemptedAt
        )
          throw missing();
        await ownHistory(tx, phone, d.recipientPatientId);
        let sourceId: string | null = null;
        let mediaType = 'application/pdf';
        if (d.kind === 'prescription_ready' && d.prescriptionId) {
          const row = await tx.prescription.findUnique({ where: { id: d.prescriptionId } });
          if (
            row?.status === 'signed' &&
            !row.supersededAt &&
            !row.voidedAt &&
            row.patientId === d.recipientPatientId
          )
            sourceId = row.id;
        } else if (d.kind === 'document_ready' && d.patientDocumentId) {
          const row = await tx.patientDocument.findUnique({
            where: { id: d.patientDocumentId },
            include: { file: true },
          });
          if (row && !row.withdrawnAt && row.patientId === d.recipientPatientId) {
            sourceId = row.id;
            mediaType = row.file.mediaType;
          }
        } else if (d.kind === 'referral_ready' && d.referralLetterId) {
          const row = await tx.referralLetter.findUnique({
            where: { id: d.referralLetterId },
            include: { referral: true },
          });
          if (row?.referral.patientId === d.recipientPatientId) sourceId = row.id;
        }
        if (!sourceId) throw missing();
        return RecordLinkTarget.parse({ kind: d.kind, sourceId, mediaType });
      });
    },
  );
  app.get('/portal/referral-letters', patient, async (request) => {
    const actor = authOf(request),
      phone = await accountPhone(s, actor.userId);
    const query = z
      .object({
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    return withTenant(s.db, actor.organisationId, async (tx) => {
      await portal.requireConsents(tx, actor);
      const rows = await tx.referralLetter.findMany({
        where: {
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
          referral: { patient: accountHistoryWhere(phone) },
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include: { referral: { include: { patient: { include: { mergedInto: true } } } } },
      });
      return PortalReferralLetters.parse({
        data: rows.slice(0, query.limit).map((r) => ({
          id: r.id,
          patientName: (r.referral.patient.mergedInto ?? r.referral.patient).name,
          signedAt: r.signedAt.toISOString(),
        })),
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      });
    });
  });
  app.get('/portal/referral-letters/:id/pdf', patient, async (request, reply) => {
    const actor = authOf(request),
      phone = await accountPhone(s, actor.userId);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const result = await withTenant(s.db, actor.organisationId, async (tx) => {
      await portal.requireConsents(tx, actor);
      const row = await tx.referralLetter.findUnique({
        where: { id },
        include: { referral: true },
      });
      if (!row) throw missing();
      await ownHistory(tx, phone, row.referral.patientId);
      const file = await s.files.get(row.pdfFileKey);
      if (sha256(file).toString('hex') !== row.pdfSha256)
        throw new Error('Stored referral PDF integrity check failed');
      await writeAudit(tx, request, {
        action: 'referral.letter_viewed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'referral',
        entityId: row.referralId,
        metadata: { letterId: row.id, by: 'patient_portal' },
      });
      return { file, filename: `referral-letter-${row.signedAt.toISOString().slice(0, 10)}.pdf` };
    });
    return sendPdf(reply, result.file, result.filename);
  });
};
