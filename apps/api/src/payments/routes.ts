import { CreateRefundBody, RefundView, RefundVoucher } from '@dhc/contracts';
import { RefundService } from './refunds';
import {
  CreateOnlinePayment,
  OnlinePaymentView,
  PaymentCheckout,
  PublicPayment,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors';
import { authOf, authenticate, requireRole } from '../plugins/authenticate';
import type { Services } from '../services';
import { CashfreeWebhook, CashfreeRefundWebhook, verifyCashfreeSignature } from './cashfree';
import { OnlinePaymentsService } from './service';
const Id = z.object({ id: z.uuid() });
const Token = z.object({ token: z.string().max(180) });
export const onlinePaymentRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const service = new OnlinePaymentsService(services),
    auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole('doctor', 'front_desk', 'clinic_admin')] };
  const billers = { preHandler: [auth, requireRole('doctor', 'front_desk')] };
  app.get('/bills/:id/online-payment', staff, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return OnlinePaymentView.parse(
      await service.view(authOf(request), Id.parse(request.params).id),
    );
  });
  app.post('/bills/:id/online-payment', billers, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return OnlinePaymentView.parse(
      await service.create(
        request,
        authOf(request),
        Id.parse(request.params).id,
        CreateOnlinePayment.parse(request.body).id,
      ),
    );
  });
  for (const action of ['check', 'close'] as const)
    app.post(`/online-payments/:id/${action}`, staff, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return OnlinePaymentView.parse(
        await service.check(
          request,
          authOf(request),
          Id.parse(request.params).id,
          action === 'close',
        ),
      );
    });
  const refunds = new RefundService(services);
  const admin = { preHandler: [auth, requireRole('clinic_admin')] };
  app.get('/bills/:id/refunds', staff, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return RefundView.parse(await refunds.view(authOf(request), Id.parse(request.params).id));
  });
  app.post('/payments/:id/refunds', admin, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return RefundView.parse(
      await refunds.create(
        request,
        authOf(request),
        Id.parse(request.params).id,
        CreateRefundBody.parse(request.body),
      ),
    );
  });
  app.post('/payments/:id/refunds/check', staff, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return RefundView.parse(
      await refunds.sync(request, authOf(request), Id.parse(request.params).id),
    );
  });
  app.post('/refunds/:id/check', staff, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return RefundView.parse(
      await refunds.check(request, authOf(request), Id.parse(request.params).id),
    );
  });
  app.post('/refunds/:id/retry', admin, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return RefundView.parse(
      await refunds.retry(request, authOf(request), Id.parse(request.params).id),
    );
  });
  app.get('/refunds/:id/voucher', staff, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return RefundVoucher.parse(
      await refunds.voucher(request, authOf(request), Id.parse(request.params).id),
    );
  });
  const limited = {
    logLevel: 'silent' as const,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  };
  app.get('/public/payments/:token', limited, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return PublicPayment.parse(
      (await service.publicOrder(Token.parse(request.params).token)).public,
    );
  });
  app.post('/public/payments/:token/checkout', limited, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return PaymentCheckout.parse(
      await service.checkout(request, Token.parse(request.params).token),
    );
  });
  app.post('/public/payments/:token/check', limited, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return PublicPayment.parse(
      await service.publicCheck(request, Token.parse(request.params).token),
    );
  });
};
/** Scoped parser preserves the exact bytes. No raw body, customer or instrument data is stored. */
export const cashfreeWebhookRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 64 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post(
    '/webhooks/cashfree',
    {
      logLevel: 'silent',
      bodyLimit: 64 * 1024,
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!services.cashfree)
        throw new AppError(503, 'BUSINESS_RULE', 'Online payments are not enabled yet.');
      const raw = request.body;
      if (!Buffer.isBuffer(raw)) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid callback.');
      let event;
      try {
        event = z
          .union([CashfreeWebhook, CashfreeRefundWebhook])
          .parse(JSON.parse(raw.toString('utf8')));
      } catch {
        throw new AppError(400, 'VALIDATION_FAILED', 'Invalid payment callback.');
      }
      const service = new OnlinePaymentsService(services),
        mapping = await service.lookup(
          event.type === 'REFUND_STATUS_WEBHOOK'
            ? event.data.refund.order_id
            : event.data.order.order_id,
        );
      if (!mapping) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid payment callback.');
      const row = await service.mappedOrder(mapping.organisation_id, mapping.id);
      const merchant = services.cashfree.merchants[row.organisationId]!;
      if (
        !verifyCashfreeSignature(
          raw,
          request.headers['x-webhook-timestamp'],
          request.headers['x-webhook-signature'],
          merchant.clientSecret,
        )
      )
        throw new AppError(401, 'UNAUTHENTICATED', 'Invalid payment callback.');
      // One bounded database transaction stores the sanitized event and applies its receipt.
      // Only acknowledge after commit; a failed transaction remains retryable by Cashfree.
      if (event.type === 'REFUND_STATUS_WEBHOOK')
        await new RefundService(services).apply(request, row, event.data.refund, undefined, raw);
      else await service.webhook(request, row, event, raw);
      return reply.code(200).send({ received: true });
    },
  );
};
