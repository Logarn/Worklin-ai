# Worklin Kimi Chat Handoff — 2026-07-05

## Current State

- Repo/worktree: `/Users/admin/Documents/New project 2/.tmp-worklin-redeploy`
- Branch: `main`
- Latest pushed commit: `4d1154c Route invalid provider keys to settings`
- Production deploy status for `4d1154c`: Vercel success, Railway success
- Runtime health: `https://worklin-ai-production.up.railway.app/readyz` returned `{"ok":true,"gatewayStatus":200}`
- Current in-app browser route after live QA: `https://worklin-ai.vercel.app/assistant/conversations/11af09ec-06f9-4bb2-ae27-195560cf7053`
- The Codex in-app browser session is authenticated and usable.
- Active profile at live QA time: `custom-balanced` / label `Balanced`, provider `kimi`, model `kimi-k2.6`, `provider_connection: kimi-personal`.
- Live Kimi chat verification succeeded in the in-app browser: Worklin accepted a provider-check message and the assistant replied `I can respond.`

## What Was Fixed In This Run

1. Provider setup/key persistence was repaired across prior commits:
   - Provider API key save path no longer fails due Railway CES/shared-data permissions.
   - Hatching no longer silently creates a managed/Anthropic-only assistant when no user provider is pending.
   - Terms review now hard-navigates after consent so stale in-memory assistant state is rebuilt.
   - Retention/Klaviyo standalone form no longer holds the conversation processing lock.

2. Latest commit `4d1154c` improves invalid provider-key UX:
   - `PROVIDER_INVALID_KEY` now routes to the provider settings banner instead of the generic Doctor CTA.
   - Banner copy now distinguishes `API key required` from `API key rejected`.
   - Regression added in `apps/web/src/domains/chat/utils/error-classification.test.ts`.

3. Local provider-parity patch after live Kimi verification:
   - Provider profile repair is no longer Kimi-special. It now selects the only user-owned runnable connection, or the most recently changed user-owned runnable connection, and still stays ambiguous on true ties.
   - ChatGPT Subscription uses `gpt-5.4-mini` when Worklin auto-creates/selects a profile.
   - Keyless Ollama uses the daemon default `llama3.2` when Worklin auto-creates/selects a profile.
   - ChatGPT OAuth completion in settings/profile surfaces now runs provider-profile repair and invalidates config after a successful connection.
   - Existing user-owned provider edits now run the same provider-profile repair/selection path after saving.
   - Ollama onboarding now carries `defaultModel: llama3.2`.
   - Regression coverage was added for provider repair, ChatGPT OAuth completion, onboarding provider-key application across Anthropic/OpenAI/Gemini/Fireworks/OpenRouter/MiniMax/xAI/Ollama/ChatGPT, provider creation parity, and provider edit repair.
   - This patch is local until committed, pushed, and deployment statuses are verified.

## Verification Performed

- `bun test src/domains/chat/utils/error-classification.test.ts` passed.
- Targeted ESLint on touched chat files passed.
- `bun run typecheck` in `apps/web` passed.
- Commit hook secret scan, ESLint, and typecheck passed.
- `git push` succeeded.
- GitHub status for `4d1154c` reports Vercel and Railway success.
- Railway `/readyz` reports runtime ok and gateway status 200.
- In-app browser authenticated session verified.
- Config/provider metadata verified through the authenticated page runtime:
  - selected assistant `worklin-fe8093fc-0980-4e00-a731-e4871385d854`
  - active profile `custom-balanced`
  - model `kimi-k2.6`
  - provider connection `kimi-personal`
- Live chat message sent in conversation `11af09ec-06f9-4bb2-ae27-195560cf7053`:
  - user message: `Quick provider check: please reply with one short sentence confirming you can respond.`
  - assistant response: `I can respond.`
- Captured browser network evidence after sending:
  - `POST /v1/assistants/worklin-fe8093fc-0980-4e00-a731-e4871385d854/messages` returned HTTP 202.
  - follow-up message/conversation/status fetches returned HTTP 200.
  - one canceled fetch was observed as `net::ERR_ABORTED`; it did not block the completed response.
