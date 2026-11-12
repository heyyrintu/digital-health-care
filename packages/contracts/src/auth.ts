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

/** Password-only deployments return tokens; other policies require a second factor. */
export const MfaRequiredResponse = z.object({
  status: z.literal('mfa_required'),
  mfaToken: z.string(),
  method: z.enum(['totp', 'whatsapp', 'email']).optional(),
});
export const LoginResponse = z.union([
  MfaRequiredResponse,
  TokenResponse.extend({ status: z.literal('signed_in') }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

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

export const SecondFactorMethod = z.enum(['totp', 'whatsapp', 'email', 'disabled']);
export const RecoveryRequestBody = z.object({
  organisation: OrganisationSlug.optional(),
  identifier: z.string().trim().min(3).max(254),
});
export const SecurityChallengeResponse = z.object({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export const RecoveryConfirmBody = z.object({
  challengeId: z.uuid(),
  organisation: OrganisationSlug.optional(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: NewPassword,
});
export const SecuritySettingsResponse = z.object({
  method: SecondFactorMethod,
  available: z.array(SecondFactorMethod),
});
export const SecurityChangeBody = z.object({
  password: z.string().min(1).max(256),
  method: SecondFactorMethod,
});
export const SecurityConfirmBody = z
  .object({
    challengeId: z.uuid(),
    currentCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    newCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .refine((body) => Boolean(body.currentCode || body.newCode), {
    message: 'Enter a verification code.',
  });
export const SecurityChangeResponse = SecurityChallengeResponse.extend({
  currentMethod: SecondFactorMethod,
  targetMethod: SecondFactorMethod,
});

export type AccountSecuritySettings = z.infer<typeof SecuritySettingsResponse>;
export type AccountSecurityChange = z.infer<typeof SecurityChangeResponse>;

export const SecurityChangedResponse = z.undefined();

export type SecondFactorMethodValue = z.infer<typeof SecondFactorMethod>;
