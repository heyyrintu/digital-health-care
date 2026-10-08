import { DoctorProfile, SaveDoctorProfileBody, SetSigningPinBody } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { DoctorProfileService } from './service';

/** The signed-in doctor's prescription pad and signing details (PRD §9.1). */
export const doctorRoutes: FastifyPluginAsync<{
  services: Services;
  /** Requests checking a password or PIN, per client address per minute. */
  signInRateLimit: number;
}> = async (app, { services, signInRateLimit }) => {
  const PIN_RATE_LIMIT = { rateLimit: { max: signInRateLimit, timeWindow: '1 minute' } };
  const profiles = new DoctorProfileService(services);
  const doctor = { preHandler: [authenticate(services), requireRole('doctor')] };

  app.get('/doctor-profile', doctor, async (request) =>
    DoctorProfile.parse(await profiles.get(authOf(request))),
  );

  app.put('/doctor-profile', doctor, async (request) => {
    const body = SaveDoctorProfileBody.parse(request.body);
    return DoctorProfile.parse(await profiles.save(request, authOf(request), body));
  });

  app.put(
    '/doctor-profile/signing-pin',
    { ...doctor, config: PIN_RATE_LIMIT },
    async (request, reply) => {
      const body = SetSigningPinBody.parse(request.body);
      await profiles.setPin(request, authOf(request), body);
      return reply.status(204).send();
    },
  );
};
