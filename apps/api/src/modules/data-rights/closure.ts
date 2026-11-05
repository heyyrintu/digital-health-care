import { withAuth, withTenant, Prisma, type Tx } from '@dhc/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ClosureView } from '@dhc/contracts';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { accountPhone, accountHistoryWhere } from '../portal/account';
import { AuthService } from '../auth/service';
import { revokePushDevicesForSessions } from '../devices/revoke';
import { requirePatientAccountOpen } from './access';
import { DataRightsService, missing, type RightsActor } from './service';
async function tenant<T>(tx: Tx, a: RightsActor, run: () => Promise<T>) {
  await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_app');
  await tx.$executeRaw`SELECT set_config('app.organisation_id',${a.organisationId},true)`;
  try {
    return await run();
  } finally {
    await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_auth');
  }
}
const out = (r: {
  id: string;
  challengeId: string | null;
  expiresAt: Date;
  confirmedAt: Date | null;
}) =>
  ClosureView.parse({
    id: r.id,
    ready: !!r.challengeId,
    expiresAt: r.expiresAt.toISOString(),
    closedAt: r.confirmedAt?.toISOString() ?? null,
  });
export class AccountClosureService {
  constructor(readonly s: Services) {}
  async start(req: FastifyRequest, a: RightsActor, id: string) {
    const phone = await accountPhone(this.s, a.userId);
    await withTenant(this.s.db, a.organisationId, (tx) => requirePatientAccountOpen(tx, a));
    const prepared = await withAuth(this.s.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`closure:${a.userId}`},0))`;
      const prior = await tx.accountClosureAttempt.findUnique({ where: { id } });
      if (prior) {
        if (prior.userId !== a.userId || prior.organisationId !== a.organisationId) throw missing();
        return { prior, slug: null };
      }
      if (
        (await tx.accountClosureAttempt.count({
          where: {
            userId: a.userId,
            createdAt: { gt: new Date(this.s.now().getTime() - 3600000) },
          },
        })) >= 3
      )
        throw new AppError(429, 'RATE_LIMITED', 'Too many closure attempts. Please try later.');
      await tx.accountClosureAttempt.create({
        data: {
          id,
          userId: a.userId,
          organisationId: a.organisationId,
          createdAt: this.s.now(),
          expiresAt: new Date(this.s.now().getTime() + 300000),
        },
      });
      return {
        prior: null,
        slug: (await tx.organisation.findUniqueOrThrow({ where: { id: a.organisationId } })).slug,
      };
    });
    if (prepared.prior) return out(prepared.prior);
    const otp = await new AuthService(this.s).requestOtp(
      req,
      prepared.slug!,
      phone,
      'account_close',
    );
    return withAuth(this.s.db, async (tx) =>
      out(
        await tx.accountClosureAttempt.update({
          where: { id },
          data: { challengeId: otp.challengeId, expiresAt: new Date(otp.expiresAt) },
        }),
      ),
    );
  }
  async verify(req: FastifyRequest, a: RightsActor, id: string, code: string) {
    const result = await withAuth(this.s.db, async (tx) => {
      await tenant(tx, a, () => requirePatientAccountOpen(tx, a, true));
      await tx.$queryRaw`SELECT id FROM account_closure_attempts WHERE id=${id}::uuid FOR UPDATE`;
      const r = await tx.accountClosureAttempt.findUnique({ where: { id } });
      if (!r || r.userId !== a.userId || r.organisationId !== a.organisationId) throw missing();
      const now = this.s.now();
      if (!r.challengeId || r.expiresAt <= now) return null;
      await tx.$queryRaw`SELECT id FROM otp_challenges WHERE id=${r.challengeId}::uuid FOR UPDATE`;
      const c = await tx.otpChallenge.findUnique({ where: { id: r.challengeId } }),
        u = await tx.user.findUnique({ where: { id: a.userId } });
      if (
        !c ||
        c.purpose !== 'account_close' ||
        c.organisationId !== a.organisationId ||
        c.phone !== u?.phone ||
        c.consumedAt ||
        c.expiresAt <= now ||
        c.attempts >= 5 ||
        u.status !== 'active'
      )
        return null;
      const hash = Buffer.from(this.s.hashOtp(c.id, code)),
        expected = Buffer.from(c.codeHash);
      if (hash.length !== expected.length || !timingSafeEqual(hash, expected)) {
        await tx.otpChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
        return null;
      }
      await tenant(tx, a, async () => {
        const people = await tx.patient.findMany({
            where: accountHistoryWhere(u.phone!),
            select: { id: true, photoKey: true },
          }),
          ids = people.map((p) => p.id);
        const records = await tx.patientRecord.findMany({
            where: { patientId: { in: ids } },
            select: { id: true },
            orderBy: { id: 'asc' },
          }),
          recordIds = records.map((r) => r.id);
        if (recordIds.length)
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM patient_records WHERE id IN (${Prisma.join(recordIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
          );
        await tx.patientRecordShare.updateMany({
          where: {
            revokedAt: null,
            OR: [{ createdByUserId: a.userId }, { recordId: { in: recordIds } }],
          },
          data: { revokedAt: now, tokenCipher: null },
        });
        await tx.patientRecord.updateMany({
          where: {
            id: { in: recordIds },
            usedAt: null,
            state: { in: ['ready', 'awaiting_upload'] },
          },
          data: { state: 'deleting', hiddenAt: now, purgeNextAt: now, revision: { increment: 1 } },
        });
        await tx.patientRecord.updateMany({
          where: { id: { in: recordIds }, usedAt: { not: null } },
          data: { hiddenAt: now },
        });
        for (const p of people)
          if (p.photoKey)
            await tx.rightsFileDeletion.upsert({
              where: { fileKey: p.photoKey },
              create: { organisationId: a.organisationId, fileKey: p.photoKey, nextAt: now },
              update: {},
            });
        await tx.patient.updateMany({
          where: { id: { in: ids } },
          data: { portalClosedAt: now, photoKey: null, photoMediaType: null },
        });
        const inboxChannels = await tx.inboxChannel.findMany({ select: { senderId: true } });
        for (const channel of inboxChannels) {
          const contactKey = this.s.inboxContactKey(channel.senderId, u.phone!);
          const threads = await tx.inboxThread.findMany({
            where: { senderId: channel.senderId, contactKey },
            select: { id: true },
          });
          const threadIds = threads.map((t) => t.id);
          await tx.inboxThread.updateMany({
            where: { id: { in: threadIds } },
            data: {
              stoppedAt: now,
              optedInAt: null,
              optInSource: null,
              revision: { increment: 1 },
              updatedAt: now,
            },
          });
          await tx.inboxMessage.updateMany({
            where: { threadId: { in: threadIds }, state: 'queued' },
            data: { state: 'skipped', statusAt: now },
          });
        }
        await tx.accountConsent.updateMany({
          where: { userId: a.userId, withdrawnAt: null },
          data: { withdrawnAt: now },
        });
        await tx.whatsAppOptIn.updateMany({
          where: { phone: u.phone!, enabled: true },
          data: {
            enabled: false,
            version: { increment: 1 },
            changedAt: now,
            changedByUserId: a.userId,
          },
        });
        await tx.membership.updateMany({
          where: { userId: a.userId, role: 'patient' },
          data: { status: 'revoked' },
        });
        await tx.patientAccountAccess.update({
          where: { organisationId_userId: { organisationId: a.organisationId, userId: a.userId } },
          data: { closedAt: now },
        });
        await tx.dataRightsRequest.create({
          data: {
            id,
            organisationId: a.organisationId,
            userId: a.userId,
            kind: 'account_closure',
            area: 'account',
            state: 'fulfilled',
            detailsCipher: this.s.cipher.encrypt(
              JSON.stringify({
                scope: 'current_clinic_patient_login_and_family_profiles',
                retention:
                  'Clinical and financial records retained; appointments are not cancelled.',
              }),
            ),
            createdAt: now,
          },
        });
        await new DataRightsService(this.s).event(tx, req, a, id, 'account_closed');
      });
      await tx.otpChallenge.update({ where: { id: c.id }, data: { consumedAt: now } });
      const sessions = await tx.session.findMany({
        where: {
          organisationId: a.organisationId,
          userId: a.userId,
          role: 'patient',
          revokedAt: null,
        },
        select: { id: true },
      });
      await revokePushDevicesForSessions(
        tx,
        sessions.map((s) => s.id),
        'account_closed',
        now,
      );
      await tx.session.updateMany({
        where: { id: { in: sessions.map((s) => s.id) } },
        data: { revokedAt: now, revokedReason: 'account_closed' },
      });
      return out(
        await tx.accountClosureAttempt.update({ where: { id }, data: { confirmedAt: now } }),
      );
    });
    if (!result)
      throw new AppError(400, 'VALIDATION_FAILED', 'The closure code is invalid or expired.', {
        code: 'invalid',
      });
    return result;
  }
}
/** Private profile photos have a durable retry queue, separate from retained care files. */
export async function purgeRightsPhotos(s: Services, organisationId: string) {
  const rows = await withTenant(s.db, organisationId, (tx) =>
    tx.rightsFileDeletion.findMany({ where: { doneAt: null, nextAt: { lte: s.now() } }, take: 50 }),
  );
  for (const r of rows) {
    try {
      await s.files.delete(r.fileKey);
      await withTenant(s.db, organisationId, (tx) =>
        tx.rightsFileDeletion.update({ where: { id: r.id }, data: { doneAt: s.now() } }),
      );
    } catch {
      await withTenant(s.db, organisationId, (tx) =>
        tx.rightsFileDeletion.update({
          where: { id: r.id },
          data: { nextAt: new Date(s.now().getTime() + 60000) },
        }),
      );
    }
  }
}
