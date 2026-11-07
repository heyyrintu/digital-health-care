import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN = new RegExp(`^v1\\.(${UUID})\\.([0-9]{1,12})\\.([A-Za-z0-9_-]{43})$`);
const signature = (payload: string, secret: string) =>
  createHmac('sha256', secret)
    .update('dhc-record-navigation:' + payload)
    .digest('base64url');

/** Navigation only: the API must independently authenticate and authorize every access. */
export function createRecordLinkToken(deliveryId: string, expiresAt: Date, secret: string): string {
  if (
    !new RegExp(`^${UUID}$`).test(deliveryId) ||
    secret.length < 32 ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    throw new Error('Invalid record link configuration');
  }
  const expiry = Math.floor(expiresAt.getTime() / 1000);
  if (expiry < 1 || expiry > 253402300799) throw new Error('Invalid record link expiry');
  const payload = `v1.${deliveryId}.${expiry}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyRecordLinkToken(
  token: string,
  secret: string,
  now = new Date(),
): { deliveryId: string; expiresAt: number } | null {
  if (secret.length < 32 || token.length > 180 || !Number.isFinite(now.getTime())) return null;
  const match = TOKEN.exec(token);
  if (!match) return null;
  const expiry = Number(match[2]);
  if (expiry > 253402300799 || expiry <= Math.floor(now.getTime() / 1000)) return null;
  const payload = token.slice(0, token.lastIndexOf('.'));
  if (!timingSafeEqual(Buffer.from(match[3]!), Buffer.from(signature(payload, secret))))
    return null;
  return { deliveryId: match[1]!, expiresAt: expiry };
}

const financeSecret = (secret: string) =>
  createHmac('sha256', secret).update('dhc-financial-navigation').digest('hex');
export function createFinanceLinkToken(id: string, expires: Date, secret: string) {
  if (secret.length < 32) throw new Error('Invalid finance link configuration');
  return createRecordLinkToken(id, expires, financeSecret(secret));
}
export function verifyFinanceLinkToken(token: string, secret: string, now = new Date()) {
  return secret.length < 32 ? null : verifyRecordLinkToken(token, financeSecret(secret), now);
}

const reviewSecret = (secret: string) =>
  createHmac('sha256', secret).update('dhc-review-invitation').digest('hex');
export function createReviewLinkToken(id: string, expires: Date, secret: string) {
  if (secret.length < 32) throw new Error('Invalid review link configuration');
  return createRecordLinkToken(id, expires, reviewSecret(secret));
}
export function verifyReviewLinkToken(token: string, secret: string, now = new Date()) {
  return secret.length < 32 ? null : verifyRecordLinkToken(token, reviewSecret(secret), now);
}
