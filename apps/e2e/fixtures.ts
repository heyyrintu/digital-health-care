import { createDb, type Db } from '@dhc/db';
import { expect, test as base, type Page } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'node:crypto';

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

/** RFC 6238 code for a base32 secret, `offset` steps from now. */
export function totp(secret: string, offset = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
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

/** The page's own alert (Next.js also renders a hidden route-announcer alert). */
export const pageAlert = (page: Page) => page.locator('main [role=alert]');

export const test = base.extend<{ clinic: Clinic }, { db: Db }>({
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
});

export { expect };
