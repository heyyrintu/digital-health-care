/**
 * Build-time settings (EXPO_PUBLIC_* values are inlined by Metro). One build per environment;
 * EAS profiles set these.
 */
export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_BASE_URL?.trim() || 'http://localhost:4000/v1'
).replace(/\/+$/, '');

/** A white-labelled Patient app build fixes its clinic (build plan §6.10); otherwise empty. */
export const FIXED_ORGANISATION = process.env.EXPO_PUBLIC_ORGANISATION?.trim() || undefined;

/**
 * The published privacy notice and terms of use, opened from onboarding before the patient
 * accepts them. A release build must set both.
 */
export const DOCUMENT_URLS = {
  privacy_notice: process.env.EXPO_PUBLIC_PRIVACY_NOTICE_URL?.trim() || undefined,
  terms: process.env.EXPO_PUBLIC_TERMS_URL?.trim() || undefined,
};
