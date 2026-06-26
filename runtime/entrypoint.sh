#!/usr/bin/env bash
set -euo pipefail

: "${WORKLIN_RUNTIME_ROOT:=/data}"
: "${VELLUM_WORKSPACE_DIR:=${WORKLIN_RUNTIME_ROOT}/workspace}"
: "${GATEWAY_SECURITY_DIR:=${WORKLIN_RUNTIME_ROOT}/gateway-security}"
: "${CES_DATA_DIR:=${WORKLIN_RUNTIME_ROOT}/ces-data}"
: "${CREDENTIAL_SECURITY_DIR:=${WORKLIN_RUNTIME_ROOT}/ces-security}"
: "${CES_BOOTSTRAP_SOCKET_DIR:=/run/ces-bootstrap}"
: "${CES_HEALTH_PORT:=8090}"
: "${CES_CREDENTIAL_URL:=http://127.0.0.1:${CES_HEALTH_PORT}}"
: "${GATEWAY_PORT:=7830}"
: "${RUNTIME_HTTP_PORT:=3001}"
: "${RUNTIME_HTTP_HOST:=0.0.0.0}"
: "${ASSISTANT_HOST:=127.0.0.1}"
: "${GATEWAY_INTERNAL_URL:=http://127.0.0.1:${GATEWAY_PORT}}"
: "${UNMAPPED_POLICY:=default}"
: "${GATEWAY_TRUST_PROXY:=true}"
: "${IS_CONTAINERIZED:=true}"
: "${CES_MODE:=managed}"

export WORKLIN_RUNTIME_ROOT
export VELLUM_WORKSPACE_DIR
export GATEWAY_SECURITY_DIR
export CES_DATA_DIR
export CREDENTIAL_SECURITY_DIR
export CES_BOOTSTRAP_SOCKET_DIR
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

mkdir -p \
  "${WORKLIN_RUNTIME_ROOT}" \
  "${VELLUM_WORKSPACE_DIR}" \
  "${GATEWAY_SECURITY_DIR}" \
  "${CES_DATA_DIR}" \
  "${CREDENTIAL_SECURITY_DIR}" \
  "${CES_BOOTSTRAP_SOCKET_DIR}"

chown assistant:vellum "${WORKLIN_RUNTIME_ROOT}" "${VELLUM_WORKSPACE_DIR}"
chown gateway:gateway "${GATEWAY_SECURITY_DIR}"
chown ces:ces "${CES_DATA_DIR}" "${CREDENTIAL_SECURITY_DIR}"
chmod 2775 "${WORKLIN_RUNTIME_ROOT}" "${VELLUM_WORKSPACE_DIR}"
chmod 700 "${GATEWAY_SECURITY_DIR}" "${CES_DATA_DIR}" "${CREDENTIAL_SECURITY_DIR}"
chmod 777 "${CES_BOOTSTRAP_SOCKET_DIR}"

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

exit_code=0
if ! wait -n "${pids[@]}"; then
  exit_code=$?
fi

if [[ "${exit_code}" -eq 0 ]]; then
  exit_code=1
fi

shutdown "${exit_code}"
