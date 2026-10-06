import { createDb, type Db } from '@dhc/db';
import { createHmac, hkdfSync } from 'node:crypto';
import { FieldCipher } from './auth/field-cipher';
import { TokenService } from './auth/tokens';
import type { Config } from './config';

/** Delivers patient sign-in codes. The SMS/WhatsApp provider plugs in here (decision O5). */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

export interface Services {
  db: Db;
  tokens: TokenService;
  cipher: FieldCipher;
  otpSender: OtpSender;
  /** HMAC for OTP codes at rest, keyed separately from JWT signing. */
  hashOtp(challengeId: string, code: string): string;
  now(): Date;
}

export function createServices(
  config: Config,
  overrides: { otpSender?: OtpSender; now?: () => Date } = {},
): Services {
  const { DATABASE_URL, JWT_SECRET, FIELD_ENCRYPTION_KEY } = config;
  if (!DATABASE_URL || !JWT_SECRET || !FIELD_ENCRYPTION_KEY) {
    throw new Error('DATABASE_URL, JWT_SECRET and FIELD_ENCRYPTION_KEY are required');
  }
  const otpKey = Buffer.from(hkdfSync('sha256', JWT_SECRET, 'dhc-otp', 'otp-code-hash', 32));

  const otpSender: OtpSender =
    overrides.otpSender ??
    (config.OTP_DELIVERY === 'log'
      ? {
          send: async (phone, code) =>
            console.warn(`[DEV ONLY] Sign-in code for ${phone}: ${code}`),
        }
      : {
          send: async () => {
            throw new Error('No OTP delivery configured');
          },
        });

  return {
    db: createDb(DATABASE_URL),
    tokens: new TokenService(JWT_SECRET),
    cipher: new FieldCipher(FIELD_ENCRYPTION_KEY),
    otpSender,
    hashOtp: (challengeId, code) =>
      createHmac('sha256', otpKey).update(`${challengeId}:${code}`).digest('base64url'),
    now: overrides.now ?? (() => new Date()),
  };
}
