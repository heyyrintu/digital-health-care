import { z } from 'zod';
import { CursorQuery, page } from './pagination';

export const WhatsAppDeliveryStatus = z.enum([
  'pending',
  'accepted',
  'submission_failed',
  'sent',
  'delivered',
  'read',
  'failed',
  'queued',
  'sending',
  'skipped',
  'uncertain',
]);
export const WhatsAppDeliveryKind = z.enum([
  'payment_link',
  'receipt_ready',
  'refund_ready',
  'prescription_ready',
  'referral_ready',
  'document_ready',
  'otp',
  'appointment_update',
  'appointment_confirmation',
  'appointment_reminder',
]);
export const WhatsAppDeliveryEntry = z.object({
  id: z.uuid(),
  kind: WhatsAppDeliveryKind.default('otp'),
  status: WhatsAppDeliveryStatus,
  createdAt: z.iso.datetime(),
  lastStatusAt: z.iso.datetime(),
  errorCode: z.number().int().nullable(),
});
export type WhatsAppDeliveryEntry = z.infer<typeof WhatsAppDeliveryEntry>;
export const WhatsAppDeliveryList = page(WhatsAppDeliveryEntry);
export const WhatsAppDeliveryQuery = CursorQuery.extend({
  status: WhatsAppDeliveryStatus.optional(),
  kind: WhatsAppDeliveryKind.optional(),
});

export const WhatsAppPreference = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  phoneLast4: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type WhatsAppPreference = z.infer<typeof WhatsAppPreference>;

export const SetWhatsAppPreference = z
  .object({
    enabled: z.boolean(),
    recipientAgreed: z.boolean().default(false),
  })
  .refine((v) => !v.enabled || v.recipientAgreed, {
    message: 'Confirm that the number holder agreed to WhatsApp messages in this category.',
    path: ['recipientAgreed'],
  });

export const RecordLinkTarget = z.object({
  kind: z.enum(['prescription_ready', 'referral_ready', 'document_ready']),
  sourceId: z.uuid(),
  mediaType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
});
export type RecordLinkTarget = z.infer<typeof RecordLinkTarget>;
export const PortalReferralLetter = z.object({
  id: z.uuid(),
  patientName: z.string(),
  signedAt: z.iso.datetime(),
});
export const PortalReferralLetters = page(PortalReferralLetter);
