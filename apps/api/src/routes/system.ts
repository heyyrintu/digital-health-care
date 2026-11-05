import { HealthResponse, buildOpenApiDocument } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';

export interface SystemRoutesOptions {
  version: string;
  readiness?: () => Promise<void>;
}

export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (
  app,
  { version, readiness },
) => {
  app.get('/health', async () =>
    HealthResponse.parse({ status: 'ok', service: 'api', version, time: new Date().toISOString() }),
  );

  app.get('/ready', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!readiness) return reply.code(503).send({ status: 'unavailable' });
    try {
      await readiness();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  const openApi = buildOpenApiDocument({ version, serverUrl: '/v1' });
  app.get('/openapi.json', async () => openApi);
};
