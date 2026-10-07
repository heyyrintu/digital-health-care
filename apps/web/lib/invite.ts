import type { MessageKey } from '@dhc/i18n';

/** Invite tokens are 32 random bytes in base64url (43 characters). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * Reads the invite token from the URL fragment (`/invite#<token>`). Fragments are never
 * sent to servers or in Referer headers, so the token stays out of every log.
 */
export function readInviteToken(hash: string): string | null {
  const token = decodeURIComponent(hash.replace(/^#/, '')).trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

/** The base32 secret inside an `otpauth://totp/...?secret=...` URI. */
export function secretFromOtpauth(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}

/** `JBSWY3DPEHPK3PXP` → `JBSW Y3DP EHPK 3PXP`, easier to type into an app by hand. */
export function groupKey(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export const MIN_PASSWORD_LENGTH = 12;

export function newPasswordError(password: string, confirm: string): MessageKey | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'invite.passwordTooShort';
  if (password !== confirm) return 'invite.passwordMismatch';
  return null;
}

export function isSixDigitCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
