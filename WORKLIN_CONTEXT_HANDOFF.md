# Worklin Context Handoff

Last updated: 2026-06-25

This handoff is for a fresh Codex chat. Read this file first, then read `AGENTS.md`.

## Current Objective

Make the current Worklin app usable in production:

- Frontend live on Vercel.
- Backend/control-plane live on Railway.
- Auth works through Auth0.
- Frontend and backend talk to each other.
- Product remains Worklin, not Vellum.
- Retention/audit features remain usable; do not delete product features just to satisfy tests.

The user has Auth0, Railway, and Vercel open and prefers clear click-by-click guidance over dashboard automation.

## Repo And Source State

Current up-to-date local checkout:

```text
/private/tmp/worklin-git.1ykbSk/repo
```

GitHub repo:

```text
https://github.com/Logarn/Worklin-ai.git
```

Current branch:

```text
main
```

Latest known commit:

```text
8a4d5b9 Use Bun start command for Railway
```

Recent commits:

```text
8a4d5b9 Use Bun start command for Railway
190d1c6 Add Railway control-plane deploy config
7fab9ca Update README for Worklin
0d80fbc Publish current Worklin app
5cefd09 Publish current Worklin app
```

Working tree was clean when this handoff was written.

## Product Direction

The app name is **Worklin** everywhere user-facing. Do not refer to the product as Vellum in UI/copy/docs unless explaining historical source code.

Strategic architecture:

- Use the Vellum-style app/runtime architecture as the base product.
- Treat old Worklin code as a source of retention concepts and domain logic only.
- Do not make a messy hybrid app.
- Do not port old Worklin Next pages, dashboards, auth, Prisma runtime, generic agent router, or token storage wholesale.
- Worklin should feel like a clean autonomous retention marketer for DTC brands.

Preserve Worklin-specific retention value:

- Brand Brain.
- Shopify and Klaviyo read-only source analysis.
- Customer intelligence and feature store.
- Retention scoring and micro-segments.
- Opportunity engine.
- Deep retention audits.
- Campaign package generation.
- QA, approvals, action logs, safety metadata.
- Draft-only Klaviyo behavior, no live send/schedule in v1.

## Current Product Requirements

The user wants Worklin to become a functional autonomous retention marketer:

1. Conversational onboarding.
2. Brand Brain created during onboarding.
3. Website/domain is the first simple onboarding question.
4. Agent asks one simple question at a time.
5. Questions should often have clickable options so users do not need to type everything.
6. Agent should detect missing integrations and show a working connection card, not ask awkwardly whether to reconnect.
7. Klaviyo + Shopify are the core source layer, but current deep audit testing can be Klaviyo-only when Shopify is unavailable.
8. Klaviyo behavior is read-only for audits and draft-only after approval.
9. Shopify behavior is read-only.
10. No Klaviyo send, schedule, flow activation, profile mutation, segment mutation, or Shopify write.
11. Deep audits must be much richer than the current output.
12. Deep audits should have large, clear, interactive artifacts and charts.
13. Deep audits must be downloadable as PDF, with charts included in the PDF.
14. Audit UI should be simple: quick summary first, clear open/download actions for the full audit.
15. Users should see audit progress/reasoning/steps, but not truncated cards.
16. Audits take time; UI must clearly say an audit can take a while, give an estimate, and tell users not to close the tab until it finishes.

## Audit Output Direction

The user supplied real audit examples, especially a Dr. Rachael-style Klaviyo retention audit. The desired output is not just mirrored design; the audit content matters.

Expected audit modules:

- Data trust and input readiness.
- Product performance when Shopify or product data exists.
- Campaign cadence and send frequency.
- Subject-line and word-bank analysis.
- Campaign theme mix.
- Sale vs non-sale analysis.
- Segment performance and whitespace.
- Flow/lifecycle coverage.
- Forms/pop-up acquisition data where available.
- Prioritized opportunity backlog.
- QA and safety metadata.

Visual artifact inspiration:

- Clean report format.
- Strong headings.
- Big readable cards.
- Large charts.
- Red/yellow/green/purple and other useful chart colors.
- Charts should be interactive in the app and included in PDF export.
- PDF must be downloadable reliably outside the Codex browser too.

