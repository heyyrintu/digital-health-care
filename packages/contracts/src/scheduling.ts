import { z } from 'zod';

/** `HH:MM`, 24-hour, IST wall-clock. */
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

// ---- Clinics (clinic admin) ----------------------------------------------------------

export const Clinic = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  /** Deactivated clinics keep their history but take no new schedules. */
  active: z.boolean(),
});
export type Clinic = z.infer<typeof Clinic>;

export const ClinicList = z.object({ data: z.array(Clinic) });
export type ClinicList = z.infer<typeof ClinicList>;

export const CreateClinicBody = z.object({
  name: z.string().trim().min(1).max(80),
  address: optionalText(300),
  phone: optionalText(20),
});
export type CreateClinicBody = z.infer<typeof CreateClinicBody>;

export const UpdateClinicBody = CreateClinicBody.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateClinicBody = z.infer<typeof UpdateClinicBody>;

// ---- Consultation types (clinic admin) -----------------------------------------------

export const ConsultationMode = z.enum(['in_person', 'audio', 'video']);
export type ConsultationMode = z.infer<typeof ConsultationMode>;

/** Amounts are in paise (₹1 = 100 paise). */
export const ConsultationType = z.object({
  id: z.uuid(),
  name: z.string(),
  mode: ConsultationMode,
  /** Default slot length for schedules of this type. */
  defaultDurationMin: z.number().int(),
  feePaise: z.number().int(),
  followUpFeePaise: z.number().int().nullable(),
  requiresPrepayment: z.boolean(),
  active: z.boolean(),
});
export type ConsultationType = z.infer<typeof ConsultationType>;

export const ConsultationTypeList = z.object({ data: z.array(ConsultationType) });
export type ConsultationTypeList = z.infer<typeof ConsultationTypeList>;

/** Up to ₹1,00,000. */
const Paise = z.number().int().min(0).max(10_000_000);

export const CreateConsultationTypeBody = z.object({
  name: z.string().trim().min(1).max(60),
  mode: ConsultationMode,
  defaultDurationMin: z.number().int().min(5).max(240),
  feePaise: Paise,
  followUpFeePaise: Paise.nullable().optional(),
  requiresPrepayment: z.boolean().default(false),
});
export type CreateConsultationTypeBody = z.infer<typeof CreateConsultationTypeBody>;

export const UpdateConsultationTypeBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  mode: ConsultationMode.optional(),
  defaultDurationMin: z.number().int().min(5).max(240).optional(),
  feePaise: Paise.optional(),
  followUpFeePaise: Paise.nullable().optional(),
  requiresPrepayment: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateConsultationTypeBody = z.infer<typeof UpdateConsultationTypeBody>;

// ---- Booking rules (clinic admin) ----------------------------------------------------

export const BookingRules = z.object({
  /** Patients may book this many days ahead. */
  horizonDays: z.number().int().min(1).max(365),
  /** Same-day patient bookings close this many minutes before the slot. */
  sameDayCutoffMinutes: z.number().int().min(0).max(1440),
  /** Staff may book this many extra patients into taken slots per doctor per day. */
  overbookPerDay: z.number().int().min(0).max(50),
});
export type BookingRules = z.infer<typeof BookingRules>;

// ---- Doctors -------------------------------------------------------------------------

export const Doctor = z.object({ userId: z.uuid(), displayName: z.string().nullable() });
export type Doctor = z.infer<typeof Doctor>;

export const DoctorList = z.object({ data: z.array(Doctor) });
export type DoctorList = z.infer<typeof DoctorList>;

// ---- Weekly schedules ----------------------------------------------------------------

export const ScheduleSession = z.object({ start: Time, end: Time });

const Day = z.array(ScheduleSession).max(6).optional();
/** Sessions per weekday; days left out have none. Gaps between sessions are breaks. */
export const WeeklySchedule = z.object({
  sun: Day,
  mon: Day,
  tue: Day,
  wed: Day,
  thu: Day,
  fri: Day,
  sat: Day,
});
export type WeeklySchedule = z.infer<typeof WeeklySchedule>;

/**
 * A doctor's weekly schedule at one clinic for one consultation type, from a date until
 * a later version takes over. Versions are never edited, so past days keep their slots.
 */
