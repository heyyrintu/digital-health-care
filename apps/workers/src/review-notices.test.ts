import { expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { sendReviewNotice } from './review-notices';
import { NoticeSendFailure } from './appointment-notices';
import { verifyReviewLinkToken } from '@dhc/secure-links';
const env = {
  WHATSAPP_REVIEWS_ENABLED: 'true',
  DATABASE_URL: 'postgresql://synthetic@localhost/test',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234',
  WHATSAPP_GRAPH_API_VERSION: 'v25.0',
  WHATSAPP_REVIEW_LINK_SECRET: 'synthetic-review-link-secret-32-characters',
  WHATSAPP_REVIEW_TEMPLATE: 'clinic_honest_review',
  WHATSAPP_REVIEW_TEMPLATE_LANGUAGE: 'en',
  WEB_BASE_URL: 'https://portal.test',
};
const id = '12345678-1234-4234-8234-123456789abc',
  notice = {
    phone: '+919876543210',
    clinic_name: 'Synthetic clinic',
    expires_at: new Date(Date.now() + 86400000),
  };
it('defaults off, accepts blank optional deployment values, and requires complete enabled configuration', () => {
  expect(
    loadConfig({
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_REVIEW_LINK_SECRET: '',
      WHATSAPP_REVIEW_TEMPLATE: '',
      WHATSAPP_REVIEW_TEMPLATE_LANGUAGE: '',
    }).WHATSAPP_REVIEWS_ENABLED,
  ).toBe(false);
  expect(loadConfig(env).WHATSAPP_REVIEWS_ENABLED).toBe(true);
  for (const key of [
    'DATABASE_URL',
    'WHATSAPP_REVIEW_LINK_SECRET',
    'WHATSAPP_REVIEW_TEMPLATE',
    'WHATSAPP_REVIEW_TEMPLATE_LANGUAGE',
    'WHATSAPP_ACCESS_TOKEN',
  ])
    expect(() => loadConfig({ ...env, [key]: undefined })).toThrow();
  expect(() => loadConfig({ ...env, WEB_BASE_URL: 'http://portal.test' })).toThrow();
});
it('sends only the clinic and opaque invitation URL with stable receipt correlation', async () => {
  const f = vi.fn<typeof fetch>(async () =>
    Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'synthetic-message' }] }),
  );
  expect(await sendReviewNotice(loadConfig(env), id, notice, f)).toBe('synthetic-message');
  const request = f.mock.calls[0]![1]!,
    body = JSON.parse(String(request.body));
  expect(body.biz_opaque_callback_data).toBe(id);
  expect(body.template.name).toBe('clinic_honest_review');
  const values = body.template.components[0].parameters.map((p: { text: string }) => p.text);
  expect(values).toHaveLength(2);
  expect(values[0]).toBe('Synthetic clinic');
  const url = new URL(values[1]);
  expect(url.pathname).toBe('/review');
  expect(url.search).toBe('');
  expect(
    verifyReviewLinkToken(url.hash.slice(1), env.WHATSAPP_REVIEW_LINK_SECRET)?.deliveryId,
  ).toBe(id);
  expect(String(request.body)).not.toMatch(/patient|diagnosis|appointment|rating|reason/);
});
it('classifies rejected and uncertain sends without propagating provider or credential details', async () => {
  for (const [status, result] of [
    [400, 'submission_failed'],
    [500, 'uncertain'],
  ] as const) {
    const f = vi.fn<typeof fetch>(async () => new Response('private provider detail', { status }));
    await expect(sendReviewNotice(loadConfig(env), id, notice, f)).rejects.toMatchObject({
      result,
    });
  }
  const f = vi.fn<typeof fetch>(async () => {
    throw new Error('synthetic-token ' + notice.phone);
  });
  try {
    await sendReviewNotice(loadConfig(env), id, notice, f);
    throw new Error('expected failure');
  } catch (e) {
    expect(e).toBeInstanceOf(NoticeSendFailure);
    expect(String(e)).not.toContain('synthetic-token');
    expect(String(e)).not.toContain(notice.phone);
  }
});
