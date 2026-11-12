# Staff and platform second-factor options

Clinic staff and platform operators can manage their own method from **Your account →
Two-step verification** (`/clinic/account` or `/platform/account`). Available choices are
Authenticator, Email OTP, WhatsApp OTP and Off. This is an account setting across clinics,
not a role-granting control. The sign-in page cannot bypass the saved method.

Changing the method requires the current password, current second-factor proof (unless
already Off), and proof of the destination method (unless switching Off). Changes expire
after five minutes and sign out all account sessions. Keep the enrolled authenticator;
it can be restored later. Initial invitation/operator setup still enrolls an authenticator.
Only configured, deliverable methods appear: email needs the SMTP sender and an account
email; WhatsApp needs the real sender plus the existing stored/mapped mobile number.
Phone numbers cannot be supplied as factor recipients during sign-in or security changes.

The following environment variables remain the **defaults for accounts that have never
chosen a personal method**. Personal choices override these deployment defaults.

| Variable | Values | Default |
| --- | --- | --- |
| `STAFF_MFA_MODE` | `totp`, `whatsapp`, `disabled` | `totp` |
| `PLATFORM_MFA_MODE` | `totp`, `whatsapp`, `disabled` | `totp` |

`totp` means password followed by an authenticator code. `whatsapp` means password
followed by a six-digit WhatsApp authentication code. `disabled` means password only.
Patient mobile OTP login is independent and remains required. Platform IP restrictions,
password checks, role/account checks, lockouts and session cookie protections still apply.
Defaults have not been changed and deployment credentials have not been edited.

## Disable the extra sign-in step

For example, to simplify clinic preview sign-in while retaining platform authenticator
verification, set the following in Coolify and redeploy:

```dotenv
STAFF_MFA_MODE=disabled
PLATFORM_MFA_MODE=totp
```

Set `PLATFORM_MFA_MODE=disabled` as well only if password-only platform sign-in is intended.
This affects future sign-ins. Existing sessions are not automatically signed out.
To restore authenticator verification, set the relevant mode to `totp` and redeploy.
Authenticator secrets are preserved. Initial invitation/operator enrollment and recovery
still use the existing trusted authenticator setup workflow; these settings change normal
sign-in, not account provisioning. Keep enrolled authenticators available for recovery.

## Use WhatsApp OTP as the second factor

Configure the existing [Meta Cloud API sender](whatsapp-cloud-api-setup.md), including
`OTP_DELIVERY=whatsapp`, token, sender number ID, supported Graph version and approved
Copy code authentication template and language. The same authentication sender delivers
staff/platform codes; patient sign-in is not used to issue staff sessions.

```dotenv
STAFF_MFA_MODE=whatsapp
PLATFORM_MFA_MODE=whatsapp
STAFF_MFA_PHONES_JSON={"doctor@example.test":"+919876543210"}
PLATFORM_MFA_PHONES_JSON={"operator@example.test":"+919000000001"}
```

These are synthetic examples; replace them with the actual account email and controlled
mobile number. Staff use the explicitly mapped number if supplied, otherwise their
existing account phone. Email-only staff need a mapping. Every platform operator needs
an explicit mapping because operator accounts do not have a mobile-number field. Verify
the number with its owner through your existing administration process before mapping it.
Recipients are configured by the server owner and cannot be supplied on the login page.
Supported recipients follow the existing sender's Indian mobile-number restriction.

Update mappings and modes together, apply migrations and redeploy the API and web
from the same release. Keep mappings/credentials private. Missing recipients or provider
failures stop sign-in; they never switch to password-only access. Start again from the
password step to request another code (there is no separate resend endpoint).

Codes expire after five minutes, are stored as keyed hashes, and can be used once.
Requests are limited to three per account in ten minutes; wrong codes also count toward
the existing five-attempt account lockout. Challenges are bound to the password step,
account, audience, credentials, recipient and (for staff) clinic and role. Patient, staff
and platform OTPs are isolated. Provider calls run outside database transactions and an
undelivered challenge cannot authenticate. No codes or phone numbers are added to audit
metadata. Live Meta delivery still requires validation with the actual sender credentials.


## Forgot password

Both `/clinic/login` and `/platform/login` link to Forgot password. A six-digit code goes
to the existing account email. Clinic staff must also enter their clinic ID. Requests give
the same acknowledgement for unknown, inactive and rate-limited identities. Codes expire
after five minutes, allow five guesses and are stored only as keyed hashes. Requests are
limited to three per account per ten minutes plus the endpoint IP limit. An hourly,
bounded cleanup removes challenges expired more than 24 hours ago, separately for each
audience; audit entries retain the security-event history.

Recovery requires `STAFF_EMAIL_VERIFICATION_ENABLED=true` and the existing SMTP settings
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`). Despite the historical
flag name, this sender serves both staff and platform security mail. SMTP must accept the
message before its code becomes usable. Delivery failures do not change credentials.

A completed reset signs out all sessions and invalidates outstanding password-step tokens
and security challenges. It preserves the selected second factor and authenticator secret.
Losing an authenticator still uses the existing trusted support recovery process; email
password recovery does not remove that factor. Patient WhatsApp sign-in remains separate.

## Release and rollback

Apply `20261112090000_account_security` and ship API and web together. Existing accounts
inherit their current deployment policy; the migration does not disable verification.
Credential/contact/security changes increment an account authentication version in the
DB. Pending password-step tokens must match it. Password resets and method changes revoke
existing sessions in the same transaction.

After a security change, the database rejects staff/platform session creation by older
API images that do not understand the new protocol. Rolling back to those images can
therefore block affected accounts; it must never silently substitute an older, weaker
verification policy. Prefer a forward fix or restore a matched application/database
snapshot through the documented restore procedure. Do not drop the guard to restore access.
