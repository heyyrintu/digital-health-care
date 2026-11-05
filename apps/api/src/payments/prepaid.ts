import type { CreatePrepaidBooking, PrepaidBookingView } from '@dhc/contracts';
import { withPayments, withTenant } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import type { Services } from '../services';
import { PortalBookingService } from '../modules/portal/booking';
import { accountPhone, ownHistory } from '../modules/portal/account';
import { PortalService } from '../modules/portal/service';
import { OnlinePaymentsService } from './service';
interface Actor {
  organisationId: string;
  userId: string;
}
const missing = () => new AppError(404, 'NOT_FOUND', 'Reservation not found.');
export class PrepaidBookingService {
  constructor(private readonly s: Services) {}
  async view(actor: Actor, id: string, providerAvailable = true): Promise<PrepaidBookingView> {
    const phone = await accountPhone(this.s, actor.userId);
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await new PortalService(this.s).requireConsents(tx, actor);
      const h = await tx.cashfreeBooking.findUnique({
        where: { id },
        include: { appointment: true, order: true },
      });
      if (!h) throw missing();
      await ownHistory(tx, phone, h.appointment.patientId);
      return h;
    });
    const view = await new OnlinePaymentsService(this.s).view(actor, row.order.billId);
    const payable =
      row.state === 'held' &&
      row.order.status === 'active' &&
      row.expiresAt > this.s.now() &&
      this.s.cashfree?.acceptNewPayments !== false;
    return {
      id: row.id,
      appointmentId: row.appointmentId,
      appointmentStatus: row.appointment.status,
      state: row.state as PrepaidBookingView['state'],
      expiresAt: row.expiresAt.toISOString(),
      amountPaise: row.order.amountPaise,
      orderStatus: row.order.status as PrepaidBookingView['orderStatus'],
      paymentUrl: payable ? (view.order?.paymentUrl ?? null) : null,
      providerAvailable,
    };
  }
  async create(request: FastifyRequest, actor: Actor, body: CreatePrepaidBooking) {
    await new PortalBookingService(this.s).book(request, actor, body, body.id);
    // The reservation survives unknown provider answers; always return its recoverable ID.
    let available = true;
    try {
      await new OnlinePaymentsService(this.s).ensureBooking(request, actor.organisationId, body.id);
    } catch {
      available = false;
    }
    return this.view(actor, body.id, available);
  }
  async check(request: FastifyRequest, actor: Actor, id: string, close = false) {
    await this.view(actor, id);
    const claim = await withPayments(this.s.db, actor.organisationId, (tx) =>
      tx.cashfreeBooking.updateMany({
        where: { id, state: 'held', nextCheckAt: { lte: this.s.now() } },
        data: { nextCheckAt: new Date(this.s.now().getTime() + 60000) },
      }),
    );
    if (!claim.count) return this.view(actor, id);
    let available = true;
    try {
      const payments = new OnlinePaymentsService(this.s);
      if (!close) await payments.ensureBooking(request, actor.organisationId, id);
      await payments.check(
        request,
        actor,
        id,
        close || (await this.view(actor, id)).expiresAt <= this.s.now().toISOString(),
      );
    } catch {
      available = false;
    }
    // Interactive checks can run again in 5 seconds. Crashes retain the 60 second lease.
    await withPayments(this.s.db, actor.organisationId, (tx) =>
      tx.cashfreeBooking.updateMany({
        where: { id, state: 'held' },
        data: { nextCheckAt: new Date(this.s.now().getTime() + 5000) },
      }),
    );
    return this.view(actor, id, available);
  }
}
/** Uses the API's existing verified payment processor; one durable claim per hold. */
export async function sweepPrepaidBookings(s: Services) {
  if (!s.cashfree) return;
  const source = {
    id: `prepaid-sweep-${randomUUID()}`,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'prepaid-booking-sweep' },
  } as FastifyRequest;
  for (const organisationId of Object.keys(s.cashfree.merchants)) {
    const due = await withPayments(s.db, organisationId, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; created_by_user_id: string }[]
      >`SELECT id,created_by_user_id FROM cashfree_bookings WHERE state='held' AND expires_at<=${s.now()} AND next_check_at<=${s.now()} ORDER BY next_check_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
      if (rows.length)
        await tx.cashfreeBooking.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { nextCheckAt: new Date(s.now().getTime() + 120000) },
        });
      return rows;
    });
    for (const h of due) {
      try {
        await new OnlinePaymentsService(s).check(
          source,
          { organisationId, userId: h.created_by_user_id },
          h.id,
          true,
        );
      } catch {
        /* Keep uncertain holds and retry; never infer closure from local time. */
      }
    }
  }
}
export function schedulePrepaidSweep(s: Services) {
  let active: Promise<void> | undefined,
    stopping = false;
  const tick = () => {
    if (stopping || active || !s.cashfree) return;
    active = sweepPrepaidBookings(s)
      .catch(() => {
        console.error('Booking payment sweep unavailable; reservations retained');
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 30000);
  timer.unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await active;
  };
}
