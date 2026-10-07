import { z } from 'zod';

export const Role = z.enum(['patient', 'doctor', 'front_desk', 'clinic_admin']);
export type Role = z.infer<typeof Role>;

export const STAFF_ROLES = [
  'doctor',
  'front_desk',
  'clinic_admin',
] as const satisfies readonly Role[];

/** Organisation slug as used in clinic links, e.g. `gupta-clinic`. */
export const OrganisationSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use lowercase letters, digits and dashes');

export const OtpRequestBody = z.object({
  organisation: OrganisationSlug,
  phone: z.string().min(10).max(20),
});
export type OtpRequestBody = z.infer<typeof OtpRequestBody>;

export const OtpRequestResponse = z.object({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponse>;

export const OtpVerifyBody = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type OtpVerifyBody = z.infer<typeof OtpVerifyBody>;

export const LoginBody = z.object({
  organisation: OrganisationSlug,
  /** Email address or mobile number. */
  identifier: z.string().min(3).max(254),
  password: z.string().min(1).max(256),
  /** Only needed when the person holds more than one staff role in the organisation. */
  role: z.enum(STAFF_ROLES).optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

/**
 * Staff accounts are always set up through an invite (authenticator included), so the
 * password step only ever leads to the authenticator-code step.
 */
export const LoginResponse = z.object({ status: z.literal('mfa_required'), mfaToken: z.string() });
export type LoginResponse = z.infer<typeof LoginResponse>;

/** New staff passwords: length over complexity rules (NIST SP 800-63B). */
export const NewPassword = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256, 'Use at most 256 characters');

export const MfaVerifyBody = z.object({
  mfaToken: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type MfaVerifyBody = z.infer<typeof MfaVerifyBody>;

export const TokenResponse = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
  /** Single use: each refresh returns a new one, and reusing an old one ends the session. */
  refreshToken: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const RefreshBody = z.object({ refreshToken: z.string().min(1) });
export type RefreshBody = z.infer<typeof RefreshBody>;

export const MeResponse = z.object({
  user: z.object({
    id: z.uuid(),
    displayName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
  organisation: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
  role: Role,
});
export type MeResponse = z.infer<typeof MeResponse>;
