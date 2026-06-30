#!/usr/bin/env bash
set -euo pipefail

: "${WORKLIN_RUNTIME_ROOT:=/data}"
: "${VELLUM_WORKSPACE_DIR:=${WORKLIN_RUNTIME_ROOT}/workspace}"
: "${GATEWAY_SECURITY_DIR:=${WORKLIN_RUNTIME_ROOT}/gateway-security}"
: "${CES_DATA_DIR:=${WORKLIN_RUNTIME_ROOT}/ces-data}"
: "${CREDENTIAL_SECURITY_DIR:=${WORKLIN_RUNTIME_ROOT}/ces-security}"
: "${CES_BOOTSTRAP_SOCKET_DIR:=/run/ces-bootstrap}"
: "${GATEWAY_IPC_SOCKET_DIR:=/run/gateway-ipc}"
: "${DEBUG_STDOUT_LOGS:=1}"
: "${PORT:=8080}"
: "${WORKLIN_CONTROL_PLANE_PORT:=${PORT}}"
: "${WORKLIN_CONTROL_DB:=${WORKLIN_RUNTIME_ROOT}/control-plane.sqlite}"
: "${CES_HEALTH_PORT:=8090}"
: "${CES_CREDENTIAL_URL:=http://127.0.0.1:${CES_HEALTH_PORT}}"
: "${GATEWAY_PORT:=7830}"
: "${RUNTIME_HTTP_PORT:=3001}"
: "${RUNTIME_HTTP_HOST:=0.0.0.0}"
: "${ASSISTANT_HOST:=127.0.0.1}"
: "${UNMAPPED_POLICY:=default}"
: "${GATEWAY_TRUST_PROXY:=true}"
: "${IS_CONTAINERIZED:=true}"
: "${CES_MODE:=managed}"

workspace_data_dir="${VELLUM_WORKSPACE_DIR%/}/data"
workspace_credentials_dir="${workspace_data_dir}/credentials"

# runtime/Dockerfile is the combined single-container deploy. The gateway is
# co-located with the public control-plane, so service-to-service traffic must
# stay on loopback even if a stale split-service/docker-compose env var exists.
GATEWAY_INTERNAL_URL="http://127.0.0.1:${GATEWAY_PORT}"

export WORKLIN_RUNTIME_ROOT
export VELLUM_WORKSPACE_DIR
export GATEWAY_SECURITY_DIR
export CES_DATA_DIR
export CREDENTIAL_SECURITY_DIR
export CES_BOOTSTRAP_SOCKET_DIR
export GATEWAY_IPC_SOCKET_DIR
export DEBUG_STDOUT_LOGS
export PORT
export WORKLIN_CONTROL_PLANE_PORT
export WORKLIN_CONTROL_DB
export CES_HEALTH_PORT
export CES_CREDENTIAL_URL
export GATEWAY_PORT
export RUNTIME_HTTP_PORT
export RUNTIME_HTTP_HOST
export ASSISTANT_HOST
export GATEWAY_INTERNAL_URL
export UNMAPPED_POLICY
export GATEWAY_TRUST_PROXY
export IS_CONTAINERIZED
export CES_MODE
export WORKLIN_GATEWAY_URL="${GATEWAY_INTERNAL_URL}"

mkdir -p \
  "${WORKLIN_RUNTIME_ROOT}" \
  "${VELLUM_WORKSPACE_DIR}" \
  "${workspace_data_dir}" \
  "${workspace_credentials_dir}" \
  "${GATEWAY_SECURITY_DIR}" \
  "${CES_DATA_DIR}" \
  "${CREDENTIAL_SECURITY_DIR}" \
  "${CES_BOOTSTRAP_SOCKET_DIR}" \
  "${GATEWAY_IPC_SOCKET_DIR}"

signing_key_path="${GATEWAY_SECURITY_DIR%/}/actor-token-signing-key"
if [[ -z "${ACTOR_TOKEN_SIGNING_KEY:-}" ]]; then
  if [[ ! -f "${signing_key_path}" ]] || [[ "$(wc -c < "${signing_key_path}")" -ne 32 ]]; then
    head -c 32 /dev/urandom > "${signing_key_path}"
    chmod 600 "${signing_key_path}"
  fi
  ACTOR_TOKEN_SIGNING_KEY="$(od -An -tx1 -v "${signing_key_path}" | tr -d ' \n')"
fi
export ACTOR_TOKEN_SIGNING_KEY

ces_service_token_path="${GATEWAY_SECURITY_DIR%/}/ces-service-token"
if [[ -z "${CES_SERVICE_TOKEN:-}" ]]; then
  if [[ ! -f "${ces_service_token_path}" ]] || [[ "$(wc -c < "${ces_service_token_path}")" -ne 64 ]]; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "${ces_service_token_path}"
    chmod 600 "${ces_service_token_path}"
  fi
  CES_SERVICE_TOKEN="$(tr -d '\n' < "${ces_service_token_path}")"
fi
export CES_SERVICE_TOKEN

# Repair ownership on persisted volume contents before handing control to the
# unprivileged service users. Railway can reuse a volume that contains files
# written by an older root-run deployment, and directory-only chowns leave the
# existing SQLite/WAL files inaccessible to the new assistant/gateway/CES
# processes.
chown -R assistant:vellum "${WORKLIN_RUNTIME_ROOT}" "${VELLUM_WORKSPACE_DIR}"
chown -R gateway:gateway "${GATEWAY_SECURITY_DIR}"
chown -R gateway:vellum "${GATEWAY_IPC_SOCKET_DIR}"
chown -R ces:ces "${CES_DATA_DIR}" "${CREDENTIAL_SECURITY_DIR}"
chmod 2775 \
  "${WORKLIN_RUNTIME_ROOT}" \
  "${VELLUM_WORKSPACE_DIR}" \
  "${workspace_data_dir}" \
  "${workspace_credentials_dir}"
chmod 700 "${GATEWAY_SECURITY_DIR}" "${CES_DATA_DIR}" "${CREDENTIAL_SECURITY_DIR}"
chmod 777 "${CES_BOOTSTRAP_SOCKET_DIR}"
chmod 2770 "${GATEWAY_IPC_SOCKET_DIR}"

declare -a pids=()

start_as() {
  local user="$1"
  shift
  runuser -u "${user}" -- "$@" &
  pids+=("$!")
}

shutdown() {
  local exit_code="${1:-0}"
  for pid in "${pids[@]:-}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
  wait || true
  exit "${exit_code}"
}

trap 'shutdown 143' SIGTERM SIGINT

start_as ces bash -lc "cd /app/credential-executor && exec bun run src/managed-main.ts"

socket_path="${CES_BOOTSTRAP_SOCKET_DIR%/}/ces.sock"
for _ in $(seq 1 120); do
  if [[ -S "${socket_path}" ]]; then
    break
  fi
  sleep 0.25
done

if [[ ! -S "${socket_path}" ]]; then
  echo "CES bootstrap socket did not appear at ${socket_path}" >&2
  shutdown 1
fi

start_as gateway bash -lc "cd /app/gateway && exec bun --smol run src/index.ts"
start_as assistant bash -lc "cd /app/assistant && exec /app/assistant/docker-entrypoint.sh"
start_as assistant bash -lc "cd /app/control-plane && exec bun run src/index.ts"

exit_code=0
if ! wait -n "${pids[@]}"; then
  exit_code=$?
fi

if [[ "${exit_code}" -eq 0 ]]; then
  exit_code=1
fi

shutdown "${exit_code}"
