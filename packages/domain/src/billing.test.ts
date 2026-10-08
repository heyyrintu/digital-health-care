import { describe, expect, it } from 'vitest';
import { billStatus, billTotals, formatReceiptNumber } from './billing';

describe('billTotals', () => {
  it('adds the lines and takes off the discount', () => {
    expect(
      billTotals(
        [
          { unitPaise: 80000, quantity: 1 },
          { unitPaise: 15000, quantity: 2 },
        ],
        10000,
      ),
    ).toEqual({ subtotal: 110000, discount: 10000, total: 100000 });
  });

  it('allows an empty or fully discounted bill', () => {
    expect(billTotals([])).toEqual({ subtotal: 0, discount: 0, total: 0 });
    expect(billTotals([{ unitPaise: 50000, quantity: 1 }], 50000).total).toBe(0);
  });

  it('rejects a discount above the bill, fractions and bad quantities', () => {
    expect(() => billTotals([{ unitPaise: 100, quantity: 1 }], 101)).toThrow(/discount/);
    expect(() => billTotals([{ unitPaise: 100.5, quantity: 1 }])).toThrow(/price/);
    expect(() => billTotals([{ unitPaise: 100, quantity: 0 }])).toThrow(/quantity/);
    expect(() => billTotals([{ unitPaise: 100, quantity: 100 }])).toThrow(/quantity/);
    expect(() => billTotals([{ unitPaise: 100, quantity: 1.5 }])).toThrow(/quantity/);
  });
});

describe('billStatus', () => {
  it('follows the amount collected', () => {
    expect(billStatus(80000, 0)).toBe('due');
    expect(billStatus(80000, 30000)).toBe('partly_paid');
    expect(billStatus(80000, 80000)).toBe('paid');
    // A fully discounted bill has nothing left to collect.
    expect(billStatus(0, 0)).toBe('paid');
  });
});

describe('formatReceiptNumber', () => {
  it('pads the counter after the prefix', () => {
    expect(formatReceiptNumber('R', 7)).toBe('R00007');
    expect(formatReceiptNumber('GC-', 123456)).toBe('GC-123456');
    expect(() => formatReceiptNumber('R', 0)).toThrow();
  });
});
