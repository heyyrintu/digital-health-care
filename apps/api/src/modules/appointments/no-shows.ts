import { randomUUID } from 'node:crypto';
import { withAuth, withTenant } from '@dhc/db';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';
import { publishQueueChanged, type QueueChanged } from '../queue/live';
import { DEFAULT_BOOKING_RULES } from '../scheduling/settings';

/** Bookings closed per clinic per run; the next run picks up any more. */
const BATCH = 500;

const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Automatic no-shows (PRD §5.2): a booking still pending or confirmed once its slot has
 * ended and the clinic's grace period (booking rules) has passed becomes a no-show, with
 * no staff member as the actor. No-shows do not hold their slot, so it is free again.
 * Rows are taken with SKIP LOCKED and re-checked under the lock, so it is safe to run on
 * every API instance at once and never races a check-in.
 */
export async function sweepNoShows(
  s: Pick<Services, 'db' | 'now'>,
  source: AuditSource,
): Promise<number> {
  const organisations = await withAuth(s.db, (tx) =>
    tx.organisation.findMany({ where: { status: 'active' }, select: { id: true } }),
  );
  let total = 0;
  for (const { id } of organisations) {
    total += await sweepOrganisation(s, source, id);
  }
  return total;
}

export async function sweepOrganisation(
  s: Pick<Services, 'db' | 'now'>,
  source: AuditSource,
  organisationId: string,
): Promise<number> {
  const now = s.now();
  const events: QueueChanged[] = [];
  await withTenant(s.db, organisationId, async (tx) => {
    const rules = await tx.bookingRules.findUnique({
      where: { organisationId },
      select: { noShowAfterMinutes: true },
    });
    const grace = rules ? rules.noShowAfterMinutes : DEFAULT_BOOKING_RULES.noShowAfterMinutes;
    if (grace === null) return;
    const cutoff = new Date(now.getTime() - grace * 60_000);
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM appointments
      WHERE status IN ('pending', 'confirmed') AND end_at <= ${cutoff}
      ORDER BY end_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED`;
    for (const { id } of due) {
      const appointment = await tx.appointment.findUnique({ where: { id } });
      if (!appointment || !['pending', 'confirmed'].includes(appointment.status)) continue;
      await tx.appointment.update({ where: { id }, data: { status: 'no_show' } });
      await tx.appointmentStatusHistory.create({
        data: {
          organisationId,
          appointmentId: id,
          fromStatus: appointment.status,
          toStatus: 'no_show',
          actorUserId: null,
          note: `Not checked in ${grace} minutes after the slot ended.`,
          at: now,
        },
      });
      await writeAudit(tx, source, {
        action: 'appointment.status_changed',
        organisationId,
        actorUserId: null,
        entityType: 'appointment',
        entityId: id,
        metadata: { from: appointment.status, to: 'no_show', automatic: true },
      });
      events.push({
        type: 'queue.changed',
        organisationId,
        date: fromDbDate(appointment.date),
        clinicId: appointment.clinicId,
        doctorUserId: appointment.doctorUserId,
        appointmentId: id,
        reason: 'no_show',
      });
    }
  });
  events.forEach(publishQueueChanged);
  return events.length;
}

/**
 * Runs the sweep every `seconds` (0 turns it off). Returns a stop function. A run that
 * fails is logged and the next one tries again; runs never overlap.
 */
export function scheduleNoShowSweep(
  s: Pick<Services, 'db' | 'now'>,
  seconds: number,
  log: { info(obj: object, msg: string): void; error(obj: object, msg: string): void },
): () => void {
  if (seconds === 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const source = {
      id: `no-show-sweep-${randomUUID()}`,
      ip: 'scheduler',
      headers: { 'user-agent': 'no-show-sweep' },
    };
    sweepNoShows(s, source)
      .then((count) => {
        if (count > 0) log.info({ count }, 'Marked bookings as no-shows');
      })
      .catch((err: unknown) => log.error({ err }, 'No-show sweep failed'))
      .finally(() => {
        running = false;
      });
  }, seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
