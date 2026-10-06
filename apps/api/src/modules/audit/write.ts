import type { Prisma, Tx } from '@dhc/db';

/**
 * Where an audited action came from. An HTTP request fits as-is; scripts (support
 * tooling) pass their own run ID and a descriptive user agent.
 */
export interface AuditSource {
  id: string;
  ip: string;
  headers: { 'user-agent'?: string };
}

export interface AuditEvent {
  action: string;
  organisationId?: string | null;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  /** Never put patient data here: IDs, counts and reasons only. */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Appends to the audit log inside the caller's transaction, so it commits with the change.
 * `createMany` issues a plain INSERT (no RETURNING): the sign-in role may write audit
 * rows but never read them.
 */
export async function writeAudit(tx: Tx, request: AuditSource, event: AuditEvent): Promise<void> {
  await tx.auditLog.createMany({
    data: {
      action: event.action,
      organisationId: event.organisationId ?? null,
      actorUserId: event.actorUserId ?? null,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      metadata: event.metadata,
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    },
  });
}
