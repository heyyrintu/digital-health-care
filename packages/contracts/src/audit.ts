import { z } from 'zod';
import { page } from './pagination';

export const AuditEntry = z.object({
  id: z.uuid(),
  action: z.string(),
  actorUserId: z.uuid().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  requestId: z.string().nullable(),
  at: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditListResponse = page(AuditEntry);
export type AuditListResponse = z.infer<typeof AuditListResponse>;
