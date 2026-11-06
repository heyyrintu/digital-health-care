# Staff and platform second-factor options

The server owner chooses login policies through Coolify environment variables. These
are deployment-wide settings, separately for clinic staff and platform operators.
They are not per-user or per-clinic switches in the People portal (that portal remains
pending). An unauthenticated user cannot select or bypass the configured policy.

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


## Validation for this local increment

All 50 migrations applied to a fresh disposable database. Existing staff authentication
regressions passed (31 tests); the new MFA-options/platform run passed 68 tests with one
existing Redis-dependent case skipped. Configuration tests (3), browser-session route
tests (27), contracts tests (118), API/web type checks and API-client type checks passed.
API and web production builds passed (web verified with Webpack because this computer
restricts a port used by Turbopack). No live Meta message or hosted authentication change
was performed. Browser session routes were tested for refresh-cookie isolation and for
not exposing refresh tokens in password-only login responses.
