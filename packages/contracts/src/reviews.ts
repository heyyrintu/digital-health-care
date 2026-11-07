import { z } from 'zod';
import { WhatsAppDeliveryStatus } from './messaging';
/** Only direct Google review destinations; no arbitrary redirect or map-search URLs. */
export function isGoogleReviewUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false;
    if (u.hostname === 'g.page')
      return /^\/r\/[A-Za-z0-9_-]{4,200}\/review\/?$/.test(u.pathname) && !u.search;
    return (
      u.hostname === 'search.google.com' &&
      u.pathname === '/local/writereview' &&
      [...u.searchParams.keys()].length === 1 &&
      /^[A-Za-z0-9_-]{4,300}$/.test(u.searchParams.get('placeid') ?? '')
    );
  } catch {
    return false;
  }
}
export const ReviewSettingsBody = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    googleUrl: z
      .string()
      .trim()
      .max(600)
      .nullable()
      .refine((v) => v === null || isGoogleReviewUrl(v)),
    cooldownDays: z.number().int().min(30).max(365),
  })
  .strict()
  .refine((v) => !v.enabled || v.googleUrl !== null, {
    message: 'Set the direct Google review link first.',
  });
export type ReviewSettingsBody = z.infer<typeof ReviewSettingsBody>;
export const ReviewSettings = z.object({
  version: z.number().int(),
  enabled: z.boolean(),
  googleUrl: z.string().nullable(),
  cooldownDays: z.number().int(),
  deliveryAvailable: z.boolean(),
});
export const ReviewConsent = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  phoneLast4: z.string().nullable(),
});
export const ReviewConsentBody = z
  .object({ enabled: z.boolean(), recipientAgreed: z.boolean().default(false) })
  .strict()
  .refine((v) => !v.enabled || v.recipientAgreed, {
    message: 'Agree to optional review requests first.',
  });
export const ReviewRequest = z.object({
  id: z.uuid(),
  appointmentId: z.uuid(),
  patientId: z.uuid(),
  patientName: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  cancelled: z.boolean(),
  status: z.enum([...WhatsAppDeliveryStatus.options, 'unavailable']),
  openedAt: z.iso.datetime().nullable(),
});
export type ReviewRequest = z.infer<typeof ReviewRequest>;
export const ReviewRequestList = z.object({
  data: z.array(ReviewRequest),
  nextCursor: z.string().nullable(),
  metrics: z.object({
    total: z.number().int(),
    accepted: z.number().int(),
    sent: z.number().int(),
    delivered: z.number().int(),
    opened: z.number().int(),
  }),
});
export const RequestReview = z.object({ id: z.uuid(), appointmentId: z.uuid() }).strict();
export type RequestReview = z.infer<typeof RequestReview>;
export const ReviewQuery = z.object({ cursor: z.uuid().optional() });
export const ResolveReviewBody = z.object({ token: z.string().max(180) }).strict();
export const ReviewLanding = z.object({ clinicName: z.string() });
export const ReviewDestination = z.object({ url: z.string().refine(isGoogleReviewUrl) });

export type ReviewSettings = z.infer<typeof ReviewSettings>;
export type ReviewConsent = z.infer<typeof ReviewConsent>;