- No `API key rejected` or `API key required` banner appeared, and browser console warning/error logs were empty during the provider-check turn.
- Focused provider parity suite passed:
  - `bun test src/assistant/provider-profile-repair.test.ts src/domains/onboarding/provider-key.test.ts src/domains/settings/ai/provider-create-form.test.tsx src/domains/settings/ai/provider-editor-modal.test.tsx src/components/ai/chatgpt-oauth-section.test.tsx`
  - Result: 48 pass, 0 fail.
- `PATH="$HOME/.bun/bin:$PATH" bunx tsc --noEmit` in `apps/web` passed.
- Targeted ESLint on touched provider/onboarding/settings files passed.

## Important Finding

The old provided Kimi key was rejected directly by Moonshot before Worklin was involved.

Direct probes:

- `https://api.moonshot.ai/v1/models` returned HTTP 401 with `Invalid Authentication`.
- `https://api.moonshot.cn/v1/models` returned HTTP 401 with `Invalid Authentication`.

That old key is intentionally not written here. Do not reuse it.

The currently saved Worklin connection `kimi-personal` did successfully power a live `kimi-k2.6` chat response in the authenticated in-app browser session after this handoff was updated. The replacement key itself was not exposed or written here.

## Live Browser Status

Earlier in this debugging run, the controllable Chrome profile `Steve` and the Codex in-app browser were both stuck on Worklin login, which blocked full end-to-end QA.

That is no longer the freshest known state for the in-app browser:

- At live-QA time, the Codex in-app browser is on:
  - `https://worklin-ai.vercel.app/assistant/conversations/11af09ec-06f9-4bb2-ae27-195560cf7053`
- The session is authenticated and usable.
- The active Kimi profile responded successfully to a provider-check message.

Safari was not accessible from this worker through Apple Events, so Safari-specific continuation is still not a reliable automation path from here.

## Remaining Test Plan

Completed:

1. In-app browser authenticated session verified.
2. Active profile confirmed as Kimi `kimi-k2.6` using `provider_connection: kimi-personal`.
3. Simple chat message sent and assistant response received.
4. Invalid-key banner did not appear during the successful turn.

Still useful if more confidence is needed:

1. Send one or two normal follow-up messages in the same in-app browser session.
2. Confirm they do not get stuck behind the retention/Klaviyo form processing lock.
3. After committing/pushing the local provider-parity patch, verify Vercel/Railway deployment statuses and re-check `/readyz`.
4. If a future failure appears, capture exact browser network/error events and Railway logs before patching.

## Paste-Ready Prompt For A Fresh Codex Chat

Continue Worklin production chat verification from `/Users/admin/Documents/New project 2/.tmp-worklin-redeploy`.

Read `WORKLIN_KIMI_CHAT_HANDOFF_2026-07-05.md` first. Latest pushed commit is `4d1154c Route invalid provider keys to settings`; Vercel and Railway are green and `/readyz` returned `{"ok":true,"gatewayStatus":200}`.

Do not use the old Kimi key. It was tested directly against both `api.moonshot.ai` and `api.moonshot.cn` and returned HTTP 401 `Invalid Authentication`.

Freshest browser context: the Codex in-app browser is authenticated on `https://worklin-ai.vercel.app/assistant/conversations/11af09ec-06f9-4bb2-ae27-195560cf7053`. The active profile is `custom-balanced`, provider `kimi`, model `kimi-k2.6`, using `provider_connection: kimi-personal`.

Live Kimi chat verification already succeeded after the key was replaced/saved in Worklin: the provider-check user message was accepted, `/messages` returned HTTP 202, follow-up reads returned HTTP 200, and the assistant replied `I can respond.` Continue with a couple of normal follow-up messages if more confidence is needed. If chat fails later, capture exact browser network/error events and Railway logs before patching.

There is also a local provider-parity patch ready to carry forward if it has not been committed/deployed yet: provider-profile repair no longer special-cases Kimi, ChatGPT Subscription auth now selects a runnable `gpt-5.4-mini` profile after OAuth, user-owned provider edits run profile repair, and Ollama defaults to `llama3.2`. The focused provider suite passed with 48 tests, `apps/web` typecheck passed, and targeted ESLint passed. Commit/push it, then verify Vercel/Railway and `/readyz`.
