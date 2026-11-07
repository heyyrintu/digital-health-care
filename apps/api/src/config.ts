import { parseMfaPhones } from './auth/mfa-otp';
import { parseInboxChannels } from './modules/whatsapp-inbox/gateway';
import { parseMerchants } from './payments/cashfree';
import { z } from 'zod';
import { IpAllowlist, hasCatchAll, parseCidrs } from './plugins/ip-allowlist';

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    APP_VERSION: z.string().default('0.0.0'),
    DATABASE_URL: z.string().optional(),
    /**
     * The workers' Redis (BullMQ). The API only reads queue counts from it, for the platform
     * console's system health; unset or empty, the queues show as not configured there.
     */
    REDIS_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url({ protocol: /^rediss?$/, error: 'Use a redis:// or rediss:// URL' }).optional(),
    ),
    JWT_SECRET: z.string().min(32).optional(),
    /** 32 bytes, base64. */
    FIELD_ENCRYPTION_KEY: z.string().optional(),
    /** `log` prints sign-in codes to the server log; development only, or use Meta WhatsApp Cloud API. */
    CASHFREE_ACCEPT_NEW_PAYMENTS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    CASHFREE_PREPAID_BOOKING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CASHFREE_RECONCILIATION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CASHFREE_REFUNDS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CASHFREE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CASHFREE_MERCHANTS_JSON: z.string().optional(),
    CASHFREE_LINK_SECRET: z.string().min(32).regex(/^\S+$/).optional(),
    CASHFREE_WEBHOOK_URL: z.url().optional(),
    WHATSAPP_REVIEWS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_REVIEW_LINK_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32).regex(/^\S+$/).optional(),
    ),
    WHATSAPP_OPERATIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_INBOX_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_INBOX_CHANNELS_JSON: z.string().optional(),
    STAFF_EMAIL_VERIFICATION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_HOST: z.string().trim().min(1).optional(),
    SMTP_PORT: z.coerce
      .number()
      .int()
      .refine((p) => p === 465 || p === 587)
      .default(587),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_FROM: z.email().optional(),
    STAFF_MFA_MODE: z.enum(['totp', 'whatsapp', 'disabled']).default('totp'),
    PLATFORM_MFA_MODE: z.enum(['totp', 'whatsapp', 'disabled']).default('totp'),
    /** Operator-controlled recipient maps, keyed by account email, never browser input. */
    STAFF_MFA_PHONES_JSON: z.string().optional(),
    PLATFORM_MFA_PHONES_JSON: z.string().optional(),
    OTP_DELIVERY: z.enum(['log', 'disabled', 'whatsapp']).default('disabled'),
    WHATSAPP_ACCESS_TOKEN: z
      .string()
      .trim()
      .regex(/^[^\s]+$/)
      .optional(),
    WHATSAPP_PAYMENTS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_PAYMENT_LINK_SECRET: z.string().min(32).regex(/^\S+$/).optional(),
    WHATSAPP_RECORDS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_RECORD_LINK_SECRET: z.string().min(32).regex(/^\S+$/).optional(),
    WHATSAPP_APPOINTMENTS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_WEBHOOK_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_APP_SECRET: z.string().min(16).regex(/^\S+$/).optional(),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(32).regex(/^\S+$/).optional(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^\d+$/).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
    // Explicit version: operators choose a supported Graph API version for their Meta app.
    WHATSAPP_GRAPH_API_VERSION: z
      .string()
      .regex(/^v[1-9]\d*\.0$/)
      .optional(),
    WHATSAPP_OTP_TEMPLATE_NAME: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .max(512)
      .optional(),
    WHATSAPP_OTP_TEMPLATE_LANGUAGE: z
      .string()
      .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
      .optional(),
    /** Web app origin; staff invite links point here. */
    WEB_BASE_URL: z.url().default('http://localhost:3000'),
    /** Sign-in requests allowed per client address per minute. */
    SIGN_IN_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(10),
    /** Comma-separated browser origins allowed to call the API. Defaults to WEB_BASE_URL. */
    CORS_ORIGINS: z.string().optional(),
    /**
     * Prescription signing (ADR 0008). `test_key` signs with a key derived from JWT_SECRET,
     * labelled not legally valid: development and staging only, until the cloud DSC provider.
     */
    SIGNER: z.enum(['test_key', 'disabled']).default('disabled'),
    /** Directory for stored files (signed PDFs) until object storage is connected. */
    FILE_STORE_DIR: z.string().default('.data/files'),
    /** How often (seconds) bookings past their grace period become no-shows; 0 turns it off. */
    NO_SHOW_SWEEP_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    /**
     * Proxies in front of the API in production (load balancer, CDN) whose X-Forwarded-For
     * entries are trusted. The client address is the entry this many hops from the right;
     * anything further left was written by the client and is ignored.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    /**
     * Uploaded PDFs rebuilt at once (threat model T27). Each rebuild's worker can use up to
     * about 600 MB of the API's memory on hostile files: size the container for it
     * (runbook `deploy.md`).
     */
    PDF_REBUILD_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    /**
     * Comma-separated networks of those proxies (the load balancer's subnets). When set,
     * X-Forwarded-For is trusted only from a peer inside them. When unset, TRUST_PROXY_HOPS
     * must be 0 unless the API port can be reached only from the load balancer.
     */
    TRUSTED_PROXY_CIDRS: z
      .string()
      .default('')
      .refine((raw) => parseCidrs(raw) !== null, 'Use CIDRs like 10.0.0.0/16, comma-separated'),
    /**
     * Comma-separated networks (CIDR, IPv4 or IPv6, or single addresses) that may reach the
     * platform console's `/platform/*` endpoints (PRD §3.3). `*` allows any address outside
     * production (local development). Empty allows nobody, except under NODE_ENV=test.
     */
    PLATFORM_ALLOWED_CIDRS: z
      .string()
      .default('')
      .refine(
        (raw) => raw.trim() === '*' || parseCidrs(raw) !== null,
        'Use CIDRs like 203.0.113.0/24, comma-separated, or * outside production',
      ),
  })
  .refine(
    (env) =>
      !(
        env.NODE_ENV === 'production' &&
        (env.PLATFORM_ALLOWED_CIDRS.trim() === '*' ||
          hasCatchAll(parseCidrs(env.PLATFORM_ALLOWED_CIDRS) ?? []))
      ),
    {
      message:
        'PLATFORM_ALLOWED_CIDRS=* and catch-all networks (0.0.0.0/0, ::/0) are not allowed in production',
      path: ['PLATFORM_ALLOWED_CIDRS'],
    },
  )
  .superRefine((env, ctx) => {
    if (env.STAFF_EMAIL_VERIFICATION_ENABLED)
      for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const)
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required for staff email verification.',
          });
    for (const key of ['STAFF_MFA_PHONES_JSON', 'PLATFORM_MFA_PHONES_JSON'] as const) {
      try {
        const recipients = parseMfaPhones(env[key]);
        if (
          key === 'PLATFORM_MFA_PHONES_JSON' &&
          env.PLATFORM_MFA_MODE === 'whatsapp' &&
          Object.keys(recipients).length === 0
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Configure at least one platform operator recipient.',
          });
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Map account emails to valid Indian mobile numbers.',
        });
      }
    }
    if (
      (env.STAFF_MFA_MODE === 'whatsapp' || env.PLATFORM_MFA_MODE === 'whatsapp') &&
      env.OTP_DELIVERY !== 'whatsapp'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_DELIVERY'],
        message: 'WhatsApp second factors require OTP_DELIVERY=whatsapp.',
      });
    }
    if (env.PLATFORM_MFA_MODE === 'whatsapp' && !env.PLATFORM_MFA_PHONES_JSON?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLATFORM_MFA_PHONES_JSON'],
        message:
          'Configure each platform operator recipient before enabling WhatsApp second factors.',
      });
    }

    if (env.WHATSAPP_INBOX_ENABLED) {
      for (const key of [
        'WHATSAPP_WEBHOOK_ENABLED',
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_GRAPH_API_VERSION',
      ] as const)
        if (!env[key])
          ctx.addIssue({ code: 'custom', path: [key], message: 'Required for WhatsApp inbox' });
      try {
        const channels = parseInboxChannels(env.WHATSAPP_INBOX_CHANNELS_JSON ?? '');
        if (channels.some((c) => c.senderId === env.WHATSAPP_PHONE_NUMBER_ID))
          ctx.addIssue({
            code: 'custom',
            path: ['WHATSAPP_INBOX_CHANNELS_JSON'],
            message:
              'Inbox numbers must differ from the shared OTP and automated-notification sender',
          });
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['WHATSAPP_INBOX_CHANNELS_JSON'],
          message: 'Configure unique clinic/sender bindings',
        });
      }
    }

    if (
      (env.CASHFREE_REFUNDS_ENABLED ||
        env.CASHFREE_RECONCILIATION_ENABLED ||
        env.CASHFREE_PREPAID_BOOKING_ENABLED) &&
      !env.CASHFREE_ENABLED
    )
      ctx.addIssue({
        code: 'custom',
        path: ['CASHFREE_ENABLED'],
        message: 'Cashfree payment features require the main integration',
      });
    if (env.CASHFREE_ENABLED) {
      try {
        parseMerchants(env.CASHFREE_MERCHANTS_JSON ?? '');
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['CASHFREE_MERCHANTS_JSON'],
          message: 'Configure distinct Cashfree merchant accounts by organisation UUID',
        });
      }
      if (!env.CASHFREE_LINK_SECRET)
        ctx.addIssue({
          code: 'custom',
          path: ['CASHFREE_LINK_SECRET'],
          message: 'Required for payment links',
        });
      for (const key of ['WEB_BASE_URL', 'CASHFREE_WEBHOOK_URL'] as const) {
        let url: URL | null = null;
        try {
          if (env[key]) url = new URL(env[key]);
        } catch {
          /* Report a configuration issue below. */
        }
        if (
          !url ||
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'Payment links require public HTTPS URLs without credentials, queries or fragments',
          });
      }
    }

    if (
      (env.WHATSAPP_REVIEWS_ENABLED ||
        env.WHATSAPP_OPERATIONS_ENABLED ||
        env.WHATSAPP_APPOINTMENTS_ENABLED ||
        env.WHATSAPP_RECORDS_ENABLED ||
        env.WHATSAPP_PAYMENTS_ENABLED) &&
      !env.WHATSAPP_WEBHOOK_ENABLED
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_WEBHOOK_ENABLED'],
        message:
          'Optional WhatsApp messages require callbacks for delivery receipts and STOP replies',
      });
    }
    if (env.WHATSAPP_REVIEWS_ENABLED && !env.WHATSAPP_REVIEW_LINK_SECRET)
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_REVIEW_LINK_SECRET'],
        message: 'Required for review requests',
      });
    if (env.WHATSAPP_WEBHOOK_ENABLED) {
      for (const key of [
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_BUSINESS_ACCOUNT_ID',
      ] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required for WhatsApp status webhooks',
          });
      }
    }
    if (env.WHATSAPP_PAYMENTS_ENABLED && !env.WHATSAPP_PAYMENT_LINK_SECRET)
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_PAYMENT_LINK_SECRET'],
        message: 'Required for payment notices',
      });
    if (env.WHATSAPP_RECORDS_ENABLED && !env.WHATSAPP_RECORD_LINK_SECRET)
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_RECORD_LINK_SECRET'],
        message: 'Required for record links',
      });
    if (env.OTP_DELIVERY !== 'whatsapp') return;
    for (const key of [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_GRAPH_API_VERSION',
      'WHATSAPP_OTP_TEMPLATE_NAME',
      'WHATSAPP_OTP_TEMPLATE_LANGUAGE',
    ] as const) {
      if (!env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Required for WhatsApp OTP delivery',
        });
    }
  })
  // Trusting every address as a proxy is trusting X-Forwarded-For from anyone.
  .refine(
    (env) =>
      !(env.NODE_ENV === 'production' && hasCatchAll(parseCidrs(env.TRUSTED_PROXY_CIDRS) ?? [])),
    {
      message: 'TRUSTED_PROXY_CIDRS must not include a catch-all network in production',
      path: ['TRUSTED_PROXY_CIDRS'],
    },
  )
  .refine((env) => !(env.NODE_ENV === 'production' && env.OTP_DELIVERY === 'log'), {
    message: 'OTP_DELIVERY=log is not allowed in production',
    path: ['OTP_DELIVERY'],
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.SIGNER === 'test_key'), {
    message: 'SIGNER=test_key is not allowed in production',
    path: ['SIGNER'],
  });

