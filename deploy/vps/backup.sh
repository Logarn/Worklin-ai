#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# != 4 )); then
  echo "Usage: $0 DEPLOYMENT_ENV BACKUP_PARENT AGE_RECIPIENTS_FILE SECRETS_DIRECTORY" >&2
  exit 2
fi

deployment_env="$1"
backup_parent="$2"
age_recipients_file="$3"
secrets_directory="$4"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${script_directory}/compose.yml"

for required_file in "$deployment_env" "$age_recipients_file"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required file does not exist: ${required_file}" >&2
    exit 1
  fi
done
if [[ ! -d "$secrets_directory" ]]; then
  echo "Secrets directory does not exist: ${secrets_directory}" >&2
  exit 1
fi
command -v age >/dev/null 2>&1 || {
  echo "age is required to encrypt backups." >&2
  exit 1
}
command -v sha256sum >/dev/null 2>&1 || {
  echo "sha256sum is required to create the backup manifest." >&2
  exit 1
}

mkdir -p "$backup_parent"
backup_parent="$(cd "$backup_parent" && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
working_directory="${backup_parent}/.worklin-${timestamp}.incomplete"
final_directory="${backup_parent}/worklin-${timestamp}"
if [[ -e "$working_directory" || -e "$final_directory" ]]; then
  echo "Backup destination already exists for ${timestamp}." >&2
  exit 1
fi
mkdir "$working_directory"

compose=(docker compose --env-file "$deployment_env" -f "$compose_file")
stopped_writers=false
restart_writers() {
  if [[ "$stopped_writers" == true ]]; then
    "${compose[@]}" up -d control-plane concurrent-runtime retention proxy >/dev/null
  fi
}
trap restart_writers EXIT

"${compose[@]}" ps --status running postgres --quiet | grep -q . || {
  echo "PostgreSQL must be running before a backup." >&2
  exit 1
}

"${compose[@]}" stop proxy control-plane concurrent-runtime retention >/dev/null
stopped_writers=true

"${compose[@]}" exec -T postgres \
  pg_dump --username=postgres --dbname=worklin --format=custom --no-owner --no-acl \
  | age --recipients-file "$age_recipients_file" \
      --output "${working_directory}/postgres-worklin.dump.age"

"${compose[@]}" exec -T postgres \
  pg_dump --username=postgres --dbname=worklin_retention --format=custom --no-owner --no-acl \
  | age --recipients-file "$age_recipients_file" \
      --output "${working_directory}/postgres-retention.dump.age"

for volume in control-plane runtime retention-objects; do
  "${compose[@]}" --profile operations run --rm --no-deps -T backup-reader \
    -C "/volumes/${volume}" -czf - . \
    | age --recipients-file "$age_recipients_file" \
        --output "${working_directory}/${volume}.tar.gz.age"
done

tar -C "$secrets_directory" -czf - . \
  | age --recipients-file "$age_recipients_file" \
      --output "${working_directory}/secrets.tar.gz.age"

(
  cd "$working_directory"
  sha256sum ./*.age > SHA256SUMS
)

mv "$working_directory" "$final_directory"
restart_writers
stopped_writers=false
trap - EXIT

echo "Encrypted Worklin backup created at ${final_directory}."
