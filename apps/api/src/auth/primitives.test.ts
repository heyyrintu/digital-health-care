import { describe, expect, it } from 'vitest';
import { FieldCipher } from './field-cipher';
import { hashPassword, verifyPassword } from './password';
import { normaliseIndianMobile } from './phone';
import { TokenService, hashToken, newRefreshToken } from './tokens';
import { base32Decode, base32Encode, otpauthUri, totpAt, verifyTotp } from './totp';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('uses a fresh salt each time and rejects malformed hashes', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('TOTP (RFC 6238 test vectors)', () => {
  // RFC 6238 Appendix B, SHA-1 secret "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('at T=%i gives %s', (t, expected) => {
    expect(totpAt(secret, t, 8)).toBe(expected);
  });

  it('accepts codes within one step of drift and rejects older ones', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(secret, now / 1000);
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, code, now + 30_000)).toBe(true);
    expect(verifyTotp(secret, code, now + 90_000)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
  });

  it('round-trips base32 and builds an otpauth URI', () => {
    const bytes = Buffer.from('hello world!');
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(otpauthUri('DHC', 'dr@example.test', 'ABC')).toMatch(
      /^otpauth:\/\/totp\/DHC%3Adr%40example\.test\?secret=ABC/,
    );
  });
});

describe('FieldCipher', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('round-trips and produces different ciphertext each time', () => {
    const cipher = new FieldCipher(key);
    const a = cipher.encrypt('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(cipher.encrypt('JBSWY3DPEHPK3PXP'));
    expect(cipher.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering and wrong keys', () => {
    const cipher = new FieldCipher(key);
    const value = cipher.encrypt('secret');
    const [v, iv, tag, ct] = value.split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
    expect(() => new FieldCipher(Buffer.alloc(32, 8).toString('base64')).decrypt(value)).toThrow();
    expect(() => new FieldCipher('short')).toThrow();
  });
});

describe('TokenService', () => {
  const tokens = new TokenService('x'.repeat(32));
  const claims = { userId: 'u1', organisationId: 'o1', role: 'doctor' as const, sessionId: 's1' };

  it('round-trips access claims', async () => {
    expect(await tokens.verifyAccessToken(await tokens.createAccessToken(claims))).toEqual(claims);
  });

  it('rejects tokens signed with another key or meant for MFA', async () => {
    const other = new TokenService('y'.repeat(32));
    expect(await tokens.verifyAccessToken(await other.createAccessToken(claims))).toBeNull();
    const mfa = await tokens.createMfaToken('u1', 'o1', 'doctor');
    expect(await tokens.verifyAccessToken(mfa)).toBeNull();
    expect(await tokens.verifyMfaToken(mfa)).toEqual({
      userId: 'u1',
      organisationId: 'o1',
      role: 'doctor',
    });
    expect(await tokens.verifyMfaToken(await tokens.createAccessToken(claims))).toBeNull();
  });

  it('makes unguessable refresh tokens and stable hashes', () => {
    const t = newRefreshToken();
    expect(t).toHaveLength(43);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
  });
});

describe('normaliseIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['91-98765-43210', '+919876543210'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseIndianMobile(input)).toBe(expected);
  });

  it.each(['12345', '5876543210', '+1 415 555 0100', ''])('rejects %s', (input) => {
    expect(normaliseIndianMobile(input)).toBeNull();
  });
});
