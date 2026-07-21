# Worklin Production Deploy

This folder contains the deploy shape for the Vercel-hosted Worklin UI plus a
real container backend.

## Production Shape

- `apps/web` runs on Vercel.
- Railway runs one public control-plane container plus one private runtime
  container per customer assistant. Both use `runtime/Dockerfile`.
- The public container uses `WORKLIN_RUNTIME_MODE=control-plane`; it starts
  only the control plane and public edge on a clean volume.
- Each customer container uses `WORKLIN_RUNTIME_MODE=isolated`; it starts its
  own assistant, gateway, and credential executor on a dedicated volume.
- The control plane is the only browser-facing HTTP surface. Customer gateways
  stay private and are selected only after ownership verification.

This is the smallest backend that matches the current Worklin web architecture:
the browser signs in through the control-plane, receives a self-hosted assistant
descriptor, then runtime calls are proxied through the gateway using scoped
actor tokens.

## Current Scope

Included:

- Auth0 sign-in through `api.worklin.ai`.
- Cookie-backed Worklin sessions.
- One organization per signed-in user.
- One self-hosted assistant descriptor per signed-in user.
- Gateway-backed chat/runtime calls.
- Existing assistant/gateway/CES runtime behavior.

Not enabled by default:

- Billing implementation.
- Team accounts.
- Full SaaS-grade tenant isolation.

The control plane includes a gated Railway provisioner for separate assistant
stacks. It remains inert until a project-scoped token, project/environment IDs,
and an explicit positive service cap are configured. This prevents a code
deploy from creating billable resources by itself.

Managed chat requires a runtime stack row per assistant. Without an active
stack-specific gateway URL, the control-plane returns `runtime_not_ready`
instead of routing to the shared container runtime. The old co-located gateway
can only be used when `WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME=true` and
`WORKLIN_REQUIRE_ISOLATED_RUNTIME=false` are set together for a local smoke
test.

## Backend

For Railway, the repo-root `railway.json` builds both service shapes:

- Dockerfile: `runtime/Dockerfile`
- Health check: `/readyz`
- Persistent volume: `/data` on each service

The public service listens through the control plane and must set
`WORKLIN_RUNTIME_MODE=control-plane`,
`WORKLIN_REQUIRE_ISOLATED_RUNTIME=true`, and
`WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME=false`. Its readiness check validates the
isolated provisioner configuration without depending on a co-located gateway.
The old combined volume remains detached and quarantined.

### Isolated Railway runtime provisioning

Set all of the following on the public control-plane service only:

```bash
WORKLIN_RAILWAY_PROVISIONING_ENABLED=true
WORKLIN_RAILWAY_PROJECT_TOKEN=<project-scoped token>
WORKLIN_RAILWAY_PROJECT_ID=<project id>
WORKLIN_RAILWAY_ENVIRONMENT_ID=<production environment id>
WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES=5
WORKLIN_RAILWAY_PROVISIONING_CONCURRENCY=2
```

The maximum-service value is a required cost guard. The initial production
value of `5` supports five isolated customer assistants on the current Railway
plan. Keep provisioning concurrency at `2` unless Railway capacity and launch
telemetry justify raising it. Optional settings include:

```bash
WORKLIN_RAILWAY_RUNTIME_REPOSITORY=Logarn/Worklin-ai
WORKLIN_RAILWAY_RUNTIME_BRANCH=main
WORKLIN_RAILWAY_RUNTIME_REGION=<Railway region>
WORKLIN_RAILWAY_RUNTIME_MOUNT_PATH=/data
WORKLIN_RAILWAY_RUNTIME_PORT=8080
WORKLIN_RAILWAY_REQUEST_TIMEOUT_MS=30000
WORKLIN_RAILWAY_SERVICE_RECONCILE_TIMEOUT_MS=30000
WORKLIN_RAILWAY_PROVISIONING_LEASE_TTL_MS=120000
```

