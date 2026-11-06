import { parseMfaPhones, type MfaMode } from './auth/mfa-otp';
import {
  MetaInboxGateway,
  parseInboxChannels,
  type InboxChannelConfig,
  type InboxGateway,
} from './modules/whatsapp-inbox/gateway';
import { parseMerchants, CashfreeHttpGateway, type CashfreeIntegration } from './payments/cashfree';
import { createDb, type Db } from '@dhc/db';
import { createHmac, hkdfSync } from 'node:crypto';
import { FieldCipher } from './auth/field-cipher';
import { PlatformTokenService, TokenService } from './auth/tokens';
import type { Config } from './config';
import { LiveEvents } from './live';
import { LocalFileStore, type FileStore } from './files';
import { PdfRebuilder, pdfRebuildLimits } from './modules/documents/pdf-rebuild';
import {
  RedisQueueProbe,
  queuesNotConfigured,
  type QueueProbe,
} from './modules/platform/queue-health';
import { createOtpSender } from './messaging/otp-sender';
import { TestKeySigner, type PrescriptionSigner } from './signing/signer';

/** Delivers patient sign-in codes. The SMS/WhatsApp provider plugs in here (decision O5). */
export interface OtpSender {
  readonly channel?: 'whatsapp';
  readonly senderId?: string;
  send(phone: string, code: string, deliveryId?: string): Promise<void | { messageId: string }>;
}

export interface Services {
  db: Db;
  staffMfaMode: MfaMode;
  platformMfaMode: MfaMode;
  staffMfaPhones: Record<string, string>;
  platformMfaPhones: Record<string, string>;
  cashfree?: CashfreeIntegration;
  tokens: TokenService;
  /** Platform console tokens: their own audience and key (ADR 0016). */
  platformTokens: PlatformTokenService;
  cipher: FieldCipher;
  otpSender: OtpSender;
  appointmentMessagingSender?: string;
  operationMessagingSender?: string;
  recordMessagingSender?: string;
  paymentMessagingSender?: string;
  paymentLinkSecret?: string;
  recordLinkSecret?: string;
  whatsappWebhook?: {
    appSecret: string;
    verifyToken: string;
    senderId: string;
    businessAccountId: string;
  };
  /** HMAC for OTP codes at rest, keyed separately from JWT signing. */
  whatsappInbox?: { channels: InboxChannelConfig[]; gateway: InboxGateway };
  inboxContactKey(senderId: string, phone: string): string;
  inboxPayloadHash(purpose: string, payload: string): string;
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
  /** Queue changes from the database, for the live queue and waiting-room streams. */
  live: LiveEvents;
  /** Background queues' job counts for the platform console's system health. */
  queues: QueueProbe;
  /** Rebuilds uploaded PDFs in limited worker threads, one queue per process (T27). */
  pdf: PdfRebuilder;
  now(): Date;
}

