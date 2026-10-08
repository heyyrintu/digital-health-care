import { createDb, type Db } from '@dhc/db';
import { createHmac, hkdfSync } from 'node:crypto';
import { FieldCipher } from './auth/field-cipher';
import { TokenService } from './auth/tokens';
import type { Config } from './config';
import { LocalFileStore, type FileStore } from './files';
import { TestKeySigner, type PrescriptionSigner } from './signing/signer';

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
  /**
   * Keyed digest of a signing PIN before it is hashed: a six-digit PIN cannot be guessed
   * offline from a database copy without the server secret.
   */
  pepperPin(userId: string, pin: string): string;
  /** Web app origin for links sent to people (staff invites, prescription QR codes). */
  webBaseUrl: string;
  /** Null when signing is not set up on this server: signing then answers 503. */
  signer: PrescriptionSigner | null;
  files: FileStore;
  now(): Date;
}

export function createServices(
  config: Config,
  overrides: {
    otpSender?: OtpSender;
    now?: () => Date;
    signer?: PrescriptionSigner | null;
    files?: FileStore;
  } = {},
): Services {
  const { DATABASE_URL, JWT_SECRET, FIELD_ENCRYPTION_KEY } = config;
  if (!DATABASE_URL || !JWT_SECRET || !FIELD_ENCRYPTION_KEY) {
    throw new Error('DATABASE_URL, JWT_SECRET and FIELD_ENCRYPTION_KEY are required');
  }
  const otpKey = Buffer.from(hkdfSync('sha256', JWT_SECRET, 'dhc-otp', 'otp-code-hash', 32));
  const pinKey = Buffer.from(hkdfSync('sha256', JWT_SECRET, 'dhc-pin', 'signing-pin', 32));

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
    pepperPin: (userId, pin) =>
      createHmac('sha256', pinKey).update(`${userId}:${pin}`).digest('base64url'),
    webBaseUrl: config.WEB_BASE_URL.replace(/\/+$/, ''),
    signer:
      overrides.signer !== undefined
        ? overrides.signer
        : config.SIGNER === 'test_key'
          ? new TestKeySigner(JWT_SECRET)
          : null,
    files: overrides.files ?? new LocalFileStore(config.FILE_STORE_DIR ?? '.data/files'),
    now: overrides.now ?? (() => new Date()),
  };
}