For each assistant, the provisioner creates one GitHub-backed service and one
persistent volume, applies assistant-scoped runtime variables, deploys the
service, waits for Railway deployment success and `/readyz`, then stores its
private `SERVICE_NAME.railway.internal` gateway URL. Partial attempts persist
their service and volume IDs, and reserve service capacity durably until the
service identity is recorded. A database-backed lease fences overlapping
control-plane processes. Ambiguous service or volume creates remain marked
until the deterministic resource appears. Automatic retries never issue a
second create; if the resource never appears, an operator must verify its
absence in Railway before clearing `service_create_attempted_at` or
`volume_create_attempted_at` for that stack. Retries reconcile Railway before
rejecting a retry at the configured cap.
An isolated runtime does not become active until database initialization,
daemon startup, and the credential service are complete and `/readyz`
succeeds.

The public edge does not forward the unscoped ElevenLabs Speech Engine
WebSocket path to a shared gateway. Managed ElevenLabs voice remains
fail-closed until its callback is routed with an assistant-bound token to the
matching isolated runtime.

Create a real env file from the template:

```bash
cd deploy/production
cp backend.env.example backend.env
```

Fill `backend.env` on the host. At minimum provide:

- `AUTH0_ISSUER_BASE_URL`
- `AUTH0_BASE_URL`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`
- `AUTH0_SECRET`
- `WORKLIN_SESSION_SECRET`
- `ACTOR_TOKEN_SIGNING_KEY`
- one LLM provider key, such as `OPENAI_API_KEY`
- `CES_SERVICE_TOKEN`

Start the stack:

```bash
docker compose --env-file backend.env up --build -d
```

Health checks:

```bash
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

Expose the control-plane through HTTPS at your Railway domain or custom API
domain. Railway terminates TLS and forwards to the control-plane inside the
combined container.

## DNS

Create a DNS record for `api.worklin.ai` that points to the backend host:

- `A` record to the host IP, or
- `CNAME` to the container platform hostname.

Verify:

```bash
curl -I https://api.worklin.ai/healthz
```

## Auth0

Create an Auth0 Regular Web Application. The Worklin frontend is not the OAuth
callback target; the public control-plane backend is.

Production Auth0 settings:

- Allowed Callback URLs: `https://<public-backend-domain>/callback`
- Allowed Logout URLs: `https://<frontend-domain>/account/login`
- Allowed Web Origins: `https://<frontend-domain>`
- Allowed Origins (CORS): `https://<frontend-domain>`

Local smoke-test settings, if you run the control-plane on `19282`:

- Allowed Callback URLs: `http://127.0.0.1:19282/callback`
- Allowed Logout URLs: `http://127.0.0.1:5177/account/login`
- Allowed Web Origins: `http://127.0.0.1:5177`
- Allowed Origins (CORS): `http://127.0.0.1:5177`

Set:

```bash
AUTH0_ISSUER_BASE_URL=https://dev-t8ju8fx27q3pgjld.us.auth0.com
AUTH0_BASE_URL=https://<public-backend-domain>
```

Provide `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, and `AUTH0_SECRET` from the
Auth0 application settings, alongside the generated Worklin secrets.

`AUTH0_SECRET` is the SDK cookie encryption secret. Generate it separately from
the Auth0 client secret:

```bash
openssl rand -hex 32
```

For local development, generate ignored env files with:

```bash
deploy/production/create-local-auth0-env.sh
```

The script prompts for the Auth0 client secret, generates local Worklin/Auth0
cookie secrets, writes `control-plane/.env`, and writes
`deploy/production/backend.env.local`. Do not commit either generated env file.

## Vercel Frontend

Set these in the Vercel project:

```bash
VITE_PLATFORM_MODE=true
VITE_PLATFORM_API_BASE_URL=https://<public-backend-domain>
VITE_AUTH_API_BASE_URL=https://<public-backend-domain>
VITE_DAEMON_API_BASE_URL=https://<public-backend-domain>
```

Then deploy from the repo root:

```bash
bunx vercel build --prod --yes
bunx vercel deploy --prebuilt --prod --yes --archive=tgz
```

The frontend production build can deploy before the backend, but sign-in and
chat only work after `api.worklin.ai` resolves to the control-plane.
