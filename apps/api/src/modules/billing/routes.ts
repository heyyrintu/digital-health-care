import {
  Bill,
  BillView,
  CollectionsQuery,
  CollectionsReport,
  CreatePriceListItemBody,
  Payment,
  PriceList,
  PriceListItem,
  Receipt,
  RecordPaymentBody,
  SaveBillBody,
  UpdatePriceListItemBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { BillingService } from './service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Billing and counter payments (PRD §5.6, §3.2): front desk and doctors bill and take
 * payments; clinic admins keep the price list and view bills, receipts and collections.
 */
export const billingRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const billing = new BillingService(services);
  const auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole('front_desk', 'doctor', 'clinic_admin')] };
  const billers = { preHandler: [auth, requireRole('front_desk', 'doctor')] };
  const admin = { preHandler: [auth, requireRole('clinic_admin')] };

  app.get('/price-list', staff, async (request) =>
    PriceList.parse({ data: await billing.priceList(authOf(request)) }),
  );

  app.post('/price-list', admin, async (request, reply) => {
    const body = CreatePriceListItemBody.parse(request.body);
    const item = await billing.createPriceListItem(request, authOf(request), body);
    return reply.status(201).send(PriceListItem.parse(item));
  });

  app.patch('/price-list/:id', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdatePriceListItemBody.parse(request.body);
    return PriceListItem.parse(
      await billing.updatePriceListItem(request, authOf(request), id, body),
    );
  });

  app.get('/appointments/:id/bill', staff, async (request) => {
    const { id } = IdParams.parse(request.params);
    return BillView.parse(await billing.view(authOf(request), id));
  });

  app.put('/appointments/:id/bill', billers, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = SaveBillBody.parse(request.body);
    return Bill.parse(await billing.save(request, authOf(request), id, body));
  });

  app.post('/bills/:id/payments', billers, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = RecordPaymentBody.parse(request.body);
    const { payment, created } = await billing.recordPayment(request, authOf(request), id, body);
    return reply.status(created ? 201 : 200).send(Payment.parse(payment));
  });

  app.get('/payments/:id/receipt', staff, async (request) => {
    const { id } = IdParams.parse(request.params);
    return Receipt.parse(await billing.receipt(request, authOf(request), id));
  });

  app.get('/collections', staff, async (request) => {
    const { date } = CollectionsQuery.parse(request.query);
    return CollectionsReport.parse(await billing.collections(authOf(request), date));
  });
};
