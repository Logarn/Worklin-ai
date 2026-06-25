# Worklin Production Deploy

This folder contains the deploy shape for the Vercel-hosted Worklin UI plus a
real container backend.

## Production Shape

- `apps/web` runs on Vercel.
- `control-plane` runs the public `api.worklin.ai` API for login, sessions,
  organizations, assistant ownership, and runtime proxying.
- `assistant`, `gateway`, and `credential-executor` run as long-lived Docker
  services behind the control-plane.
- The gateway is private inside the Compose network. Do not expose it directly
  to the public internet.

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

Not included yet:

- Billing implementation.
- Team accounts.
- Separate assistant stacks per customer.
- Runtime auto-provisioning per tenant.
- Full SaaS-grade tenant isolation.

For real SaaS isolation, provision separate assistant/gateway/CES stacks per
customer or workspace and make the control-plane route each user to the correct
stack.

## Backend

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

Expose the control-plane through HTTPS at:

```text
https://api.worklin.ai
```

Your reverse proxy or container platform should terminate TLS and forward to
the control-plane container on port `8080`.

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

- Allowed Callback URLs: `https://api.worklin.ai/callback`
- Allowed Logout URLs: `https://worklin-ai.vercel.app/account/login`
- Allowed Web Origins: `https://worklin-ai.vercel.app`
- Allowed Origins (CORS): `https://worklin-ai.vercel.app`

Local smoke-test settings, if you run the control-plane on `19282`:

- Allowed Callback URLs: `http://127.0.0.1:19282/callback`
- Allowed Logout URLs: `http://127.0.0.1:5177/account/login`
- Allowed Web Origins: `http://127.0.0.1:5177`
- Allowed Origins (CORS): `http://127.0.0.1:5177`

Set:

```bash
AUTH0_ISSUER_BASE_URL=https://dev-t8ju8fx27q3pgjld.us.auth0.com
AUTH0_BASE_URL=https://api.worklin.ai
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...
AUTH0_SECRET=...
```

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
VITE_PLATFORM_API_BASE_URL=https://api.worklin.ai
VITE_AUTH_API_BASE_URL=https://api.worklin.ai
VITE_DAEMON_API_BASE_URL=https://api.worklin.ai
```

Then deploy from the repo root:

```bash
bunx vercel build --prod --yes
bunx vercel deploy --prebuilt --prod --yes --archive=tgz
```

The frontend production build can deploy before the backend, but sign-in and
chat only work after `api.worklin.ai` resolves to the control-plane.
