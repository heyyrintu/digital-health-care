# Coolify client-preview deployment

This is the supported **single-server, synthetic client-preview** deployment of the existing web version. It runs production Node builds and real authentication, with a persistent PostgreSQL database, persistent Redis and private file volume. It does not turn the unfinished integrations into production features. Native apps remain paused. No PR is needed to use this deployment.

## 1. Prepare the source and server

Coolify builds a Git commit, not the uncommitted files on a developer's laptop. Include the complete locally implemented web work and these deployment files in the branch you select. Do not point Coolify at an older main branch and expect local changes to appear. Record the deployed commit and set `RELEASE_TAG` to that identifier. The preview does not require merging to main or creating a PR.

Use a separate Coolify application/database from any real patient installation. Allow approximately **4 vCPU, 8 GB RAM and 30 GB free disk** as a starting allocation, with more RAM or a separate build server if building while the stack is running. These are initial sizing estimates, not load-test results. The API has a 1.5 GB limit for PDF processing; keep `PDF_REBUILD_CONCURRENCY=1`. Keep database, file and Redis volumes on persistent server storage. Do not scale this file-based stack to multiple servers.

Point a preview hostname at the Coolify server. Enable HTTPS through Coolify. Database, Redis, API and web containers have no published host ports; only the gateway receives a public domain.

## 2. Add a Git-based Compose application

In Coolify, create a resource from the repository and select the branch containing the completed local work. Choose the **Docker Compose** build strategy, base directory `/`, Compose location `/docker-compose.coolify.yml`. Do not select the development `docker-compose.yml` or Nixpacks.

Under Domains, assign **only `gateway`** a domain targeting its internal port, for example `https://preview.your-domain.com:8080`. The browser uses `https://preview.your-domain.com`; `:8080` is Coolify's destination container port, not a public browser port. Do not give postgres, redis, migrate, api or workers a domain. Do not enable automatic PR previews against this persistent database.

This follows Coolify's [Git-based Compose instructions](https://coolify.io/docs/applications/builds/docker-compose). Compose owns dependencies, health checks and volumes; there is no separate Nixpacks start command.

## 3. Configure environment values

Use [deploy/coolify/env.example](../../deploy/coolify/env.example) as the small configuration list. Generate fresh secrets on your own terminal, redirecting directly to a private file:

```sh
umask 077
node scripts/coolify-env.mjs https://preview.your-domain.com > /private/tmp/dhc-preview.env
```

Copy the values into this Coolify resource's environment settings. Store them in a secret manager as well; never commit the filled file. The generator makes URL-safe hexadecimal database/Redis passwords, an independent JWT secret and an exact 32-byte base64 encryption key. Never rotate `FIELD_ENCRYPTION_KEY` by simply changing the environment: existing encrypted data needs the original key. Changing `POSTGRES_PASSWORD` does not change the password in an already initialized PostgreSQL volume.

Set `COOLIFY_PROXY_CIDR` to the **actual subnet of the Coolify proxy network** on that server. Inspect it on the server, for example:

```sh
docker network inspect coolify --format '{{range .IPAM.Config}}{{.Subnet}}{{println}}{{end}}'
```

Use the subnet that actually carries the proxy-to-gateway connection, not the sample local-test address. Confirm the proxy is attached to it. Do not use `0.0.0.0/0` or `::/0`. The gateway trusts forwarded addresses from that subnet only and replaces the client-supplied forwarded chain before forwarding to the API/web. Keep application containers reachable only through their own stack. Do not attach unrelated/untrusted applications to this private application network.

Leave `PLATFORM_ALLOWED_CIDRS` empty initially: platform console access is denied. If a platform operator demo is required, add only the presenter's known public IP/CIDR and use the existing [platform-operator runbook](platform-operators.md); no public bootstrap endpoint or default account exists.

`APP_URL` must be the exact HTTPS browser origin, without a trailing slash or path. The same origin serves web and `/v1`, while server-side calls use the private API address. Public URLs and cookies work without baking the preview domain into the image.

