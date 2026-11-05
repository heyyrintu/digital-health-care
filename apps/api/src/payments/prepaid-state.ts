import type { Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { writeAudit } from '../modules/audit/write';
/** Called under the payment bill lock, in the same transaction as the verified receipt. */
export async function settleBooking(tx: Tx, request: FastifyRequest, orderId: string, now: Date) {
  const hold = await tx.cashfreeBooking.findUnique({
    where: { orderId },
    include: { appointment: true, order: true },
  });
  if (!hold || ['confirmed', 'review'].includes(hold.state)) return;
  const paid = hold.order.status === 'paid',
    terminal = ['expired', 'terminated'].includes(hold.order.status);
  if (!paid && !terminal) return;
  const a = hold.appointment;
  const confirm = paid && hold.state === 'held' && a.status === 'pending' && a.startAt > now;
  const state = confirm ? 'confirmed' : paid ? 'review' : 'released';
  if (hold.state === state) return;
  await tx.cashfreeBooking.update({ where: { id: hold.id }, data: { state } });
  const status = confirm
    ? hold.autoConfirm
      ? 'confirmed'
      : null
    : hold.state === 'held'
      ? 'cancelled'
      : null;
  if (status && a.status === 'pending') {
    await tx.appointment.update({
      where: { id: a.id },
      data: {
        status,
        ...(status === 'cancelled'
          ? {
              cancelReason: paid
                ? 'Booking payment requires clinic review'
                : 'Unpaid reservation closed',
            }
          : {}),
      },
    });
    await tx.appointmentStatusHistory.create({
      data: {
        organisationId: hold.organisationId,
        appointmentId: a.id,
        fromStatus: a.status,
        toStatus: status,
        actorUserId: null,
        at: now,
        note: confirm ? 'Prepayment verified' : 'Reservation released; payment may require review',
      },
    });
  }
  await writeAudit(tx, request, {
    action: `booking.prepaid_${state}`,
    organisationId: hold.organisationId,
    entityType: 'appointment',
    entityId: a.id,
    metadata: { orderId },
  });
}
