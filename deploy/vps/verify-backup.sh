#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 BACKUP_DIRECTORY AGE_IDENTITY_FILE" >&2
  exit 2
fi

backup_directory="$1"
age_identity_file="$2"
if [[ ! -d "$backup_directory" ]]; then
  echo "Backup directory does not exist: ${backup_directory}" >&2
  exit 1
fi
if [[ ! -f "$age_identity_file" ]]; then
  echo "Age identity file does not exist: ${age_identity_file}" >&2
  exit 1
fi
for command_name in age pg_restore sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "${command_name} is required to verify backups." >&2
    exit 1
  }
done

(
  cd "$backup_directory"
  sha256sum --check SHA256SUMS
)

for archive in control-plane runtime retention-objects secrets; do
  age --decrypt --identity "$age_identity_file" \
    "${backup_directory}/${archive}.tar.gz.age" \
    | tar -tzf - >/dev/null
done

for database_dump in postgres-worklin postgres-retention; do
  age --decrypt --identity "$age_identity_file" \
    "${backup_directory}/${database_dump}.dump.age" \
    | pg_restore --list >/dev/null
done

echo "Backup checksums, encrypted archives, and PostgreSQL dumps are valid."
