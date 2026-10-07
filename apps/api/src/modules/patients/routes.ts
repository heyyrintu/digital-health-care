import { PatientListQuery, PatientListResponse, PatientSummary, STAFF_ROLES } from '@dhc/contracts';
import { withTenant, type Patient } from '@dhc/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

const IdParams = z.object({ id: z.uuid() });

const toSummary = (p: Patient): PatientSummary => ({
  id: p.id,
  uhid: p.uhid,
  name: p.name,
  phone: p.phone,
  dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
});

/** Staff-only patient lookup. Every query runs inside the caller's organisation (RLS). */
export const patientRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const guard = { preHandler: [authenticate(services), requireRole(...STAFF_ROLES)] };

  app.get('/patients', guard, async (request) => {
    const { organisationId } = authOf(request);
    const { limit, cursor, q } = PatientListQuery.parse(request.query);
    const rows = await withTenant(services.db, organisationId, (tx) =>
      tx.patient.findMany({
        where: q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { uhid: { contains: q.toUpperCase() } },
                { phone: { contains: q } },
              ],
            }
          : undefined,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: decodeCursor(cursor) }, skip: 1 } : {}),
      }),
    );
    const pageRows = rows.slice(0, limit);
    return PatientListResponse.parse({
      data: pageRows.map(toSummary),
      nextCursor: rows.length > limit ? encodeCursor(pageRows[pageRows.length - 1]!.id) : null,
    });
  });

  app.get('/patients/:id', guard, async (request) => {
    const { organisationId, userId } = authOf(request);
    const { id } = IdParams.parse(request.params);
    const patient = await withTenant(services.db, organisationId, async (tx) => {
      const found = await tx.patient.findUnique({ where: { id } });
      // Another organisation's patient is indistinguishable from a missing one.
      if (!found) return null;
      await writeAudit(tx, request, {
        action: 'patient.viewed',
        organisationId,
        actorUserId: userId,
        entityType: 'patient',
        entityId: id,
      });
      return found;
    });
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    return PatientSummary.parse(toSummary(patient));
  });
};

const encodeCursor = (id: string) => Buffer.from(id).toString('base64url');

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!z.uuid().safeParse(id).success)
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor.', { cursor: 'invalid' });
  return id;
}