export type Config = z.infer<typeof Env>;

/** Origins allowed by CORS: CORS_ORIGINS if set, else the web app's origin. */
export function corsOrigins(config: Pick<Config, 'CORS_ORIGINS' | 'WEB_BASE_URL'>): string[] {
  const raw = config.CORS_ORIGINS ?? config.WEB_BASE_URL;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin);
}

/**
 * Who may reach `/platform/*`: the configured networks. `*` is everyone (refused in
 * production); an empty list is nobody, except under NODE_ENV=test.
 */
export function platformAllowlist(
  config: Pick<Config, 'NODE_ENV' | 'PLATFORM_ALLOWED_CIDRS'>,
): IpAllowlist {
  const raw = config.PLATFORM_ALLOWED_CIDRS.trim();
  if (raw === '*') return config.NODE_ENV === 'production' ? IpAllowlist.none() : IpAllowlist.any();
  const cidrs = parseCidrs(raw) ?? [];
  if (cidrs.length > 0) return IpAllowlist.of(cidrs);
  return config.NODE_ENV === 'test' ? IpAllowlist.any() : IpAllowlist.none();
}

export interface ProxyTrust {
  /** How many proxy hops of X-Forwarded-For to trust. */
  hops: number;
  /** When set, a hop is trusted only if that peer's address is inside these networks. */
  proxies?: IpAllowlist;
}

/** Which proxies' X-Forwarded-For entries to believe: production only, never all of them. */
export function proxyTrust(
  config: Pick<Config, 'NODE_ENV' | 'TRUST_PROXY_HOPS' | 'TRUSTED_PROXY_CIDRS'>,
): ProxyTrust | false {
  if (config.NODE_ENV !== 'production' || config.TRUST_PROXY_HOPS === 0) return false;
  const cidrs = parseCidrs(config.TRUSTED_PROXY_CIDRS) ?? [];
  return {
    hops: config.TRUST_PROXY_HOPS,
    ...(cidrs.length > 0 ? { proxies: IpAllowlist.of(cidrs) } : {}),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const input = { ...env };
  for (const key of [
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_GRAPH_API_VERSION',
    'WHATSAPP_OTP_TEMPLATE_NAME',
    'WHATSAPP_OTP_TEMPLATE_LANGUAGE',
  ]) {
    if (input[key] === '') delete input[key];
  }
  const parsed = Env.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
