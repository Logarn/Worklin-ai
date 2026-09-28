#!/usr/bin/env bash
set -euo pipefail

minimum_memory_kib="${WORKLIN_MIN_HOST_MEMORY_KIB:-7340032}"
minimum_disk_kib="${WORKLIN_MIN_HOST_DISK_KIB:-62914560}"
data_path="${WORKLIN_DATA_PATH:-/var/lib/docker}"

for value in "$minimum_memory_kib" "$minimum_disk_kib"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "Preflight thresholds must be positive integer KiB values." >&2
    exit 1
  fi
done

architecture="$(uname -m)"
if [[ "$architecture" != "x86_64" ]]; then
  echo "Worklin VPS requires x86_64; found ${architecture}." >&2
  exit 1
fi

if [[ ! -r /proc/meminfo ]]; then
  echo "Cannot read host memory from /proc/meminfo." >&2
  exit 1
fi

memory_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
if [[ ! "$memory_kib" =~ ^[0-9]+$ ]]; then
  echo "Cannot determine total host memory." >&2
  exit 1
fi
if (( memory_kib < minimum_memory_kib )); then
  echo "Host memory is ${memory_kib} KiB; at least ${minimum_memory_kib} KiB is required." >&2
  exit 1
fi

while [[ ! -e "$data_path" && "$data_path" != "/" ]]; do
  data_path="$(dirname "$data_path")"
done
disk_kib="$(df -Pk "$data_path" | awk 'END { print $(NF - 4) }')"
if [[ ! "$disk_kib" =~ ^[0-9]+$ ]]; then
  echo "Cannot determine filesystem capacity for ${data_path}." >&2
  exit 1
fi
if (( disk_kib < minimum_disk_kib )); then
  echo "Host filesystem is ${disk_kib} KiB; at least ${minimum_disk_kib} KiB is required." >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required." >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose v2 is required." >&2
  exit 1
}

echo "Worklin VPS preflight passed: ${memory_kib} KiB memory, ${disk_kib} KiB filesystem, ${architecture}."
