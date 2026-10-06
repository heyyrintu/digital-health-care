import { z } from 'zod';
import { STAFF_ROLES } from './auth';

export const StaffRole = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRole>;

// ---- Clinic admin -------------------------------------------------------------------

export const CreateStaffInviteBody = z.object({
  /** Email address or Indian mobile number the person will sign in with. */
  identifier: z.string().trim().min(3).max(254),
  displayName: z.string().trim().min(1).max(120).optional(),
  role: StaffRole,
});
export type CreateStaffInviteBody = z.infer<typeof CreateStaffInviteBody>;

export const StaffInviteStatus = z.enum(['pending', 'accepted', 'revoked', 'expired']);
export type StaffInviteStatus = z.infer<typeof StaffInviteStatus>;

export const StaffInvite = z.object({
  id: z.uuid(),
  role: StaffRole,
  identifier: z.string(),
  displayName: z.string().nullable(),
  status: StaffInviteStatus,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type StaffInvite = z.infer<typeof StaffInvite>;

export const CreatedStaffInvite = StaffInvite.extend({
  /** Shown once. Share it with the person directly; it cannot be retrieved again. */
  inviteUrl: z.url(),
});
export type CreatedStaffInvite = z.infer<typeof CreatedStaffInvite>;

export const StaffInviteList = z.object({ data: z.array(StaffInvite) });
export type StaffInviteList = z.infer<typeof StaffInviteList>;

// ---- Person accepting the invite --------------------------------------------------

export const InviteTokenBody = z.object({ token: z.string().min(20).max(200) });
export type InviteTokenBody = z.infer<typeof InviteTokenBody>;

export const InviteDetails = z.object({
  organisation: z.object({ name: z.string(), slug: z.string() }),
  role: StaffRole,
  /** Partly hidden, e.g. `do****@clinic.test`. */
  identifier: z.string(),
  /** `new`: set a password and authenticator. `existing`: confirm with the ones you have. */
  account: z.enum(['new', 'existing']),
  expiresAt: z.iso.datetime(),
});
export type InviteDetails = z.infer<typeof InviteDetails>;

export const AcceptInviteBody = InviteTokenBody.extend({
  /**
   * New accounts: the password to set (checked against `NewPassword`).
   * Existing accounts: their current password.
   */
  password: z.string().min(1).max(256),
});
export type AcceptInviteBody = z.infer<typeof AcceptInviteBody>;

export const AcceptInviteResponse = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('setup_required'),
    /** Show as a QR code for the authenticator app, then complete with its first code. */
    otpauthUri: z.string(),
  }),
  z.object({ status: z.literal('confirm_required') }),
]);
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponse>;

export const CompleteInviteBody = InviteTokenBody.extend({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type CompleteInviteBody = z.infer<typeof CompleteInviteBody>;
