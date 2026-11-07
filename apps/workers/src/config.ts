import { parseMerchants } from '@dhc/cashfree';
import { Redis } from 'ioredis';
import { z } from 'zod';

const Env = z
  .object({
    CASHFREE_RECONCILIATION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CASHFREE_MERCHANTS_JSON: z.string().optional(),
    CASHFREE_RECONCILIATION_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(31).default(7),
    WHATSAPP_REVIEWS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_REVIEW_LINK_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32).regex(/^\S+$/).optional(),
    ),
    WHATSAPP_REVIEW_TEMPLATE: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[a-z0-9_]+$/)
        .optional(),
    ),
    WHATSAPP_REVIEW_TEMPLATE_LANGUAGE: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
        .optional(),
    ),
    WHATSAPP_OPERATIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_OPERATION_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    WHATSAPP_OPERATION_TEMPLATE_LANGUAGE: z
      .string()
      .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
      .optional(),
    WHATSAPP_PAYMENTS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_PAYMENT_LINK_SECRET: z.string().min(32).regex(/^\S+$/).optional(),
    WHATSAPP_PAYMENT_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    WHATSAPP_PAYMENT_TEMPLATE_LANGUAGE: z
      .string()
      .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
      .optional(),
    WHATSAPP_RECORDS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_RECORD_LINK_SECRET: z.string().min(32).regex(/^\S+$/).optional(),
    WHATSAPP_APPOINTMENTS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WHATSAPP_ACCESS_TOKEN: z.string().regex(/^\S+$/).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
    WHATSAPP_GRAPH_API_VERSION: z
      .string()
      .regex(/^v[1-9]\d*\.0$/)
      .optional(),
    WHATSAPP_APPOINTMENT_CONFIRMATION_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    WHATSAPP_APPOINTMENT_REMINDER_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    WHATSAPP_APPOINTMENT_TEMPLATE_LANGUAGE: z
      .string()
      .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
      .optional(),
    WHATSAPP_RECORD_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    WHATSAPP_RECORD_TEMPLATE_LANGUAGE: z
      .string()
      .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
      .optional(),
    WEB_BASE_URL: z.url().default('http://localhost:3000'),
    DATABASE_URL: z.url().optional(),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  })
  .superRefine((env, ctx) => {
    if (env.CASHFREE_RECONCILIATION_ENABLED) {
      if (!env.DATABASE_URL)
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Required for reconciliation',
        });
      try {
        parseMerchants(env.CASHFREE_MERCHANTS_JSON ?? '');
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['CASHFREE_MERCHANTS_JSON'],
          message: 'Configure distinct clinic accounts for reconciliation',
        });
      }
    }
    if (
      !env.WHATSAPP_REVIEWS_ENABLED &&
      !env.WHATSAPP_OPERATIONS_ENABLED &&
      !env.WHATSAPP_APPOINTMENTS_ENABLED &&
      !env.WHATSAPP_RECORDS_ENABLED &&
      !env.WHATSAPP_PAYMENTS_ENABLED
    )
      return;
    for (const key of [
      ...(env.WHATSAPP_REVIEWS_ENABLED
        ? ([
            'WHATSAPP_REVIEW_LINK_SECRET',
            'WHATSAPP_REVIEW_TEMPLATE',
            'WHATSAPP_REVIEW_TEMPLATE_LANGUAGE',
          ] as const)
        : []),
      'DATABASE_URL',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_GRAPH_API_VERSION',
      ...(env.WHATSAPP_OPERATIONS_ENABLED
        ? (['WHATSAPP_OPERATION_TEMPLATE', 'WHATSAPP_OPERATION_TEMPLATE_LANGUAGE'] as const)
        : []),
      ...(env.WHATSAPP_APPOINTMENTS_ENABLED
        ? ([
            'WHATSAPP_APPOINTMENT_CONFIRMATION_TEMPLATE',
            'WHATSAPP_APPOINTMENT_REMINDER_TEMPLATE',
            'WHATSAPP_APPOINTMENT_TEMPLATE_LANGUAGE',
          ] as const)
        : []),
      ...(env.WHATSAPP_PAYMENTS_ENABLED
        ? ([
            'WHATSAPP_PAYMENT_LINK_SECRET',
            'WHATSAPP_PAYMENT_TEMPLATE',
            'WHATSAPP_PAYMENT_TEMPLATE_LANGUAGE',
          ] as const)
        : []),
      ...(env.WHATSAPP_RECORDS_ENABLED
        ? ([
            'WHATSAPP_RECORD_LINK_SECRET',
            'WHATSAPP_RECORD_TEMPLATE',
            'WHATSAPP_RECORD_TEMPLATE_LANGUAGE',
          ] as const)
        : []),
    ] as const) {
      if (!env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Required for enabled WhatsApp messages',
        });
    }
    const url = new URL(env.WEB_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password)
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_BASE_URL'],
        message: 'WhatsApp portal links require HTTPS without credentials',
      });
  });

export type WorkerConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const input = { ...env };
  for (const key of [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_GRAPH_API_VERSION',
  ])
    if (input[key] === '') delete input[key];
  const parsed = Env.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Redis client for BullMQ. BullMQ needs a ready-made client under ESM, and blocking
 * worker commands require `maxRetriesPerRequest: null`. `rediss://` URLs enable TLS.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
