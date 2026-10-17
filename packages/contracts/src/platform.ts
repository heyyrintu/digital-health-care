import { z } from 'zod';
import { OrganisationSlug } from './auth';

/**
 * Platform console (PRD §3.2, §9.3): organisations, doctor verification and usage only.
 * Separate sign-in and token audience from the clinic app; nothing here carries patient
 * or clinical data (threat model T17, ADR 0016).
 */

// ---- Sign-in ------------------------------------------------------------------------

export const PlatformLoginBody = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});
export type PlatformLoginBody = z.infer<typeof PlatformLoginBody>;

/** Operators always have an authenticator (set when they are created), so this is the only answer. */
export const PlatformLoginResponse = z.object({
  status: z.literal('mfa_required'),
  mfaToken: z.string(),
});
export type PlatformLoginResponse = z.infer<typeof PlatformLoginResponse>;

export const PlatformOperator = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
});
export type PlatformOperator = z.infer<typeof PlatformOperator>;

export const PlatformMeResponse = z.object({ operator: PlatformOperator });
export type PlatformMeResponse = z.infer<typeof PlatformMeResponse>;

// ---- Organisations ------------------------------------------------------------------

const Count = z.number().int().min(0);

/** Memberships of one staff role, by status. */
export const StaffCounts = z.object({ active: Count, invited: Count, revoked: Count });
export type StaffCounts = z.infer<typeof StaffCounts>;

export const PlatformOrganisation = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  createdAt: z.iso.datetime(),
  clinics: z.object({ active: Count, total: Count }),
  staff: z.object({ doctor: StaffCounts, frontDesk: StaffCounts, clinicAdmin: StaffCounts }),
  /** Active doctors' profiles by verification state; doctors who have not filled in their pad have none. */
  doctorVerification: z.object({ pending: Count, verified: Count }),
});
export type PlatformOrganisation = z.infer<typeof PlatformOrganisation>;

export const PlatformOrganisationList = z.object({ data: z.array(PlatformOrganisation) });
export type PlatformOrganisationList = z.infer<typeof PlatformOrganisationList>;

/** Onboarding steps 1–2 (PRD §9.1): the organisation, its first clinic and its first admin's invite. */
export const CreatePlatformOrganisationBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: OrganisationSlug,
  clinic: z.object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).optional(),
    phone: z.string().trim().max(20).optional(),
  }),
  /** The first clinic admin, who then invites the doctors and staff. */
  admin: z.object({
    /** Email address or Indian mobile number they will sign in with. */
    identifier: z.string().trim().min(3).max(254),
    displayName: z.string().trim().min(1).max(120).optional(),
  }),
});
export type CreatePlatformOrganisationBody = z.infer<typeof CreatePlatformOrganisationBody>;

export const CreatedPlatformOrganisation = z.object({
  organisation: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
  clinic: z.object({ id: z.uuid(), name: z.string() }),
  invite: z.object({
    id: z.uuid(),
    role: z.literal('clinic_admin'),
    /** Partly hidden, e.g. `ad****@clinic.test`. */
    identifier: z.string(),
    expiresAt: z.iso.datetime(),
    /** Shown once. Give it to the admin directly; it cannot be retrieved again. */
    inviteUrl: z.url(),
  }),
});
export type CreatedPlatformOrganisation = z.infer<typeof CreatedPlatformOrganisation>;

// ---- Doctor verification ------------------------------------------------------------

export const PlatformDoctorQuery = z.object({
  status: z.enum(['pending', 'verified']).default('pending'),
});
export type PlatformDoctorQuery = z.infer<typeof PlatformDoctorQuery>;

/** An active doctor's registration details, oldest submission first (at most 200). */
export const PlatformDoctor = z.object({
  profileId: z.uuid(),
  organisation: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
  displayName: z.string().nullable(),
  /** Partly hidden email or mobile. */
  identifier: z.string(),
  registrationNumber: z.string().nullable(),
  council: z.string().nullable(),
  qualifications: z.string().nullable(),
  specialty: z.string().nullable(),
  verification: z.enum(['pending', 'verified']),
  /** When the profile was saved, or its registration last changed. */
  submittedAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().nullable(),
  /** `operator (ticket)` */
  verifiedBy: z.string().nullable(),
});
export type PlatformDoctor = z.infer<typeof PlatformDoctor>;

export const PlatformDoctorList = z.object({ data: z.array(PlatformDoctor) });
export type PlatformDoctorList = z.infer<typeof PlatformDoctorList>;

export const SupportTicket = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,40}$/, 'Give the support ticket ID (3–40 letters, digits, . _ -).');

export const VerifyPlatformDoctorBody = z.object({
  /** The ticket recording the registration check (council register, certificate). */
  ticket: SupportTicket,
});
export type VerifyPlatformDoctorBody = z.infer<typeof VerifyPlatformDoctorBody>;

export const VerifiedPlatformDoctor = PlatformDoctor.extend({
  /** True when it was verified already: nothing changed. */
  alreadyVerified: z.boolean(),
});
export type VerifiedPlatformDoctor = z.infer<typeof VerifiedPlatformDoctor>;

// ---- Usage --------------------------------------------------------------------------

/** Longest range usage reports on at once, in days. */
export const MAX_USAGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

export const PlatformUsageQuery = z
  .object({
    /** First IST day, inclusive. Defaults to 29 days before `to`. */
    from: z.iso.date().optional(),
    /** Last IST day, inclusive. Defaults to today. */
    to: z.iso.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date.',
    path: ['from'],
  })
  .refine(
    (q) => !q.from || !q.to || (Date.parse(q.to) - Date.parse(q.from)) / DAY_MS < MAX_USAGE_DAYS,
    { message: `Pick at most ${MAX_USAGE_DAYS} days.`, path: ['from'] },
  );
export type PlatformUsageQuery = z.infer<typeof PlatformUsageQuery>;

export const PlatformUsageRow = z.object({
  organisation: z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(['active', 'suspended']),
  }),
  /** Visits on the range's days, counted as on the clinic dashboard (rescheduled ones excluded). */
  appointments: Count,
  /** Prescriptions first signed in the range (amendments and voided ones excluded). */
  prescriptions: Count,
  /** Payments received in the range: counter payments for now, Cashfree when it arrives. */
  payments: z.object({ count: Count, amountPaise: Count }),
  /** Always null until messaging is built (Phase 3). */
  messages: Count.nullable(),
  /** Always null until the AI scribe is built (Phase 3). */
  scribeMinutes: Count.nullable(),
});
export type PlatformUsageRow = z.infer<typeof PlatformUsageRow>;

export const PlatformUsageReport = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  data: z.array(PlatformUsageRow),
});
export type PlatformUsageReport = z.infer<typeof PlatformUsageReport>;
