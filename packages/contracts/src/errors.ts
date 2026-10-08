import { z } from 'zod';

/**
 * Error codes shared by every client. Generic codes map to HTTP statuses;
 * business-rule codes come from API guide §5.
 */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'BUSINESS_RULE',
  'RATE_LIMITED',
  'INTERNAL',
  'SLOT_TAKEN',
  'BOOKING_LIMIT',
  'SAFETY_BLOCK',
  'SCRIBE_DRAFT_PENDING',
  'DOCTOR_NOT_VERIFIED',
  'PRESCRIPTION_LOCKED',
  'SIGNING_UNAVAILABLE',
  'PAYMENT_PENDING',
  'CONSENT_REQUIRED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The one error shape every endpoint returns (API guide §2). */
export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    /** Safe to show to users. Never contains patient data. */
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
