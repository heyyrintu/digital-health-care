/**
 * Development seed: one demo clinic, three staff accounts and the synthetic personas
 * from docs/qa/test-plan.md. Never real patient data. Refuses to run in production.
 *
 * Staff accounts are created as invites: open each printed link to set a password and
 * enrol an authenticator. Re-running issues fresh links for anyone not yet set up.
 */
import { DEFAULT_TAGS } from '@dhc/contracts';
import { createDb } from '@dhc/db';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/tokens';
import { INVITE_TTL_MS } from '../modules/invites/service';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const db = createDb(url);
const webBaseUrl = (process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const org = await db.organisation.upsert({
  where: { slug: 'demo-clinic' },
  update: {},
  create: { slug: 'demo-clinic', name: 'Demo Clinic' },
});

const staff = [
  { email: 'doctor@demo-clinic.test', displayName: 'Dr. Demo', role: 'doctor' },
  { email: 'frontdesk@demo-clinic.test', displayName: 'Front Desk', role: 'front_desk' },
  { email: 'admin@demo-clinic.test', displayName: 'Clinic Admin', role: 'clinic_admin' },
] as const;

const links: string[] = [];
for (const s of staff) {
  const user = await db.user.upsert({
    where: { email: s.email },
    update: {},
    create: { email: s.email, displayName: s.displayName },
  });
  const key = { organisationId: org.id, userId: user.id, role: s.role };
  const membership = await db.membership.upsert({
    where: { organisationId_userId_role: key },
    update: {},
    create: { ...key, status: 'invited' },
  });
  if (membership.status === 'active') {
    links.push(`  ${s.email}: already set up`);
    continue;
  }
  await db.membership.update({ where: { id: membership.id }, data: { status: 'invited' } });
  await db.staffInvite.updateMany({
    where: { ...key, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const token = randomBytes(32).toString('base64url');
  await db.staffInvite.create({
    data: {
      ...key,
      tokenHash: hashToken(token),
      // Bootstrap: seeded invites are attributed to the invitee.
      createdByUserId: user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  links.push(`  ${s.email} (${s.role}): ${webBaseUrl}/invite#${token}`);
}

// Synthetic personas (docs/qa/test-plan.md §3). Phone numbers are fictional.
const personas = [
  { name: 'Asha Verma', dob: '1992-03-14', phone: '+919000000001' },
  { name: 'Ravi Mehra', dob: '1968-07-02', phone: '+919000000002' },
  { name: 'Neha Kapoor', dob: '1997-11-23', phone: '+919000000003' },
  { name: 'Aarav Singh', dob: '2020-05-09', phone: null },
  { name: 'Kamla Devi', dob: '1954-01-30', phone: '+919000000005' },
  { name: 'Imran Khan', dob: '1985-09-18', phone: '+919000000006' },
];
for (const [i, p] of personas.entries()) {
  const uhid = `DC-${String(i + 1).padStart(6, '0')}`;
  await db.patient.upsert({
    where: { organisationId_uhid: { organisationId: org.id, uhid } },
    update: {},
    create: {
      organisationId: org.id,
      uhid,
      name: p.name,
      phone: p.phone,
      dob: new Date(`${p.dob}T00:00:00Z`),
    },
  });
}

// UHID numbering and the default tags (PRD §5.4).
await db.uhidSettings.upsert({
  where: { organisationId: org.id },
  update: {},
  create: { organisationId: org.id, prefix: 'DC', nextNumber: 10001 },
});
await db.tag.createMany({
  data: DEFAULT_TAGS.map((t) => ({ ...t, organisationId: org.id })),
  skipDuplicates: true,
});

await db.$disconnect();

console.warn(
  `Seeded organisation "demo-clinic" with ${staff.length} staff, ${personas.length} synthetic patients and the default tags (new UHIDs start at DC10001).`,
);
console.warn('Staff invite links (valid 72 hours; the token is everything after #):');
for (const line of links) console.warn(line);
console.warn('Open a link in the browser (web app running) to set a password and authenticator.');
console.warn(
  'Patients sign in with a mobile code; set OTP_DELIVERY=log to see codes in the API console.',
);
