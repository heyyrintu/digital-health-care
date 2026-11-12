import { withAuth, withPlatform, type Tx } from '@dhc/db';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import type { Services } from '../services';
import { normaliseIndianMobile } from './phone';
import { hashToken } from './tokens';

export type MfaMode = 'totp' | 'whatsapp' | 'email' | 'disabled';
export interface MfaOtpContext {
  audience: 'staff' | 'platform';
  subjectId: string;
  phone: string;
  method?: 'whatsapp' | 'email';
  authVersion?: number;
  passwordHash: string;
  secret: string | null;
  organisationId?: string;
  role?: string;
}
const unavailable = () =>
  new AppError(
    503,
    'UNAVAILABLE',
    'Second-factor delivery is not available. Contact your administrator.',
  );
export function parseMfaPhones(raw?: string): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const decoded: unknown = JSON.parse(raw);
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      Object.keys(decoded).some((key) => !z.email().safeParse(key).success)
    )
      throw new Error('Invalid mapping keys');
    const source = z.record(z.email(), z.string()).parse(decoded);
    const phones: Record<string, string> = Object.create(null);
    for (const [email, value] of Object.entries(source)) {
      const phone = normaliseIndianMobile(value);
      const key = email.toLowerCase();
      if (!phone || phones[key]) throw new Error('Invalid MFA mapping');
      phones[key] = phone;
    }
    return phones;
  } catch {
    throw new Error(
      'MFA phone mappings must be JSON objects mapping account emails to Indian mobile numbers.',
    );
  }
}
const binding = (s: Services, context: MfaOtpContext) =>
  s.hashOtp(
    'mfa-binding',
    JSON.stringify([
      context.audience,
      context.subjectId,
      context.phone,
      context.method ?? 'whatsapp',
      context.authVersion ?? 0,
      context.passwordHash,
      context.secret,
      context.organisationId ?? null,
      context.role ?? null,
    ]),
  );

/** Called only after password, account, membership and lockout checks pass. */
export async function createMfaOtp(s: Services, tx: Tx, token: string, context: MfaOtpContext) {
  if (
    context.method === 'email'
      ? !z.email().safeParse(context.phone).success || !s.emailSender?.sendSecurityCode
      : !normaliseIndianMobile(context.phone)
  )
    throw unavailable();
  const now = s.now();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa:${context.audience}:${context.subjectId}`}, 0))`;
  const recent = await tx.mfaOtpChallenge.count({
    where: {
      audience: context.audience,
      subjectId: context.subjectId,
      createdAt: { gt: new Date(now.getTime() - 10 * 60_000) },
    },
  });
  if (recent >= 3)
    throw new AppError(
      429,
      'RATE_LIMITED',
      'Too many codes requested. Try again in a few minutes.',
    );
  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await tx.mfaOtpChallenge.create({
    data: {
      id,
      tokenHash: hashToken(token),
      subjectId: context.subjectId,
      audience: context.audience,
      bindingHash: binding(s, context),
      codeHash: s.hashOtp(id, code),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    },
  });
  return { id, code, phone: context.phone, audience: context.audience, method: context.method };
}

/** Provider calls run outside the database transaction. Undelivered codes cannot sign in. */
export async function deliverMfaOtp(
  s: Services,
  pending: Awaited<ReturnType<typeof createMfaOtp>>,
) {
  const run = pending.audience === 'staff' ? withAuth : withPlatform;
  try {
    if (pending.method === 'email')
      await s.emailSender!.sendSecurityCode!(pending.phone, pending.code, 'second_factor');
    else await s.otpSender.send(pending.phone, pending.code);
    await run(s.db, (tx) =>
      tx.mfaOtpChallenge.update({ where: { id: pending.id }, data: { deliveredAt: s.now() } }),
    );
  } catch {
    await run(s.db, (tx) =>
      tx.mfaOtpChallenge.update({ where: { id: pending.id }, data: { consumedAt: s.now() } }),
    );
    throw unavailable();
  }
}

/** Failure is returned, not thrown, so attempt increments commit with the account lockout. */
export async function consumeMfaOtp(
  s: Services,
  tx: Tx,
  token: string,
  code: string,
  context: MfaOtpContext,
): Promise<boolean> {
  const now = s.now();
  const row = await tx.mfaOtpChallenge.findUnique({ where: { tokenHash: hashToken(token) } });
  if (
    !row ||
    row.audience !== context.audience ||
    row.subjectId !== context.subjectId ||
    row.bindingHash !== binding(s, context) ||
    !row.deliveredAt ||
    row.consumedAt ||
    row.expiresAt <= now ||
    row.attempts >= 5
  )
    return false;
  const matches = timingSafeEqual(Buffer.from(row.codeHash), Buffer.from(s.hashOtp(row.id, code)));
  const claimed = await tx.mfaOtpChallenge.updateMany({
    where: {
      id: row.id,
      attempts: row.attempts,
      consumedAt: null,
      deliveredAt: { not: null },
      expiresAt: { gt: now },
    },
    data: matches ? { consumedAt: now } : { attempts: { increment: 1 } },
  });
  return matches && claimed.count === 1;
}
