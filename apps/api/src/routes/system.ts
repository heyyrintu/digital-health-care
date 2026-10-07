import { HealthResponse, buildOpenApiDocument } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';

export interface SystemRoutesOptions {
  version: string;
}

export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (app, { version }) => {
  app.get('/health', async () =>
    HealthResponse.parse({ status: 'ok', service: 'api', version, time: new Date().toISOString() }),
  );

  const openApi = buildOpenApiDocument({ version, serverUrl: '/v1' });
  app.get('/openapi.json', async () => openApi);
};
