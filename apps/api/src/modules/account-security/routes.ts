import {
  RecoveryRequestBody,
  RecoveryConfirmBody,
  SecurityChangeBody,
  SecurityConfirmBody,
  STAFF_ROLES,
} from '@dhc/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { AccountSecurityService } from './service';

const deliveries = new WeakMap<Services, Set<Promise<void>>>();
export async function drainSecurityDeliveries(s: Services) {
  await Promise.allSettled([...(deliveries.get(s) ?? [])]);
}

type Context = { id: string; organisationId?: string; sessionId?: string; role?: string };
export async function registerAccountSecurity(
  app: FastifyInstance,
  services: Services,
  audience: 'staff' | 'platform',
  signInRateLimit: number,
  guard: (request: FastifyRequest) => Promise<unknown>,
  contextOf: (request: FastifyRequest) => Context,
) {
  const service = new AccountSecurityService(services, audience);
  let active = deliveries.get(services);
  if (!active) {
    active = new Set();
    deliveries.set(services, active);
  }
  const tasks = active;
  app.addHook('onClose', () => drainSecurityDeliveries(services));
  const config = { rateLimit: { max: signInRateLimit, timeWindow: '1 minute' } };
  const own = {
    config,
    preHandler: async (request: FastifyRequest) => {
      await guard(request);
      const context = contextOf(request);
      if (audience === 'staff' && !(STAFF_ROLES as readonly string[]).includes(context.role ?? ''))
        throw new AppError(403, 'FORBIDDEN', 'Staff accounts only.');
    },
  };
  app.post('/auth/password/request', { config }, async (request, reply) => {
    const body = RecoveryRequestBody.parse(request.body);
    if (audience === 'staff' && !body.organisation)
      throw new AppError(400, 'VALIDATION_FAILED', 'Enter the clinic ID.');
    const pending = await service.requestRecovery(request, body.identifier, body.organisation);
    reply.code(202).send(pending.response);
    // Never serialize the transient delivery closure/code, and never make response timing
    // depend on the provider or reveal whether the account exists.
    const task = pending.deliver();
    tasks.add(task);
    try {
      await task;
    } finally {
      tasks.delete(task);
    }
    return reply;
  });
  app.post('/auth/password/confirm', { config }, async (request, reply) => {
    const body = RecoveryConfirmBody.parse(request.body);
    await service.confirmRecovery(
      request,
      body.challengeId,
      body.code,
      body.newPassword,
      body.organisation,
    );
    return reply.code(204).send();
  });
  app.get('/auth/security', own, (request) => service.settings(contextOf(request)));
  app.post('/auth/security/request', own, (request) => {
    const body = SecurityChangeBody.parse(request.body);
    return service.requestChange(request, contextOf(request), body.password, body.method);
  });
  app.post('/auth/security/confirm', own, async (request, reply) => {
    const body = SecurityConfirmBody.parse(request.body);
    await service.confirmChange(
      request,
      contextOf(request),
      body.challengeId,
      body.currentCode,
      body.newCode,
    );
    return reply.code(204).send();
  });
}
