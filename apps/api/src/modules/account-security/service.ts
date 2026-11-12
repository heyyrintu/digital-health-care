import { STAFF_ROLES, type SecondFactorMethodValue } from '@dhc/contracts';
import { withAuth, withPlatform, type Tx } from '@dhc/db';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../auth/password';
import { normaliseIndianMobile } from '../../auth/phone';
import { matchTotpStep } from '../../auth/totp';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { revokePushDevicesForSessions } from '../devices/revoke';

type Method = SecondFactorMethodValue;
type Audience = 'staff' | 'platform';
type Context = { id: string; organisationId?: string; sessionId?: string };
type Subject = {
  id: string;
  email: string | null;
  phone: string | null;
  passwordHash: string | null;
  mfaSecret: string | null;
  mfaMode: string | null;
  authVersion: number;
  status: string;
  mfaLastUsedStep: number | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
};
const invalid = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The code is invalid or has expired. Start again.');
const unavailable = () =>
  new AppError(
    503,
    'UNAVAILABLE',
    'Verification delivery is not configured. Contact your administrator.',
  );
const denied = () =>
  new AppError(401, 'UNAUTHENTICATED', 'Please check your password and verification code.');
const randomCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Recovery and personal security settings; audience-scoped RLS and purpose-bound codes. */
export class AccountSecurityService {
  constructor(
    private s: Services,
    private audience: Audience,
  ) {}
  private run<T>(fn: (tx: Tx) => Promise<T>) {
    return (this.audience === 'staff' ? withAuth : withPlatform)(this.s.db, fn);
  }
  private async subject(tx: Tx, id: string): Promise<Subject | null> {
    const row =
      this.audience === 'staff'
        ? await tx.user.findUnique({ where: { id } })
        : await tx.platformOperator.findUnique({ where: { id } });
    return row ? { ...row, phone: 'phone' in row ? row.phone : null } : null;
  }
  private async lockedSubject(tx: Tx, id: string) {
    if (this.audience === 'staff')
      await tx.$queryRaw`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM platform_operators WHERE id=${id}::uuid FOR UPDATE`;
    return this.subject(tx, id);
  }
  private method(u: Subject): Method {
    return (u.mfaMode ??
      (this.audience === 'staff' ? this.s.staffMfaMode : this.s.platformMfaMode)) as Method;
  }
  private phone(u: Subject) {
    return (
      ((u.email
        ? (this.audience === 'staff' ? this.s.staffMfaPhones : this.s.platformMfaPhones)[
            u.email.toLowerCase()
          ]
        : undefined) ??
        u.phone) ||
      ''
    );
  }
  private binding(u: Subject, context: Context, purpose: string) {
    return this.s.hashOtp(
      'account-security-binding',
      JSON.stringify([
        this.audience,
        purpose,
        u.id,
        u.authVersion,
        u.passwordHash,
        u.mfaSecret,
        u.email,
        this.phone(u),
        this.method(u),
        context.organisationId ?? null,
        context.sessionId ?? null,
      ]),
    );
  }
  private active(u: Subject | null): u is Subject {
    return Boolean(u?.passwordHash && u.status === 'active');
  }
  private locked(u: Subject) {
    return Boolean(u.lockedUntil && u.lockedUntil > this.s.now());
  }
  private async hasAccess(tx: Tx, context: Context) {
    if (this.audience === 'platform') return true;
    const org = context.organisationId
      ? await tx.organisation.findUnique({ where: { id: context.organisationId } })
      : null;
    return (
      org?.status === 'active' &&
      Boolean(
        await tx.membership.findFirst({
          where: {
            userId: context.id,
            organisationId: org.id,
            status: 'active',
            role: { in: [...STAFF_ROLES] },
          },
        }),
      )
    );
  }
  private async update(
    tx: Tx,
    u: Subject,
    data: {
      passwordHash?: string;
      mfaMode?: string;
      failedLoginCount?: number;
      lockedUntil?: Date | null;
      mfaLastUsedStep?: number;
    },
  ) {
    const where = {
      id: u.id,
      status: 'active' as const,
      passwordHash: u.passwordHash!,
      authVersion: u.authVersion,
    };
    return this.audience === 'staff'
      ? tx.user.updateMany({ where, data })
      : tx.platformOperator.updateMany({ where, data });
  }
  private async failure(tx: Tx, u: Subject) {
    const count = u.failedLoginCount + 1;
    await this.update(
      tx,
      u,
      count >= 5
        ? { failedLoginCount: 0, lockedUntil: new Date(this.s.now().getTime() + 15 * 60_000) }
        : { failedLoginCount: count },
    );
  }
  private async revoke(tx: Tx, u: Subject, reason: string) {
    const now = this.s.now();
    if (this.audience === 'platform')
      await tx.platformSession.updateMany({
        where: { operatorId: u.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
    else {
      const sessions = await tx.session.findMany({
        where: { userId: u.id, revokedAt: null },
        select: { id: true },
      });
      await tx.session.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
      await revokePushDevicesForSessions(
        tx,
        sessions.map((s) => s.id),
        reason,
        now,
      );
    }
  }
  private audit(tx: Tx, request: FastifyRequest, context: Context, action: string) {
    return writeAudit(tx, request, {
      action: `${this.audience === 'platform' ? 'platform.' : ''}auth.${action}`,
      organisationId: context.organisationId ?? null,
      entityType: this.audience === 'platform' ? 'platform_operator' : 'user',
      entityId: context.id,
    });
  }
  private async canRequest(tx: Tx, u: Subject, purpose: string) {
    return (
      (await tx.accountSecurityChallenge.count({
        where: {
          audience: this.audience,
          subjectId: u.id,
          purpose,
          createdAt: { gt: new Date(this.s.now().getTime() - 10 * 60_000) },
        },
      })) < 3
    );
  }
  private send(
    method: Method,
    u: Subject,
    code: string,
    purpose: 'password_reset' | 'second_factor',
  ) {
    if (method === 'email' && u.email && this.s.emailSender?.sendSecurityCode)
      return this.s.emailSender.sendSecurityCode(u.email, code, purpose);
    if (
      method === 'whatsapp' &&
      this.s.otpSender.channel === 'whatsapp' &&
      normaliseIndianMobile(this.phone(u))
    )
      return this.s.otpSender.send(this.phone(u), code).then(() => undefined);
    throw unavailable();
  }
  private matches(id: string, part: string, hash: string | null, code?: string) {
    return Boolean(
      hash &&
      code &&
      timingSafeEqual(Buffer.from(hash), Buffer.from(this.s.hashOtp(`${id}:${part}`, code))),
    );
  }
  private totp(u: Subject, code?: string) {
    if (!u.mfaSecret || !code) return null;
    const step = matchTotpStep(this.s.cipher.decrypt(u.mfaSecret), code, this.s.now().getTime());
    return step !== null && (u.mfaLastUsedStep === null || step > u.mfaLastUsedStep) ? step : null;
  }

  async settings(context: Context) {
    return this.run(async (tx) => {
      const u = await this.subject(tx, context.id);
      if (!this.active(u) || !(await this.hasAccess(tx, context))) throw denied();
      return { method: this.method(u), available: this.options(u) };
    });
  }

  async requestRecovery(request: FastifyRequest, identifier: string, organisation?: string) {
    if (!this.s.emailSender?.sendSecurityCode) throw unavailable();
    const id = randomUUID(),
      code = randomCode(),
      now = this.s.now();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    const found = await this.run(async (tx) => {
      if (this.audience === 'platform') {
        const row = await tx.platformOperator.findUnique({
          where: { email: identifier.trim().toLowerCase() },
        });
        return row ? { id: row.id } : null;
      }
      const org = organisation
        ? await tx.organisation.findUnique({ where: { slug: organisation } })
        : null;
      if (org?.status !== 'active') return null;
      const value = identifier.trim().toLowerCase();
      const phone = normaliseIndianMobile(value);
      const row = value.includes('@')
        ? await tx.user.findUnique({ where: { email: value } })
        : phone
          ? await tx.user.findUnique({ where: { phone } })
          : null;
      return row ? { id: row.id, organisationId: org.id } : null;
    });
    // Same expensive operation for existing and unknown identities. Mail delivery begins
    // only after the route has sent the identical acknowledgement to the browser.
    await verifyPassword('recovery-request-timing', DUMMY_PASSWORD_HASH);
    const pending = found
      ? await this.run(async (tx) => {
          const u = await this.lockedSubject(tx, found.id);
          if (
            !this.active(u) ||
            !u.email ||
            !(await this.hasAccess(tx, found)) ||
            !(await this.canRequest(tx, u, 'recovery'))
          )
            return null;
          await tx.accountSecurityChallenge.create({
            data: {
              id,
              audience: this.audience,
              subjectId: u.id,
              purpose: 'recovery',
              bindingHash: this.binding(u, found, 'recovery'),
              newCodeHash: this.s.hashOtp(`${id}:new`, code),
              createdAt: now,
              expiresAt,
            },
          });
          await this.audit(tx, request, found, 'password_reset.requested');
          return u;
        })
      : null;
    return {
      response: { challengeId: id, expiresAt: expiresAt.toISOString() },
      deliver: async () => {
        if (!pending || !found) return;
        try {
          await this.send('email', pending, code, 'password_reset');
          await this.run((tx) =>
            tx.accountSecurityChallenge.update({
              where: { id },
              data: { deliveredAt: this.s.now() },
            }),
          );
        } catch {
          await this.run(async (tx) => {
            await tx.accountSecurityChallenge.update({
              where: { id },
              data: { consumedAt: this.s.now() },
            });
            await this.audit(tx, request, found, 'password_reset.delivery_failed');
          });
        }
      },
    };
  }

  async confirmRecovery(
    request: FastifyRequest,
    id: string,
    code: string,
    password: string,
    organisation?: string,
  ) {
    const hash = await hashPassword(password);
    const result = await this.run(async (tx) => {
      const row = await tx.accountSecurityChallenge.findUnique({ where: { id } });
      if (!row || row.purpose !== 'recovery') return false;
      const u = await this.lockedSubject(tx, row.subjectId);
      const org =
        this.audience === 'staff' && organisation
          ? await tx.organisation.findUnique({ where: { slug: organisation } })
          : null;
      const context = { id: row.subjectId, ...(org ? { organisationId: org.id } : {}) };
      const current = await tx.accountSecurityChallenge.findUniqueOrThrow({ where: { id } });
      if (
        !this.active(u) ||
        !(await this.hasAccess(tx, context)) ||
        current.consumedAt ||
        !current.deliveredAt ||
        current.expiresAt <= this.s.now() ||
        current.attempts >= 5 ||
        current.bindingHash !== this.binding(u, context, 'recovery')
      )
        return false;
      if (!this.matches(id, 'new', current.newCodeHash, code)) {
        await tx.accountSecurityChallenge.update({
          where: { id },
          data: { attempts: { increment: 1 } },
        });
        return false;
      }
      await tx.accountSecurityChallenge.update({
        where: { id },
        data: { consumedAt: this.s.now() },
      });
      const updated = await this.update(tx, u, {
        passwordHash: hash,
        failedLoginCount: 0,
        lockedUntil: null,
      });
      if (updated.count !== 1) return false;
      await this.revoke(tx, u, 'password_reset');
      await this.audit(tx, request, context, 'password_reset.succeeded');
      return true;
    });
    if (!result) throw invalid();
  }

  async requestChange(request: FastifyRequest, context: Context, password: string, target: Method) {
    const found = await this.run((tx) => this.subject(tx, context.id));
    const passwordOk = await verifyPassword(password, found?.passwordHash ?? DUMMY_PASSWORD_HASH);
    const id = randomUUID(),
      oldCode = randomCode(),
      newCode = randomCode(),
      now = this.s.now();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    const result = await this.run(async (tx) => {
      const u = await this.lockedSubject(tx, context.id);
      if (!this.active(u) || !(await this.hasAccess(tx, context)) || this.locked(u)) return null;
      if (!passwordOk || u.passwordHash !== found?.passwordHash) {
        await this.failure(tx, u);
        return null;
      }
      const options = this.options(u);
      if (!options.includes(target) || target === this.method(u))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Choose an available, different verification method.',
        );
      if (!(await this.canRequest(tx, u, 'mfa_change')))
        throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again in ten minutes.');
      await tx.accountSecurityChallenge.create({
        data: {
          id,
          audience: this.audience,
          subjectId: u.id,
          purpose: 'mfa_change',
          targetMode: target,
          bindingHash: this.binding(u, context, 'mfa_change'),
          oldCodeHash: this.s.hashOtp(`${id}:old`, oldCode),
          newCodeHash: this.s.hashOtp(`${id}:new`, newCode),
          createdAt: now,
          expiresAt,
        },
      });
      await this.audit(tx, request, context, 'security.change_requested');
      return u;
    });
    if (!result) throw denied();
    try {
      const current = this.method(result);
      if (current === 'email' || current === 'whatsapp')
        await this.send(current, result, oldCode, 'second_factor');
      if (target === 'email' || target === 'whatsapp')
        await this.send(target, result, newCode, 'second_factor');
      await this.run((tx) =>
        tx.accountSecurityChallenge.update({ where: { id }, data: { deliveredAt: this.s.now() } }),
      );
    } catch {
      await this.run((tx) =>
        tx.accountSecurityChallenge.update({ where: { id }, data: { consumedAt: this.s.now() } }),
      );
      throw unavailable();
    }
    return {
      challengeId: id,
      expiresAt: expiresAt.toISOString(),
      currentMethod: this.method(result),
      targetMethod: target,
    };
  }
  private options(u: Subject): Method[] {
    return [
      'disabled',
      ...(u.mfaSecret ? ['totp'] : []),
      ...(u.email && this.s.emailSender?.sendSecurityCode ? ['email'] : []),
      ...(normaliseIndianMobile(this.phone(u)) && this.s.otpSender.channel === 'whatsapp'
        ? ['whatsapp']
        : []),
    ] as Method[];
  }
  async confirmChange(
    request: FastifyRequest,
    context: Context,
    id: string,
    currentCode?: string,
    newCode?: string,
  ) {
    const ok = await this.run(async (tx) => {
      const u = await this.lockedSubject(tx, context.id);
      if (!this.active(u) || this.locked(u) || !(await this.hasAccess(tx, context))) return false;
      const row = await tx.accountSecurityChallenge.findUnique({ where: { id } });
      if (
        !row ||
        row.subjectId !== u.id ||
        row.purpose !== 'mfa_change' ||
        !row.targetMode ||
        row.consumedAt ||
        !row.deliveredAt ||
        row.attempts >= 5 ||
        row.expiresAt <= this.s.now() ||
        row.bindingHash !== this.binding(u, context, 'mfa_change')
      )
        return false;
      const current = this.method(u),
        target = row.targetMode as Method;
      const step =
        current === 'totp'
          ? this.totp(u, currentCode)
          : target === 'totp'
            ? this.totp(u, newCode)
            : null;
      const oldOk =
        current === 'disabled' ||
        (current === 'totp'
          ? step !== null
          : this.matches(id, 'old', row.oldCodeHash, currentCode));
      const newOk =
        target === 'disabled' ||
        (target === 'totp' ? step !== null : this.matches(id, 'new', row.newCodeHash, newCode));
      if (!oldOk || !newOk) {
        await tx.accountSecurityChallenge.update({
          where: { id },
          data: { attempts: { increment: 1 } },
        });
        await this.failure(tx, u);
        return false;
      }
      await tx.accountSecurityChallenge.update({
        where: { id },
        data: { consumedAt: this.s.now() },
      });
      const updated = await this.update(tx, u, {
        mfaMode: target,
        failedLoginCount: 0,
        lockedUntil: null,
        ...(step !== null ? { mfaLastUsedStep: step } : {}),
      });
      if (updated.count !== 1) return false;
      await this.revoke(tx, u, 'security_changed');
      await this.audit(tx, request, context, 'security.changed');
      return true;
    });
    if (!ok) throw invalid();
  }
}