Important known issue:

- The recent audit generated in-app was wrong/off-brand and not Dr. Rachael-specific.
- Artifacts were too small, unclear, not interactive enough, and sometimes invisible/clicks did not work.
- PDF download/open failed.
- Audit copy sounded too robotic and too short.

Potential implementation direction:

- Build a real audit swarm where separate audit agents handle modules, then a coordinator combines them.
- The first swarm implementation may have been deterministic rather than true background child compositions. The user asked to make it actual agents doing actual work.
- Do not break existing audit features while improving architecture.

## Branding And UI Direction

Brand:

- Product name: Worklin.
- Logo assets were supplied earlier by the user.
- Primary colors: black and white.
- Secondary color: navy from favicon, but blue/navy should be less than 2 percent of the site and used only for special states.
- Error/destructive UI may keep red/orange where appropriate.

UI issues user flagged:

- Dropdowns/settings modals were translucent and hard to read.
- Language model/provider settings were confusing.
- Open ChatGPT sign-in initially did not open properly.
- Chat screen copy was generic, not retention-focused.
- Safety metadata in onboarding UI was too technical and unfriendly.
- Onboarding was too skewed to Dr. Rachael and must support any brand.
- Queue/composer UI felt confusing.
- Connection artifacts/cards for Klaviyo did not reliably show or work.
- Avatar creation is not customizable enough; user likes Notion Faces-style customization. If implementing this later, avoid copying copyrighted characters exactly in shipped assets; use original, configurable avatar parts.

## Deployment State

Frontend:

```text
https://worklin-ai.vercel.app
```

Confirmed with curl:

```text
https://worklin-ai.vercel.app/account/login
```

returned HTTP 200 and served `index.html`. It may still be an older Vercel deployment until env vars and redeploy are fixed.

Backend/control-plane on Railway:

```text
https://worklin-ai-production.up.railway.app
```

Confirmed with curl:

```text
curl -i https://worklin-ai-production.up.railway.app/healthz
```

returned:

```json
{"ok":true}
```

Railway project:

```text
adequate-possibility
```

Railway environment:

```text
production
```

Railway service:

```text
Worklin-ai
```

Railway service settings URL:

```text
https://railway.com/project/938404be-040e-4d8f-a6ad-129fe36fc07f/service/6652911c-2726-425a-af5c-b3a66be07dc5/settings?environmentId=20611cc5-31f1-4fe8-a0c8-4237ee95a924
```

Railway service variables URL:

```text
https://railway.com/project/938404be-040e-4d8f-a6ad-129fe36fc07f/service/6652911c-2726-425a-af5c-b3a66be07dc5/variables?environmentId=20611cc5-31f1-4fe8-a0c8-4237ee95a924
```

Railway status:

- Service is online.
- Public Railway domain exists.
- Wait for CI is now off.
- The last attempted raw editor update did **not** land. Railway still appeared to show only two service variables.

Known Railway variables present:

```text
WORKLIN_SESSION_SECRET
ACTOR_TOKEN_SIGNING_KEY
```

Do not expose the values.

Auth status:

```text
curl -i https://worklin-ai-production.up.railway.app/_allauth/browser/v1/config
```

returned:

```json
{"data":{},"meta":{},"status":200}
```

This means the backend is live but Auth0 is not fully configured in Railway env yet.

Unauthenticated session endpoint:

```text
curl -i https://worklin-ai-production.up.railway.app/_allauth/browser/v1/auth/session
```

returned HTTP 401 with `is_authenticated:false`, which is expected before login.

## Auth0 State

Tenant:

```text
https://dev-t8ju8fx27q3pgjld.us.auth0.com
```

Client ID:

```text
lWY6GcvryGi5ZxZlnbNU3ybUNXelD4uH
```

The user provided the Auth0 client secret in the prior chat. Do not print it. Ask the user to paste it directly into Railway if needed.

Auth0 app should be a Regular Web Application using `client_secret_post`.

Required Auth0 Application Settings:

Allowed Callback URLs:

