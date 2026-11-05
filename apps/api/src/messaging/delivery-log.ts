import { WhatsAppDeliveryList, WhatsAppDeliveryQuery } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../plugins/authenticate';
import type { Services } from '../services';

export const deliveryLogRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/delivery-log',
    { preHandler: [authenticate(services), requireRole('clinic_admin')] },
    async (request) => {
      const { organisationId } = authOf(request);
      const { status, kind, cursor, limit } = WhatsAppDeliveryQuery.parse(request.query);
      const cursorId = cursor
        ? z.uuid().parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        : undefined;
      const rows = await withTenant(services.db, organisationId, (tx) =>
        tx.whatsAppDelivery.findMany({
          where: { ...(status ? { status } : {}), ...(kind ? { kind } : {}) },
          select: {
            id: true,
            kind: true,
            status: true,
            createdAt: true,
            lastStatusAt: true,
            errorCode: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        }),
      );
      const entries = rows.slice(0, limit);
      return WhatsAppDeliveryList.parse({
        data: entries.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          lastStatusAt: row.lastStatusAt.toISOString(),
        })),
        nextCursor:
          rows.length > limit ? Buffer.from(entries.at(-1)!.id).toString('base64url') : null,
      });
    },
  );
};