Providers are explicitly off in this preview Compose file: OTP, outbound WhatsApp, Cashfree and legal prescription signing. `NODE_ENV` stays `production`; neither logged OTPs nor test signing are enabled. Credentials for those providers can come later, followed by a separate configuration/acceptance step. The web shows a client-preview notice and the gateway sends `noindex, nofollow, noarchive`. Indexing instructions are not access control: share the preview URL only with the intended reviewers and use authenticated staff areas for the demo.

## 4. Deploy and bootstrap synthetic records

Select Deploy. The stack starts database and Redis, runs **all committed migrations once per deployment**, then starts API/workers, web and finally gateway after health checks pass. `migrate` exiting with status **0** is expected; do not configure it to restart indefinitely. If migration fails, API/workers must remain stopped. Do not remove dependencies to force an unhealthy release online.

Check these browser URLs and Coolify logs:

- `/health`: web process alive.
- `/v1/health`: API process alive and version.
- `/v1/ready`: API database query succeeds; returns 503 on failure.
- `/clinic/login`: styled page with the synthetic-preview notice.
- API logs: `PDF rebuild self-test passed` before serving traffic. Production startup refuses a broken PDF rebuild package.

Container API/worker probes additionally check PostgreSQL and Redis; the API probe checks private-file permissions. Worker probes establish process/dependency availability, not proof that every provider job completes. Monitor job failures and outbox state when integrations are enabled later.

In Coolify's **API container terminal**, manually run this **once**, without recording or sharing its output:

```sh
node dist/seed.js --empty-demo-database
```

It refuses a database containing organisations, users, patients or platform operators, and refuses active provider configuration. It creates Demo Clinic, six fictional patients, consultation types, a schedule, sample medicines and three staff invitations. It does not create shared passwords, bypass MFA, auto-send messages or automatically run on deployment. The sample video consultation type is illustrative; video consulting/prepayment are not part of this preview acceptance.

Open the generated fragment invite links privately to set individual passwords and enrol authenticators for:

- `frontdesk@demo-clinic.test`
- `doctor@demo-clinic.test`
- `admin@demo-clinic.test`

The links are credentials and expire after 72 hours. Do not put them in tickets, build logs, screenshots or the client presentation. A populated database deliberately cannot be reseeded in production. Finish invitation setup before the presentation; use normal staff invitation/recovery workflows thereafter. Ordinary development seeding still refuses `NODE_ENV=production` without this explicit empty-demo flag.

Follow [the client-demo guide](../product/client-preview-guide.md). Keep synthetic data only. Patient OTP and final signed prescription delivery are unavailable while their providers remain deferred; do not weaken login controls to demonstrate them.

## 5. Back up and prove restoration

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

## 6. Rollback and operating checks

Before a release, record commit/tag and take a verified backup. Deploy the chosen commit manually during the client-preview period. Preserve the named volumes and original secrets. **Never use `docker compose down -v` on a deployment you want to keep.**

On startup failure, inspect the migrate exit code, backend logs, PDF self-test and individual container health first. Coolify can redeploy an earlier commit, but schema migrations remain applied. Roll back application code only when compatible with the current schema; otherwise restore the matched database/files/keys into an isolated replacement stack and switch the domain only after verification. Do not run destructive/down migrations as an automatic rollback.

Set an uptime monitor on the HTTPS login page and `/v1/ready`; review disk usage, container memory/restarts, API errors, failed queue jobs and backup age daily during the preview. Container JSON logs rotate at 10 MB with three files per service. Docker marks unhealthy containers but does not automatically restart every unhealthy process: alert and investigate dependency/storage failures. Keep database disk and file-volume free space monitored. Track the deployed commit and demo feedback.

A real-patient launch still requires the deferred integrations, approved patient documents and clinical workflows, production storage/retention decisions, security/restore/load acceptance, monitoring ownership and a controlled pilot. This bundle makes the existing web work hostable for a client demonstration; it does not claim those launch gates are finished.
