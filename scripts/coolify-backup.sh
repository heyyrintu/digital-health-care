#!/bin/sh
# Run on the Coolify server from the checkout, with its exact Compose project name
# and env file. The brief maintenance window keeps DB and file backups consistent.
set -eu
umask 077
: "${COMPOSE_PROJECT_NAME:?Set the existing Coolify stack project name}"
: "${DHC_ENV_FILE:?Set the path to a private copy of the deployment environment}"
: "${DHC_BACKUP_DIR:?Set an absolute backup directory outside the repository}"
case "$DHC_BACKUP_DIR" in /*) ;; *) echo 'Backup directory must be absolute.' >&2; exit 1;; esac
compose() { docker compose --env-file "$DHC_ENV_FILE" -f docker-compose.coolify.yml "$@"; }
mkdir -p "$DHC_BACKUP_DIR"
backup="$DHC_BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup"
# Also back up secret values separately into your encrypted secret manager.
# The script never copies secrets into the archive or prints them.
trap 'compose start api workers web gateway >/dev/null' EXIT
trap 'exit 130' HUP INT TERM
compose stop gateway web api workers
compose exec -T postgres pg_dump -U dhc -d dhc -Fc > "$backup/database.dump"
compose run --rm --no-deps --entrypoint tar api -C /data/files -czf - . > "$backup/files.tar.gz"
# Archive only after all steps pass. A missing COMPLETE marker means discard/retry.
(cd "$backup" && sha256sum database.dump files.tar.gz > SHA256SUMS)
printf '%s\n' "${RELEASE_TAG:-Record the deployed commit manually}" > "$backup/RELEASE"
touch "$backup/COMPLETE"
echo "Backup complete: $backup. Copy to encrypted off-host storage and verify a restore."
