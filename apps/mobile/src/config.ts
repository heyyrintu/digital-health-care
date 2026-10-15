/**
 * Build-time settings (EXPO_PUBLIC_* values are inlined by Metro). One build per environment;
 * EAS profiles set these.
 */
export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/v1')
  .trim()
  .replace(/\/+$/, '');

/** A white-labelled Patient app build fixes its clinic (build plan §6.10); otherwise empty. */
export const FIXED_ORGANISATION = process.env.EXPO_PUBLIC_ORGANISATION?.trim() || undefined;
