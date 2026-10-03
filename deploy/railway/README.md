# Railway hosting test

The Vercel SPA proxies authentication and API requests to the public Railway
control plane. The concurrent worker and PostgreSQL have private endpoints.

```mermaid
flowchart LR
  Web[Vercel SPA] --> API[Railway control plane]
  API --> Worker[Private concurrent worker]
  Worker --> DB[(PostgreSQL)]
```

The control plane builds `control-plane/Dockerfile` from the repository root
and starts `bun run src/index.ts`. The worker builds `runtime/Dockerfile`
and starts `/app/runtime/entrypoint.sh`. Readiness uses `/readyz` with a 300-second
timeout. Each has a `/data` volume and a 1 vCPU / 1 GB cap. These are starting
limits for low-volume testing, not a measured production capacity guarantee.

The control plane uses `WORKLIN_RUNTIME_MODE=control-plane`, disables automatic
Railway provisioning, and points `WORKLIN_CONCURRENT_RUNTIME_GATEWAY_URL` at the
worker's actual private DNS name on port 8080. Renaming a Railway service does
not rename its private DNS entry. Readiness accepts an enabled concurrent
runtime configuration without requiring automatic per-assistant provisioning.

The worker uses `WORKLIN_RUNTIME_MODE=concurrent_service`,
`RUNTIME_ASSISTANT_SCOPE_MODE=tenant_context`, one concurrent turn, and at most
five database connections. The internal signing key is shared with the control
plane. Store all credentials in Railway variables, never in the checkout.

The control plane uses the public Vercel application origin for Auth0 callbacks.
Set `WORKLIN_WEB_ORIGIN` and `AUTH0_BASE_URL` to the same canonical HTTPS origin.
The Vercel aliases and `dashboard.worklin.io` redirect to `app.worklin.io` before login starts so
the host-only verification cookie reaches the callback. Rejected callback
transactions return a non-cacheable 400/401 page with a fresh sign-in link;
they must not be retried by reusing the callback URL.
GoDaddy hosts DNS. The root `worklin.io` domain and `www.worklin.io` point to
the Framer marketing website. The application uses `app.worklin.io` with the
project's recommended Vercel CNAME. Email records are independent of this mapping.
The application-domain rollout requires `https://app.worklin.io/callback` in
Auth0's allowed callbacks, `https://app.worklin.io/account/login` in allowed
logout URLs, and `https://app.worklin.io` in allowed web origins. Configure those
before setting the backend origins to `https://app.worklin.io` and deploying
the alias redirects. Keep the prior callback URLs during the transition.
The three `VITE_*_API_BASE_URL` settings and the backend rewrites in
`vercel.json` must identify the same backend. Environment changes require a new
Vercel build. Build with `--archive=tgz` when using the CLI to avoid exceeding
the per-file upload limit on this monorepo. Keep `--skip-domain` until backend
health and authentication bootstrap checks pass, then promote the deployment.

## Rollout boundaries

- `WORKLIN_CONCURRENT_RUNTIME_MODE=internal` restricts concurrent routing to
  explicitly allowlisted assistant or user IDs. It does not enable all users.
  Set `WORKLIN_CONCURRENT_RUNTIME_ASSISTANT_IDS` to the canary assistant ID
  before testing hatching. An unallocated failed stack recovers on its next
  request after this configuration is deployed.
- The workspace usage warning is $15 and the configured hard usage limit is
  $20. This cutoff can interrupt services. Usage caps are not a fixed-price
  quote and do not include separate model-provider charges or applicable taxes.
- PostgreSQL is fresh; this hosting test does not migrate existing user data.
- Retention, outbound campaigns, and browser-broker operations are not enabled
  by this three-service profile. The full VPS profile includes additional
  retention components; those require a separate Railway deployment and test.
- Application and migration database roles must be separated, RLS isolation
  verified, and backup/restore and concurrent-runtime release gates completed
  before a broad production rollout. See
  `docs/concurrent-runtime-service.md`.

## Verification

Run the focused control-plane readiness tests and typecheck before deployment.
Verify both Railway service deployments report success, the backend `/readyz`
returns HTTP 200, and authentication bootstrap responds through the Vercel
proxy. A passing healthcheck alone does not prove login, chat, retention, or
durable-job execution end to end.