export function createServices(
  config: Config,
  overrides: {
    otpSender?: OtpSender;
    now?: () => Date;
    signer?: PrescriptionSigner | null;
    files?: FileStore;
    queues?: QueueProbe;
    pdf?: PdfRebuilder;
  } = {},
): Services {
  const { DATABASE_URL, JWT_SECRET, FIELD_ENCRYPTION_KEY } = config;
  if (!DATABASE_URL || !JWT_SECRET || !FIELD_ENCRYPTION_KEY) {
    throw new Error('DATABASE_URL, JWT_SECRET and FIELD_ENCRYPTION_KEY are required');
  }
  const otpKey = Buffer.from(hkdfSync('sha256', JWT_SECRET, 'dhc-otp', 'otp-code-hash', 32));
  const pinKey = Buffer.from(hkdfSync('sha256', JWT_SECRET, 'dhc-pin', 'signing-pin', 32));

  const inboxHashKey = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(FIELD_ENCRYPTION_KEY, 'base64'),
      'dhc-inbox',
      'payload-hash',
      32,
    ),
  );

  const otpSender = overrides.otpSender ?? createOtpSender(config);

  return {
    db: createDb(DATABASE_URL),
    staffMfaMode: config.STAFF_MFA_MODE ?? 'totp',
    platformMfaMode: config.PLATFORM_MFA_MODE ?? 'totp',
    staffMfaPhones: parseMfaPhones(config.STAFF_MFA_PHONES_JSON),
    platformMfaPhones: parseMfaPhones(config.PLATFORM_MFA_PHONES_JSON),
    tokens: new TokenService(JWT_SECRET),
    platformTokens: new PlatformTokenService(JWT_SECRET),
    cipher: new FieldCipher(FIELD_ENCRYPTION_KEY),
    otpSender,
    ...(config.CASHFREE_ENABLED
      ? {
          cashfree: {
            acceptNewPayments: config.CASHFREE_ACCEPT_NEW_PAYMENTS,
            refundsEnabled: config.CASHFREE_REFUNDS_ENABLED,
            reconciliationEnabled: config.CASHFREE_RECONCILIATION_ENABLED,
            prepaidBookingEnabled: config.CASHFREE_PREPAID_BOOKING_ENABLED,
            refundGateway: new CashfreeHttpGateway(),
            merchants: parseMerchants(config.CASHFREE_MERCHANTS_JSON!),
            gateway: new CashfreeHttpGateway(),
            linkSecret: config.CASHFREE_LINK_SECRET!,
            webBaseUrl: config.WEB_BASE_URL,
            notifyUrl: config.CASHFREE_WEBHOOK_URL!,
          },
        }
      : {}),
    operationMessagingSender: config.WHATSAPP_OPERATIONS_ENABLED
      ? config.WHATSAPP_PHONE_NUMBER_ID
      : undefined,
    paymentLinkSecret: config.WHATSAPP_PAYMENT_LINK_SECRET,
    ...(config.WHATSAPP_PAYMENTS_ENABLED
      ? {
          paymentMessagingSender: config.WHATSAPP_PHONE_NUMBER_ID!,
        }
      : {}),
    ...(config.WHATSAPP_RECORDS_ENABLED
      ? {
          recordMessagingSender: config.WHATSAPP_PHONE_NUMBER_ID!,
          recordLinkSecret: config.WHATSAPP_RECORD_LINK_SECRET!,
        }
      : {}),
    ...(config.WHATSAPP_APPOINTMENTS_ENABLED
      ? { appointmentMessagingSender: config.WHATSAPP_PHONE_NUMBER_ID! }
      : {}),
    ...(config.WHATSAPP_WEBHOOK_ENABLED
      ? {
          whatsappWebhook: {
            appSecret: config.WHATSAPP_APP_SECRET!,
            verifyToken: config.WHATSAPP_WEBHOOK_VERIFY_TOKEN!,
            senderId: config.WHATSAPP_PHONE_NUMBER_ID!,
            businessAccountId: config.WHATSAPP_BUSINESS_ACCOUNT_ID!,
          },
        }
      : {}),
    ...(config.WHATSAPP_INBOX_ENABLED
      ? {
          whatsappInbox: {
            channels: parseInboxChannels(config.WHATSAPP_INBOX_CHANNELS_JSON!),
            gateway: new MetaInboxGateway(
              config.WHATSAPP_ACCESS_TOKEN!,
              config.WHATSAPP_GRAPH_API_VERSION!,
            ),
          },
        }
      : {}),
    inboxPayloadHash: (purpose, payload) =>
      createHmac('sha256', inboxHashKey)
        .update(purpose + ':' + payload)
        .digest('hex'),
    inboxContactKey: (sender, phone) =>
      createHmac(
        'sha256',
        Buffer.from(
          hkdfSync(
            'sha256',
            Buffer.from(FIELD_ENCRYPTION_KEY, 'base64'),
            'dhc-inbox',
            'contact-key',
            32,
          ),
        ),
      )
        .update(sender + ':' + phone)
        .digest('hex'),
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
    live: new LiveEvents(DATABASE_URL),
    queues:
      overrides.queues ??
      (config.REDIS_URL ? new RedisQueueProbe(config.REDIS_URL) : queuesNotConfigured),
    pdf: overrides.pdf ?? new PdfRebuilder(pdfRebuildLimits(config.PDF_REBUILD_CONCURRENCY)),
    now: overrides.now ?? (() => new Date()),
  };
}
