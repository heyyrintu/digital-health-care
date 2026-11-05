import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Db } from '@dhc/db';
import { loadConfig } from './config';
import { reconciliationProcessor } from './reconciliation';
import { processRun } from '@dhc/reconciliation';
vi.mock('@dhc/reconciliation', () => ({
  processRun: vi.fn(),
  scheduleNightly: vi.fn(),
  claimDispatch: vi.fn(),
}));
const organisationId = '00000000-0000-4000-8000-000000000001',
  runId = '00000000-0000-4000-8000-000000000002';
const env = {
  CASHFREE_RECONCILIATION_ENABLED: 'true',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/test',
  CASHFREE_MERCHANTS_JSON: JSON.stringify({
    [organisationId]: {
      clientId: 'synthetic',
      clientSecret: 'synthetic-secret-32-characters',
      environment: 'sandbox',
    },
  }),
};
describe('reconciliation worker boundary', () => {
  it('stays disabled by default and validates enabled accounts and bounded lookback', () => {
    expect(loadConfig({}).CASHFREE_RECONCILIATION_ENABLED).toBe(false);
    expect(() => loadConfig({ CASHFREE_RECONCILIATION_ENABLED: 'true' })).toThrow();
    expect(() => loadConfig({ ...env, CASHFREE_RECONCILIATION_LOOKBACK_DAYS: '32' })).toThrow();
    expect(loadConfig(env).CASHFREE_RECONCILIATION_LOOKBACK_DAYS).toBe(7);
  });
  it('accepts only tenant/run IDs and never permits patient or merchant payload overrides', async () => {
    const processor = reconciliationProcessor({} as Db, loadConfig(env));
    await expect(
      processor({
        name: 'cashfree-reconciliation',
        data: { organisationId, runId, clientSecret: 'private' },
      } as Job),
    ).rejects.toThrow();
    await expect(
      processor({ name: 'cashfree-reconciliation', data: { organisationId, runId } } as Job),
    ).resolves.toBeUndefined();
    expect(processRun).toHaveBeenCalledWith(
      {},
      organisationId,
      runId,
      expect.objectContaining({ clientId: 'synthetic' }),
      expect.anything(),
    );
  });
});
