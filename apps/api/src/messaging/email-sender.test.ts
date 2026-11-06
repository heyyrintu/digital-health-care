import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
import { createEmailSender } from './email-sender';
import { loadConfig } from '../config';
afterEach(() => vi.resetAllMocks());
it('keeps email verification disabled until explicitly configured', () => {
  expect(createEmailSender(loadConfig({}))).toBeUndefined();
  expect(mocks.createTransport).not.toHaveBeenCalled();
  expect(() => loadConfig({ STAFF_EMAIL_VERIFICATION_ENABLED: 'true' })).toThrow();
});
it('uses required TLS, bounded timeouts and a text-only verification message', async () => {
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  mocks.sendMail.mockResolvedValue({ accepted: ['staff@example.test'], rejected: [] });
  const config = loadConfig({
    STAFF_EMAIL_VERIFICATION_ENABLED: 'true',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'synthetic-user',
    SMTP_PASSWORD: 'synthetic-password',
    SMTP_FROM: 'no-reply@example.test',
  });
  await createEmailSender(config)!.sendVerification('staff@example.test', '123456');
  expect(mocks.createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      requireTLS: true,
      secure: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      socketTimeout: 10000,
    }),
  );
  expect(mocks.sendMail).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'staff@example.test',
      from: 'no-reply@example.test',
      text: expect.stringContaining('123456'),
    }),
  );
  mocks.sendMail.mockRejectedValue(new Error('Private provider error'));
  await expect(
    createEmailSender(config)!.sendVerification('staff@example.test', '654321'),
  ).rejects.toThrow('Email verification could not be sent');
});
