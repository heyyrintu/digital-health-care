import { expect, pageAlert, test } from '../fixtures';

test('the isolated payment page opens hosted checkout and waits for server verification', async ({
  page,
}) => {
  const token = 'synthetic-pay-only-token';
  let paid = false,
    sdkLoads = 0;
  const info = () => ({
    clinicName: 'Synthetic Clinic',
    amountPaise: 80000,
    currency: 'INR',
    status: paid ? 'paid' : 'active',
    canPay: !paid,
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  });
  await page.route('**/v1/public/payments/' + token + '/check', (route) =>
    route.fulfill({ json: info() }),
  );
  await page.route('**/v1/public/payments/' + token + '/checkout', (route) =>
    route.fulfill({ json: { environment: 'sandbox', paymentSessionId: 'synthetic-session-only' } }),
  );
  await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', (route) => {
    sdkLoads++;
    return route.fulfill({
      contentType: 'application/javascript',
      body: `window.Cashfree = function (config) { return { checkout: async function (options) { window.__syntheticCheckout = { config, options }; return { paymentDetails: 'Browser success is not proof' }; } }; };`,
    });
  });
  const response = await page.goto(`/pay/${token}?status=paid`);
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.getByRole('heading', { name: 'Online payment' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Awaiting payment');
  await expect(page.getByText('Synthetic Clinic', { exact: true })).toBeVisible();
  expect(sdkLoads).toBe(0);
  await page.getByRole('button', { name: 'Pay securely with Cashfree' }).click();
  await expect.poll(() => sdkLoads).toBe(1);
  await expect(page.getByRole('button', { name: 'Pay securely with Cashfree' })).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as Window & { __syntheticCheckout?: unknown }).__syntheticCheckout,
    ),
  ).toEqual({
    config: { mode: 'sandbox' },
    options: { paymentSessionId: 'synthetic-session-only', redirectTarget: '_self' },
  });
  await expect(page.getByRole('status')).toHaveText('Awaiting payment');
  paid = true;
  await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(page.getByRole('status')).toHaveText('Payment confirmed');
  await expect(page.getByRole('button', { name: 'Pay securely with Cashfree' })).toHaveCount(0);
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.getByRole('status')).toHaveText('भुगतान की पुष्टि हो गई');
});

test('an invalid or unavailable payment link offers a retry without loading checkout', async ({
  page,
}) => {
  let sdkLoads = 0;
  await page.route('**/v1/public/payments/synthetic-unavailable/check', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'Payment not found.', requestId: 'synthetic' } },
    }),
  );
  await page.route('https://sdk.cashfree.com/**', (route) => {
    sdkLoads++;
    return route.abort();
  });
  await page.goto('/pay/synthetic-unavailable');
  await expect(pageAlert(page)).toContainText('Unable to continue');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(sdkLoads).toBe(0);
});
