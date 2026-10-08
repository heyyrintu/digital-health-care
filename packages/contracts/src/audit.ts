import { z } from 'zod';
import { CursorQuery, page } from './pagination';

export const AuditEntry = z.object({
  id: z.uuid(),
  action: z.string(),
  actorUserId: z.uuid().nullable(),
  /** The staff member's name (or email), for reading the log; null for system and patient actions. */
  actorName: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  requestId: z.string().nullable(),
  at: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditListResponse = page(AuditEntry);
export type AuditListResponse = z.infer<typeof AuditListResponse>;

/** Audit log filters; all optional and combined with AND. */
export const AuditQuery = CursorQuery.extend({
  /** An action or its start, such as `bill.saved` or `prescription.`. */
  action: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z_.]+$/, 'Letters, dots and underscores only.')
    .optional(),
  actorUserId: z.uuid().optional(),
  /** First and last IST day, inclusive. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine((q) => !q.from || !q.to || q.from <= q.to, {
  message: 'The start date must be on or before the end date.',
  path: ['from'],
});
export type AuditQuery = z.infer<typeof AuditQuery>;
