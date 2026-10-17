import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Config, ProxyTrust } from './config';
import { registerErrorHandling } from './errors';
import { appointmentRoutes } from './modules/appointments/routes';
import { auditRoutes } from './modules/audit/routes';
import { authRoutes } from './modules/auth/routes';
import { inviteRoutes } from './modules/invites/routes';
import { patientRoutes } from './modules/patients/routes';
import { clinicalRoutes } from './modules/clinical/routes';
import { deviceRoutes } from './modules/devices/routes';
import { doctorRoutes } from './modules/doctors/routes';
import { medicineRoutes } from './modules/medicines/routes';
import { orderRoutes } from './modules/orders/routes';
import { prescribingRoutes } from './modules/prescribing/routes';
import { billingRoutes } from './modules/billing/routes';
import { queueRoutes } from './modules/queue/routes';
import { reportRoutes } from './modules/reports/routes';
import { platformRoutes } from './modules/platform/routes';
import { portalRoutes } from './modules/portal/routes';
import { settingsRoutes } from './modules/settings/routes';
import { schedulingRoutes } from './modules/scheduling/routes';
import { staffRoutes } from './modules/staff/routes';
import { syncRoutes } from './modules/sync/routes';
import { IpAllowlist } from './plugins/ip-allowlist';
import { systemRoutes } from './routes/system';
import type { Services } from './services';

export interface BuildAppOptions {
  config: Pick<Config, 'LOG_LEVEL' | 'APP_VERSION'>;
  /** Without services only the system routes are mounted (health, OpenAPI). */
  services?: Services;
  /**
   * Behind a load balancer: which proxies' X-Forwarded-For entries to trust for client IPs
   * (rate limits, the platform allowlist), by hop count and, when given, by the proxies'
   * networks. Never "all": that would trust entries the client wrote itself.
   */
  trustProxy?: ProxyTrust | false;
  /** Sign-in requests per IP per minute (default 10). */
  signInRateLimit?: number;
  /** Browser origins allowed to call the API (web app). None means no CORS headers. */
  corsOrigins?: string[];
  /** Networks that may reach `/v1/platform/*` (from PLATFORM_ALLOWED_CIDRS); default none. */
  platformAllowlist?: IpAllowlist;
}

export function buildApp({
  config,
  services,
  trustProxy = false,
  signInRateLimit = 10,
  corsOrigins = [],
  platformAllowlist = IpAllowlist.none(),
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
      'token',
    ],
  };

  const app = Fastify({
    logger,
    // A function, so the hop count and the proxies' networks both apply: hop 0 is the
    // socket peer; each trusted hop lets the next X-Forwarded-For entry to the left count.
    trustProxy:
      trustProxy === false
        ? false
        : (address: string, hop: number) =>
            hop < trustProxy.hops && (trustProxy.proxies?.allows(address) ?? true),
    // Request IDs are always ours; a client-supplied ID is never trusted.
    requestIdHeader: false,
    genReqId: () => `req_${randomUUID()}`,
  });

  app.decorateRequest('auth', null);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onClose', async () => services?.live.close());
  registerErrorHandling(app);
  // Bearer tokens only (no cookies), so credentials are never allowed cross-origin.
  app.register(cors, {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
  app.register(rateLimit, { global: false });
  app.register(systemRoutes, { prefix: '/v1', version: config.APP_VERSION });
  if (services) {
    app.register(authRoutes, { prefix: '/v1', services, signInRateLimit });
    app.register(inviteRoutes, { prefix: '/v1', services, signInRateLimit });
    app.register(patientRoutes, { prefix: '/v1', services });
    app.register(schedulingRoutes, { prefix: '/v1', services });
    app.register(appointmentRoutes, { prefix: '/v1', services });
    app.register(queueRoutes, { prefix: '/v1', services });
    app.register(clinicalRoutes, { prefix: '/v1', services });
    app.register(prescribingRoutes, { prefix: '/v1', services, signInRateLimit });
    app.register(doctorRoutes, { prefix: '/v1', services, signInRateLimit });
    app.register(medicineRoutes, { prefix: '/v1', services });
    app.register(billingRoutes, { prefix: '/v1', services });
    app.register(orderRoutes, { prefix: '/v1', services });
    app.register(staffRoutes, { prefix: '/v1', services });
    app.register(auditRoutes, { prefix: '/v1', services });
    app.register(reportRoutes, { prefix: '/v1', services });
    app.register(settingsRoutes, { prefix: '/v1', services });
    app.register(portalRoutes, { prefix: '/v1', services });
    app.register(deviceRoutes, { prefix: '/v1', services });
    app.register(syncRoutes, { prefix: '/v1', services });
    app.register(platformRoutes, {
      prefix: '/v1/platform',
      services,
      signInRateLimit,
      allowlist: platformAllowlist,
      version: config.APP_VERSION,
    });
    app.addHook('onClose', async () => services.queues.close());
    app.addHook('onClose', async () => services.db.$disconnect());
  }

  return app;
}
