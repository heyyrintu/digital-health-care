import { PushDevice, PushDeviceList, RegisterPushDeviceBody } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { PushDeviceService } from './service';

const IdParams = z.object({ id: z.uuid() });

/** Push notification devices, for anyone signed in (staff and patients). */
export const deviceRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const devices = new PushDeviceService(services);
  const signedIn = { preHandler: [authenticate(services)] };

  app.post('/push-devices', signedIn, async (request, reply) => {
    const body = RegisterPushDeviceBody.parse(request.body);
    const device = await devices.register(request, authOf(request), body);
    return reply.status(201).send(PushDevice.parse(device));
  });

  app.get('/push-devices', signedIn, async (request) =>
    PushDeviceList.parse({ data: await devices.list(authOf(request)) }),
  );

  app.delete('/push-devices/:id', signedIn, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await devices.remove(request, authOf(request), id);
    return reply.status(204).send();
  });
};
