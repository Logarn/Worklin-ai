#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# != 2 )); then
  echo "Usage: $0 DEPLOYMENT_ENV OUTPUT_DIRECTORY" >&2
  exit 2
fi

deployment_env="$1"
output_directory="$2"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_directory}/../.." && pwd)"

if [[ ! -f "$deployment_env" ]]; then
  echo "Deployment environment does not exist: ${deployment_env}" >&2
  exit 1
fi
if [[ -n "$(git -C "$repository_root" status --porcelain)" ]]; then
  echo "Production images require a clean Git checkout." >&2
  exit 1
fi

release="$(awk -F= '$1 == "WORKLIN_RELEASE" { print substr($0, index($0, "=") + 1) }' "$deployment_env" | tail -n 1)"
if [[ ! "$release" =~ ^[0-9a-f]{40}$ ]]; then
  echo "WORKLIN_RELEASE must be a full 40-character Git commit." >&2
  exit 1
fi
head_commit="$(git -C "$repository_root" rev-parse HEAD)"
if [[ "$release" != "$head_commit" ]]; then
  echo "WORKLIN_RELEASE does not match the checked-out commit." >&2
  exit 1
fi

mkdir -p "$output_directory"
output_directory="$(cd "$output_directory" && pwd)"
bundle="${output_directory}/worklin-vps-images-${release}.tar.gz"
manifest="${output_directory}/worklin-vps-images-${release}.manifest"
if [[ -e "$bundle" || -e "$manifest" ]]; then
  echo "Image output already exists for ${release}." >&2
  exit 1
fi

runtime_image="worklin-vps-runtime:${release}"
retention_image="worklin-vps-retention:${release}"
docker build --pull --platform linux/amd64 \
  --file "${repository_root}/runtime/Dockerfile" \
  --tag "$runtime_image" \
  "$repository_root"
docker build --pull --platform linux/amd64 \
  --file "${repository_root}/retention-service/Dockerfile" \
  --tag "$retention_image" \
  "$repository_root"

runtime_id="$(docker image inspect "$runtime_image" --format '{{.Id}}')"
retention_id="$(docker image inspect "$retention_image" --format '{{.Id}}')"

docker save "$runtime_image" "$retention_image" | gzip -9 > "$bundle"
bundle_checksum="$(sha256sum "$bundle" | awk '{ print $1 }')"
{
  printf 'release=%s\n' "$release"
  printf 'runtime_image=%s\n' "$runtime_image"
  printf 'runtime_image_id=%s\n' "$runtime_id"
  printf 'retention_image=%s\n' "$retention_image"
  printf 'retention_image_id=%s\n' "$retention_id"
  printf 'bundle_sha256=%s\n' "$bundle_checksum"
} > "$manifest"

echo "Production image bundle created at ${bundle}."
