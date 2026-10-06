import { z } from 'zod';
import { CursorQuery, page } from './pagination';

export const PatientSummary = z.object({
  id: z.uuid(),
  uhid: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  /** `YYYY-MM-DD` */
  dob: z.iso.date().nullable(),
});
export type PatientSummary = z.infer<typeof PatientSummary>;

export const PatientListQuery = CursorQuery.extend({
  /** Matches name, phone or UHID. */
  q: z.string().trim().min(1).max(100).optional(),
});
export type PatientListQuery = z.infer<typeof PatientListQuery>;

export const PatientListResponse = page(PatientSummary);
export type PatientListResponse = z.infer<typeof PatientListResponse>;