```text
https://worklin-ai-production.up.railway.app/callback, http://127.0.0.1:19283/callback
```

Allowed Logout URLs:

```text
https://worklin-ai.vercel.app/account/login, http://127.0.0.1:5177/account/login
```

Allowed Web Origins:

```text
https://worklin-ai.vercel.app, https://worklin-ai-production.up.railway.app, http://127.0.0.1:5177, http://127.0.0.1:19283
```

Allowed Origins (CORS):

```text
https://worklin-ai.vercel.app, https://worklin-ai-production.up.railway.app, http://127.0.0.1:5177, http://127.0.0.1:19283
```

Save changes in Auth0 after editing.

## Railway Env Vars Still Needed

Go to Railway service variables. Add these without revealing secrets in chat:

```text
WORKLIN_WEB_ORIGIN=https://worklin-ai.vercel.app
WORKLIN_API_ORIGIN=https://worklin-ai-production.up.railway.app
AUTH0_ISSUER_BASE_URL=https://dev-t8ju8fx27q3pgjld.us.auth0.com
AUTH0_BASE_URL=https://worklin-ai-production.up.railway.app
AUTH0_CLIENT_ID=lWY6GcvryGi5ZxZlnbNU3ybUNXelD4uH
AUTH0_CLIENT_SECRET=<paste from Auth0 dashboard>
AUTH0_SECRET=<generate with openssl rand -hex 32>
```

Keep the existing variables:

```text
WORKLIN_SESSION_SECRET
ACTOR_TOKEN_SIGNING_KEY
```

Do not overwrite those unless Railway says they are invalid.

Generate `AUTH0_SECRET` locally:

```bash
openssl rand -hex 32
```

After changing Railway env vars, click Deploy/apply changes and wait for the service to return Online.

Then verify:

```bash
curl -i https://worklin-ai-production.up.railway.app/healthz
curl -i https://worklin-ai-production.up.railway.app/_allauth/browser/v1/config
```

Expected config after Auth0 is set:

```json
{"data":{"socialaccount":{"providers":[{"id":"auth0","name":"Auth0","client_id":"lWY6GcvryGi5ZxZlnbNU3ybUNXelD4uH","flows":["login","signup"]}]}},"meta":{},"status":200}
```

Exact JSON shape may vary slightly, but it must no longer be empty.

## Vercel Env Vars Still Needed

In Vercel project settings for `worklin-ai`, set these environment variables for Production:

```text
VITE_PLATFORM_MODE=true
VITE_PLATFORM_API_BASE_URL=https://worklin-ai-production.up.railway.app
VITE_AUTH_API_BASE_URL=https://worklin-ai-production.up.railway.app
VITE_DAEMON_API_BASE_URL=https://worklin-ai-production.up.railway.app
```

Then redeploy the latest main commit.

Vercel config in repo:

```text
vercel.json
```

Railway config in repo:

```text
railway.json
```

If Vercel build fails, inspect logs first. Do not delete features just to make build pass. Fix only real deployment/build configuration issues.

## Click-By-Click Plan For The Next Chat

Use this order.

### 1. Railway

1. Open Railway project `adequate-possibility`.
2. Click service `Worklin-ai`.
3. Open `Variables`.
4. Confirm existing variables include:
   - `WORKLIN_SESSION_SECRET`
   - `ACTOR_TOKEN_SIGNING_KEY`
5. Add the missing vars listed in "Railway Env Vars Still Needed".
6. Paste `AUTH0_CLIENT_SECRET` directly from Auth0 into Railway. Do not paste it into Codex.
7. Generate `AUTH0_SECRET` with `openssl rand -hex 32` and paste only into Railway.
8. Apply/deploy changes.
9. Wait until Railway says Online.
10. Verify `/healthz`.
11. Verify `/_allauth/browser/v1/config` is no longer empty.

### 2. Auth0

1. Open Auth0 dashboard.
2. Go to `Applications -> Applications`.
3. Open the Worklin application.
4. Go to `Settings`.
5. Confirm:
   - Application Type: Regular Web Application.
   - Token Endpoint Authentication Method: `client_secret_post`.
