import {
  STAFF_ROLES,
  SyncMedicinesQuery,
  SyncMedicinesResponse,
  SyncTodayQuery,
  SyncTodayResponse,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { SyncService } from './service';

/** What the Clinic app caches for offline use (ADR 0009). */
export const syncRoutes: FastifyPluginAsync<{ services: Services }> = async (app, { services }) => {
  const sync = new SyncService(services);
  const auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole(...STAFF_ROLES)] };
  const doctor = { preHandler: [auth, requireRole('doctor')] };

  app.get('/sync/medicines', doctor, async (request) => {
    const query = SyncMedicinesQuery.parse(request.query);
    return SyncMedicinesResponse.parse(await sync.medicines(authOf(request), query));
  });

  app.get('/sync/today', staff, async (request) => {
    const query = SyncTodayQuery.parse(request.query);
    return SyncTodayResponse.parse(await sync.today(authOf(request), query));
  });
};
