import { purgeRightsPhotos } from '../data-rights/closure';
import { randomUUID } from 'node:crypto';
import { withAuth, withTenant } from '@dhc/db';
import type { Services } from '../../services';
/** Hidden unused files only. A crash after deleting bytes is safely retried. */
export async function purgePatientRecords(
  s: Services,
  organisationId: string,
  log?: { warn(obj: object, msg: string): void },
) {
  const now = s.now();
  await withTenant(s.db, organisationId, async (tx) => {
    await tx.patientRecord.updateMany({
      where: { state: 'awaiting_upload', uploadExpiresAt: { lte: now } },
      data: { state: 'deleting', hiddenAt: now, purgeNextAt: now },
    });
  });
  let count = 0;
  for (let i = 0; i < 50; i++) {
    const claim = randomUUID();
    const row = await withTenant(s.db, organisationId, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM patient_records WHERE state='deleting' AND used_at IS NULL AND (purge_next_at IS NULL OR purge_next_at<=${now}) AND (purge_lease_until IS NULL OR purge_lease_until<=${now}) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!rows[0]) return null;
      return tx.patientRecord.update({
        where: { id: rows[0].id },
        data: { purgeClaim: claim, purgeLeaseUntil: new Date(now.getTime() + 60000) },
      });
    });
    if (!row) break;
    try {
      if (row.fileKey) await s.files.delete(row.fileKey);
      await withTenant(s.db, organisationId, async (tx) => {
        const updated = await tx.patientRecord.updateMany({
          where: { id: row.id, state: 'deleting', usedAt: null, purgeClaim: claim },
          data: {
            state: 'deleted',
            fileKey: null,
            detailsCipher: null,
            sha256: null,
            sourceSha256: null,
            purgedAt: s.now(),
            category: 'other',
            recordDate: null,
            appointmentId: null,
            testOrderId: null,
            purgeClaim: null,
            purgeLeaseUntil: null,
          },
        });
        if (updated.count)
          await tx.auditLog.create({
            data: {
              organisationId,
              action: 'record.purged',
              entityType: 'patient_record',
              entityId: row.id,
              at: s.now(),
            },
          });
        count += updated.count;
      });
    } catch {
      log?.warn({ recordId: row.id }, 'Record file deletion failed; will retry');
      await withTenant(s.db, organisationId, (tx) =>
        tx.patientRecord.updateMany({
          where: { id: row.id, purgeClaim: claim, state: 'deleting' },
          data: {
            purgeClaim: null,
            purgeLeaseUntil: null,
            purgeNextAt: new Date(s.now().getTime() + 60000),
          },
        }),
      );
    }
  }
  return count;
}
export function schedulePatientRecordPurge(
  s: Services,
  log: { warn(obj: object, msg: string): void },
) {
  let running: Promise<void> | null = null,
    stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = (async () => {
      let cursor: string | undefined;
      do {
        const orgs = await withAuth(s.db, (tx) =>
          tx.organisation.findMany({
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          }),
        );
        for (const org of orgs) {
          if (stopped) return;
          await purgePatientRecords(s, org.id, log);
          await purgeRightsPhotos(s, org.id);
        }
        cursor = orgs.length === 100 ? orgs.at(-1)!.id : undefined;
      } while (cursor);
    })()
      .catch(() => log.warn({}, 'Patient record deletion sweep failed; will retry'))
      .finally(() => {
        running = null;
      });
  }, 30000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
