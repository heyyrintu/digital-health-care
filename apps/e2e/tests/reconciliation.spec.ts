import { randomUUID } from 'node:crypto';
import { expect, setUpFromInvite, test } from '../fixtures';
test('admin requests a report, reviews discrepancies and reads gross/fees/tax/net with a bank confirmation hint', async ({
  page,
  clinic,
}) => {
  await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
  const runId = randomUUID(),
    issueId = randomUUID(),
    settlementId = randomUUID();
  let completed = false,
    reviewed = false;
  const run = () => ({
    id: runId,
    fromDate: '2026-11-01',
    toDate: '2026-11-01',
    environment: 'sandbox',
    status: completed ? 'succeeded' : 'queued',
    attempts: completed ? 1 : 0,
    eventCount: completed ? 2 : 0,
    settlementCount: completed ? 1 : 0,
    mismatchCount: completed ? 1 : 0,
    createdAt: new Date().toISOString(),
    completedAt: completed ? new Date().toISOString() : null,
    errorCode: null,
  });
  await page.route('**/v1/reconciliation/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    let body: unknown;
    if (path.endsWith('/review')) {
      reviewed = true;
      body = { reviewed: true };
    } else if (path.endsWith('/issues'))
      body = {
        data: completed
          ? [
              {
                id: issueId,
                code: 'unknown_order',
                severity: 'attention',
                providerReference: 'outside-order',
                settlementId: 'CF-SETTLEMENT-1',
                orderId: null,
                paymentId: null,
                appointmentId: null,
                expectedPaise: null,
                reportedPaise: 80000,
                reviewedAt: reviewed ? new Date().toISOString() : null,
                reviewReason: reviewed ? 'external_transaction' : null,
              },
            ]
          : [],
        nextCursor: null,
      };
    else if (path.endsWith('/settlements'))
      body = {
        data: completed
          ? [
              {
                id: settlementId,
                settlementId: 'CF-SETTLEMENT-1',
                status: 'SUCCESS',
                chargingBasis: 'PREPAID',
                utr: 'UTR-SYNTHETIC',
                grossPaise: 80000,
                feesPaise: 1600,
                taxPaise: 288,
                adjustmentPaise: 0,
                netPaise: 78112,
              },
            ]
          : [],
        nextCursor: null,
      };
    else if (path.endsWith('/runs') && method === 'GET')
      body = { enabled: true, runs: { data: [run()], nextCursor: null } };
    else body = { run: run(), unreviewedCount: reviewed ? 0 : 1 };
    await route.fulfill({ json: body });
  });
  await page.goto('/clinic/reconciliation');
  await expect(
    page.getByRole('heading', { name: 'Settlement reconciliation', exact: true }),
  ).toBeVisible();
  await page.getByLabel('From date').fill('2026-11-01');
  await page.getByLabel('To date').fill('2026-11-01');
  await page.getByRole('button', { name: 'Request report', exact: true }).click();
  await expect(page.getByRole('heading', { name: /2026-11-01.*Queued/ })).toBeVisible();
  completed = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Provider transaction has no clinic order' }),
  ).toBeVisible();
  await expect(page.getByText('UTR: UTR-SYNTHETIC')).toBeVisible();
  await expect(page.getByText('₹781.12', { exact: true })).toBeVisible();
  await expect(page.getByText(/Match the UTR with your bank statement/)).toBeVisible();
  await page.getByLabel('Review reason').selectOption('external_transaction');
  await page.getByRole('button', { name: 'Acknowledge review' }).click();
  await expect(page.getByText(/Review acknowledged/)).toBeVisible();
  await expect(
    page.getByText(/It does not change balances or resolve a discrepancy/),
  ).toBeVisible();
});
