import { createDb, type Db } from '@dhc/db';
import { expect, test as base, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, createHmac, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { E2E_FIELD_ENCRYPTION_KEY, E2E_JWT_SECRET } from './env';

const WEB_URL = 'http://localhost:3300';

type StaffRole = 'doctor' | 'front_desk' | 'clinic_admin';

export interface Clinic {
  slug: string;
  name: string;
  /** Invite link for a seeded staff member, by role. */
  inviteLink(role: StaffRole): string;
  email(role: StaffRole): string;
}

/**
 * A fresh clinic per test: organisation, three invited staff and synthetic patients,
 * written straight to the e2e database. Invite tokens are generated here, so each test
 * holds its own links.
 */
async function createClinic(db: Db): Promise<Clinic> {
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const org = await db.organisation.create({ data: { slug, name: `Clinic ${slug}` } });
  const links = new Map<StaffRole, string>();
  const names: Record<StaffRole, string> = {
    clinic_admin: 'Clinic Admin',
    doctor: 'Dr. Synthetic',
    front_desk: 'Front Desk',
  };

  for (const role of Object.keys(names) as StaffRole[]) {
    const user = await db.user.create({
      data: { email: `${role}@${slug}.test`, displayName: names[role] },
    });
    await db.membership.create({
      data: { organisationId: org.id, userId: user.id, role, status: 'invited' },
    });
    const token = randomBytes(32).toString('base64url');
    await db.staffInvite.create({
      data: {
        organisationId: org.id,
        userId: user.id,
        role,
        tokenHash: createHash('sha256').update(token).digest('base64url'),
        createdByUserId: user.id,
        expiresAt: new Date(Date.now() + 72 * 3600_000),
      },
    });
    links.set(role, `${WEB_URL}/invite#${token}`);
  }

  const patients = ['Asha Verma', 'Ravi Mehra', 'Kamla Devi'];
  for (const [i, name] of patients.entries()) {
    await db.patient.create({
      data: { organisationId: org.id, uhid: `E2E-${String(i + 1).padStart(6, '0')}`, name },
    });
  }

  return {
    slug,
    name: org.name,
    inviteLink: (role) => links.get(role)!,
    email: (role) => `${role}@${slug}.test`,
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 code for a base32 secret, `offset` steps from now. */
export function totp(secret: string, offset = 0): string {
  const alphabet = BASE32;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/\s/g, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Completes an invite in the browser and returns the authenticator secret.
 * Ends on the signed-in dashboard.
 */
export async function setUpFromInvite(page: Page, link: string, password: string, offset = 0) {
  await page.goto(link);
  await page.getByLabel('Choose a password').fill(password);
  await page.getByLabel('Type the password again').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.getByTestId('manual-key').innerText()).replace(/\s/g, '');
  await page.getByLabel('6-digit code from your authenticator app').fill(totp(secret, offset));
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(/\/clinic$/);
  await expect(page.getByTestId('signed-in-as')).toBeVisible();
  return secret;
}

/**
 * The doctor's prescription pad and signing PIN in the browser (signed in as the doctor),
 * then the platform team's verification, written straight to the database here. Ends on
 * the doctor's profile page.
 */
export async function setUpPrescriptionPad(
  page: Page,
  db: Db,
  clinic: Clinic,
  { prefix, password, pin }: { prefix: string; password: string; pin: string },
) {
  await page.goto('/clinic/profile');
  const pad = page.getByTestId('profile-form');
  await expect(pad).toContainText('Waiting for verification by the platform team');
  await pad.getByLabel('Registration number').fill('TEST-12345');
  await pad.getByLabel('Medical council').fill('Test Medical Council');
  await pad.getByLabel('Qualifications').fill('MBBS, MS (Ortho)');
  await pad.getByLabel('Prescription number prefix').fill(prefix);
  await pad.getByRole('button', { name: 'Save' }).click();
  await expect(pad.getByRole('status')).toHaveText('Saved.');

  const pinForm = page.getByTestId('pin-form');
  await pinForm.getByLabel('Account password').fill(password);
  await pinForm.getByLabel('New PIN').fill(pin);
  await pinForm.getByLabel('Repeat the PIN').fill(pin);
  await pinForm.getByRole('button', { name: 'Save PIN' }).click();
  await expect(pinForm.getByRole('status')).toHaveText('PIN saved.');
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  await db.doctorProfile.update({
    where: { organisationId_userId: { organisationId: org.id, userId: doctor.id } },
    data: { verification: 'verified', verifiedAt: new Date(), verifiedBy: 'e2e (SUP-1)' },
  });
}

/** A synthetic platform operator's password (named so it reads as test data). */
export const OPERATOR_PASSWORD = 'operator synthetic passphrase';

export interface Operator {
  email: string;
  name: string;
  /** Base32 authenticator key, new for each operator: codes then never collide across tests. */
  totpKey: string;
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/**
 * A platform operator for one test, created with the API's own `createPlatformOperator`
 * (as the support command does; there is no HTTP route) through `apps/api/test/seed-platform-operator.ts`.
 */
async function createOperator(): Promise<Operator> {
  const operator = {
    email: `ops-${randomBytes(4).toString('hex')}@platform.test`,
    name: 'Synthetic Operator',
    totpKey: base32(randomBytes(20)),
  };
  await promisify(execFile)('pnpm', ['exec', 'tsx', 'test/seed-platform-operator.ts'], {
    cwd: fileURLToPath(new URL('../api', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      FIELD_ENCRYPTION_KEY: E2E_FIELD_ENCRYPTION_KEY,
      E2E_OPERATOR_EMAIL: operator.email,
      E2E_OPERATOR_NAME: operator.name,
      E2E_OPERATOR_PASSWORD: OPERATOR_PASSWORD,
      E2E_OPERATOR_TOTP_KEY: operator.totpKey,
    },
  });
  return operator;
}

/** Signs in to the platform console with password and authenticator. Ends on Organisations. */
export async function signInToConsole(page: Page, operator: Operator, offset = 0) {
  await page.goto('/platform/login');
  await page.getByLabel('Work email').fill(operator.email);
  await page.getByLabel('Password').fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page
    .getByLabel('Enter the code from your authenticator app')
    .fill(totp(operator.totpKey, offset));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/platform$/);
  await expect(page.getByTestId('signed-in-as')).toContainText(operator.email);
}

/** A synthetic Indian mobile number, new for each test (the API limits codes per number). */
export const syntheticMobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

/** The API's hash of a sign-in code (`hashOtp` in `apps/api/src/services.ts`), with the e2e secret. */
function otpCodeHash(challengeId: string, code: string): string {
  const key = Buffer.from(hkdfSync('sha256', E2E_JWT_SECRET, 'dhc-otp', 'otp-code-hash', 32));
  return createHmac('sha256', key).update(`${challengeId}:${code}`).digest('base64url');
}

/**
 * Signs a patient in on the web portal with their mobile number and an SMS code. No SMS
 * goes out here, so once the page has asked for a code the test gives that challenge a
 * code it knows, then types it, ticking "Keep me signed in" when `keep`. Ends wherever the
 * portal sends the patient next.
 */
export async function signInAsPatient(
  page: Page,
  db: Db,
  clinic: Clinic,
  phone: string,
  { keep = false }: { keep?: boolean } = {},
) {
  await page.goto(`/app/login?clinic=${clinic.slug}`);
  await enterPatientCode(page, db, clinic, phone, { keep });
}

/**
 * The sign-in steps after the page is open with the clinic filled in (from a link): the
 * mobile number, then a code the test gives the challenge (no SMS goes out here).
 */
export async function enterPatientCode(
  page: Page,
  db: Db,
  clinic: Clinic,
  phone: string,
  { keep = false }: { keep?: boolean } = {},
) {
  await expect(page.getByLabel('Clinic ID')).toHaveValue(clinic.slug);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(`We sent a code to ${phone}.`)).toBeVisible();
  const challenge = await db.otpChallenge.findFirstOrThrow({
    where: { phone: `+91${phone}` },
    orderBy: { createdAt: 'desc' },
  });
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.otpChallenge.update({
    where: { id: challenge.id },
    data: { codeHash: otpCodeHash(challenge.id, code) },
  });
  await page.getByLabel('6-digit code from the SMS').fill(code);
  if (keep) await page.getByRole('checkbox', { name: 'Keep me signed in on this device' }).check();
  await page.getByRole('button', { name: 'Verify' }).click();
}

/** The page's own alert (Next.js also renders a hidden route-announcer alert). */
export const pageAlert = (page: Page) => page.locator('main [role=alert]');

export const test = base.extend<{ clinic: Clinic; operator: Operator }, { db: Db }>({
  db: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const db = createDb(process.env.E2E_DATABASE_URL!);
      await use(db);
      await db.$disconnect();
    },
    { scope: 'worker' },
  ],
  clinic: async ({ db }, use) => {
    await use(await createClinic(db));
  },
  // eslint-disable-next-line no-empty-pattern
  operator: async ({}, use) => {
    await use(await createOperator());
  },
});

export { expect };
