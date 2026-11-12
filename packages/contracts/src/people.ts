import { z } from 'zod';
import { SecondFactorMethod } from './auth';
import { StaffRole, StaffSessionList } from './invites';
export const PeoplePerson = z.object({
  userId: z.uuid(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(StaffRole),
  status: z.enum(['active', 'invited', 'disabled']),
  identityEditable: z.boolean(),
  signInReady: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type PeoplePerson = z.infer<typeof PeoplePerson>;
export const PeopleList = z.object({
  data: z.array(PeoplePerson),
  nextCursor: z.string().nullable(),
});
export const PeopleQuery = z.object({
  q: z.string().trim().max(120).optional(),
  cursor: z.uuid().optional(),
});
export type PeopleQuery = z.infer<typeof PeopleQuery>;
export const PeopleDetail = PeoplePerson.extend({
  version: z.string(),
  lockedUntil: z.iso.datetime().nullable(),
  authenticatorEnrolled: z.boolean(),
  secondFactorMode: SecondFactorMethod,
  emailVerificationAvailable: z.boolean(),
  phoneVerificationAvailable: z.boolean(),
  audit: z.array(
    z.object({
      id: z.uuid(),
      action: z.string(),
      at: z.iso.datetime(),
      actorName: z.string().nullable(),
    }),
  ),
});
export type PeopleDetail = z.infer<typeof PeopleDetail>;
export const UpdatePeopleBody = z
  .object({
    version: z.string().min(1),
    displayName: z.string().trim().min(1).max(120).nullable(),
    roles: z
      .array(StaffRole)
      .min(1)
      .max(3)
      .refine((a) => new Set(a).size === a.length),
    enabled: z.boolean(),
  })
  .strict();
export type UpdatePeopleBody = z.infer<typeof UpdatePeopleBody>;
export const RequestStaffContactBody = z
  .object({
    version: z.string().min(1),
    field: z.enum(['email', 'phone']),
    value: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(256),
  })
  .strict();
export type RequestStaffContactBody = z.infer<typeof RequestStaffContactBody>;
export const StaffContactChange = z.object({
  id: z.uuid(),
  field: z.enum(['email', 'phone']),
  destination: z.string(),
  expiresAt: z.iso.datetime(),
  state: z.enum(['pending', 'delivery_failed', 'completed', 'cancelled', 'expired']),
});
export type StaffContactChange = z.infer<typeof StaffContactChange>;
export const StaffContactChanges = z.object({ data: z.array(StaffContactChange) });
export const ConfirmStaffContactBody = z
  .object({ code: z.string().regex(/^\d{6}$/), password: z.string().min(1).max(256) })
  .strict();
export type ConfirmStaffContactBody = z.infer<typeof ConfirmStaffContactBody>;
export const StaffContactConfirmed = z.object({ updated: z.literal(true) });
export { StaffSessionList as PeopleSessions };
