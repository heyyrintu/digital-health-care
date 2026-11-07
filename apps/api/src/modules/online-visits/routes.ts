import {
  OnlineIntake,
  OnlineCall,
  OnlineVerify,
  OnlineVersion,
  OnlineVisit,
  OnlineSettings,
  OnlineDestination,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { authenticate, authOf, requireRole } from '../../plugins/authenticate';
import { OnlineVisitsService } from './service';
export const onlineVisitRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  app.addHook('onRoute', (route) => {
    if (['POST', 'PUT'].includes(String(route.method)))
      route.config = { ...route.config, rateLimit: { max: 30, timeWindow: '1 minute' } };
  });
  const s = new OnlineVisitsService(services),
    auth = authenticate(services),
    admin = { preHandler: [auth, requireRole('clinic_admin')] },
    staff = { preHandler: [auth, requireRole('doctor', 'front_desk', 'clinic_admin')] },
    patient = { preHandler: [auth, requireRole('patient')] },
    doctor = { preHandler: [auth, requireRole('doctor')] },
    id = z.object({ id: z.uuid() });
  app.addHook('onSend', async (_r, reply, p) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return p;
  });
  app.get('/online-settings', admin, async (r) =>
    OnlineSettings.parse(await s.settings(authOf(r))),
  );
  app.put('/online-settings', admin, async (r) => {
    const a = authOf(r),
      value = await s.settings(a, OnlineSettings.parse(r.body), r);
    return OnlineSettings.parse(value);
  });
  app.get('/appointments/:id/online', staff, async (r) =>
    OnlineVisit.parse(await s.read(r, authOf(r), id.parse(r.params).id, false)),
  );
  app.put('/appointments/:id/online/call', staff, async (r) =>
    OnlineVisit.parse(
      await s.mutate(r, authOf(r), id.parse(r.params).id, 'call', OnlineCall.parse(r.body), false),
    ),
  );
  app.post('/appointments/:id/online/verify', doctor, async (r) =>
    OnlineVisit.parse(
      await s.mutate(
        r,
        authOf(r),
        id.parse(r.params).id,
        'verify',
        OnlineVerify.parse(r.body),
        false,
      ),
    ),
  );
  app.get('/portal/appointments/:id/online', patient, async (r) =>
    OnlineVisit.parse(await s.read(r, authOf(r), id.parse(r.params).id, true)),
  );
  app.put('/portal/appointments/:id/online', patient, async (r) =>
    OnlineVisit.parse(
      await s.mutate(
        r,
        authOf(r),
        id.parse(r.params).id,
        'intake',
        OnlineIntake.parse(r.body),
        true,
      ),
    ),
  );
  app.post('/portal/appointments/:id/online/withdraw', patient, async (r) =>
    OnlineVisit.parse(
      await s.mutate(
        r,
        authOf(r),
        id.parse(r.params).id,
        'withdraw',
        OnlineVersion.parse(r.body),
        true,
      ),
    ),
  );
  app.post('/portal/appointments/:id/online/join', patient, async (r) =>
    OnlineDestination.parse(await s.join(r, authOf(r), id.parse(r.params).id)),
  );
};
