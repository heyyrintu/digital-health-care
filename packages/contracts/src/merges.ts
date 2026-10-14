import { z } from 'zod';
import { Gender, PatientRef } from './patients';

// Merging duplicate patient records (PRD §3.2, §5.3): front desk, doctors and clinic admins
// ask; a clinic admin approves or rejects. Merges cannot be undone.

export const PatientMergeStatus = z.enum(['pending', 'approved', 'rejected']);
export type PatientMergeStatus = z.infer<typeof PatientMergeStatus>;

export const CreatePatientMergeBody = z.object({
  /** The duplicate: it becomes read-only and its history shows under the target. */
  sourcePatientId: z.uuid(),
  /** The record that stays. */
  targetPatientId: z.uuid(),
  reason: z.string().trim().min(1).max(300),
});
export type CreatePatientMergeBody = z.infer<typeof CreatePatientMergeBody>;

/** One side of a request, with enough to compare the two records. */
export const PatientMergeSide = PatientRef.extend({
  phone: z.string().nullable(),
  dob: z.iso.date().nullable(),
  gender: Gender.nullable(),
  registeredAt: z.iso.datetime(),
  visits: z.number().int().min(0),
});
export type PatientMergeSide = z.infer<typeof PatientMergeSide>;

export const PatientMergeRequest = z.object({
  id: z.uuid(),
  source: PatientMergeSide,
  target: PatientMergeSide,
  reason: z.string(),
  status: PatientMergeStatus,
  requestedByName: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  decidedByName: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionNote: z.string().nullable(),
});
export type PatientMergeRequest = z.infer<typeof PatientMergeRequest>;

export const PatientMergeQuery = z.object({
  /** `pending` (oldest first) or `decided` (the latest 50). */
  status: z.enum(['pending', 'decided']).default('pending'),
});
export type PatientMergeQuery = z.infer<typeof PatientMergeQuery>;

export const PatientMergeList = z.object({ data: z.array(PatientMergeRequest) });
export type PatientMergeList = z.infer<typeof PatientMergeList>;

export const ApprovePatientMergeBody = z.object({
  note: z.string().trim().min(1).max(300).optional(),
});
export type ApprovePatientMergeBody = z.infer<typeof ApprovePatientMergeBody>;

export const RejectPatientMergeBody = z.object({ note: z.string().trim().min(1).max(300) });
export type RejectPatientMergeBody = z.infer<typeof RejectPatientMergeBody>;
