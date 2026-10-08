import type { Paise } from './money';

/** Most of one item a bill line may carry. */
export const MAX_LINE_QUANTITY = 99;

/** Most a bill may come to before any discount: ₹1 crore, well inside the database's 32-bit amounts. */
export const MAX_BILL_PAISE = 1_000_000_000;

export type BillStatus = 'due' | 'partly_paid' | 'paid';

export interface BillTotals {
  subtotal: Paise;
  discount: Paise;
  total: Paise;
}

/** The lines come to more than {@link MAX_BILL_PAISE}. */
export class BillTooLargeError extends Error {
  constructor() {
    super('A bill cannot come to more than ₹1,00,00,000');
  }
}

/**
 * A bill's figures (PRD §5.6): the lines' sum, the discount and what the patient owes.
 * The server stores these; the bill screen shows the same numbers while editing.
 */
export function billTotals(
  lines: { unitPaise: Paise; quantity: number }[],
  discountPaise: Paise = 0,
): BillTotals {
  let subtotal = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitPaise) || line.unitPaise < 0) {
      throw new Error('A price must be a non-negative whole number of paise');
    }
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > MAX_LINE_QUANTITY
    ) {
      throw new Error(`A quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}`);
    }
    subtotal += line.unitPaise * line.quantity;
  }
  if (subtotal > MAX_BILL_PAISE) {
    throw new BillTooLargeError();
  }
  if (!Number.isSafeInteger(discountPaise) || discountPaise < 0 || discountPaise > subtotal) {
    throw new Error('A discount must be between nothing and the whole bill');
  }
  return { subtotal, discount: discountPaise, total: subtotal - discountPaise };
}

/** Paid, partly paid or still due, from the amount collected so far. */
export function billStatus(totalPaise: Paise, paidPaise: Paise): BillStatus {
  // A fully discounted bill has nothing to collect, so it is settled.
  if (paidPaise >= totalPaise) return 'paid';
  return paidPaise > 0 ? 'partly_paid' : 'due';
}

/** A receipt number from the clinic's prefix and counter: `R` and 7 → `R00007`. */
export function formatReceiptNumber(prefix: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Receipt numbers start at 1');
  return `${prefix}${String(n).padStart(5, '0')}`;
}
