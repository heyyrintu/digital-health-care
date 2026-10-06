import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Config } from './config';
import { registerErrorHandling } from './errors';
import { systemRoutes } from './routes/system';

export function buildApp(config: Pick<Config, 'LOG_LEVEL' | 'APP_VERSION'>) {
  const logger: FastifyServerOptions['logger'] = {
    level: config.LOG_LEVEL,
    // Credentials never reach the logs.
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["idempotency-key"]'],
  };

  const app = Fastify({
    logger,
    // Request IDs are always ours; a client-supplied ID is never trusted.
    requestIdHeader: false,
    genReqId: () => `req_${randomUUID()}`,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  app.register(systemRoutes, { prefix: '/v1', version: config.APP_VERSION });

  return app;
}
