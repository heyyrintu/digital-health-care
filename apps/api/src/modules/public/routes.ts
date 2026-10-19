import {
  PublicBranding,
  PublicBrandingParams,
  PublicDoctor,
  PublicDoctorDirectory,
  PublicDoctorList,
  PublicDoctorParams,
  PublicLogoParams,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Services } from '../../services';
import { BRANDING_NOT_FOUND, PublicBrandingService } from './branding';
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

/**
 * Logos: every visitor's browser fetches them from here (one per organisation on the home
 * page), so they have their own, higher limit per address.
 */
export const PUBLIC_LOGO_RATE_LIMIT = { max: 600, timeWindow: '1 minute' };
/**
 * A logo's address is its hash, so a copy never goes stale; it is still kept only five
 * minutes, by browsers and shared caches alike, so a suspended organisation's logo (or one
 * removed after a mistake) stops being shown within five minutes.
 */
const LOGO_CACHE = 'public, max-age=300, s-maxage=300';

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

  // The home page's "Find a doctor" list: the same limit and caching as the sitemap list.
  app.get('/public/doctor-directory', LIMITED, async (request, reply) => {
    reply.header('Cache-Control', CACHE);
    return PublicDoctorDirectory.parse(await doctors.directory(request.log));
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

  // Organisation branding (ADR 0017 addendum 2): the portal's sign-in and frame.
  const branding = new PublicBrandingService(services);

  app.get('/public/organisations/:slug/branding', LIMITED, async (request, reply) => {
    reply.header('Cache-Control', NO_STORE);
    const params = PublicBrandingParams.safeParse(request.params);
    if (!params.success) throw BRANDING_NOT_FOUND();
    const body = PublicBranding.parse(await branding.get(params.data.slug));
    reply.header('Cache-Control', CACHE);
    return body;
  });

  app.get(
    '/public/logos/:sha256',
    { config: { rateLimit: PUBLIC_LOGO_RATE_LIMIT } },
    async (request, reply) => {
      reply.header('Cache-Control', NO_STORE);
      const params = PublicLogoParams.safeParse(request.params);
      if (!params.success) throw BRANDING_NOT_FOUND();
      const logo = await branding.logo(params.data.sha256, request.log);
      // The type the stored bytes show, never sniffed by the browser, never run as a page
      // (the sandbox and `default-src 'none'` hold even if it were opened directly), and
      // embeddable by the web app's pages on their own origin.
      return reply
        .type(logo.mediaType)
        .header('Cache-Control', LOGO_CACHE)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .header('Content-Disposition', 'inline; filename="logo"')
        .send(logo.data);
    },
  );
};
