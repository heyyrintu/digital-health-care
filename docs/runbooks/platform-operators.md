# Runbook: Platform Console Operators

**Owner:** Tech lead · **When:** someone joins or leaves the platform team, or needs console access (PRD §3.2: organisations, doctor verification, usage and system health only).

Platform operators are not clinic users: they have their own accounts, sign in only to the platform console, and have no access to patient or clinical data (ADR 0016). There is no screen or API for creating them; it is done with the support command below.

## The console
On the web app, from the office network or VPN only:

| Path | What it is for |
|---|---|
| `/platform/login` | Sign in: work email and password, then the code from the authenticator app. A clinic sign-in does not open the console, and a console sign-in does not open the clinic dashboard. |
| `/platform` | **Organisations**: each one's status, clinics, staff (active and invited, by role) and doctors pending or verified. **Onboard organisation** creates an organisation, its first clinic and an invite for its first clinic admin; the invite link is shown once, on that page only. Copy it and give it to the admin directly (not by ticket or group chat); it stays while you move between console pages, but once you reload, close the tab or sign out it cannot be shown again, and it cannot be issued again either ([Lost first-admin invite](#lost-first-admin-invite)). Until you choose **I have copied the link** the idle sign-out waits (up to an hour), the browser asks before you reload or close the tab, and you cannot onboard another organisation. |
| `/platform/doctors` | **Doctor verification**: the queue, pending and verified, oldest first ([doctor verification runbook](doctor-verification.md)). |
| `/platform/usage` | **Usage** per organisation over a range of days. Messages and scribe minutes show "—" until those features exist. |
| `/platform/health` | **System health**: the API server, the database and the background queues, with job counts per queue ([System health](#system-health)). |

Your name and email are shown at the top of every page; **Sign out** ends the session at once. The console also signs you out after 15 minutes without activity, and a session lasts 8 hours at most.

## System health
`/platform/health` checks when you open it and when you choose **Refresh** (it never refreshes on its own; each check is recorded). It shows status and counts only, never what a job is about. **Last checked** is the time of the answer, in IST.

| Card | Status | What it means | What to do |
|---|---|---|---|
| API | OK | The API server that answered, its version (`APP_VERSION`) and how long it has been running. Each server behind the load balancer answers for itself, so the version and running time can differ between refreshes during a deploy. | A version you did not expect after a deploy: check the deploy ([deploy runbook](deploy.md)); a running time that keeps resetting means the server is restarting: check its logs. |
| Database | OK | It answered a trivial query in the time shown. **Latest migration** is the last one applied. | If the migration is older than the release that went out, the deploy's migration step did not run: see the [deploy runbook](deploy.md). Answers that are usually a few milliseconds and now take hundreds: watch it and check the database's monitoring. |
| Database | Down | It failed, or did not answer within 2 seconds, after your session was checked: it is failing or slow. When it is fully down the session check fails first, and instead of the cards the page says **System health could not be checked: the API or its database is not answering** (other console pages show an error, and signing in fails). | Treat it as an [incident](incident-response.md): clinics cannot work. Check the database's status in the cloud console and the API's logs. |
| Background queues | OK | Every queue answered; the table shows each queue's jobs: waiting to start, running, delayed (scheduled, or a retry waiting out its backoff) and **failed** (failed after every retry). | Failed jobs are highlighted in red, with a notice naming the queues. They are kept on purpose; find out why from the workers' logs (job IDs and queue names only) before retrying or removing them, and raise a ticket. Waiting counts that keep growing mean the workers are not keeping up or not running: check the workers' service. |
| Background queues | Down | Redis did not answer within 1.5 seconds: jobs cannot be counted and are probably not running (messages, documents, webhooks). | Check Redis and the workers' service; raise an [incident](incident-response.md) if it lasts. |
| Background queues | Not configured | This API server has no `REDIS_URL`, so it does not check the queues. Expected in local development and CI; not in production. | In production, set `REDIS_URL` for the API to the workers' Redis and redeploy. |

## Lost first-admin invite
The first clinic admin's link works once and expires after 72 hours. **Today there is no supported way to issue a new one**: the console has no re-issue, onboarding again with the same organisation ID is refused (it is taken), the clinic has no admin yet who could invite anyone, and `support-reset-authenticator` works only for staff who are already active. Re-issuing is not built yet (API guide §3s).

So:
1. **Prevent it.** Copy the link before leaving the page, give it to the admin in person or by phone, and ask them to open it the same day.
2. **If it is lost or expires:** record it on the onboarding ticket and tell the tech lead. Any repair (a new invite for that admin) is a database change with break-glass access under the [access control policy](../security/access-control.md), raised as an [incident](incident-response.md) and recorded on the ticket; there is no command for it. Do not onboard the organisation again under another ID without the tech lead's agreement: the first one stays, and organisations cannot be suspended yet.

## Add an operator
1. **Ticket and approval.** Open a ticket naming the person and why they need access. The tech lead (or delegate, not the person) approves on the ticket. Production database access for the command follows the break-glass rule in the [access control policy](../security/access-control.md).
2. **Network.** Check the person will work from a network in `PLATFORM_ALLOWED_CIDRS` (office or VPN). Changing that list is a deploy-time setting change, with its own ticket.
3. **Run the command with the new operator present.** From a production API task (the command ships in the API build) with `DATABASE_URL` and `FIELD_ENCRYPTION_KEY` set as for the API, in a recorded session:

   ```sh
   node dist/support-platform-operator.js \
     --email new.person@platform.example \
     --name "New Person" \
     --ticket SUP-1234 \
     --operator your.name@platform.example
   ```

   The new operator types their password (at least 12 characters; not shown, asked twice). The command then asks you to **pause the session recording**: the QR code holds the authenticator secret and must not be in the recording. Press Enter once it is paused; the operator scans the QR code with their authenticator app and types the first code. The screen is cleared, and you resume the recording when the command says so. Nothing is saved until that code matches, and that code cannot then be used to sign in.

   The typed key (the same secret as text) is printed only with `--show-key`, for an app that cannot scan; keep the recording paused while it is on screen. Locally, `pnpm --filter @dhc/api support:platform-operator --email …` runs the same command from source.
4. **Close out.** Record the run ID on the ticket. The new operator signs in to the console at `/platform/login` (work email, password, then the authenticator code) to check it works.

Never put a password, the authenticator key or a code in the ticket, chat or email.

## Remove an operator
Do this on the person's last day, or at once if their phone or password may be compromised:

```sh
node dist/support-platform-operator.js --disable \
  --email person@platform.example --ticket SUP-1235 --operator your.name@platform.example
```

Type `DISABLE` when asked (or pass `--yes` in a recorded non-interactive session). It disables the account and ends all their console sessions at once.

## Lost or replaced phone
1. **At once:** disable the operator as above (new ticket), so a found phone and a known password are not enough.
2. **Identity check and approval** on the ticket as when adding an operator; the operator comes to the terminal with their new phone.
3. **New authenticator**, with the recording paused for the QR code exactly as when adding:

   ```sh
   node dist/support-platform-operator.js --reset-authenticator \
     --email person@platform.example --ticket SUP-1236 --operator your.name@platform.example
   ```

   It replaces the authenticator (the old phone's codes stop working), ends any sessions and clears a lockout. The password stays as it was; if it may be known to someone else, also follow [Compromised password](#compromised-password) before step 4.
4. **Enable** them again:

   ```sh
   node dist/support-platform-operator.js --enable \
     --email person@platform.example --ticket SUP-1236 --operator your.name@platform.example
   ```

   Type `ENABLE` when asked. The operator signs in with the new authenticator to check it works.

The same `--enable` brings back someone who left and returned, after a new approval on the ticket.

## Compromised password
If an operator's password may be known to someone else (phished, reused, written down), treat it as an [incident](incident-response.md) and:

1. **At once:** disable the operator (new ticket). The account stays shut until step 4.
2. **Identity check and approval** on the ticket, as when adding an operator; the operator comes to the terminal.
3. **New password**, typed by the operator (not echoed):

   ```sh
   node dist/support-platform-operator.js --reset-password \
     --email person@platform.example --ticket SUP-1237 --operator your.name@platform.example
   ```

   It is refused while the operator is active, replaces the password, ends any sessions and clears a lockout. If the phone may also be compromised, run `--reset-authenticator` too.
4. **Enable** them again with `--enable` (as above) and have them sign in to check.

## What is recorded
Every operator's sign-ins, failures, lockouts and logouts, and every list, onboarding (and refused onboarding), verification (and refused verification), usage view and system health check (`platform.health.viewed`, with the database's and the queues' status), are in the audit log with no organisation (`platform.*`), naming the operator, so one operator's activity can be reviewed in one place. Onboarding and verification are also in the organisation's own log (`platform.organisation.created`, `support.doctor.verified`). Creating, disabling, enabling and replacing an operator's authenticator or password write `platform.operator.created`, `platform.operator.disabled`, `platform.operator.enabled`, `platform.operator.authenticator_reset` and `platform.operator.password_reset` with the ticket and who ran the command.

## If something goes wrong
- **"An operator with that email already exists."** If they were disabled and are coming back, use `--enable` (and `--reset-authenticator` if their phone changed).
- **"No matching code: nothing was saved."** Check the phone's clock is set automatically, then run the command again.
- **"The platform console is not available from this network."** (403) Connect to the office network or VPN. If you are on it, check `PLATFORM_ALLOWED_CIDRS` and how the web server's forwarded address reaches the API (API guide §3s, *Web console*; ADR 0015). Never fix it by adding the web servers' addresses to `PLATFORM_ALLOWED_CIDRS`. Before `FORWARD_CLIENT_IP` is turned on: the load balancer in front of the web servers must overwrite `X-Forwarded-For` with, or append to it, the client address it observed, so that address is the rightmost entry; the web servers must accept traffic only from the load balancer; and the API must believe forwarded entries only from the load balancer and the web servers. The API believes them only from a peer in `TRUSTED_PROXY_CIDRS` when that is set, so list both peers there: the load balancer's subnets (the console's own requests come from the browser through it) and the web servers' subnets (the web app's session routes, clinic and console). Each adds exactly one entry, so `TRUST_PROXY_HOPS=1` fits both paths. Without `TRUSTED_PROXY_CIDRS`, set `TRUST_PROXY_HOPS=0` unless the API port can be reached only from the load balancer and the web servers.
- **"Too many attempts. Sign-in is locked for 15 minutes."** (429) Five wrong passwords or codes locked the account. It lifts after 15 minutes, or at once with `--reset-authenticator`. Repeated lockouts may be someone guessing: check the audit log for `platform.auth.login.failed` from unfamiliar addresses and treat it as an [incident](incident-response.md).
- **"Too many attempts. Wait a minute and try again."** (429) Too many sign-in requests from your address in a minute (the per-address rate limit), not a lockout: wait a minute. The account is not locked and nothing needs resetting.

## Access review
Quarterly, the tech lead lists the active operators (with the audit log's `platform.auth.login.succeeded` for each) against the platform team, disables anyone who no longer needs access, and records the review on a ticket ([access control policy](../security/access-control.md)).
