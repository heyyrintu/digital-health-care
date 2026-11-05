import { expect, it, vi } from 'vitest';
import { MetaInboxGateway, parseInboxChannels } from './gateway';
const channel = {
  organisationId: '00000000-0000-4000-8000-000000000001',
  senderId: '111',
  businessId: '222',
};
it('refuses ambiguous clinic or sender bindings', () => {
  expect(parseInboxChannels(JSON.stringify([channel]))).toHaveLength(1);
  expect(() =>
    parseInboxChannels(
      JSON.stringify([
        channel,
        { ...channel, organisationId: '00000000-0000-4000-8000-000000000002' },
      ]),
    ),
  ).toThrow();
  expect(() =>
    parseInboxChannels(JSON.stringify([channel, { ...channel, senderId: '333' }])),
  ).toThrow();
});
it('sends text without link previews or implicit templates and correlates provider status', async () => {
  const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 }),
    ),
    g = new MetaInboxGateway('synthetic-token', 'v25.0', fetcher);
  expect(
    await g.send(channel, { id: 'send-id', to: '+919876543210', text: 'Generic reply' }),
  ).toMatchObject({ state: 'accepted', messageId: 'wamid.test' });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://graph.facebook.com/v25.0/111/messages');
  expect(JSON.parse(String(options?.body))).toMatchObject({
    to: '919876543210',
    biz_opaque_callback_data: 'send-id',
    type: 'text',
    text: { preview_url: false, body: 'Generic reply' },
  });
});
it('treats transport errors and malformed success responses as uncertain without retrying', async () => {
  const f = vi.fn<typeof fetch>(async () => {
    throw new Error('Network failed');
  });
  expect(
    await new MetaInboxGateway('token', 'v25.0', f).send(channel, {
      id: 'id',
      to: '+919876543210',
      text: 'Reply',
    }),
  ).toEqual({ state: 'uncertain' });
  expect(f).toHaveBeenCalledTimes(1);
  f.mockImplementationOnce(async () => new Response('{}', { status: 200 }));
  expect(
    (
      await new MetaInboxGateway('token', 'v25.0', f).send(channel, {
        id: 'id2',
        to: '+919876543210',
        text: 'Reply',
      })
    ).state,
  ).toBe('uncertain');
});
it('uses only same-host cursor pagination and refuses incomplete template lists', async () => {
  const template = {
      id: '1',
      name: 'service',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Contact clinic' }],
    },
    f = vi.fn<typeof fetch>();
  f.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        data: [template],
        paging: { next: 'https://untrusted.invalid/token-leak', cursors: { after: 'cursor' } },
      }),
    ),
  ).mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
  const list = await new MetaInboxGateway('secret', 'v25.0', f).templates(channel);
  expect(list).toHaveLength(1);
  expect(String(f.mock.calls[1]![0])).toMatch(
    /^https:\/\/graph.facebook.com\/v25.0\/222\/message_templates\?/,
  );
  expect(String(f.mock.calls[1]![0])).toContain('after=cursor');
  f.mockResolvedValueOnce(new Response(JSON.stringify({ data: [], paging: { next: 'exists' } })));
  await expect(new MetaInboxGateway('secret', 'v25.0', f).templates(channel)).rejects.toThrow(
    'Incomplete',
  );
});
it('sends only the chosen static template name and language; surfaces sanitized provider error codes', async () => {
  const f = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ error: { code: 131047, message: 'Do not expose provider details' } }),
        { status: 400 },
      ),
  );
  const r = await new MetaInboxGateway('token', 'v25.0', f).send(channel, {
    id: 'id',
    to: '+919876543210',
    template: { name: 'service', language: 'hi' },
  });
  expect(r).toEqual({ state: 'failed', errorCode: 131047 });
  expect(JSON.parse(String(f.mock.calls[0]![1]?.body)).template).toEqual({
    name: 'service',
    language: { code: 'hi' },
  });
});
