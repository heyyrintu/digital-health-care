import { describe, expect, it, vi } from 'vitest';
import { CashfreeReportingGateway, allReportPages, reportPaise, ReportEvent } from './reports';
const merchant = {
  clientId: 'synthetic',
  clientSecret: 'synthetic-secret-123456',
  environment: 'sandbox' as const,
};
describe('bounded read-only Cashfree reporting', () => {
  it('uses fixed report endpoints, API version, filters and opaque cursor; strips personal data', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        cursor: 'next',
        data: [
          {
            event_details: {
              event_id: 17,
              event_type: 'PAYMENT',
              event_status: 'SUCCESS',
              event_amount: '12.10',
              sale_type: 'CREDIT',
              event_currency: 'INR',
              note: 'private',
            },
            customer_details: { customer_phone: 'private' },
            payment_details: { cf_payment_id: 12, bank_account: 'private' },
          },
        ],
      }),
    );
    const gateway = new CashfreeReportingGateway(fetcher);
    const page = await gateway.events(merchant, '2026-11-01', '2026-11-02', null);
    const [url, options] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://sandbox.cashfree.com/pg/recon');
    expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({
      'x-api-version': '2026-01-01',
      'x-client-id': 'synthetic',
    });
    expect(JSON.parse(options.body as string)).toEqual({
      pagination: { limit: 100, cursor: null },
      filters: { start_date: '2026-11-01', end_date: '2026-11-02' },
    });
    expect(page.cursor).toBe('next');
    expect(page.data[0]?.event_details.event_id).toBe('17');
    expect(JSON.stringify(page)).not.toContain('private');
    fetcher.mockResolvedValueOnce(Response.json({ data: [], cursor: null }));
    await gateway.settlements({ ...merchant, environment: 'production' }, 'a', 'b', 'opaque');
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.cashfree.com/pg/settlements');
    await gateway.settlementEvents(merchant, ['settlement-1'], 'opaque');
    expect(fetcher.mock.calls[2]?.[0]).toBe('https://sandbox.cashfree.com/pg/settlement/recon');
  });
  it('does not expose provider errors or retain oversized responses', async () => {
    const bad = new CashfreeReportingGateway(
      async () => new Response('secret bank account', { status: 503 }),
    );
    await expect(bad.events(merchant, 'a', 'b', null)).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'Cashfree reconciliation could not complete',
    });
    const huge = new CashfreeReportingGateway(async () => new Response('x'.repeat(1000001)));
    await expect(huge.events(merchant, 'a', 'b', null)).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
  });
  it('exhausts every page and rejects loops and partial scans', async () => {
    const heart = vi.fn(async () => {}),
      read = vi.fn(async (c: string | null) => ({
        data: [c ?? 'first'],
        cursor: c ? null : 'second',
      }));
    expect(await allReportPages(read, heart)).toEqual(['first', 'second']);
    expect(heart).toHaveBeenCalledTimes(2);
    await expect(allReportPages(async () => ({ data: [], cursor: 'same' }))).rejects.toMatchObject({
      code: 'invalid_report',
    });
    await expect(
      allReportPages(async (c) => {
        if (c) throw new Error('down');
        return { data: ['first'], cursor: 'next' };
      }),
    ).rejects.toThrow('down');
  });
  it('keeps exact signed paise, rejects fractional paise, exponentials and overflow', () => {
    expect(reportPaise('-12.1')).toBe(-1210);
    expect(reportPaise(0)).toBe(0);
    expect(reportPaise('1000000000')).toBe(100000000000);
    for (const n of ['1.001', '1e3', '1000000001', NaN, Infinity])
      expect(() => reportPaise(n)).toThrow();
    expect(
      ReportEvent.safeParse({
        event_details: { event_id: 9007199254740992, event_type: 'PAYMENT' },
      }).success,
    ).toBe(false);
  });
});