6. Add the callback/logout/web origin/CORS URLs above.
7. Save changes.

### 3. Vercel

1. Open Vercel project `worklin-ai`.
2. Go to `Settings -> Environment Variables`.
3. Add/update the four Vite env vars listed above for Production.
4. Redeploy latest `main`.
5. If build fails, inspect logs before changing code.
6. Open `https://worklin-ai.vercel.app/account/login`.
7. Confirm login page loads.

### 4. Auth Smoke Test

1. Open:

```text
https://worklin-ai.vercel.app/account/login?returnTo=%2Fassistant%2Fhome
```

2. Click signup/login.
3. Expected redirect:

```text
Worklin frontend -> Railway backend auth redirect -> Auth0 hosted login -> Railway /callback -> Worklin frontend
```

4. If callback mismatch appears, compare browser callback URL exactly against Auth0 Allowed Callback URLs.
5. If CORS error appears, compare frontend origin exactly against Auth0 Allowed Origins and Railway CORS config.

## Current Code Deployment Pieces

`control-plane/src/index.ts` is the production backend/control-plane currently deployed on Railway.

It reads:

```text
PORT or WORKLIN_CONTROL_PLANE_PORT
WORKLIN_WEB_ORIGIN
WORKLIN_API_ORIGIN
WORKLIN_GATEWAY_URL
WORKLIN_CONTROL_DB
WORKLIN_SESSION_SECRET
ACTOR_TOKEN_SIGNING_KEY
AUTH0_ISSUER_BASE_URL
AUTH0_BASE_URL
AUTH0_CLIENT_ID
AUTH0_CLIENT_SECRET
AUTH0_SECRET
```

It exposes:

```text
/healthz
/_allauth/browser/v1/config
/_allauth/browser/v1/auth/session
/_allauth/browser/v1/auth/provider/redirect
/callback
```

The Auth0 provider only appears in config when all required Auth0 env vars are set.

## Safety Boundaries

Do not expose raw secrets in chat or docs.

Do not use live Klaviyo/Shopify write behavior.

Blocked in v1:

- Klaviyo send.
- Klaviyo schedule.
- Klaviyo flow activation.
- Klaviyo profile mutation.
- Klaviyo segment mutation.
- Shopify write actions.

Audit results and tools should include:

```text
externalActionTaken:false
canGoLiveNow:false
source freshness
caveats
blocked capabilities
approval status
```

But do not show raw safety metadata as ugly user-facing onboarding copy. Translate it into human language.

## Known Local App Issues To Revisit After Deployment

- Onboarding Q&A needs simpler, generic questions.
- Website/domain should be the first question.
- More questions need clickable option cards.
- Klaviyo connection card must appear automatically when missing and must work.
- Audit progress/reasoning card should be visible and not truncated.
- Audit copy needs to be much deeper and more human.
- Audit artifacts should be bigger, clearer, interactive, and downloadable.
- PDF export must work and include charts.
- Worklin should not require unnatural giant prompts from users. "Can you run an audit?" should trigger the full audit flow.
- UI should be cleaner: summary first, clear open/download actions.
- Avatar builder should become more customizable later.

## Commands Useful For The Next Chat

From repo:

```bash
cd /private/tmp/worklin-git.1ykbSk/repo
git status --short --branch
git log --oneline -5
curl -i https://worklin-ai-production.up.railway.app/healthz
curl -i https://worklin-ai-production.up.railway.app/_allauth/browser/v1/config
curl -i https://worklin-ai.vercel.app/account/login
```

If building locally:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /private/tmp/worklin-git.1ykbSk/repo/apps/web
bun install --frozen-lockfile
VITE_PLATFORM_MODE=true VERCEL=1 bun run build
```

Do not run unscoped full test suites. Follow `AGENTS.md`.

## Suggested First Reply In The New Chat

The next Codex chat should say something like:

```text
I read WORKLIN_CONTEXT_HANDOFF.md. I will not ask you to restate context. First we will configure Railway env vars, then Auth0 URLs, then Vercel env vars, then run an auth smoke test. I will give click-by-click instructions and keep secrets out of chat.
```

Then guide the user step by step.
