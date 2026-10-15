import { ApiError } from '@dhc/api-client';
import type { MessageKey } from '@dhc/i18n';

/** The API's own message (it explains what to do), or a translated fallback. */
export function errorMessage(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return t('error.network');
  return t('error.generic');
}

export const isSixDigitCode = (value: string) => /^\d{6}$/.test(value);
