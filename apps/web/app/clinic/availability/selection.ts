import type { Clinic, ConsultationType } from '@dhc/contracts';

/** What the availability page is showing: one doctor at one clinic for one type. */
export interface Selection {
  doctorId: string;
  clinic: Clinic;
  type: ConsultationType;
  clinics: Clinic[];
  /** May change this doctor's schedule. */
  canEdit: boolean;
  isAdmin: boolean;
  today: string;
  /** Bumped after every change so the slot preview reloads. */
  version: number;
  changed(): void;
}
