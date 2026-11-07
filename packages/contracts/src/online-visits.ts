import { z } from 'zod';
export const ONLINE_CONSENT_VERSION = 'online-2026-11-07';
/** Patient birthdays are calendar dates in the clinic's India timezone. */
export function onlineAgeAt(dob: string, now: Date) {
  const today = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
  return (
    Number(today.slice(0, 4)) - Number(dob.slice(0, 4)) - (today.slice(5) < dob.slice(5) ? 1 : 0)
  );
}
export function isMeetingUrl(value: string) {
  try {
    const u = new URL(value);
    const meetingPath =
      u.hostname === 'meet.google.com'
        ? /^\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[a-zA-Z0-9_-]+)\/?$/.test(u.pathname)
        : /^(?:[a-z0-9-]+\.)?zoom\.us$/.test(u.hostname)
          ? /^\/(?:j\/\d{6,15}|my\/[a-zA-Z0-9._-]{1,100})\/?$/.test(u.pathname)
          : ['teams.microsoft.com', 'teams.live.com'].includes(u.hostname) &&
            /^\/(?:l\/meetup-join\/[^/]+\/0|meet\/[^/]+)\/?$/.test(u.pathname);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      (['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com'].includes(
        u.hostname,
      ) ||
        /^[a-z0-9-]+\.zoom\.us$/.test(u.hostname)) &&
      meetingPath
    );
  } catch {
    return false;
  }
}
export const OnlineIdentity = z
  .object({
    name: z.string().trim().min(1).max(120),
    dob: z.iso.date(),
    address: z.string().trim().min(5).max(300),
    guardianName: z.string().trim().min(1).max(120).nullable(),
    guardianRelationship: z.string().trim().min(1).max(80).nullable(),
    authorityConfirmed: z.literal(true),
  })
  .strict();
export const OnlineIntake = z
  .object({
    version: z.number().int().min(0),
    consentVersion: z.literal(ONLINE_CONSENT_VERSION),
    agreed: z.literal(true),
    identity: OnlineIdentity,
  })
  .strict();
export const OnlineVersion = z.object({ version: z.number().int().min(0) }).strict();
export const OnlineCall = OnlineVersion.extend({
  meetingUrl: z
    .string()
    .max(1000)
    .refine(isMeetingUrl, 'Use a direct HTTPS Google Meet, Zoom or Teams meeting URL.')
    .nullable(),
  callPhone: z
    .string()
    .regex(/^\+91[6-9]\d{9}$/)
    .nullable(),
}).strict();
export const OnlineVerify = OnlineVersion.extend({
  identityConfirmed: z.literal(true),
  ageConfirmed: z.literal(true),
  guardianConfirmed: z.boolean(),
  suitable: z.literal(true),
  method: z.enum(['audio', 'video']),
}).strict();
export const OnlineVisit = z.object({
  appointmentId: z.uuid(),
  version: z.number().int(),
  mode: z.enum(['audio', 'video']),
  enabled: z.boolean(),
  stale: z.boolean(),
  consentVersion: z.literal(ONLINE_CONSENT_VERSION),
  consented: z.boolean(),
  verified: z.boolean(),
  identity: OnlineIdentity.nullable(),
  patient: z.object({
    id: z.uuid(),
    name: z.string(),
    uhid: z.string(),
    dob: z.iso.date().nullable(),
  }),
  meetingUrl: z.string().refine(isMeetingUrl).nullable(),
  callPhone: z
    .string()
    .regex(/^\+91[6-9]\d{9}$/)
    .nullable(),
  provider: z.string().nullable(),
  joinAvailable: z.boolean(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  doctor: z.object({
    name: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    council: z.string().nullable(),
    qualifications: z.string().nullable(),
    verified: z.boolean(),
  }),
});
export type OnlineVisit = z.infer<typeof OnlineVisit>;
export const OnlineSettings = z.object({ version: z.number().int().min(0), enabled: z.boolean() });
export const OnlineDestination = z.object({
  url: z.string().refine((value) => isMeetingUrl(value) || /^tel:\+91[6-9]\d{9}$/.test(value)),
});
export type OnlineSettings = z.infer<typeof OnlineSettings>;
