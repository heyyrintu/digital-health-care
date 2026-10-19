import { LOGO_MAX_BYTES, LOGO_MEDIA_TYPES, UpdateOrganisationBrandingBody } from '@dhc/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { uploadRateLimit, type UploadedFile } from '../orders/upload';
import { BrandingService } from './service';

/**
 * Logo bodies are read as raw bytes up to twice the logo limit, so a file a little over
 * 512 KB gets a clear `too_large` from the checks; anything bigger is a 413 before it is
 * read in full. SVG is accepted as a body only to be refused by name (`svg_not_allowed`).
 */
const LOGO_BODY_TYPES = [...Object.values(LOGO_MEDIA_TYPES), 'image/svg+xml'];

/** Clinic admin: the organisation's branding (Build Plan §5.1; ADR 0017 addendum 2). */
export const brandingRoutes: FastifyPluginAsync<{
  services: Services;
  /** Uploads per client address per minute, shared with result uploads. */
  uploadRateLimit: number;
}> = async (app, { services, uploadRateLimit: uploadMax }) => {
  // Parsers are per plugin: JSON endpoints elsewhere are unaffected.
  app.addContentTypeParser(
    LOGO_BODY_TYPES,
    { parseAs: 'buffer', bodyLimit: 2 * LOGO_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );
  const branding = new BrandingService(services);
  const admin = { preHandler: [authenticate(services), requireRole('clinic_admin')] };
  // Authenticated in `onRequest`, before the body is read (as result uploads are).
  const adminUpload = {
    onRequest: [
      uploadRateLimit(app, services, uploadMax),
      authenticate(services),
      requireRole('clinic_admin'),
    ],
  };

  app.get('/organisation-branding', admin, async (request) => branding.get(authOf(request)));

  app.put('/organisation-branding', admin, async (request) => {
    const body = UpdateOrganisationBrandingBody.parse(request.body);
    return branding.update(request, authOf(request), body);
  });

  app.post('/organisation-branding/logo', adminUpload, async (request) =>
    branding.uploadLogo(request, authOf(request), logoFile(request)),
  );

  app.delete('/organisation-branding/logo', admin, async (request) =>
    branding.deleteLogo(request, authOf(request)),
  );
};

/**
 * The body as a file. An SVG body counts too, so it is refused by name; a logo type with no
 * body is an empty file; anything else (JSON, text) is not a logo.
 */
function logoFile(request: FastifyRequest): UploadedFile {
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (Buffer.isBuffer(request.body)) return { mediaType, data: request.body };
  if (request.body === undefined && LOGO_BODY_TYPES.includes(mediaType)) {
    return { mediaType, data: Buffer.alloc(0) };
  }
  throw new AppError(415, 'VALIDATION_FAILED', 'Send the logo itself, as PNG, JPEG or WebP.', {
    file: 'type_not_allowed',
  });
}
