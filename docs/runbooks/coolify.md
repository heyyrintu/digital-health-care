# Host Digital Healthcare on Coolify

Deploy the web client preview from [heyyrintu/digital-health-care](https://github.com/heyyrintu/digital-health-care), branch **`main`**, using **`/docker-compose.coolify.yml`**. The web workflows and hosting setup were merged in [PR #52](https://github.com/heyyrintu/digital-health-care/pull/52). Select the latest intended commit on `main` and record it for the release.

This deployment runs production builds of the web app, API and workers, with persistent PostgreSQL, Redis and private files. It is a **synthetic client preview**: staff use real passwords with authenticator verification by default. Patient OTP and optional outgoing integrations remain disabled unless explicitly configured; Cashfree and legal prescription signing remain disabled in this preview setup. Native apps remain paused.

Examples below use `preview.your-domain.com`. Replace it with your own hostname everywhere. You need one application hostname; a separate API hostname is unnecessary.

## 1. Prepare the server and DNS

Before creating the application, have:

- A working Coolify installation and a connected server whose Docker/proxy services are healthy.
- Access to the server terminal and your domain's DNS settings.
- Approximately **4 vCPU, 8 GB RAM and 30 GB free disk** as an initial allocation. These are estimates, not load-test results; building while the stack runs may need more memory or a separate build server.
- A separate application and database for synthetic preview records.

The server runs the application through Docker. Node.js and pnpm do not need to be installed directly on that server. The secret-generation command in section 4 can run on your laptop, with Node.js 22 available.

In your DNS provider, create this record:

| Type | Name                                      | Value                                             |
| ---- | ----------------------------------------- | ------------------------------------------------- |
| `A`  | `preview` (for `preview.your-domain.com`) | Public IPv4 address of the **application server** |

Create an `AAAA` record only if IPv6 is configured and reaches that same application server. Confirm the hostname resolves correctly before deploying. Allow inbound TCP **80 and 443** to the Coolify proxy, while retaining the management/SSH access required by your Coolify setup. See Coolify's [DNS guide](https://coolify.io/docs/core/networking/dns) and [firewall guide](https://coolify.io/docs/core/infrastructure/servers/firewall).

Do not publish database or Redis ports. Compose already keeps PostgreSQL, Redis, API and web off host ports; the gateway is the public entry point. Keep `PDF_REBUILD_CONCURRENCY=1` and the supplied memory budgets for the initial preview. This file-storage setup is for one server, with persistent storage; do not scale it across multiple servers.

## 2. Create the application in Coolify

1. Open your Coolify project and choose the environment for the preview. Create a separate environment if needed, for example `client-preview`.
2. Select **+ New** and create an application from a Git repository. Use the GitHub connection, a deploy key, or the public-repository option as appropriate.
3. Select `heyyrintu/digital-health-care`. For the public-repository option, use `https://github.com/heyyrintu/digital-health-care`.
4. Select branch **`main`** and the destination server.
5. Choose the **Docker Compose** build strategy. Save these values:

| Setting                  | Value                           |
| ------------------------ | ------------------------------- |
| Repository               | `heyyrintu/digital-health-care` |
| Branch                   | `main`                          |
| Base Directory           | `/`                             |
| Docker Compose Location  | `/docker-compose.coolify.yml`   |
| Public receiving service | `gateway`                       |
| Gateway container port   | `8080`                          |

Load/reload the Compose definition and confirm the services are `postgres`, `redis`, `migrate`, `api`, `workers`, `web` and `gateway`. The Dockerfile and Compose file supply the build and start commands; leave unrelated install/build/start overrides unset. Use neither Nixpacks nor the development `docker-compose.yml`.

Keep automatic PR previews off for this persistent preview database. Use manual deployments initially so you can choose the release and rehearse before the client meeting. Coolify documents the repository-based setup in its [Compose guide](https://coolify.io/docs/applications/builds/docker-compose).

## 3. Set the public domain

In the application's **Domains** configuration, select **`gateway`** and set:

```text
https://preview.your-domain.com:8080
```

The `:8080` tells Coolify which container port receives traffic. Your browser address is:

```text
https://preview.your-domain.com
```

Assign a domain only to `gateway`. Remove any unintended generated public routes for other services. Do not add public domains for `web`, `api`, `postgres`, `redis`, `migrate` or `workers`, and do not add host-port mappings to make them accessible.

Use the HTTPS domain so Coolify can terminate TLS. If certificate issuance fails, resolve DNS/proxy/firewall errors before using the site; the browser should load it without a certificate warning.

## 4. Generate and enter environment values

**On your laptop, from the checked-out repository**, generate a fresh private configuration file. This uses only Node's built-in library; no dependency installation is needed:

```sh
umask 077
node scripts/coolify-env.mjs https://preview.your-domain.com > /tmp/dhc-preview.env
```

The generated file contains secrets. Open it privately and copy its values into this application's **Environment Variables** settings in Coolify. Use the resource-level Compose variables so they are available when Coolify expands the Compose definition. Save the values before deploying; no secret Docker build arguments are needed. Keep a separate encrypted copy for recovery. Do not commit the filled file, paste it into a ticket or show it during the client presentation.

Use [the environment template](../../deploy/coolify/env.example) as the reference:

| Variable                 | Required?                 | What to enter                                                                                                             |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                | Yes                       | `https://preview.your-domain.com`, with no path, `/v1`, port `8080` or trailing slash                                     |
| `POSTGRES_PASSWORD`      | Yes                       | Generated hexadecimal database password                                                                                   |
| `REDIS_PASSWORD`         | Yes                       | Generated independent hexadecimal Redis password                                                                          |
| `JWT_SECRET`             | Yes                       | Generated signing secret, at least 32 characters                                                                          |
| `FIELD_ENCRYPTION_KEY`   | Yes                       | Generated Base64 value encoding exactly 32 random bytes                                                                   |
| `COOLIFY_PROXY_CIDR`     | Yes                       | Actual proxy-network subnet; find it in section 5                                                                         |
| `RELEASE_TAG`            | Recommended               | A unique release identifier, preferably the deployed commit's short SHA; replace the generator's `client-preview-1` value |
| `PLATFORM_ALLOWED_CIDRS` | Optional                  | Leave empty initially, denying platform-console access                                                                    |
| `PRIVACY_NOTICE_URL`     | Optional for this preview | Preview defaults to `/privacy`; configure reviewed documents for live use                                                                |
| `TERMS_URL`              | Optional for this preview | Preview defaults to `/terms`; configure reviewed documents for live use                                                                |

The generator fills the passwords and cryptographic keys, but leaves `COOLIFY_PROXY_CIDR` blank for you to complete. The six required variables must have real values before Deploy.

Compose constructs `DATABASE_URL`, `REDIS_URL`, browser API URLs and the private server-to-server API URL. You do not need to create a second database resource, install PostgreSQL separately, or supply those URLs yourself. Do not import the entire development `.env.example`; use the small deployment template above.

The provider switches are **fixed off in this preview Compose file**. Entering provider credentials alone will not enable them. Enabling integrations later requires an explicit configuration change and acceptance checks. Keep `NODE_ENV=production`, `OTP_DELIVERY=disabled` and `SIGNER=disabled`; do not enable logged OTPs or test signing to make a hosted demonstration work.

Use the same secrets on redeployment. Never regenerate `FIELD_ENCRYPTION_KEY` for an existing database without a planned data-key migration. Changing `POSTGRES_PASSWORD` in the environment does not change the password inside an already initialized PostgreSQL volume.

## 5. Find the trusted proxy subnet

**On the application server terminal**, list Docker networks and inspect the network used by the Coolify proxy:

```sh
docker network ls
```

For the usual network named `coolify`:

```sh
docker network inspect coolify --format '{{range .IPAM.Config}}{{.Subnet}}{{println}}{{end}}'
```

If your proxy uses a differently named network, inspect that network instead. Copy the actual subnet carrying the proxy-to-gateway connection into `COOLIFY_PROXY_CIDR`, then save the application's environment values. Confirm the proxy and gateway share the intended network after deployment.

For illustration, an output such as `172.20.0.0/16` would be entered exactly as that CIDR, without quotes. **Do not copy this example unless it is your server's actual output.** Use neither the server's public IP nor its Docker network ID in this field. Never use `0.0.0.0/0` or `::/0`.

This setting lets the gateway recognise the proxy and safely forward the visitor's address. The API/web containers must remain private to the application stack. Do not attach unrelated/untrusted applications to its private network.

Leave `PLATFORM_ALLOWED_CIDRS` empty for the normal staff demo. If you need platform-console access, configure only the presenter's known public IP/CIDR and follow the [platform-operator runbook](platform-operators.md). Staff login at `/clinic/login` does not require platform-console access.

## 6. Deploy and verify services

1. Save the Compose location, gateway domain and all required environment values.
2. Select **Deploy** and open **Deployment Logs**.
3. Confirm Coolify builds the repository's Docker targets. On the first deployment it also downloads the base images and installs locked dependencies.
4. Wait for database and Redis health checks, then the migration step, followed by API/workers, web and gateway.
5. Confirm the release commit in the deployment details matches the intended `main` commit.

Expected results:

| Service                            | Expected state                                            |
| ---------------------------------- | --------------------------------------------------------- |
| `postgres`, `redis`                | Running and healthy                                       |
| `migrate`                          | Completed with exit code **0**; staying stopped is normal |
| `api`, `workers`, `web`, `gateway` | Running and healthy                                       |

Migrations must finish successfully before API/workers start. Do not make `migrate` restart indefinitely or remove its dependencies to force an unhealthy deployment online. No seed data is created automatically.

Open these URLs, replacing the example hostname:

| URL                                            | Expected result                                                |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `https://preview.your-domain.com/health`       | Web JSON status `ok`                                           |
| `https://preview.your-domain.com/v1/health`    | API JSON status `ok`, with version/time                        |
| `https://preview.your-domain.com/v1/ready`     | JSON status `ready`; 503 means the API's database query failed |
| `https://preview.your-domain.com/clinic/login` | Styled staff sign-in page with the synthetic-preview notice    |

In the API's runtime logs, confirm `PDF rebuild self-test passed`. Production startup refuses a broken PDF rebuild package. Container probes additionally check database/Redis availability and API file permissions. A healthy worker probe checks process/dependency availability; it does not establish that external-provider jobs have been accepted or delivered.

The gateway excludes the preview from indexing, and the web displays its preview notice. Indexing instructions are not authentication: share the URL only with intended reviewers and use the staff sign-in for protected workflows.

## 7. Create the demo clinic and sign in

Do this only on a **fresh, migrated synthetic preview database**, after the stack is healthy.

1. Open Coolify's terminal for the **`api` service**. This is a container terminal, not the application server's host shell.
2. Its default working directory is `/app/apps/api`. If necessary, run `cd /app/apps/api`.
3. Run this once, privately and without recording the terminal output:

```sh
node dist/seed.js --empty-demo-database
```

The command creates `demo-clinic`, six fictional patients, a clinic schedule, consultation types, sample medicines and three staff invitations. It refuses existing organisations/users/patients/platform operators or enabled providers. It creates no shared password, bypasses no MFA and sends no external messages. A second run on a populated database is deliberately refused.

Open each printed invite link in full, including its `#` fragment, in your own browser. Start with the clinic admin. Each person chooses a password and scans their own authenticator QR code, then confirms a code to finish setup. The `.test` email addresses are account identifiers; no email delivery is required to use these printed links.

| Role         | Account email                | Clinic ID for later sign-in |
| ------------ | ---------------------------- | --------------------------- |
| Clinic admin | `admin@demo-clinic.test`     | `demo-clinic`               |
| Doctor       | `doctor@demo-clinic.test`    | `demo-clinic`               |
| Front desk   | `frontdesk@demo-clinic.test` | `demo-clinic`               |

Later, visit `https://preview.your-domain.com/clinic/login?clinic=demo-clinic`, enter the account email and chosen password, then the authenticator code. There is no default password. Use separate browser profiles for each role during the presentation.

Invite links are credentials and expire after 72 hours. Finish at least the admin setup promptly; use the normal staff invitation/recovery workflows for ongoing administration. Do not put invite links or authenticator QR codes in screenshots, tickets or the presentation. Do not delete the database to recover a login.

Before showing the client, follow [the presentation walkthrough](../product/client-preview-guide.md): prepare one synthetic waiting patient, one saved consultation draft and a sample document. Verify an authorised file download after a restart. Patient OTP, online payments, WhatsApp sending and final legally signed prescriptions remain outside this preview; the seeded video consultation type is illustrative, not an accepted video/prepayment integration.

## 8. Back up and prove restoration

Coolify host/volume persistence is not an off-host backup. Schedule database **and private file** backups together, and separately retain encryption keys and environment values in encrypted secret storage. Redis retains queue state through AOF but is not a substitute for the database outboxes.

The provided maintenance-window backup script runs on the Coolify server from the release checkout. Set the **existing stack's exact Compose project name** shown in Coolify/docker labels; a different project name creates different volumes and backs up the wrong stack. Use a private env file with this deployment's values, not newly generated secrets:

```sh
export COMPOSE_PROJECT_NAME='<existing-coolify-project-name>'
export DHC_ENV_FILE='/secure/path/dhc-preview.env'
export DHC_BACKUP_DIR='/secure/backups/dhc-preview'
export RELEASE_TAG='<deployed-commit>'
sh scripts/coolify-backup.sh
```

The script stops incoming traffic and writers, dumps PostgreSQL in custom format, archives private files, writes checksums and a COMPLETE marker, and restarts the same services even on failure. It does not delete old backups. A directory without COMPLETE is incomplete. Run it from a privileged server session, copy completed backups to encrypted off-host storage, set a retention policy and verify retrieval. Schedule a maintenance window before adding it to cron.

Before relying on backups, restore into a **separate new stack**, with no public domain, outbound providers disabled and the source release checked out:

1. Verify `SHA256SUMS` and COMPLETE. Keep the original encryption key/JWT secret available in the restored stack.
2. Start only postgres/redis and run that release's `migrate` to create database roles and grants. Keep API, workers, web and gateway stopped.
3. Pipe the custom dump to `pg_restore --clean --if-exists --no-owner -U dhc -d dhc` inside the **new** postgres container. Confirm the command exits successfully; never target the source stack.
4. Extract `files.tar.gz` into the **new** private-files volume using a one-off API container (`docker compose run --rm --no-deps --entrypoint tar api -C /data/files -xzf -` with archive on stdin). The API user must own/read the restored files.
5. Start API/workers/web/gateway privately. Confirm health, login/MFA, patient counts and at least one uploaded file download. Record restore time and results. Do not reconnect real-provider webhooks or share a domain during the drill.

For a new empty target, `migrate` provisions cluster-level NOLOGIN roles which are not contained in a regular database dump. Do not skip that step. Back up files and database at the same maintenance point to avoid missing file references.

## 9. Updates, rollback and operating checks

Before a release, record commit/tag and take a verified backup. Deploy the chosen commit manually during the client-preview period. Preserve the named volumes and original secrets. **Never use `docker compose down -v` on a deployment you want to keep.**

On startup failure, inspect the migrate exit code, backend logs, PDF self-test and individual container health first. Coolify can redeploy an earlier commit, but schema migrations remain applied. Roll back application code only when compatible with the current schema; otherwise restore the matched database/files/keys into an isolated replacement stack and switch the domain only after verification. Do not run destructive/down migrations as an automatic rollback.

Set an uptime monitor on the HTTPS login page and `/v1/ready`; review disk usage, container memory/restarts, API errors, failed queue jobs and backup age daily during the preview. Container JSON logs rotate at 10 MB with three files per service. Docker marks unhealthy containers but does not automatically restart every unhealthy process: alert and investigate dependency/storage failures. Keep database disk and file-volume free space monitored. Track the deployed commit and demo feedback.

A real-patient launch still requires the deferred integrations, approved patient documents and clinical workflows, production storage/retention decisions, security/restore/load acceptance, monitoring ownership and a controlled pilot. This bundle makes the existing web work hostable for a client demonstration; it does not claim those launch gates are finished.

## 10. Troubleshooting

On a heavily loaded cold start, the trusted PDF startup sample can time out before the API listens. The startup check retries that specific timeout at most three times with one-second gaps; permanent errors still fail closed. Uploaded PDF time/memory limits are unchanged. The API health-check startup allowance is 120 seconds.

| Symptom                                                            | Check and next action                                                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose file is missing, or Coolify chooses the wrong build system | Confirm repository `heyyrintu/digital-health-care`, branch `main`, base `/`, and Compose location `/docker-compose.coolify.yml`. Reload the definition.                           |
| Deployment says a variable is required                             | Fill every required variable in section 4, especially the initially blank `COOLIFY_PROXY_CIDR`, then save and redeploy.                                                           |
| Domain fails to resolve or HTTPS certificate issuance fails        | Check the application server's DNS address, any incorrect `AAAA` record, ports 80/443 and the Coolify proxy. Use the official DNS/firewall links above.                           |
| Coolify/proxy 404, 502 or 503                                      | Confirm the domain targets `gateway:8080`, all running services are healthy, and `migrate` exited 0. Read the affected service's logs; keep internal ports private.               |
| `migrate` exited 0 but appears stopped                             | This is expected. Check API/web/gateway health next.                                                                                                                              |
| Database authentication fails after editing a password             | Restore the saved matching environment value. Existing PostgreSQL volumes retain their original database password; changing an environment value does not rotate it.              |
| Staff session requests return 403                                  | Confirm `APP_URL` exactly matches the browser's HTTPS origin, without a trailing slash or `/v1`, and redeploy after changing it. Wrong-origin requests are deliberately rejected. |
| Authenticator code does not work                                   | Check the phone/server clocks and use a fresh code. Do not disable MFA for the hosted preview.                                                                                    |
| Demo seed says the database is not empty                           | It has already been populated or is the wrong target. Keep the data and use existing accounts/invites; do not rerun the seed or drop volumes.                                     |
| Patient login or a provider feature is unavailable                 | Expected while OTP, WhatsApp, Cashfree and signing are disabled in this preview. Use the prepared staff workflows.                                                                |
| Files disappear or cannot be opened after deployment               | Confirm the original `private-files` volume is mounted at `/data/files` and the original database/encryption key are in use. Restore from a matched backup if needed.             |
| Build or container is killed for lack of memory                    | Check server RAM, concurrent build usage and the supplied service limits. Add capacity or build separately; retain the API's PDF memory budget.                                   |

## 11. Ready-to-share checklist

- [ ] Coolify is deploying the intended commit on `main` using the production Compose file.
- [ ] One HTTPS hostname routes to `gateway:8080`; the browser shows no certificate warning.
- [ ] Required environment values are saved and backed up privately.
- [ ] All long-running services are healthy; `migrate` completed with exit code 0.
- [ ] Admin, doctor and front-desk accounts have completed password/authenticator setup.
- [ ] The synthetic patient, queue/consultation and document walkthrough has been rehearsed on the hosted site.
- [ ] Patient records and an authorised file download survive a restart.
- [ ] A matched backup and isolated restore have been checked on this host; monitoring and off-host backup ownership are assigned.
- [ ] The client-preview notice remains visible and providers remain disabled.


### Patient setup and practice details

The synthetic preview (`DEPLOYMENT_MODE=demo`) includes `/privacy` and `/terms` and uses
these links automatically unless custom URLs are configured. Redeploy the web service
after changing environment variables. Outside demo mode, set `PRIVACY_NOTICE_URL` and
`TERMS_URL` to clinic-reviewed published documents; missing links block onboarding.
The bundled pages describe the preview only. Review operator/contact details, providers,
retention and clinic policies before real patient use. Keep published text and
`CURRENT_CONSENT_VERSIONS` in step when changing consent versions.

Clinic admins: `/clinic` has **Clinic organisation name** for the organisation name,
**Clinics and consultations** has **Edit details** for location names/addresses,
and **Branding** controls the patient-facing display name/logo. Existing issued document
snapshots remain unchanged. Doctors: `/clinic/profile` has **Your staff profile** for your
name, plus prescription pad and public page controls for professional details. Names are
shared across staff memberships and only the account owner can change their own name.
The new migration grants only organisation name updates, preserving tenant isolation.

Document drafting reference: [MeitY DPDP Act text](https://www.meity.gov.in/static/uploads/2024/02/Digital-Personal-Data-Protection-Act-2023.pdf). The bundled preview documents do not establish legal compliance or describe a reviewed live clinic policy.


### Choose staff and platform login verification

See [second-factor options](second-factor-auth.md) for `STAFF_MFA_MODE` and
`PLATFORM_MFA_MODE` (`totp`, `whatsapp`, `disabled`), recipient mappings and redeployment.
Both default to `totp`; no hosted setting has been changed by adding these options.
