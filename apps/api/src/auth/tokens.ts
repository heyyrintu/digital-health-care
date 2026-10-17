import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export type Role = 'patient' | 'doctor' | 'front_desk' | 'clinic_admin';

export interface AccessClaims {
  userId: string;
  organisationId: string;
  role: Role;
  sessionId: string;
}

const ISSUER = 'dhc-api';
const ACCESS_AUDIENCE = 'dhc';
const MFA_AUDIENCE = 'dhc-mfa';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const MFA_TOKEN_TTL_SECONDS = 5 * 60;

/** Signs short-lived JWTs. HS256 for now; a key set with `kid` comes with key rotation. */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
    this.key = new TextEncoder().encode(secret);
  }

  async createAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ org: claims.organisationId, role: claims.role, sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: ACCESS_AUDIENCE,
        algorithms: ['HS256'],
      });
      const { sub, org, role, sid } = payload;
      if (
        typeof sub !== 'string' ||
        typeof org !== 'string' ||
        typeof sid !== 'string' ||
        !isRole(role)
      )
        return null;
      return { userId: sub, organisationId: org, role, sessionId: sid };
    } catch {
      return null;
    }
  }

  /** Proves the password step passed; only exchangeable for tokens with a valid TOTP code. */
  async createMfaToken(userId: string, organisationId: string, role: Role): Promise<string> {
    return new SignJWT({ org: organisationId, role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(MFA_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${MFA_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verifyMfaToken(
    token: string,
  ): Promise<{ userId: string; organisationId: string; role: Role } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: MFA_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.org !== 'string' ||
        !isRole(payload.role)
      )
        return null;
      return { userId: payload.sub, organisationId: payload.org, role: payload.role };
    } catch {
      return null;
    }
  }
}

export function isRole(value: unknown): value is Role {
  return (
    value === 'patient' || value === 'doctor' || value === 'front_desk' || value === 'clinic_admin'
  );
}

/** Opaque refresh token; only its SHA-256 hash is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export interface PlatformAccessClaims {
  operatorId: string;
  sessionId: string;
}

const PLATFORM_AUDIENCE = 'dhc-platform';
const PLATFORM_MFA_AUDIENCE = 'dhc-platform-mfa';

/**
 * Platform console tokens (ADR 0016). A separate audience and a separate key (derived from
 * the JWT secret), so a clinic token never verifies here and a platform token never
 * verifies as a clinic one, even if one side forgot to check the audience.
 */
export class PlatformTokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
    this.key = new Uint8Array(hkdfSync('sha256', secret, 'dhc-platform', 'platform-jwt', 32));
  }

  async createAccessToken(claims: PlatformAccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.operatorId)
      .setIssuer(ISSUER)
      .setAudience(PLATFORM_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<PlatformAccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: PLATFORM_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return { operatorId: payload.sub, sessionId: payload.sid };
    } catch {
      return null;
    }
  }

  /** Proves the password step passed; only exchangeable for tokens with a valid TOTP code. */
  async createMfaToken(operatorId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(operatorId)
      .setIssuer(ISSUER)
      .setAudience(PLATFORM_MFA_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${MFA_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verifyMfaToken(token: string): Promise<{ operatorId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: PLATFORM_MFA_AUDIENCE,
        algorithms: ['HS256'],
      });
      return typeof payload.sub === 'string' ? { operatorId: payload.sub } : null;
    } catch {
      return null;
    }
  }
}
