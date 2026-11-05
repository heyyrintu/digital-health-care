import { describe, expect, it } from 'vitest';
import { createRecordLinkToken, verifyRecordLinkToken } from './index';

const secret = 'synthetic-record-link-secret-at-least-32-characters';
const id = '12345678-1234-4234-8234-123456789abc';
const now = new Date('2026-11-04T14:00:00Z');
const expiry = new Date('2026-11-04T15:00:00Z');
describe('authenticated-navigation link signatures', () => {
  it('binds only an opaque delivery ID and expiry, and expires exactly at the boundary', () => {
    const token = createRecordLinkToken(id, expiry, secret);
    expect(verifyRecordLinkToken(token, secret, now)).toEqual({
      deliveryId: id,
      expiresAt: expiry.getTime() / 1000,
    });
    expect(verifyRecordLinkToken(token, secret, expiry)).toBeNull();
    expect(token).not.toMatch(/phone|patient|prescription|document|referral/);
  });
  it('rejects altered IDs, expiry, signature, secret, versions and oversized input', () => {
    const token = createRecordLinkToken(id, expiry, secret);
    for (const bad of [
      token.replace('12345678', '22345678'),
      token.replace(String(expiry.getTime() / 1000), '999999999999'),
      token.slice(0, -2) + '!!',
      token.replace('v1.', 'v2.'),
      token + '.',
      'x'.repeat(200),
    ]) {
      expect(verifyRecordLinkToken(bad, secret, now)).toBeNull();
    }
    expect(verifyRecordLinkToken(token, secret + 'different', now)).toBeNull();
    expect(verifyRecordLinkToken(token, 'short', now)).toBeNull();
  });
  it('refuses unsafe signing inputs', () => {
    expect(() => createRecordLinkToken('../other', expiry, secret)).toThrow();
    expect(() => createRecordLinkToken(id, expiry, 'short')).toThrow();
    expect(() => createRecordLinkToken(id, new Date('bad'), secret)).toThrow();
  });
});
