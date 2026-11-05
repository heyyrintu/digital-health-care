import { z } from 'zod';
export const ClinicOperationKind = z.enum(['cancel', 'reschedule', 'delay']);
export const PreviewClinicOperation = z
  .object({
    id: z.uuid(),
    kind: ClinicOperationKind,
    doctorId: z.uuid(),
    clinicId: z.uuid(),
    date: z.iso.date(),
    from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    reason: z.string().trim().min(1).max(300),
    delayMinutes: z.number().int().min(0).max(240).default(0),
    targetDate: z.iso.date().optional(),
    targetTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    targetClinicId: z.uuid().optional(),
    notify: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.from < b.to, { message: 'The session end must be after its start.' })
  .refine((b) => b.kind !== 'reschedule' || !!(b.targetDate && b.targetTime && b.targetClinicId), {
    message: 'Choose the destination session.',
  });
export type PreviewClinicOperation = z.infer<typeof PreviewClinicOperation>;
export const ClinicOperationRow = z.object({
  id: z.uuid(),
  patientName: z.string(),
  uhid: z.string(),
  startAt: z.iso.datetime(),
  status: z.string(),
  eligible: z.boolean(),
  issue: z.string().nullable(),
  targetAt: z.iso.datetime().nullable(),
  targetIssue: z.string().nullable(),
  newAppointmentId: z.uuid().nullable(),
});
export const ClinicOperation = z.object({
  id: z.uuid(),
  createdByUserId: z.uuid(),
  kind: ClinicOperationKind,
  state: z.enum(['preview', 'applied']),
  revision: z.number().int(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
  exceptionId: z.uuid().nullable(),
  request: PreviewClinicOperation,
  rows: z.array(ClinicOperationRow),
  canApply: z.boolean(),
  notificationsQueued: z.number().int(),
  manualCount: z.number().int(),
  changedCount: z.number().int(),
});
export type ClinicOperation = z.infer<typeof ClinicOperation>;
export const ApplyClinicOperation = z
  .object({
    revision: z.number().int().positive(),
    confirmed: z.literal(true),
    acknowledgeManual: z.boolean(),
  })
  .strict();
export const ClinicOperationOptions = z.object({
  notificationAvailable: z.boolean(),
  doctors: z.array(z.object({ id: z.uuid(), name: z.string() })),
  clinics: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export const ClinicOperationList = z.object({
  data: z.array(ClinicOperation),
  nextCursor: z.uuid().nullable(),
});
