# Worklin AI

Worklin is an autonomous retention marketing agent for ecommerce brands.

The product is being rebuilt around a Worklin-native assistant runtime, chat UI,
credential boundary, memory system, and retention intelligence layer. The first
production target is audit and approval autonomy: Worklin can onboard a brand,
connect read-only commerce and lifecycle data, build a Brand Brain, run deep
retention audits, generate opportunity backlogs, and prepare draft-only campaign
workflows for human approval.

Worklin is not the old Next.js/Prisma Worklin app. The old app was used as a
source of domain concepts. The current app is a Bun monorepo with a Vite/React
web client and separate backend services for auth, agent runtime, gateway, and
credential execution.

## Product Scope

Worklin is focused on DTC retention automation:

- Brand onboarding through conversation, not long setup forms
- Brand Brain for voice, positioning, offers, products, rules, CTAs, and learnings
- Klaviyo and Shopify source layers, with read-only data ingestion by default
- Deep retention audits over lifecycle, campaigns, flows, segments, products, and missing opportunities
- Visual audit artifacts and PDF-ready reports
- Opportunity backlog and campaign package generation
- Approval, action logs, and safety metadata for every external action
- Draft-only Klaviyo creation after explicit approval

V1 intentionally blocks live sends, live scheduling, Shopify writes, Klaviyo
profile mutation, segment mutation, and flow activation.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `apps/web` | Worklin web app. React 19, Vite, React Router, Tailwind, Worklin UI shell, onboarding, chat, settings, documents, and artifacts. |
| `assistant` | Agent runtime, tools, skills, memory, documents, schedules, sandboxed execution, and retention workflows. |
| `gateway` | Internal gateway for runtime access, feature flags, permissions, webhooks, and service coordination. |
| `control-plane` | Public API/control-plane service for auth, sessions, frontend API compatibility, and proxying into the runtime stack. |
| `credential-executor` | Isolated credential execution service for stored integration credentials. |
| `packages` | Shared contracts, clients, credential storage, design library, IPC helpers, and retention-domain package. |
| `skills` | Bundled skills and integration setup workflows. |
| `deploy` | Production deployment notes and environment examples. |
| `vercel.json` | Vercel frontend deployment config for `apps/web`. |

## Tech Stack

- Bun `1.3.x`
- Node `22.x` compatibility where needed
- React `19.x`
- Vite
- React Router
- Tailwind
- Radix UI
- lucide icons
- Zustand
- TanStack Query
- Drizzle
- SQLite for local/self-hosted state
- Qdrant-backed memory paths where enabled
- Dockerized backend services

## Local Development

Install Bun first if needed:

```bash
curl -fsSL https://bun.sh/install | bash
```

Install and run the web app:

```bash
cd apps/web
bun install
bun run dev
```

Run the local control-plane:

```bash
cd control-plane
bun install
bun run start
```

The current local web app usually runs at:

```text
http://127.0.0.1:5177/assistant
```

The local control-plane usually runs at:

```text
http://127.0.0.1:19283
```

Local auth depends on Auth0 and the local control-plane env. Use:

```bash
deploy/production/create-local-auth0-env.sh
```

Do not commit generated `.env`, `*.env.local`, `.vercel`, database files, or
private credential files.

## Useful Checks

Web typecheck:

```bash
cd apps/web
bun run typecheck
```

Web build:

```bash
cd apps/web
bun run build
```

Control-plane typecheck:

```bash
cd control-plane
bun run typecheck
```

Gateway typecheck:

```bash
cd gateway
bun run typecheck
```

Assistant typecheck:

```bash
cd assistant
bun run typecheck
```

## Deployment

Worklin is not a single Vercel app.

Use Vercel for the web frontend and Railway or another container host for the
backend services.

### Frontend: Vercel

The root `vercel.json` builds `apps/web`:

```json
{
  "installCommand": "cd apps/web && bun install --frozen-lockfile",
  "buildCommand": "cd apps/web && VITE_PLATFORM_MODE=true VERCEL=1 bun run build",
  "outputDirectory": "apps/web/dist"
}
```

