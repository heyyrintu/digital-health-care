import Link from 'next/link';
import { CURRENT_CONSENT_VERSIONS } from '@dhc/contracts';

const privacy = [
  [
    'Who this notice covers',
    'This portal is operated for the clinic whose clinic ID you select at sign-in. Contact that clinic at its reception for questions about your records or this notice. This deployment is a client preview: use synthetic records only. A real mobile number used for sign-in is still personal information.',
  ],
  [
    'Information and purposes',
    'Your mobile number and verification codes are used to sign you in. Family profiles can include names, birth date, gender, contact and emergency details, photos and self-reported health information. Appointments, consultations, prescriptions, tests, uploads, payments and receipts support clinic workflows. Consent choices, request references, account activity and security logs support access control, troubleshooting and audit. Do not enter real health records in this preview.',
  ],
  [
    'Access and service providers',
    'Your linked family account can access permitted records. Authorised clinic staff access information according to their roles and clinic access rules. Deployment providers may process data to host the service, store records, deliver messages or handle payments. Meta WhatsApp Cloud API receives the destination number and message information when WhatsApp delivery is enabled. Cashfree handles checkout when online payments are enabled. Personal record sharing authorises the selected clinic doctor until expiry or revocation; downloaded copies cannot be recalled.',
  ],
  [
    'Consent and messaging',
    'Privacy, terms and health-data choices are recorded separately. Optional WhatsApp appointment, record and payment updates have separate preferences; sign-in codes support authentication. Open Privacy to review or withdraw health-data consent and change messaging preferences. Withdrawing required health-data consent limits portal access and does not erase existing clinic records.',
  ],
  [
    'Requests and help',
    'Open Your data and account to request an export, correction or deletion review and track responses. This link remains available on the consent screen. Profile edits do not overwrite doctor-confirmed medical facts. Account closure requires a fresh code and ends this clinic patient login. It does not automatically cancel bookings, refund payments or delete clinical and financial history. Contact clinic reception for questions, grievances or requests the portal cannot handle.',
  ],
  [
    'Retention and security',
    'Information is retained to support the account, clinic workflows, security and applicable retention obligations. Clinical and financial records may remain after account closure; ask the clinic for its applicable policy. Unused personal files marked for deletion are queued for removal, which may take time. Access controls and protected sessions reduce risk; no online service guarantees absolute security. Keep your mobile and downloaded records private.',
  ],
  [
    'Family and live use',
    'Manage only yourself or people whose records you are authorised to manage. A parent or authorised guardian should manage child profiles. Contact the clinic when access or guardianship changes. Material consent changes may require acceptance again. Before real patient use the clinic must review and publish its operator and privacy contact details, actual providers, retention policy and any additional required notices.',
  ],
];
const terms = [
  [
    'Client preview',
    'This website demonstrates patient and clinic workflows using synthetic records. Do not upload real patient records or rely on preview prescriptions, results or bookings for treatment. The clinic must review and configure the service before real patient use.',
  ],
  [
    'Your account',
    'Use a mobile number you control and keep verification codes private. Manage only profiles you are authorised to access. Tell the clinic if your number changes or someone else gains access. Do not impersonate people, access unauthorised records, disrupt the service or upload malicious or unlawful content.',
  ],
  [
    'Bookings and payments',
    'Slots, fees and cancellation rules are shown during booking. Some requests need clinic confirmation. Payment alone does not guarantee treatment or a booking. Check an uncertain payment before trying again. Cancellation and refunds depend on the clinic rules shown for that transaction; contact the clinic for review. Account closure does not cancel appointments or refund charges.',
  ],
  [
    'Health and emergencies',
    'The portal helps you communicate with the clinic and view records; it does not provide emergency monitoring. Seek appropriate emergency care directly for urgent symptoms. Self-reported information may need doctor verification. Treatment decisions require the responsible clinician and an appropriate consultation.',
  ],
  [
    'Records and messages',
    'Provide only records you are entitled to share. Clinic staff may review information as part of their duties. Shared downloads cannot be recalled. Change optional WhatsApp preferences in Privacy. Do not send card details or sensitive clinical details through messages without clinic guidance on a secure process.',
  ],
  [
    'Availability and choices',
    'Service can be interrupted or updated. Keep important copies securely and contact the clinic for time-sensitive needs. Use Your data and account for access, correction, deletion review or account closure, and Privacy to withdraw required health-data consent. Some clinical and financial history may need to be retained. These terms do not remove rights available under applicable law.',
  ],
  [
    'Contact and live use',
    'Contact reception at the clinic whose ID you used at sign-in for account assistance, complaints, booking or payment disputes. Before live use the clinic must review and publish its identity, contact channels and applicable booking, payment and retention policies.',
  ],
];
export function LegalDocument({ kind }: { kind: 'privacy_notice' | 'terms' }) {
  const isPrivacy = kind === 'privacy_notice';
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <nav className="flex gap-5 text-primary underline">
        <Link href="/app">Patient portal</Link>
        <Link href={isPrivacy ? '/terms' : '/privacy'}>
          {isPrivacy ? 'Terms of use' : 'Privacy Notice'}
        </Link>
      </nav>
      <h1 className="font-display text-3xl font-bold">
        {isPrivacy ? 'Privacy Notice' : 'Terms of use'}
      </h1>
      <p className="text-sm text-muted-foreground">
        Portal consent version {CURRENT_CONSENT_VERSIONS[kind]} - Published 6 November 2026
      </p>
      <p role="note" className="rounded-xl bg-warning-soft p-4">
        Client preview. Synthetic records only. These documents describe the preview and require
        clinic review before real patient use.
      </p>
      {(isPrivacy ? privacy : terms).map(([title, body]) => (
        <section key={title} className="space-y-2">
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="leading-7">{body}</p>
        </section>
      ))}
      <Link className="inline-block text-primary underline" href="/app/data-rights">
        Your data and account
      </Link>
    </main>
  );
}
