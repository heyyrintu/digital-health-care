# Host the web preview on Amazon ECS with Fargate

This guide replaces Coolify with AWS-managed container hosting for this repository. The failed 2 GB VPS no longer builds or runs the application. AWS CodeBuild builds images; ECS/Fargate runs them; RDS, ElastiCache and EFS hold persistent state.

**Scope:** a synthetic client-preview deployment with staff passwords/MFA. Patient OTP, outgoing WhatsApp, Cashfree, AI and legal prescription signing stay deferred/off. This is not acceptance for a real-patient launch.

**Implementation status:** this guide and the files under `deploy/ecs/` are deployment examples. They have not been deployed or tested in your AWS account. Commit/push these new files to the branch you will build before configuring CodeBuild. The existing `main` release contains the application and root Dockerfile; the ECS additions must also be present in the selected source revision.

## 1. Choose the layout

For the first preview, use **one ECS service with one Fargate task**, containing four containers:

```mermaid
flowchart LR
    GitHub --> CodeBuild --> ECR
    Browser -->|HTTPS| ALB
    ALB --> Gateway
    subgraph Task[One Fargate task]
        Gateway --> Web
        Gateway --> API
        Web --> API
        Workers
    end
    ECR -. images .-> Task
    API --> RDS[(RDS PostgreSQL)]
    Workers --> RDS
    API --> Redis[(ElastiCache Redis OSS)]
    Workers --> Redis
    API --> EFS[(EFS private files)]
```

The task uses `awsvpc` networking: containers inside that same task communicate through localhost. See [AWS task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking-awsvpc.html). This arrangement avoids separate service-discovery configuration for the preview; it also means the four containers deploy, restart and scale together. Do not split them into separate tasks while keeping the localhost addresses below.

Use these repository files:

| File                                                                   | Purpose                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `Dockerfile`, target `backend`                                         | Builds the API, workers, migration CLI and operational commands |
| `Dockerfile`, target `web`                                             | Builds the standalone Next.js web server                        |
| [deploy/ecs/Dockerfile.backend](../../deploy/ecs/Dockerfile.backend)   | Adds the public RDS certificate bundle to the backend image     |
| [deploy/ecs/Dockerfile.gateway](../../deploy/ecs/Dockerfile.gateway)   | Builds the ECS-specific gateway                                 |
| [deploy/ecs/nginx.conf.template](../../deploy/ecs/nginx.conf.template) | Routes to localhost API/web and trusts the ALB subnet addresses |
| [deploy/ecs/buildspec.yml](../../deploy/ecs/buildspec.yml)             | Builds/pushes the three images using CodeBuild                  |

**Do not deploy the Coolify gateway image or `docker-compose.coolify.yml` directly to ECS.** That gateway expects Docker service-name DNS. The ECS gateway uses localhost, and AWS replaces the Compose databases, volumes, dependencies and public proxy.

## 2. Select region, names and a budget

Examples use **Mumbai (`ap-south-1`)** and `preview.your-domain.com`. Choose one region for the application resources, ECR repositories, logs, secrets and HTTPS certificate. Account IDs, subnet IDs, ARNs and endpoints must come from your own account; examples are not executable account identifiers.

