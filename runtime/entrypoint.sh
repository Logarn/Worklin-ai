#!/usr/bin/env bash
set -euo pipefail

: "${WORKLIN_RUNTIME_ROOT:=/data}"
: "${VELLUM_WORKSPACE_DIR:=${WORKLIN_RUNTIME_ROOT}/workspace}"
: "${GATEWAY_SECURITY_DIR:=${WORKLIN_RUNTIME_ROOT}/gateway-security}"
: "${CES_DATA_DIR:=${WORKLIN_RUNTIME_ROOT}/ces-data}"
: "${CREDENTIAL_SECURITY_DIR:=${CES_DATA_DIR%/}/security}"
: "${CES_BOOTSTRAP_SOCKET_DIR:=/run/ces-bootstrap}"
: "${GATEWAY_IPC_SOCKET_DIR:=${VELLUM_WORKSPACE_DIR%/}/runtime-ipc}"
: "${DEBUG_STDOUT_LOGS:=1}"
: "${PORT:=8080}"
: "${WORKLIN_PUBLIC_EDGE_PORT:=${PORT}}"
: "${WORKLIN_CONTROL_PLANE_INTERNAL_PORT:=8082}"
: "${WORKLIN_CONTROL_PLANE_PORT:=${WORKLIN_CONTROL_PLANE_INTERNAL_PORT}}"
: "${WORKLIN_CONTROL_PLANE_INTERNAL_URL:=http://127.0.0.1:${WORKLIN_CONTROL_PLANE_PORT}}"
: "${WORKLIN_CONTROL_DB:=${WORKLIN_RUNTIME_ROOT}/control-plane.sqlite}"
: "${CES_HEALTH_PORT:=8090}"
: "${CES_CREDENTIAL_URL:=http://127.0.0.1:${CES_HEALTH_PORT}}"
: "${RUNTIME_HTTP_PORT:=3001}"
: "${RUNTIME_HTTP_HOST:=0.0.0.0}"
: "${ASSISTANT_HOST:=127.0.0.1}"
: "${UNMAPPED_POLICY:=default}"
: "${GATEWAY_TRUST_PROXY:=true}"
: "${IS_CONTAINERIZED:=true}"
: "${CES_MODE:=managed}"
: "${WORKLIN_REQUIRE_ISOLATED_RUNTIME:=true}"
: "${WORKLIN_RUNTIME_MODE:=combined}"
# The combined free-tier runtime cannot safely load the local ONNX embedding
# worker alongside the gateway, control plane, CES, and assistant. Keep dense
# embeddings inert unless an operator explicitly opts in after provisioning
# enough memory or an approved external embedding backend.
: "${VELLUM_DISABLE_EMBEDDINGS:=true}"

if [[ "${WORKLIN_RUNTIME_MODE}" == "isolated" ]]; then
  : "${GATEWAY_PORT:=${PORT}}"
else
  : "${GATEWAY_PORT:=7830}"
fi

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
export WORKLIN_PUBLIC_EDGE_PORT
export WORKLIN_CONTROL_PLANE_PORT
export WORKLIN_CONTROL_PLANE_INTERNAL_URL
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
export WORKLIN_REQUIRE_ISOLATED_RUNTIME
export WORKLIN_RUNTIME_MODE
export VELLUM_DISABLE_EMBEDDINGS
export WORKLIN_GATEWAY_URL="${GATEWAY_INTERNAL_URL}"

mkdir -p \
  "${WORKLIN_RUNTIME_ROOT}" \
  "${VELLUM_WORKSPACE_DIR}" \
  "${workspace_data_dir}" \
  "${workspace_credentials_dir}" \
  "${GATEWAY_SECURITY_DIR}" \
  "${CES_DATA_DIR}" \
  "${CES_BOOTSTRAP_SOCKET_DIR}" \
  "${GATEWAY_IPC_SOCKET_DIR}"

fallback_credential_security_dir="${CES_DATA_DIR%/}/security"
if ! mkdir -p "${CREDENTIAL_SECURITY_DIR}"; then
  echo "Unable to create CREDENTIAL_SECURITY_DIR=${CREDENTIAL_SECURITY_DIR}; falling back to ${fallback_credential_security_dir}" >&2
  CREDENTIAL_SECURITY_DIR="${fallback_credential_security_dir}"
  export CREDENTIAL_SECURITY_DIR
  mkdir -p "${CREDENTIAL_SECURITY_DIR}"
fi

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

if ! runuser -u ces -g ces -G vellum -- test -w "${CREDENTIAL_SECURITY_DIR}"; then
  if [[ "${CREDENTIAL_SECURITY_DIR}" != "${fallback_credential_security_dir}" ]]; then
    echo "CREDENTIAL_SECURITY_DIR=${CREDENTIAL_SECURITY_DIR} is not writable by ces; falling back to ${fallback_credential_security_dir}" >&2
    CREDENTIAL_SECURITY_DIR="${fallback_credential_security_dir}"
    export CREDENTIAL_SECURITY_DIR
    mkdir -p "${CREDENTIAL_SECURITY_DIR}"
    chown -R ces:ces "${CREDENTIAL_SECURITY_DIR}"
    chmod 700 "${CREDENTIAL_SECURITY_DIR}"
  fi
fi

if ! runuser -u ces -g ces -G vellum -- test -w "${CREDENTIAL_SECURITY_DIR}"; then
  echo "CREDENTIAL_SECURITY_DIR=${CREDENTIAL_SECURITY_DIR} is not writable by the ces user" >&2
  exit 1
fi

# The gateway watches assistant-written credential metadata under the
# workspace. Make the shared credential directory inherit the vellum group and
# repair stale file modes from earlier deployments so both unprivileged
# processes can read/write it after runuser drops privileges.
chown -R assistant:vellum "${workspace_credentials_dir}"
find "${workspace_credentials_dir}" -type d -exec chmod 2770 {} +
find "${workspace_credentials_dir}" -type f -exec chmod 660 {} +

declare -a pids=()

start_as() {
  local user="$1"
  shift
  runuser -u "${user}" -g "${user}" -G vellum -- "$@" &
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

gateway_socket_path="${GATEWAY_IPC_SOCKET_DIR%/}/gateway.sock"
for _ in $(seq 1 120); do
  if [[ -S "${gateway_socket_path}" ]]; then
    break
  fi
  sleep 0.25
done

if [[ ! -S "${gateway_socket_path}" ]]; then
  echo "Gateway IPC socket did not appear at ${gateway_socket_path}" >&2
  shutdown 1
fi

chmod 660 "${gateway_socket_path}"

start_as assistant bash -lc "cd /app/assistant && exec /app/assistant/docker-entrypoint.sh"
if [[ "${WORKLIN_RUNTIME_MODE}" != "isolated" ]]; then
  start_as assistant bash -lc "cd /app/control-plane && exec bun run src/index.ts"
  start_as assistant bash -lc "cd /app/control-plane && exec bun run src/public-edge.ts"
fi

exit_code=0
if ! wait -n "${pids[@]}"; then
  exit_code=$?
fi

if [[ "${exit_code}" -eq 0 ]]; then
  exit_code=1
fi

shutdown "${exit_code}"
