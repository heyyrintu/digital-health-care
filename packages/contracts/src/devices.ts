import { z } from 'zod';

export const DevicePlatform = z.enum(['ios', 'android']);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** Which store app registered the device (ADR 0004). */
export const AppVariant = z.enum(['clinic', 'patient']);
export type AppVariant = z.infer<typeof AppVariant>;

/** As Expo hands it to the app: `ExponentPushToken[…]` (or `ExpoPushToken[…]`). */
export const ExpoPushToken = z
  .string()
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/, 'Not an Expo push token.');

export const RegisterPushDeviceBody = z.object({
  platform: DevicePlatform,
  appVariant: AppVariant,
  expoPushToken: ExpoPushToken,
  /** What the person calls the device, e.g. "Reception iPad". */
  deviceName: z.string().trim().min(1).max(80).nullable().optional(),
});
export type RegisterPushDeviceBody = z.infer<typeof RegisterPushDeviceBody>;

/**
 * A device that receives push notifications for the signed-in session. The token itself
 * is never returned: it is a delivery address, not something the app needs back.
 */
export const PushDevice = z.object({
  id: z.uuid(),
  platform: DevicePlatform,
  appVariant: AppVariant,
  deviceName: z.string().nullable(),
  /** This request's own session registered it. */
  current: z.boolean(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type PushDevice = z.infer<typeof PushDevice>;

export const PushDeviceList = z.object({ data: z.array(PushDevice) });
export type PushDeviceList = z.infer<typeof PushDeviceList>;
