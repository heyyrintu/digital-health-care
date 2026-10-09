import { z } from 'zod';

// ---- Clinic admin settings (PRD §9.2) -----------------------------------------------

/**
 * Who sees a patient's chart (PRD §3.2). `shared`: every doctor in the organisation.
 * `own_patients`: a doctor sees it once the patient has been checked in to them (internal
 * referrals add access in phase 3).
 */
export const ChartModel = z.enum(['shared', 'own_patients']);
export type ChartModel = z.infer<typeof ChartModel>;

/**
 * The safety rules a clinic may hide: the catalogue's "Visibility only" rules, all
 * non-critical. An API test keeps this list in step with `@dhc/safety`.
 */
export const TunableSafetyRule = z.enum(['SR-06', 'SR-08', 'SR-15']);
export type TunableSafetyRule = z.infer<typeof TunableSafetyRule>;

/** File types a clinic can accept for uploads, with the media types each one covers. */
export const UploadType = z.enum(['pdf', 'jpeg', 'png', 'heic']);
export type UploadType = z.infer<typeof UploadType>;
export const UPLOAD_MEDIA_TYPES: Record<UploadType, readonly string[]> = {
  pdf: ['application/pdf'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  heic: ['image/heic', 'image/heif'],
};

/** The platform's ceiling; a clinic can set a lower limit, never a higher one. */
export const MAX_UPLOAD_MB = 25;

export const OrganisationSettings = z.object({
  chartModel: ChartModel,
  hiddenSafetyRules: z.array(TunableSafetyRule),
  maxUploadMb: z.number().int().min(1).max(MAX_UPLOAD_MB),
  uploadTypes: z.array(UploadType).min(1),
});
export type OrganisationSettings = z.infer<typeof OrganisationSettings>;

export const DEFAULT_ORGANISATION_SETTINGS: OrganisationSettings = {
  chartModel: 'shared',
  hiddenSafetyRules: [],
  maxUploadMb: 10,
  uploadTypes: ['pdf', 'jpeg', 'png'],
};

const unique = <T>(list: T[]) => new Set(list).size === list.length;

export const UpdateOrganisationSettingsBody = OrganisationSettings.refine(
  (s) => unique(s.hiddenSafetyRules),
  { path: ['hiddenSafetyRules'], message: 'Each rule once.' },
).refine((s) => unique(s.uploadTypes), { path: ['uploadTypes'], message: 'Each type once.' });
export type UpdateOrganisationSettingsBody = z.infer<typeof UpdateOrganisationSettingsBody>;

/**
 * Whether a file fits the clinic's limits. Every upload endpoint checks this on the
 * server; clients check it first so people are told before a long upload.
 */
export function checkUpload(
  settings: Pick<OrganisationSettings, 'maxUploadMb' | 'uploadTypes'>,
  file: { mediaType: string; sizeBytes: number },
): 'ok' | 'too_large' | 'type_not_allowed' {
  const mediaType = file.mediaType.toLowerCase();
  if (!settings.uploadTypes.some((t) => UPLOAD_MEDIA_TYPES[t].includes(mediaType))) {
    return 'type_not_allowed';
  }
  if (file.sizeBytes > settings.maxUploadMb * 1024 * 1024) return 'too_large';
  return 'ok';
}
