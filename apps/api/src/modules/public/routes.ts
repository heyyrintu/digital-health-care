import { PublicDoctor, PublicDoctorList, PublicDoctorParams } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Services } from '../../services';
import { PAGE_NOT_FOUND, PublicDoctorService } from './service';

/**
 * Per client address per minute. The web app renders the pages on its server and caches
 * them (ISR, 5 minutes), so most of this is the web server; scrapers calling the API
 * directly are slowed here and at the CDN (threat model T20).
 */
export const PUBLIC_DOCTOR_RATE_LIMIT = { max: 120, timeWindow: '1 minute' };
const LIMITED = { config: { rateLimit: PUBLIC_DOCTOR_RATE_LIMIT } };

/**
 * Browsers keep an answer a minute, shared caches (a CDN) five minutes, as the web app does.
 * The `x-request-id` header is cached along with it: a cached copy repeats the ID of the
 * request that filled the cache, which is harmless (it names no person) but is not the
 * ID of the later request.
 */
const CACHE = 'public, max-age=60, s-maxage=300';
/** Missing or hidden pages are never cached, so a page listed a moment later shows. */
const NO_STORE = 'no-store';

/** Public doctor pages (Build Plan §5.1; ADR 0017): no sign-in, listed and verified only. */
export const publicDoctorRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const doctors = new PublicDoctorService(services);

  app.get('/public/doctors', LIMITED, async (_request, reply) => {
    reply.header('Cache-Control', CACHE);
    return PublicDoctorList.parse(await doctors.list());
  });

  app.get('/public/doctors/:slug', LIMITED, async (request, reply) => {
    // A malformed address is answered like a missing page, never with a validation error.
    reply.header('Cache-Control', NO_STORE);
    const params = PublicDoctorParams.safeParse(request.params);
    if (!params.success) throw PAGE_NOT_FOUND();
    const page = PublicDoctor.parse(await doctors.get(params.data.slug));
    reply.header('Cache-Control', CACHE);
    return page;
  });
};
