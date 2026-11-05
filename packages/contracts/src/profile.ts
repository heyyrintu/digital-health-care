import { z } from 'zod';
import { BloodGroup, Gender, Language } from './patients';
import { Allergy, MedicalCondition, CurrentMedication } from './consultations';
const text = (max: number) => z.string().trim().min(1).max(max).nullable();
export const PortalProfile = z.object({
  id: z.uuid(),
  uhid: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  dob: z.iso.date().nullable(),
  gender: Gender.nullable(),
  language: Language,
  email: z.string().nullable(),
  address: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  bloodGroup: BloodGroup.nullable(),
  reportedBloodGroup: BloodGroup.nullable(),
  bloodGroupPending: z.boolean(),
  hasPhoto: z.boolean(),
  canChangePhone: z.boolean(),
  updatedAt: z.iso.datetime(),
  allergies: z.array(Allergy),
  conditions: z.array(MedicalCondition),
  medications: z.array(CurrentMedication),
});
export type PortalProfile = z.infer<typeof PortalProfile>;
export const UpdatePortalProfile = z
  .object({
    updatedAt: z.iso.datetime(),
    name: z.string().trim().min(1).max(120),
    dob: z.iso.date(),
    gender: Gender,
    language: Language,
    email: z.email().max(254).nullable(),
    address: text(300),
    emergencyContactName: text(120),
    emergencyContactPhone: text(20),
    reportedBloodGroup: BloodGroup.nullable(),
  })
  .strict();
export type UpdatePortalProfile = z.infer<typeof UpdatePortalProfile>;
export const PatientReportedEntry = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('allergies'),
      substance: z.string().trim().min(1).max(120),
      reaction: text(200),
    })
    .strict(),
  z.object({ kind: z.literal('conditions'), name: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      kind: z.literal('medications'),
      name: z.string().trim().min(1).max(200),
      dose: text(120),
    })
    .strict(),
]);
export type PatientReportedEntry = z.infer<typeof PatientReportedEntry>;
export const StartPhoneChange = z
  .object({ id: z.uuid(), newPhone: z.string().min(10).max(20) })
  .strict();
export type StartPhoneChange = z.infer<typeof StartPhoneChange>;
export const PhoneChangeView = z.object({
  id: z.uuid(),
  expiresAt: z.iso.datetime(),
  completed: z.boolean(),
  ready: z.boolean(),
});
export type PhoneChangeView = z.infer<typeof PhoneChangeView>;
export const VerifyPhoneChange = z
  .object({ oldCode: z.string().regex(/^\d{6}$/), newCode: z.string().regex(/^\d{6}$/) })
  .strict();
export type VerifyPhoneChange = z.infer<typeof VerifyPhoneChange>;

export const ProfileConfirmed = z.object({ confirmed: z.literal(true) });
export const DoctorBloodReport = z.object({
  group: BloodGroup.nullable(),
  pending: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export const ConfirmBloodReport = z.object({ updatedAt: z.iso.datetime() }).strict();

export type DoctorBloodReport = z.infer<typeof DoctorBloodReport>;
