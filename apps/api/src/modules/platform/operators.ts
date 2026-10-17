import { NewPassword } from '@dhc/contracts';
import { withPlatform } from '@dhc/db';
import { hashPassword } from '../../auth/password';
import type { FieldCipher } from '../../auth/field-cipher';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';

/** Authenticator apps show this as the account's issuer. */
export const PLATFORM_TOTP_ISSUER = 'DHC Platform';

const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

export interface SupportTrail {
  /** Ticket recording the request and approval. */
  ticket: string;
  /** Who runs the command. */
  operator: string;
}

function checkTrail(trail: SupportTrail): SupportTrail {
  const ticket = trail.ticket.trim();
  const operator = trail.operator.trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(ticket)) {
    throw invalid('ticket', 'Give the support ticket ID (3–40 letters, digits, . _ -).');
  }
  if (operator.length < 3 || operator.length > 80) {
    throw invalid('operator', 'Give your name or email (3–80 characters).');
  }
  return { ticket, operator };
}

export function normaliseOperatorEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  // 80 characters at most: the email is what verifications record as the operator.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 80) {
    throw invalid('email', 'Give the operator’s work email (at most 80 characters).');
  }
  return email;
}

export interface CreateOperatorParams extends SupportTrail {
  email: string;
  displayName: string;
  password: string;
  /** Base32 secret the new operator has already confirmed with a code from their app. */
  totpSecret: string;
}

/**
 * Creates a platform operator (docs/runbooks/platform-operators.md). Only the support
 * command calls this: there is no HTTP route that creates or changes operators.
 */
export async function createPlatformOperator(
  s: Pick<Services, 'db' | 'now'> & { cipher: FieldCipher },
  source: AuditSource,
  params: CreateOperatorParams,
): Promise<{ id: string; email: string }> {
  const trail = checkTrail(params);
  const email = normaliseOperatorEmail(params.email);
  const displayName = params.displayName.trim();
  if (displayName.length < 2 || displayName.length > 120) {
    throw invalid('displayName', 'Give the operator’s name (2–120 characters).');
  }
  const password = NewPassword.safeParse(params.password);
  if (!password.success) {
    throw invalid('password', password.error.issues[0]?.message ?? 'Choose a longer password.');
  }
  const passwordHash = await hashPassword(password.data);
  const now = s.now();

  return withPlatform(s.db, async (tx) => {
    if (await tx.platformOperator.findUnique({ where: { email }, select: { id: true } })) {
      throw new AppError(409, 'CONFLICT', 'An operator with that email already exists.', {
        email: 'exists',
      });
    }
    const created = await tx.platformOperator.create({
      data: {
        email,
        displayName,
        passwordHash,
        mfaSecret: s.cipher.encrypt(params.totpSecret),
        createdAt: now,
      },
      select: { id: true, email: true },
    });
    await writeAudit(tx, source, {
      action: 'platform.operator.created',
      entityType: 'platform_operator',
      entityId: created.id,
      metadata: { ...trail },
    });
    return created;
  });
}

/** Disables an operator and ends their console sessions at once (offboarding). */
export async function disablePlatformOperator(
  s: Pick<Services, 'db' | 'now'>,
  source: AuditSource,
  params: SupportTrail & { email: string },
): Promise<{ id: string; sessionsRevoked: number }> {
  const trail = checkTrail(params);
  const email = normaliseOperatorEmail(params.email);
  const now = s.now();
  return withPlatform(s.db, async (tx) => {
    const operator = await tx.platformOperator.findUnique({ where: { email } });
    if (!operator) throw new AppError(404, 'NOT_FOUND', 'No operator with that email.');
    await tx.platformOperator.update({ where: { id: operator.id }, data: { status: 'disabled' } });
    const revoked = await tx.platformSession.updateMany({
      where: { operatorId: operator.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'operator_disabled' },
    });
    await writeAudit(tx, source, {
      action: 'platform.operator.disabled',
      entityType: 'platform_operator',
      entityId: operator.id,
      metadata: { ...trail, sessionsRevoked: revoked.count },
    });
    return { id: operator.id, sessionsRevoked: revoked.count };
  });
}
