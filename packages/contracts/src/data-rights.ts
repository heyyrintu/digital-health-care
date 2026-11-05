import { z } from 'zod';
export const RightsPatient = z.object({ id: z.uuid(), name: z.string(), uhid: z.string() });
export const RightsPatients = z.object({ data: z.array(RightsPatient) });
export const RightsCreate = z
  .object({
    id: z.uuid(),
    patientId: z.uuid(),
    kind: z.enum(['correction', 'erasure']),
    area: z.enum(['profile', 'clinical', 'financial']),
    field: z
      .enum([
        'name',
        'dob',
        'gender',
        'email',
        'address',
        'language',
        'emergencyContactName',
        'emergencyContactPhone',
      ])
      .nullable(),
    value: z.string().trim().max(300).nullable(),
    message: z.string().trim().min(1).max(1000),
    referenceId: z.uuid().nullable(),
  })
  .strict();
export type RightsCreate = z.infer<typeof RightsCreate>;
export const RightsItem = z.object({
  id: z.uuid(),
  patient: RightsPatient.nullable(),
  kind: z.string(),
  area: z.string(),
  state: z.string(),
  revision: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  assignedDoctorId: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  response: z.string().nullable(),
  policyReference: z.string().nullable(),
  reviewAfter: z.iso.date().nullable(),
  evidenceId: z.uuid().nullable(),
  events: z.array(z.object({ action: z.string(), at: z.iso.datetime() })),
});
export type RightsItem = z.infer<typeof RightsItem>;
export const RightsQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  state: z
    .enum([
      'requested',
      'in_review',
      'fulfilled',
      'declined',
      'retained',
      'withdrawn',
      'processing',
      'failed',
    ])
    .optional(),
});
export type RightsQuery = z.infer<typeof RightsQuery>;
export const RightsList = z.object({ data: z.array(RightsItem), nextCursor: z.uuid().nullable() });
export const RightsAssignment = z
  .object({ revision: z.number().int().positive(), doctorId: z.uuid() })
  .strict();
export const RightsDecision = z
  .object({
    revision: z.number().int().positive(),
    state: z.enum(['in_review', 'fulfilled', 'declined', 'retained']),
    response: z.string().trim().min(1).max(1000),
    policyReference: z
      .string()
      .trim()
      .max(120)
      .regex(/^[A-Za-z0-9_. /:-]*$/)
      .nullable(),
    reviewAfter: z.iso.date().nullable(),
    evidenceId: z.uuid().nullable(),
  })
  .strict();
export type RightsDecision = z.infer<typeof RightsDecision>;
export const RightsExport = z.object({ id: z.uuid(), patientId: z.uuid() }).strict();
export const ClosureStart = z.object({ id: z.uuid() }).strict();
export const ClosureVerify = z
  .object({ code: z.string().regex(/^\d{6}$/), confirmed: z.literal(true) })
  .strict();
export const ClosureView = z.object({
  id: z.uuid(),
  ready: z.boolean(),
  expiresAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type ClosureView = z.infer<typeof ClosureView>;
export const RightsReviewers = z.object({
  data: z.array(z.object({ id: z.uuid(), name: z.string().nullable() })),
});