Use a recognisable prefix such as `dhc-preview`. Before creating resources, estimate the combined charges for Fargate, RDS, Redis, EFS, ALB, NAT, builds, logs, backups and data transfer with the [AWS Pricing Calculator](https://calculator.aws/). Set an AWS Budget alert. This multi-service setup has costs even with few visitors; it is not a free-tier or minimum-cost architecture.

Initial **preview sizing estimates**, to adjust after measuring:

- Fargate task: **2 vCPU / 4 GB RAM**, Linux **X86_64**, desired task count **1**. Build images for the same architecture.
- CodeBuild: a Docker-capable Linux compute size with at least 8 GB RAM; select a larger size for build headroom. Do not build on the old VPS.
- RDS PostgreSQL 16: start with a small instance with about 2 GB RAM, encrypted storage and automated backups. Use Multi-AZ when availability requirements justify it.
- Redis OSS 7.x: a supported node size with space for the queue workload; monitor memory and failed jobs. Add a replica/failover for production availability.

These are planning estimates, not load-test results or a guarantee of capacity. Keep one API process and PDF rebuild concurrency 1 for the preview.

## 3. Create the VPC and security groups

In VPC, create a VPC with two Availability Zones, two public subnets and two private subnets. Place the internet-facing ALB in the public subnets. Put Fargate, RDS and Redis in the private subnets, with Fargate public IP assignment disabled. Create EFS mount targets in the task Availability Zones.

Private tasks need outbound connectivity for ECR image pulls, logs, secret retrieval and any later provider calls. Start with NAT egress, or design the necessary VPC endpoints and external-provider egress explicitly. NAT has a separate cost; tasks without a working egress path often fail before a container starts.

Create security groups with these inbound rules:

| Security group | Inbound access                                                                                |
| -------------- | --------------------------------------------------------------------------------------------- |
| `dhc-alb-sg`   | TCP 443 from intended visitors; TCP 80 for HTTP-to-HTTPS redirect                             |
| `dhc-task-sg`  | TCP **8080 only**, source `dhc-alb-sg`                                                        |
| `dhc-db-sg`    | TCP 5432, source `dhc-task-sg`; optionally a separate approved admin SG for initial SQL setup |
| `dhc-redis-sg` | TCP 6379, source `dhc-task-sg`                                                                |
| `dhc-efs-sg`   | TCP 2049, source `dhc-task-sg`                                                                |

Attach the task SG to both application and migration tasks. Database, Redis and NFS ports remain private. No SSH port is needed on Fargate. Record the **two public subnet CIDRs occupied by the ALB** for the gateway environment values later. These are AWS VPC subnet CIDRs, not the previous Coolify subnet or the ALB's changing individual IPs.

## 4. Create RDS PostgreSQL

In RDS, create PostgreSQL **16**, database name `dhc`, in the private DB subnet group, with `dhc-db-sg`, encryption, backups and public access disabled. Keep the admin login in Secrets Manager. Record the RDS DNS endpoint.

This repository's migrations create NOLOGIN application roles, grants, row-level security and security-definer functions. The migration connection must own the application objects and be able to create/grant the `dhc_*` roles. RDS administrators do not have PostgreSQL's unrestricted `SUPERUSER`; see [RDS role behaviour](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html).

From an approved private-VPC admin connection with `psql` (for example a configured CloudShell VPC environment or SSM-managed admin host), create a dedicated owner login before migrating:

```sql
CREATE ROLE dhc_owner LOGIN CREATEROLE;
\password dhc_owner
ALTER DATABASE dhc OWNER TO dhc_owner;
```

Use a generated unique password at the prompt. Run this while the application database is empty. Confirm the login can create schema objects and grant the migration roles. Do not try to reach a private RDS endpoint from an ordinary internet shell without a VPC access path.

For this preview, the current code expects an owner-capable database connection and switches to restricted roles inside tenant/auth transactions. Use that dedicated owner login consistently for migrations and the current runtime. Do not put the RDS administrator login into application containers. A further audited split between migration/runtime/maintenance privileges is a real-patient-launch task; do not assume an arbitrary read/write database login can run this release unchanged.

Store the following as the `DATABASE_URL` secret, replacing the endpoint/password:

```text
postgresql://dhc_owner:HEX_PASSWORD@YOUR_RDS_ENDPOINT:5432/dhc?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem
```

Use the real RDS hostname for certificate verification. A hexadecimal password avoids URL-escaping surprises. The ECS backend wrapper includes the RDS CA file at that exact path. Keep TLS verification enabled; see [RDS PostgreSQL TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html). Verify all migrations against this RDS instance before creating the public service.

## 5. Create ElastiCache Redis

Create a **node-based Redis OSS** replication group with **cluster mode disabled**, private subnet placement, `dhc-redis-sg`, encryption at rest and TLS required. Set a strong AUTH token. Use a parameter group with **`maxmemory-policy=noeviction`** so queue data is not silently evicted.

This release uses a normal ioredis connection, not a Redis Cluster client. Do not select serverless/cluster-mode-enabled Redis as a drop-in replacement. The current app uses database 0.

Record the **primary endpoint**, not a read-only endpoint, and store:

```text
rediss://:HEX_AUTH_TOKEN@YOUR_REDIS_PRIMARY_ENDPOINT:6379/0
```

The `rediss` scheme enables TLS. This example uses password-only AUTH, not short-lived IAM tokens. See [ElastiCache AUTH](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth.html) and [node-based cluster setup](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/SubnetGroups.designing-cluster-pre.redis.html). Test BullMQ operations and queue monitoring on the selected engine/version before enabling any provider workers.

## 6. Create persistent EFS files

Create an encrypted Regional EFS file system in the same VPC, with mount targets in both task AZs using `dhc-efs-sg`. Create an access point with:

| Setting                            | Value           |
| ---------------------------------- | --------------- |
| Access-point path                  | `/dhc-preview`  |
| Enforced POSIX UID / GID           | `1000` / `1000` |
| Directory creation owner UID / GID | `1000` / `1000` |
| Directory creation permissions     | `0750`          |

The backend runs as Node's non-root user. Set directory creation information so EFS can create the path on first mount. Enable EFS backups and define retention.

In the application task definition, add volume `private-files` with the file-system ID, this access-point ID, IAM authorization **enabled** and transit encryption **enabled**. Omit the EFS root-directory setting or use `/` when specifying an access point. Mount it **read/write at `/data/files` in the API container only**.

The application task role needs `elasticfilesystem:ClientMount` and `elasticfilesystem:ClientWrite` scoped to this file system/access point; configure the EFS resource policy consistently. It does not need unrestricted root access. Follow [AWS EFS/ECS guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-best-practices.html).

Do not use the Fargate task's temporary filesystem for retained uploads. S3 is a possible later storage-adapter change, not a filesystem mount substitute for the existing LocalFileStore.

## 7. Create secrets, log groups and IAM roles

Create separate Secrets Manager values (or keys in one JSON secret) for:

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`: independently generated, at least 32 characters.
- `FIELD_ENCRYPTION_KEY`: exactly 32 random bytes encoded as Base64.

Generate secrets privately; do not paste them into task-definition JSON, build arguments, screenshots or Git. The repository's `scripts/coolify-env.mjs` can generate the random passwords/keys on your laptop, but its Coolify-only variables are not used here. Do not regenerate the encryption key when restarting or updating an existing database.

Create CloudWatch log groups for `api`, `web`, `workers`, `gateway` and `migrate`, with a chosen retention period. Use `awslogs` with the correct region and stream prefix in each container definition. The gateway disables URL access logs; keep application credential redaction intact.

Create these separate IAM roles:

| Role                      | Access required                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeBuild service role    | Push/pull the three ECR repositories; obtain an ECR authorization token; use the selected GitHub/CodeConnections source connection; write build logs/artifacts. No application database or field-encryption secrets. |
| ECS task execution role   | Pull images, write container logs, retrieve the referenced Secrets Manager values, and decrypt their KMS key if needed.                                                                                              |
| ECS application task role | EFS client mount/write permissions; approved ECS Exec permissions only if you enable that administration path.                                                                                                       |

Map secrets using ECS container `secrets` entries, not ordinary environment values. A JSON-key mapping has the form `arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME-SUFFIX:DATABASE_URL::`. Check the exact ARN from your account and use Linux Fargate platform **1.4.0 or later**. Secret changes require replacement tasks; existing containers do not automatically reload them. See [ECS secret injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html).

## 8. Build images with CodeBuild and store them in ECR

1. In ECR, create private repositories `dhc-backend`, `dhc-web` and `dhc-gateway`. Enable tag immutability and image scanning; retain images required for rollback.
2. In CodeBuild, create a project connected to `heyyrintu/digital-health-care`, selecting the source branch/revision containing the ECS files.
3. Choose an AWS-managed Docker-capable **Linux X86_64**, EC2-backed build environment, appropriate memory (section 2), and **privileged mode** for this Docker build. Keep this build project separate from the application's private VPC unless you deliberately configure its egress.
4. Set buildspec path to **`deploy/ecs/buildspec.yml`**.
5. Set the non-secret project environment variable `AWS_ACCOUNT_ID` to your account ID. Confirm the build region through `AWS_DEFAULT_REGION`; CodeBuild normally supplies it.
6. Attach the scoped CodeBuild role from section 7 and start a build of the intended commit.
7. Confirm all three image pushes succeed and save the image URIs from `imagedefinitions.json`/ECR.

The buildspec builds sequentially, adds the public RDS CA bundle to the backend image, and publishes a unique **commit-SHA/build-number** tag. The API, workers and migration tasks use that same backend image. It never deploys ECS or receives runtime secrets. See [AWS's Docker/ECR build example](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-docker.html).

Use the exact image tag or digest in task revisions. Never mix a new web image with an unrelated backend release. Do not publish the raw local `dhc-backend-base:build` image as the ECS runtime; the wrapped ECR backend contains the required CA bundle.

## 9. Create the application task definition

In ECS, create cluster `dhc-preview`, then a task definition family `dhc-preview-app`:

- Launch type **Fargate**, Linux **X86_64**, network mode **awsvpc**.
- Task size **2 vCPU / 4 GB**, using the execution/application roles above.
- Add the EFS volume from section 6.
- Add these four **essential** containers. All share one task/network namespace.

| Container | Image                            | Port     | Working directory / command                                            | Memory limit starting point |
| --------- | -------------------------------- | -------- | ---------------------------------------------------------------------- | --------------------------- |
| `api`     | Wrapped `dhc-backend` image      | TCP 4000 | Keep image defaults                                                    | 1536 MiB                    |
| `workers` | Same backend image               | None     | Working directory `/app/apps/workers`; command `node`, `dist/index.js` | 512 MiB                     |
| `web`     | `dhc-web` image                  | TCP 3000 | Keep image defaults                                                    | 1024 MiB                    |
| `gateway` | ECS-specific `dhc-gateway` image | TCP 8080 | Keep image defaults                                                    | 128 MiB                     |

Use default CPU shares initially; the sum of hard memory limits leaves task headroom. Give API/workers a stop timeout up to 120 seconds for graceful draining. Only the API mounts EFS. These limits do not apply to CodeBuild: build capacity is configured separately.

### API environment and secrets

Inject all four secrets from section 7 into API. Set ordinary environment values:

```dotenv
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=4000
APP_VERSION=YOUR_RELEASE_TAG
WEB_BASE_URL=https://preview.your-domain.com
CORS_ORIGINS=https://preview.your-domain.com
FILE_STORE_DIR=/data/files
PDF_REBUILD_CONCURRENCY=1
LOG_LEVEL=info
TRUST_PROXY_HOPS=1
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
PLATFORM_ALLOWED_CIDRS=
OTP_DELIVERY=disabled
SIGNER=disabled
CASHFREE_ENABLED=false
CASHFREE_ACCEPT_NEW_PAYMENTS=false
CASHFREE_REFUNDS_ENABLED=false
CASHFREE_RECONCILIATION_ENABLED=false
CASHFREE_PREPAID_BOOKING_ENABLED=false
WHATSAPP_WEBHOOK_ENABLED=false
WHATSAPP_APPOINTMENTS_ENABLED=false
WHATSAPP_OPERATIONS_ENABLED=false
WHATSAPP_RECORDS_ENABLED=false
WHATSAPP_PAYMENTS_ENABLED=false
WHATSAPP_INBOX_ENABLED=false
```

Loopback trust is intentional: gateway/web are the only HTTP callers inside the task. The task security group exposes only gateway port 8080 to the ALB, so clients cannot bypass it to reach API/web.

### Workers environment and secrets

Inject `DATABASE_URL` and `REDIS_URL` into workers. Set `NODE_ENV=production`, `WEB_BASE_URL` to the HTTPS origin, and the `WHATSAPP_*_ENABLED`/`CASHFREE_RECONCILIATION_ENABLED` switches above to `false`. No external-provider credentials are needed for this preview.

### Web environment

```dotenv
NODE_ENV=production
HOSTNAME=0.0.0.0
PORT=3000
NEXT_TELEMETRY_DISABLED=1
DEPLOYMENT_MODE=demo
API_BASE_URL=https://preview.your-domain.com/v1
API_INTERNAL_BASE_URL=http://127.0.0.1:4000/v1
PUBLIC_SITE_URL=https://preview.your-domain.com
WEB_BASE_URL=https://preview.your-domain.com
FORWARD_CLIENT_IP=true
```

Leave `PRIVACY_NOTICE_URL` and `TERMS_URL` unset until reviewed documents are published; patient OTP remains disabled. No database or encryption secrets belong in web/gateway.

### Gateway environment

```dotenv
ALB_SUBNET_CIDR_1=YOUR_FIRST_ALB_PUBLIC_SUBNET_CIDR
ALB_SUBNET_CIDR_2=YOUR_SECOND_ALB_PUBLIC_SUBNET_CIDR
NGINX_ENVSUBST_FILTER=^ALB_SUBNET_CIDR_[12]$
```

Use the **actual** two ALB subnet CIDRs, such as `10.42.0.0/24` and `10.42.1.0/24` only if those are your configured subnets. Never use a catch-all CIDR. ECS environment values are literal: enter the filter with **one** `$`, not Compose's escaped `$$`. No `COOLIFY_PROXY_CIDR` is used here.

The gateway restores the client address from ALB, replaces forwarded headers sent onward, routes `/v1/` to local API and all other paths to local web, and sends preview no-index headers. Keep ALB X-Forwarded-For processing in **append** mode, with client-port inclusion disabled.

### Container health and startup dependencies

Add these ECS health checks as `CMD` arrays (not Dockerfile text); use 30-second intervals, appropriate start periods around 60 seconds, and three retries. Backend checks need a 10-second timeout, web about 5 seconds.

```json
["CMD", "node", "/app/deploy/coolify/healthcheck.mjs", "api"]
```

```json
["CMD", "node", "/app/deploy/coolify/healthcheck.mjs", "workers"]
```

```json
[
  "CMD",
  "node",
  "-e",
  "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
]
```

For gateway, use `CMD-SHELL` with:

```sh
wget -q -O /dev/null http://127.0.0.1:8080/health && wget -q -O /dev/null http://127.0.0.1:8080/v1/ready
```

The reused backend probe's directory name says `coolify`, but it checks standard PostgreSQL/Redis/file/HTTP dependencies and also works here. Set web to depend on API being `HEALTHY`; gateway depends on API and web being `HEALTHY`. Workers need no HTTP dependency. Migrations are a separate release step below, not a permanently running container or per-replica startup action.

## 10. Run migrations before the first service deployment

Create a separate Fargate task definition `dhc-preview-migrate` with **one** container:

- Same wrapped backend release image and execution role.
- Working directory `/app`.
- Command array `["pnpm", "--filter", "@dhc/db", "migrate:deploy"]`.
- Inject `DATABASE_URL`; set `NODE_ENV=production`.
- CloudWatch log group for migrations; no ports, ALB attachment, EFS mount, health check or ECS service.
- Start with 1 vCPU / 2 GB RAM, in the private task subnets with `dhc-task-sg` and working outbound connectivity.

Run it as a standalone task. Wait until it stops, inspect its logs and confirm **container exit code 0**. A stopped task alone does not establish success. On a fresh database it should apply all migrations in that source revision (48 in the initial web preview release).

If role ownership/grant/TLS checks fail, fix those before starting the application. Do not discard failing migrations, relax tenant policies or manually mark unapplied migrations successful. Run migrations once per deployment with the intended backend image, before replacing the application service.

## 11. Configure HTTPS, load balancer and the ECS service

1. In ACM, request a certificate for `preview.your-domain.com` in the **ALB's region** and complete DNS validation. Keep the validation record for renewal.
2. Create an internet-facing Application Load Balancer in the two public subnets, using `dhc-alb-sg`.
3. Create a target group with target type **IP**, protocol **HTTP**, port **8080**, health path **`/v1/ready`** and success code **200**. Do not use instance targets for this Fargate service.
4. Add HTTPS listener **443** using the ACM certificate; forward its default action to this target group. Add HTTP **80** redirecting to HTTPS. Use an idle timeout suitable for long responses, initially 120 seconds.
5. In ECS, create service `dhc-preview-app` using the intended application task revision, Fargate platform 1.4.0 or later and desired count **1**. Select the private task subnets, `dhc-task-sg`, and disable public IP assignment.
6. Attach the ALB target group to container **`gateway`**, port **8080**. Set a health-check grace period such as 120 seconds and enable deployment failure detection/rollback.
7. Wait for ECS steady state and healthy ALB targets. Do not manually register changing task IPs; ECS maintains registrations.
8. In DNS, point the application hostname to the ALB using a Route 53 alias, or a subdomain CNAME at your existing DNS provider. It no longer points to the old VPS or Coolify server.

Open `/health`, `/v1/health`, `/v1/ready` and `/clinic/login` through the HTTPS hostname. Confirm the preview notice, no-index response header, styled assets and API log `PDF rebuild self-test passed`.

## 12. Bootstrap the synthetic clinic and rehearse

Enable an approved ECS Exec administration path for the running API container if you need interactive bootstrap. This requires suitable operator IAM, task permissions, network access and Session Manager tooling; follow [AWS ECS Exec setup](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html). Do not add a public management HTTP endpoint or SSH server to the task.

Invite links are credentials. Use a private administrative session suitable for handling them. Do not run the seed as a normal CloudWatch-logged build/migration command. If your organisation records administrative session output, use its approved credential-provisioning procedure; do not disable required audit controls.

In the API container shell:

```sh
cd /app/apps/api
node dist/seed.js --empty-demo-database
```

This runs only against an empty, migrated synthetic database with providers disabled. Open the printed invitation links privately and complete passwords/authenticators for admin, doctor and front desk. For later login, use clinic ID **`demo-clinic`** and the identifiers `admin@demo-clinic.test`, `doctor@demo-clinic.test` and `frontdesk@demo-clinic.test`. There is no default password or need to deliver emails to those `.test` identifiers.

Finish setup within the invite expiry window; do not reseed a populated database. Rehearse [the client walkthrough](../product/client-preview-guide.md). Force a task replacement, then confirm records and an authorised file download remain available from RDS/EFS. Verify staff session refresh and client-IP rate limiting through the ALB/gateway path. Keep native builds and external providers off.

## 13. Backups, updates, rollback and costs

Use RDS automated backups/point-in-time recovery and AWS Backup for EFS, with explicit retention, access controls and restore ownership. Retain the original field-encryption key separately in protected secret recovery storage. For a matched application backup, pause incoming traffic and writers while taking the database/file recovery point; independent asynchronous snapshots alone do not establish cross-store consistency. Prove an isolated restore, including authenticated file access.

The Coolify host backup script is **not applicable** to managed RDS/EFS. Do not attempt to run Docker-volume restore commands on Fargate or place PostgreSQL/Redis inside a task with temporary storage.

For each release:

1. Build and record the three versioned image URIs/digests and source commit.
2. Take/verify recovery points; review database compatibility.
3. Run the migration task and require exit code 0.
4. Create a new application task revision with matching images; update the service.
5. Wait for steady state, then rehearse login, queue, consultation, file access and health checks.

Rolling deployments temporarily overlap old/new tasks. For the initial preview, use a short maintenance window when needed: stop writers and wait for old tasks to drain before replacing them. Do not scale this single-task preview into concurrent API maintenance processes without reviewing sweep/inbox dispatch concurrency, provider configuration and database connection limits.

ECS deployment rollback restores a task revision, **not** earlier database contents. Use it only while the old code is compatible with applied migrations. Otherwise restore the matched database/files/keys to an isolated environment before switching traffic. Preserve image versions needed for that operation.

Set alerts for unhealthy ALB targets, failed ECS deployments/task restarts, memory/CPU pressure, database connections/storage, Redis memory/evictions and failed jobs, EFS backup failures and unexpected spend. Use HTTPS uptime checks and CloudWatch log retention. Stop/delete unused preview resources deliberately: scaling the ECS service to zero does not stop RDS, Redis, NAT, ALB or storage charges.

## 14. Troubleshooting and acceptance

| Symptom                                                      | What to check                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CodeBuild killed or out of memory                            | Build compute capacity, sequential build logs and Docker disk space; do not move the build back onto the old 2 GB VPS.                     |
| `CannotPullContainerError` / resource initialization failure | Correct image URI/digest/architecture, execution-role permissions, NAT/VPC endpoints, log groups and Secrets Manager/KMS access.           |
| RDS TLS or certificate error                                 | Wrapped backend image includes the CA file; URL has the real RDS hostname, verified TLS and correct certificate path.                      |
| Migration permission error                                   | Dedicated owner, schema ownership, RDS role-creation/grant permissions and exact source revision.                                          |
| Redis connection/queue errors                                | Private primary endpoint, TLS `rediss`, AUTH token, cluster mode disabled, compatible engine and SG 6379.                                  |
| EFS permission/mount failure                                 | Mount targets/AZs, SG 2049, access-point directory creation UID/GID 1000, mount path, IAM/resource policy and transit encryption.          |
| ALB unhealthy / 502                                          | Gateway container/port 8080, all essential containers running, startup health dependencies, successful migrations and private connections. |
| Browser login 403                                            | All public web URL values match the browser's HTTPS origin exactly.                                                                        |
| All users appear to share one rate-limit address             | Actual ALB subnet CIDRs, append-mode X-Forwarded-For, private task ingress and gateway sanitization; keep API loopback trust narrow.       |
| Preview looks healthy but files disappear on replacement     | API must mount the persistent EFS access point at `/data/files`; confirm matching database and encryption key.                             |

Before sharing with the client, require successful migration/task health, HTTPS without warnings, staff MFA/refresh, protected role access, file persistence through task replacement, a tested isolated restore, preview labelling and monitoring. RDS/ElastiCache/EFS integration, IAM/networking and AWS recovery procedures still need validation in your account; local Docker/previous Coolify CI tests do not validate those AWS resources.

### Local checks completed for these examples

The ECS gateway image built successfully and passed nginx configuration validation. A shared-network-namespace test verified localhost API/web routing and forwarded-client-address sanitization using mock backends. The backend wrapper built against an existing local backend image and its RDS certificate bundle was readable and parsed by OpenSSL. The CodeBuild YAML/command structure, shell syntax and repository links were checked. These checks do not execute CodeBuild or validate a live AWS deployment.
