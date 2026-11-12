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
it('sends five-minute recovery and second-factor codes and hides provider failures', async () => {
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  mocks.sendMail.mockResolvedValue({ accepted: ['staff@example.test'], rejected: [] });
  const sender = createEmailSender(
    loadConfig({
      STAFF_EMAIL_VERIFICATION_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '465',
      SMTP_USER: 'synthetic-user',
      SMTP_PASSWORD: 'synthetic-password',
      SMTP_FROM: 'no-reply@example.test',
    }),
  )!;
  await sender.sendSecurityCode!('staff@example.test', '123456', 'password_reset');
  expect(mocks.sendMail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      subject: 'Reset your Digital Healthcare password',
      text: expect.stringContaining('five minutes'),
    }),
  );
  await sender.sendSecurityCode!('staff@example.test', '654321', 'second_factor');
  expect(mocks.sendMail).toHaveBeenLastCalledWith(
    expect.objectContaining({ subject: 'Your Digital Healthcare verification code' }),
  );
  expect(mocks.createTransport).toHaveBeenCalledWith(
    expect.objectContaining({ secure: true, requireTLS: true }),
  );
  mocks.sendMail.mockRejectedValue(new Error('private provider credentials'));
  await expect(
    sender.sendSecurityCode!('staff@example.test', '123456', 'password_reset'),
  ).rejects.toThrow('Verification delivery is unavailable');
  mocks.sendMail.mockResolvedValue({ accepted: [], rejected: ['staff@example.test'] });
  await expect(
    sender.sendSecurityCode!('staff@example.test', '123456', 'second_factor'),
  ).rejects.toThrow('Verification delivery is unavailable');
});
