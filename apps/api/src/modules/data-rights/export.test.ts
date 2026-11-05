import { expect, it } from 'vitest';
import { claimExport } from './export';
const a = { organisationId: 'clinic', userId: 'patient', role: 'patient' as const };
it('limits duplicate and global downloads while the response retains its buffer', () => {
  const first = claimExport(a),
    second = claimExport({ ...a, userId: 'other' });
  try {
    expect(() => claimExport(a)).toThrow();
    expect(() => claimExport({ ...a, userId: 'third' })).toThrow();
  } finally {
    first();
    second();
  }
});
it('an old response firing both finish and close cannot unlock a newer request', () => {
  const old = claimExport(a);
  old();
  const next = claimExport(a);
  try {
    old();
    expect(() => claimExport(a)).toThrow();
  } finally {
    next();
  }
});
