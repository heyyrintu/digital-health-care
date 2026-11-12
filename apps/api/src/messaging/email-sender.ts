import nodemailer from 'nodemailer';
import type { Config } from '../config';
import { AppError } from '../errors';
export interface EmailSender {
  sendVerification(email: string, code: string): Promise<void>;
  sendSecurityCode?(
    email: string,
    code: string,
    purpose: 'password_reset' | 'second_factor',
  ): Promise<void>;
}
export function createEmailSender(config: Config): EmailSender | undefined {
  if (!config.STAFF_EMAIL_VERIFICATION_ENABLED) return undefined;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    requireTLS: true,
    auth: { user: config.SMTP_USER!, pass: config.SMTP_PASSWORD! },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    tls: { minVersion: 'TLSv1.2' },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async sendSecurityCode(email, code, purpose) {
      try {
        const result = await transport.sendMail({
          from: config.SMTP_FROM,
          to: email,
          subject:
            purpose === 'password_reset'
              ? 'Reset your Digital Healthcare password'
              : 'Your Digital Healthcare verification code',
          text: `Your verification code is ${code}. It expires in five minutes. Do not share this code. If you did not request this, ignore the message and contact your clinic.`,
        });
        if (result.rejected?.length || !result.accepted?.length) throw new Error('Not accepted');
      } catch {
        throw new AppError(
          503,
          'UNAVAILABLE',
          'Verification delivery is unavailable. Please try again later.',
        );
      }
    },
    async sendVerification(email, code) {
      try {
        const result = await transport.sendMail({
          from: config.SMTP_FROM,
          to: email,
          subject: 'Confirm your clinic account email change',
          text: `A clinic administrator requested this email address for your staff account. Your verification code is ${code}. It expires in 10 minutes. Sign in to your existing clinic account and open Your account to confirm the change. Do not give this code or your password to anyone. If you did not request this, ignore the message and contact your clinic.`,
        });
        if (result.rejected?.length || !result.accepted?.length) throw new Error('Not accepted');
      } catch {
        throw new AppError(
          503,
          'UNAVAILABLE',
          'Email verification could not be sent. Contact your administrator.',
        );
      }
    },
  };
}
