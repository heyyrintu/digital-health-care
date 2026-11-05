import { z } from 'zod';
export const InboxQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  state: z.enum(['open', 'resolved']).optional(),
});
export type InboxQuery = z.infer<typeof InboxQuery>;
export const InboxThread = z.object({
  id: z.uuid(),
  phone: z.string().nullable(),
  last4: z.string(),
  state: z.enum(['open', 'resolved']),
  unread: z.number().int(),
  revision: z.number().int(),
  lastInboundAt: z.iso.datetime(),
  windowEndsAt: z.iso.datetime(),
  canReply: z.boolean(),
  canRead: z.boolean(),
  stopped: z.boolean(),
  templateConsent: z.boolean(),
  assignedDoctorId: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
});
export type InboxThread = z.infer<typeof InboxThread>;
export const InboxList = z.object({
  available: z.boolean(),
  data: z.array(InboxThread),
  nextCursor: z.uuid().nullable(),
});
export const InboxMessage = z.object({
  id: z.uuid(),
  direction: z.string(),
  kind: z.string(),
  body: z.string(),
  state: z.string(),
  createdAt: z.iso.datetime(),
  occurredAt: z.iso.datetime(),
  errorCode: z.number().int().nullable(),
});
export const InboxMessages = z.object({
  thread: InboxThread,
  data: z.array(InboxMessage),
  nextCursor: z.uuid().nullable(),
});
export const InboxReply = z
  .object({
    id: z.uuid(),
    text: z.string().trim().min(1).max(4000).optional(),
    templateId: z.uuid().optional(),
  })
  .strict()
  .refine((b) => !!b.text !== !!b.templateId, { message: 'Choose text or a template.' });
export type InboxReply = z.infer<typeof InboxReply>;
export const InboxAction = z
  .object({
    revision: z.number().int().positive(),
    state: z.enum(['open', 'resolved']).optional(),
    markRead: z.boolean().optional(),
  })
  .strict();
export const InboxAssign = z
  .object({ revision: z.number().int().positive(), doctorId: z.uuid().nullable() })
  .strict();
export const InboxConsent = z
  .object({
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    recipientAgreed: z.boolean(),
    source: z.enum(['in_person', 'phone', 'written']),
  })
  .strict()
  .refine((b) => !b.enabled || b.recipientAgreed, {
    message: 'Record the number holder’s explicit agreement.',
  });
export const InboxTemplate = z.object({
  id: z.uuid(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  providerStatus: z.string(),
  body: z.string(),
  supported: z.boolean(),
  enabled: z.boolean(),
  revision: z.number().int(),
  verifiedAt: z.iso.datetime(),
});
export const InboxTemplates = z.object({ available: z.boolean(), data: z.array(InboxTemplate) });
export const InboxTemplateToggle = z
  .object({ revision: z.number().int().positive(), enabled: z.boolean() })
  .strict();
export const InboxDoctors = z.object({
  data: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