export const AvailabilityVersion = z.object({
  id: z.uuid(),
  doctorUserId: z.uuid(),
  clinicId: z.uuid(),
  consultationTypeId: z.uuid(),
  effectiveFrom: z.iso.date(),
  weekly: WeeklySchedule,
  slotMinutes: z.number().int(),
  bufferMinutes: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type AvailabilityVersion = z.infer<typeof AvailabilityVersion>;

export const AvailabilityVersionList = z.object({ data: z.array(AvailabilityVersion) });
export type AvailabilityVersionList = z.infer<typeof AvailabilityVersionList>;

export const AvailabilityQuery = z.object({
  doctorId: z.uuid().optional(),
  clinicId: z.uuid().optional(),
  consultationTypeId: z.uuid().optional(),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuery>;

export const CreateAvailabilityVersionBody = z.object({
  /** Doctors may leave this out to set their own schedule. */
  doctorUserId: z.uuid().optional(),
  clinicId: z.uuid(),
  consultationTypeId: z.uuid(),
  /** Today or later (IST). */
  effectiveFrom: z.iso.date(),
  weekly: WeeklySchedule,
  /** Defaults to the consultation type's duration. */
  slotMinutes: z.number().int().min(5).max(240).optional(),
  bufferMinutes: z.number().int().min(0).max(120).default(0),
});
export type CreateAvailabilityVersionBody = z.infer<typeof CreateAvailabilityVersionBody>;

// ---- Exceptions: leave, holidays, extra sessions -------------------------------------

export const AvailabilityExceptionType = z.enum(['leave', 'holiday', 'extra_session']);
export type AvailabilityExceptionType = z.infer<typeof AvailabilityExceptionType>;

/**
 * Leave belongs to a doctor; a holiday closes a clinic (or every clinic when no clinic
 * is given); an extra session adds hours for one doctor, clinic and consultation type.
 * Leave and holidays without times cover whole days.
 */
export const AvailabilityException = z.object({
  id: z.uuid(),
  type: AvailabilityExceptionType,
  doctorUserId: z.uuid().nullable(),
  clinicId: z.uuid().nullable(),
  consultationTypeId: z.uuid().nullable(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AvailabilityException = z.infer<typeof AvailabilityException>;

export const AvailabilityExceptionList = z.object({ data: z.array(AvailabilityException) });
export type AvailabilityExceptionList = z.infer<typeof AvailabilityExceptionList>;

export const AvailabilityExceptionQuery = z.object({
  doctorId: z.uuid().optional(),
  clinicId: z.uuid().optional(),
  /** Exceptions ending on or after this date; defaults to today. */
  from: z.iso.date().optional(),
});
export type AvailabilityExceptionQuery = z.infer<typeof AvailabilityExceptionQuery>;

export const CreateAvailabilityExceptionBody = z.object({
  type: AvailabilityExceptionType,
  doctorUserId: z.uuid().nullable().optional(),
  clinicId: z.uuid().nullable().optional(),
  consultationTypeId: z.uuid().nullable().optional(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  startTime: Time.nullable().optional(),
  endTime: Time.nullable().optional(),
  reason: optionalText(200),
});
export type CreateAvailabilityExceptionBody = z.infer<typeof CreateAvailabilityExceptionBody>;

// ---- Slots ---------------------------------------------------------------------------

export const SlotChannel = z.enum(['staff', 'patient']);
export type SlotChannel = z.infer<typeof SlotChannel>;

export const SlotsQuery = z.object({
  doctorId: z.uuid(),
  clinicId: z.uuid(),
  consultationTypeId: z.uuid(),
  date: z.iso.date(),
  /** `patient` applies the booking horizon and same-day cutoff, as the patient app will. */
  channel: SlotChannel.default('staff'),
});
export type SlotsQuery = z.infer<typeof SlotsQuery>;

export const Slot = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  /** IST wall-clock `HH:MM`. */
  startTime: z.string(),
  endTime: z.string(),
  available: z.boolean(),
  unavailableReason: z.enum(['past', 'cutoff', 'busy']).optional(),
});
export type Slot = z.infer<typeof Slot>;

export const SlotsResponse = z.object({
  date: z.iso.date(),
  slots: z.array(Slot),
  /** Why the day has no slots, when it has none. */
  closed: z.enum(['past', 'beyond_horizon', 'no_schedule', 'leave', 'holiday']).optional(),
});
export type SlotsResponse = z.infer<typeof SlotsResponse>;
