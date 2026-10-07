/** Amounts are integers in paise everywhere; never floating-point rupees. */
export type Paise = number;

export function rupeesToPaise(rupees: number): Paise {
  const paise = Math.round(rupees * 100);
  assertPaise(paise);
  return paise;
}

export function formatInr(amount: Paise, locale: 'en' | 'hi' = 'en'): string {
  assertPaise(amount);
  return new Intl.NumberFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

function assertPaise(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Amount must be a non-negative whole number of paise');
  }
}
