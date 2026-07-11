# Worklin Production Deployment

This app can be served from Vercel, but the production backend cannot live on
Vercel alone. Worklin needs long-running runtime services, persistent assistant
state, isolated credential storage, and tenant-aware provisioning.

## Production Topology

Use this split:

- Vercel: `apps/web` static frontend.
- Public API/control plane: authentication, user profile, organizations,
  billing, assistant provisioning, integration setup, and runtime routing.
- Gateway: public ingress for webhooks, OAuth callbacks, and authenticated
  reverse proxy into an assistant runtime.
- Assistant runtime: tenant-isolated assistant process with SQLite workspace
  state, documents, memory, tools, schedules, and retention skills.
- Credential executor: isolated credential storage and credential materializer.
- Data services: Postgres for the control plane, persistent volumes for runtime
  workspace/CES data, object storage for files/backups, and managed secrets.

The web frontend should be configured with:

```bash
VITE_PLATFORM_MODE=true
VITE_PLATFORM_API_BASE_URL=https://api.worklin.ai
VITE_AUTH_API_BASE_URL=https://api.worklin.ai
VITE_DAEMON_API_BASE_URL=https://api.worklin.ai
```

If the frontend and backend are served from the same origin, leave the three
API-origin variables unset and same-origin requests will be used.

## Current Repo Status

Already present:

- `apps/web`: production-buildable Vite frontend.
- `assistant/Dockerfile`: assistant runtime container.
- `gateway/Dockerfile`: gateway container.
- `credential-executor/Dockerfile`: managed credential executor container.
- `control-plane`: account/session endpoints, assistant ownership checks,
  runtime stack metadata, and fail-closed runtime proxy routing.
- Retention domain package and Worklin retention skill surfaces.

Missing for real multi-tenant production:

- Durable managed database for users, organizations, plans, assistant ownership,
  and runtime stack metadata.
- Per-tenant assistant provisioning/orchestration that turns a
  `runtime_stacks.status = 'provisioning'` row into an active private gateway
  URL.
- A safe connection model for Klaviyo and Shopify credentials per brand.

Do not expose one shared assistant runtime to multiple brands. That would mix
conversations, documents, memory, API keys, Klaviyo data, Shopify data, and audit
artifacts across customers. The production control-plane must return
`runtime_not_ready` until an assistant has an active stack-specific gateway URL;
the legacy shared gateway escape hatch is for local smoke tests only.

## Backend Contract Required By The Web App

Minimum auth/profile bootstrap endpoints:

- `GET /_allauth/browser/v1/auth/session`
- `DELETE /_allauth/browser/v1/auth/session`
- `GET /_allauth/browser/v1/config`
- `POST /_allauth/browser/v1/auth/provider/redirect`
- `GET /account/provider/callback`
- `GET /v1/user/me/`
- `PATCH /v1/user/me/`
- `GET /v1/user/username-available/`
- `GET /v1/organizations/`
- `GET /v1/assistants/`
- `GET /v1/assistants/{id}/`
- `POST /v1/assistants/hatch/`

Minimum runtime-backed surfaces:

- Conversation creation, message streaming, cancellation, and history.
- Document/artifact CRUD and export.
- Settings for model providers, integrations, permissions, schedules, and
  retention audit configuration.
- Credential setup surfaces for Klaviyo and Shopify.

## Deployment Sequence

1. Keep Vercel as the frontend host.
2. Choose a container host that supports always-on Docker services, private
   networking, persistent disks, and secrets.
3. Build the public Worklin control plane instead of pointing the web app at a
   shared runtime directly.
4. Deploy the control plane with Postgres and Google OAuth.
5. Deploy gateway, assistant runtime, and credential executor as private services
   behind the control plane.
6. Configure Vercel with the `VITE_*_API_BASE_URL` values that point at the
   public API origin.
7. Smoke-test signup, assistant provisioning, Klaviyo connection, audit run,
   artifact viewing, and PDF export with an isolated test tenant.
8. Only then invite real users.

## Required Production Inputs

The deploy cannot be completed without these:

- Public domain for the API, for example `api.worklin.ai`.
- Google OAuth client ID and secret with the production callback URL.
- Container host account with deploy credentials.
- Postgres database for users/orgs/provisioning state.
- Persistent disk/storage plan for assistant workspace and CES data.
- Object storage for generated PDFs, audit exports, and backups.
- LLM provider key or managed provider billing path.
- Klaviyo and Shopify connection policy for customer accounts.
- Billing provider details if plan gates should work in production.
