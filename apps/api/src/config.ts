import { z } from 'zod';

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
    /** Comma-separated browser origins allowed to call the API. Defaults to WEB_BASE_URL. */
    CORS_ORIGINS: z.string().optional(),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.OTP_DELIVERY === 'log'), {
    message: 'OTP_DELIVERY=log is not allowed in production',
    path: ['OTP_DELIVERY'],
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
