import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Config } from './config';
import { registerErrorHandling } from './errors';
import { auditRoutes } from './modules/audit/routes';
import { authRoutes } from './modules/auth/routes';
import { patientRoutes } from './modules/patients/routes';
import { systemRoutes } from './routes/system';
import type { Services } from './services';

export interface BuildAppOptions {
  config: Pick<Config, 'LOG_LEVEL' | 'APP_VERSION'>;
  /** Without services only the system routes are mounted (health, OpenAPI). */
  services?: Services;
  /** Behind a load balancer, trust X-Forwarded-For for client IPs and rate limits. */
  trustProxy?: boolean;
  /** Sign-in requests per IP per minute (default 10). */
  signInRateLimit?: number;
}

export function buildApp({
  config,
  services,
  trustProxy = false,
  signInRateLimit = 10,
}: BuildAppOptions) {
  const logger: FastifyServerOptions['logger'] = {
    level: config.LOG_LEVEL,
    // Credentials and tokens never reach the logs.
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["idempotency-key"]',
      'code',
      'password',
      'refreshToken',
    ],
  };

  const app = Fastify({
    logger,
    trustProxy,
    // Request IDs are always ours; a client-supplied ID is never trusted.
    requestIdHeader: false,
    genReqId: () => `req_${randomUUID()}`,
  });

  app.decorateRequest('auth', null);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  app.register(rateLimit, { global: false });
  app.register(systemRoutes, { prefix: '/v1', version: config.APP_VERSION });
  if (services) {
    app.register(authRoutes, { prefix: '/v1', services, signInRateLimit });
    app.register(patientRoutes, { prefix: '/v1', services });
    app.register(auditRoutes, { prefix: '/v1', services });
    app.addHook('onClose', async () => services.db.$disconnect());
  }

  return app;
}
