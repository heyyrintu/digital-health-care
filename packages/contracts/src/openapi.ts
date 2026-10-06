import { z } from 'zod';
import { ErrorResponse } from './errors';
import { HealthResponse } from './health';

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorResponse') } },
});

/**
 * Builds the OpenAPI 3.1 document from the Zod schemas. Endpoints are added here as
 * modules land; field detail always comes from the schemas, never written by hand.
 */
export function buildOpenApiDocument(options: { version: string; serverUrl?: string }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Digital Healthcare Platform API',
      version: options.version,
    },
    servers: options.serverUrl ? [{ url: options.serverUrl }] : [],
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Service health',
          security: [],
          responses: {
            '200': {
              description: 'Service is up',
              content: { 'application/json': { schema: ref('HealthResponse') } },
            },
            default: errorResponse('Error'),
          },
        },
      },
    },
    components: {
      schemas: {
        ErrorResponse: toSchema(ErrorResponse),
        HealthResponse: toSchema(HealthResponse),
      },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

/** JSON Schema 2020-12 (the dialect OpenAPI 3.1 uses), without the top-level `$schema`. */
function toSchema(schema: z.ZodType) {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io: 'output' });
  return rest;
}
