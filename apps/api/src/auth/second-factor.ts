import type { SecondFactorMethodValue } from '@dhc/contracts';
import type { Services } from '../services';
import { normaliseIndianMobile } from './phone';

type Identity = { email: string | null; phone: string | null; mfaSecret: string | null };
export function availableSecondFactors(
  s: Services,
  audience: 'staff' | 'platform',
  u: Identity,
): SecondFactorMethodValue[] {
  const mappings = audience === 'staff' ? s.staffMfaPhones : s.platformMfaPhones;
  const phone = (u.email ? mappings[u.email.toLowerCase()] : undefined) ?? u.phone ?? '';
  const methods: SecondFactorMethodValue[] = ['disabled'];
  if (u.mfaSecret) methods.push('totp');
  if (u.email && s.emailSender?.sendSecurityCode) methods.push('email');
  if (s.otpSender.channel === 'whatsapp' && normaliseIndianMobile(phone)) methods.push('whatsapp');
  return methods;
}

export function staffSignInReady(
  s: Services,
  u: Identity & { status: string; passwordHash: string | null; mfaMode: string | null },
) {
  return (
    u.status === 'active' &&
    Boolean(u.passwordHash) &&
    availableSecondFactors(s, 'staff', u).includes(
      (u.mfaMode ?? s.staffMfaMode) as SecondFactorMethodValue,
    )
  );
}
