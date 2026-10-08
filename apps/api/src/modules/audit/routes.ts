import { AuditListResponse, AuditQuery } from '@dhc/contracts';
import { withAuth, withTenant, type Prisma } from '@dhc/db';
import { addDays } from '@dhc/domain';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';

/** Midnight IST at the start of a day, as an instant (IST is UTC+05:30 all year). */
const istMidnight = (day: string) => new Date(`${day}T00:00:00.000+05:30`);

/**
 * Clinic admins read their organisation's audit trail, newest first, optionally by action
 * (or its start), staff member and IST dates. Staff are named; patients never are.
 */
export const auditRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/audit-log',
    { preHandler: [authenticate(services), requireRole('clinic_admin')] },
    async (request) => {
      const { organisationId } = authOf(request);
      const { limit, cursor, action, actorUserId, from, to } = AuditQuery.parse(request.query);
      const cursorId = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : undefined;
      if (cursorId && !z.uuid().safeParse(cursorId).success) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor.', { cursor: 'invalid' });
      }
      const where: Prisma.AuditLogWhereInput = {
        ...(action ? { action: { startsWith: action } } : {}),
        ...(actorUserId ? { actorUserId } : {}),
        ...(from || to
          ? {
              at: {
                ...(from ? { gte: istMidnight(from) } : {}),
                ...(to ? { lt: istMidnight(addDays(to, 1)) } : {}),
              },
            }
          : {}),
      };
      const { rows, staff } = await withTenant(services.db, organisationId, async (tx) => {
        const rows = await tx.auditLog.findMany({
          where,
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });
        const actors = [...new Set(rows.flatMap((r) => (r.actorUserId ? [r.actorUserId] : [])))];
        // Only this organisation's staff are named, so a patient's name never shows here.
        const staff = actors.length
          ? await tx.membership.findMany({
              where: { userId: { in: actors }, role: { not: 'patient' } },
              select: { userId: true },
            })
          : [];
        return { rows, staff };
      });
      const staffIds = [...new Set(staff.map((m) => m.userId))];
      const names = staffIds.length
        ? new Map(
            (
              await withAuth(services.db, (tx) =>
                tx.user.findMany({
                  where: { id: { in: staffIds } },
                  select: { id: true, displayName: true, email: true },
                }),
              )
            ).map((u) => [u.id, u.displayName ?? u.email]),
          )
        : new Map<string, string | null>();
      const pageRows = rows.slice(0, limit);
      return AuditListResponse.parse({
        data: pageRows.map((r) => ({
          id: r.id,
          action: r.action,
          actorUserId: r.actorUserId,
          actorName: (r.actorUserId && names.get(r.actorUserId)) ?? null,
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
