import { AuditListResponse, CursorQuery } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';

/** Clinic admins read their organisation's audit trail, newest first. */
export const auditRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/audit-log',
    { preHandler: [authenticate(services), requireRole('clinic_admin')] },
    async (request) => {
      const { organisationId } = authOf(request);
      const { limit, cursor } = CursorQuery.parse(request.query);
      const cursorId = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : undefined;
      if (cursorId && !z.uuid().safeParse(cursorId).success) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor.', { cursor: 'invalid' });
      }
      const rows = await withTenant(services.db, organisationId, (tx) =>
        tx.auditLog.findMany({
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        }),
      );
      const pageRows = rows.slice(0, limit);
      return AuditListResponse.parse({
        data: pageRows.map((r) => ({
          id: r.id,
          action: r.action,
          actorUserId: r.actorUserId,
          entityType: r.entityType,
          entityId: r.entityId,
          requestId: r.requestId,
          at: r.at.toISOString(),
        })),
        nextCursor:
          rows.length > limit
            ? Buffer.from(pageRows[pageRows.length - 1]!.id).toString('base64url')
            : null,
      });
    },
  );
};