Production frontend environment variables should point at the backend API:

```bash
VITE_PLATFORM_MODE=true
VITE_PLATFORM_API_BASE_URL=https://<backend-domain>
VITE_AUTH_API_BASE_URL=https://<backend-domain>
VITE_DAEMON_API_BASE_URL=https://<backend-domain>
```

### Backend: Railway

Deploy the backend from the repo root. The default Railway shape is now a
single public service using the repo-root `railway.json`, which builds
`runtime/Dockerfile` and starts the control-plane, gateway, assistant, and
credential executor together.

```text
Service name: worklin-runtime
Dockerfile path: runtime/Dockerfile
Root/build context: /
Health check: /readyz
Volume mount: /data
```

Minimal production variables for the Railway service:

```bash
WORKLIN_WEB_ORIGIN=https://worklin-ai.vercel.app
WORKLIN_API_ORIGIN=https://<railway-backend-domain>
AUTH0_ISSUER_BASE_URL=https://<auth0-tenant>
AUTH0_BASE_URL=https://<railway-backend-domain>
WORKLIN_CONTROL_DB=/data/control-plane.sqlite
```

Set `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`,
`WORKLIN_SESSION_SECRET`, and `ACTOR_TOKEN_SIGNING_KEY` separately from your
Auth0 app settings and generated production secrets.

Railway can generate a temporary HTTPS domain. A custom domain such as
`api.worklin.ai` is useful later but is not required for the first deployment.

The combined container keeps the gateway private on loopback. A small public
edge forwards ordinary HTTP traffic to the control-plane and tunnels only the
ElevenLabs Speech Engine upstream WebSocket path directly to the gateway. Root
`railway.json` is the default deploy target. The split configs remain in the
repo for future multi-service topologies:

| Service | Dockerfile | Notes |
| --- | --- | --- |
| `railway.json` | `runtime/Dockerfile` | Default single-service Railway deploy. Public control-plane plus co-located runtime services. |
| `railway.runtime.json` | `runtime/Dockerfile` | Same combined runtime shape when you want an explicit alternate Railway config file. |
| `railway.gateway.json` | `gateway/Dockerfile` | Future split private gateway service. |
| `railway.assistant.json` | `assistant/Dockerfile` | Future split assistant service. |

## Auth

Worklin uses Auth0 for hosted auth in the current production setup.

Auth0 application settings should include the backend callback:

```text
Allowed Callback URLs:
https://<backend-domain>/callback
```

For local testing:

```text
http://127.0.0.1:19283/callback
```

Allowed web origins and CORS origins should include the frontend origin:

```text
https://worklin-ai.vercel.app
http://127.0.0.1:5177
```

Rotate any Auth0 secret that has ever been pasted into chat or logs before
using it in production.

## Retention Safety Model

Every retention workflow should preserve these guarantees:

- Shopify is read-only in V1.
- Klaviyo is read, snapshot, and draft-only in V1.
- No live send or schedule action is registered.
- No profile mutation, segment mutation, or flow activation is registered.
- Tool outputs include source freshness, caveats, provenance, blocked capabilities, approval status, `externalActionTaken:false`, and `canGoLiveNow:false`.
- Draft creation requires explicit user approval and passing QA.

## Current Status

The repo has been replaced with the current Worklin monorepo. The next
production milestone is:

1. Deploy `worklin-api` on Railway from `control-plane/Dockerfile`.
2. Confirm `/healthz` works on Railway's generated domain.
3. Point Auth0 callback URLs at the Railway backend domain.
4. Point Vercel frontend env vars at the Railway backend domain.
5. Add a bundled Railway runtime service for gateway + assistant.
6. Add the credential executor service and persistent storage.
7. Smoke test signup, login, chat, onboarding, Klaviyo connection, and a read-only retention audit.

## License

MIT. See [LICENSE](LICENSE).
