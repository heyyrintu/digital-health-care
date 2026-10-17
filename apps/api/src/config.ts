import { z } from 'zod';
import { IpAllowlist, parseCidrs } from './plugins/ip-allowlist';

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
    JWT_SECRET: z.string().min(32).optional(),
    /** 32 bytes, base64. */
    FIELD_ENCRYPTION_KEY: z.string().optional(),
    /** `log` prints sign-in codes to the server log; development only, until the SMS provider (O5). */
    OTP_DELIVERY: z.enum(['log', 'disabled']).default('disabled'),
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
     * Comma-separated networks (CIDR, IPv4 or IPv6, or single addresses) that may reach the
     * platform console's `/platform/*` endpoints (PRD §3.3). Empty: none in production,
     * any in development and test.
     */
    PLATFORM_ALLOWED_CIDRS: z
      .string()
      .default('')
      .refine((raw) => parseCidrs(raw) !== null, 'Use CIDRs like 203.0.113.0/24, comma-separated'),
  })
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

/** Who may reach `/platform/*`: the configured networks; with none, nobody in production. */
export function platformAllowlist(
  config: Pick<Config, 'NODE_ENV' | 'PLATFORM_ALLOWED_CIDRS'>,
): IpAllowlist {
  const cidrs = parseCidrs(config.PLATFORM_ALLOWED_CIDRS) ?? [];
  if (cidrs.length > 0) return IpAllowlist.of(cidrs);
  return config.NODE_ENV === 'production' ? IpAllowlist.none() : IpAllowlist.any();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
