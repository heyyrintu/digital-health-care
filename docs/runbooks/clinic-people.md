# Clinic People administration

Open **Doctors and staff** (`/clinic/staff`) as a clinic admin. The People directory
includes active, invited and disabled clinic staff, supports name/email/mobile search
and paginates in groups of 50. Select a person to open Profile, Roles, Access, Security
and Activity. The existing invitation form remains below the directory.

## Profile, roles and clinic access

- Profile changes update a staff member's display name only when their identity is
  exclusive to this clinic and is not also a patient account. Shared identities require
  platform support; the owner can still edit their own name through Your account.
- Roles apply only within the current organisation. Doctor registration verification and
  prescription signing requirements remain separate. Staff must finish trusted account
  setup before active access can be assigned.
- Disabling clinic access revokes staff memberships and sessions in this clinic. Other
  clinics and patient memberships are untouched. Re-enable an enrolled account from Access.
- An admin cannot change their own roles or disable themselves. Role/access changes are
  serialised per clinic and retain an active usable admin. Session validation also checks
  the actual account, organisation, membership and session role on each request.
- Existing medical records and appointments remain. Review pending appointments and work
  that needs reassignment when a doctor leaves; access changes do not reassign care.
- Security integrates device sign-out and existing authenticator reset/setup links. It
  displays the deployment's current sign-in verification policy; per-user MFA policy is
  not introduced. Give setup links privately to the intended staff member.
- Saves use an opaque version of profile, credential and membership state. A stale save
  returns a conflict and requires reloading; sign-in timestamps and failed-code counters
  do not invalidate a pending contact request.

## Verified email and mobile changes

1. The admin opens the staff profile, selects **Change sign-in details**, enters the new
   email/mobile and confirms their own admin password.
2. The system sends a six-digit code to the new contact. Current login details stay unchanged.
3. The staff member signs into their existing account, opens **Your account** (`/clinic/account`),
   checks the requested destination, and enters the received code and current password.
4. On success the new contact is applied atomically. Staff sessions are ended and the person
   signs in again using the new detail. Their authenticator secret is preserved.

Only the staff member can confirm their request. Admins can cancel requests. Codes are
keyed hashes, destinations are encrypted at rest, expire after ten minutes and have five
attempts. Requests are limited to three per person per clinic per ten minutes, in addition
to endpoint limits. Repeated wrong passwords/codes use the account lockout. Failed delivery,
expiry, cancellation, stale versions, changed credentials, lost clinic access, conflicting
identities or a newly shared account prevent application. Values/codes are not copied to
audit metadata; profile/access and contact request/confirmation events are recorded.

Clinic admins cannot alter a shared staff/patient identity. Platform support handles these
cases through an identity review rather than merging or moving accounts automatically.
Invitations take the same identity lock as profile/contact changes, so another clinic
cannot attach an account based on a stale contact lookup.

Mobile changes use the existing Meta WhatsApp OTP sender. If a deployment phone override
is configured for the account, ask the server owner to update that mapping first. Email-only
accounts using WhatsApp second factors must verify an account mobile before changing their
email, so the next sign-in still has a delivery destination.

## Configure email delivery

Use authenticated SMTP with TLS (465 for TLS on connect, or 587 with required STARTTLS):

```dotenv
STAFF_EMAIL_VERIFICATION_ENABLED=true
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-private-smtp-password
SMTP_FROM=no-reply@your-verified-domain.example
```

Use your provider's verified sender/domain and credentials. Store these privately in
Coolify; apply the current migration and deploy API/web together. Incomplete settings fail
startup when the feature is enabled. The default is disabled: email edits remain unavailable
until the sender is configured. WhatsApp OTP delivery requires the existing approved
Authentication template and sender credentials. No live message is sent merely by deploying.

The SMTP adapter enforces TLS and bounded timeouts, disables external URL/file content,
and sends only a verification code/instruction message. Reference: [Nodemailer SMTP transport](https://nodemailer.com/smtp).

## Release state

This increment is locally implemented and uses synthetic test accounts. Live SMTP/WhatsApp
acceptance requires the clinic's configured senders. It does not create Microsoft 365
mailboxes, email hosting, platform operator accounts or per-person second-factor preferences.


Local validation: 52 migrations applied on a fresh disposable database; 59 focused
People/invitation/device/tenant-isolation tests passed, along with SMTP transport tests
and contract tests. Eight browser journeys passed, including People roles/access and
staff-owned email confirmation/re-login at 390px and 1280px, plus invitations, device
sign-out and authenticator reset. API/web builds, lint and type checks passed. Live
SMTP/WhatsApp delivery remains configuration-dependent and was not exercised with real
recipients during these checks.

Disabling clinic access retains the selected roles as suspended memberships. Re-enabling restores those roles only; previously removed roles stay revoked.
