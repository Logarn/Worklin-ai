# Worklin Context Handoff

Last updated: 2026-06-26

This handoff is for a fresh Codex chat. Read this file first, then read `AGENTS.md`.

## Current Objective

Continue from the local Worklin repo and finish the avatar/onboarding change:

1. Verify the local changes.
2. Commit and push the branch.
3. Deploy the frontend.
4. Help the user inspect how the selected avatars look in a real chat/session UI.

The user specifically wants:

- Only the six Pika-provided avatars.
- No extra generated/static avatar.
- Avatar selection in onboarding with clear selectable cards/buttons.
- The selected character to persist into the assistant profile.
- Chat/session avatars to feel cute, realistic, and visible at real chat scale.
- Preview/static behavior explained clearly: the temporary preview was made static for screenshot QA, but real product code uses MP4 playback through `PortraitAssetAvatar`.

## Repo And Branch

Current repo:

```text
/Users/admin/Documents/New project 2/Worklin-ai
```

Current branch:

```text
codex/worklin-runtime-railway
```

Remote:

```text
origin https://github.com/Logarn/Worklin-ai.git
```

## Important Project Rules

- Product name is **Worklin**.
- Do not delete or change features merely to pass tests.
- Do not run unscoped full test suites. Use focused tests and typechecks.
- Use Bun through:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

- Do not expose secrets in chat or committed docs.
- The old Vellum app is the technical base, but user-facing product should be Worklin.

## Current Working Tree

Expected changed files from the avatar/onboarding work:

```text
apps/web/src/assistant/seed-hatch-avatar.test.ts
apps/web/src/assistant/seed-hatch-avatar.ts
apps/web/src/components/avatar/assistant-character-packs.ts
apps/web/src/components/avatar/assistant-face-builder.test.ts
apps/web/src/components/avatar/assistant-face-builder.ts
apps/web/src/components/avatar/avatar-management-modal.tsx
apps/web/src/components/avatar/chat-avatar.tsx
apps/web/src/components/avatar/portrait-asset-avatar.tsx
apps/web/src/domains/onboarding/cast/cast-onboarding-flow.tsx
apps/web/src/domains/onboarding/cast/cast-starter.tsx
apps/web/src/domains/onboarding/cast/screens/screen-slot.ts
apps/web/src/domains/onboarding/cast/screens/starter-screen.tsx
apps/web/src/domains/onboarding/cast/styles/starter.css
apps/web/src/domains/onboarding/cast/use-background-hatch.test.ts
apps/web/src/domains/onboarding/cast/use-background-hatch.ts
apps/web/src/types/assistant-character-profile.test.ts
apps/web/src/types/assistant-character-profile.ts
assistant/src/prompts/templates/system-sections.ts
apps/web/public/images/avatars/
```

New avatar assets under `apps/web/public/images/avatars/`:

```text
spiky-spark.mp4
spiky-spark-poster.jpg
tin-grin.mp4
tin-grin-poster.jpg
dr-pinch.mp4
dr-pinch-poster.jpg
sunny-square.mp4
sunny-square-poster.jpg
mystery-mutt.mp4
mystery-mutt-poster.jpg
orbit-wink.mp4
orbit-wink-poster.jpg
```

The generated/static extra avatar was removed. The search:

```bash
rg -n "zap_bean|Zap Bean|zap-bean" apps/web/src assistant/src apps/web/public/images/avatars
```

should return no matches.

## What Changed

### Six-avatar Worklin pack

`apps/web/src/components/avatar/assistant-character-packs.ts`

- Worklin pack now has exactly six avatar choices:
  - `spiky_spark`
  - `tin_grin`
  - `dr_pinch`
  - `sunny_square`
  - `mystery_mutt`
  - `orbit_wink`
- Each uses an MP4 `portraitAssetUrl` and JPG `portraitPosterUrl`.
- The generated `zap_bean` avatar was removed.

### Portrait asset renderer

`apps/web/src/components/avatar/portrait-asset-avatar.tsx`

- Renders MP4/WebM/MOV avatars with:
  - `autoPlay`
  - `muted`
  - `loop`
  - `playsInline`
  - poster fallback
- Uses poster image when reduced motion is enabled or animation is disabled.
- Adds a light grey background so video cutout edges do not look harsh.

### Chat avatar path

`apps/web/src/components/avatar/chat-avatar.tsx`

- If `characterProfile.avatarStyle === "portrait_asset"` and a `portraitAssetUrl` exists, chat renders `PortraitAssetAvatar`.
- Real chat size is usually `28px`; empty state can use about `40px`.
- While streaming/processing, a small ring appears around the portrait asset.
- If reduced motion is enabled, it falls back to the poster.

### Onboarding picker

`apps/web/src/domains/onboarding/cast/cast-starter.tsx`

- Replaced the old generated-avatar roster UI with a simple Worklin picker.
- Shows six cards.
- Each card has:
  - avatar preview
  - name
  - short subtitle
  - `Select` / `Selected` state
- CTA says `Continue with {avatarName}`.
- Uses internal cast placeholders only for downstream onboarding plumbing; visible/saved avatar is the selected Worklin avatar.

`apps/web/src/domains/onboarding/cast/styles/starter.css`

- Adds large responsive card grid styling.
- Desktop: 3 columns.
- Tablet: 2 columns.
- Small mobile: 1 column.

### Persistence path

`apps/web/src/assistant/seed-hatch-avatar.ts`

- `seedHatchAvatar()` accepts an optional preferred `AssistantCharacter`.
- If provided, that exact avatar is saved.
- Otherwise it falls back to a random Worklin avatar.

`apps/web/src/domains/onboarding/cast/use-background-hatch.ts`

- Background hatch no longer saves a random avatar immediately.
- It tracks whether the hatch created a fresh assistant.
- It exposes `seedAvatar(preferredAvatar)` so onboarding can persist the user-selected avatar after the choice.
- Existing assistants are not clobbered.

`apps/web/src/domains/onboarding/cast/cast-onboarding-flow.tsx`

- Stores the selected avatar in onboarding completion data.
- Calls `seedAvatar(data.assistantAvatar)` during handoff.

### Assistant tone mapping

`assistant/src/prompts/templates/system-sections.ts`

- Maps the six avatar IDs to lightweight internal tone/personality styles.
- Removed `zap_bean`.

## Verification Already Completed

These passed earlier:

```bash
cd "/Users/admin/Documents/New project 2/Worklin-ai/apps/web"
PATH="$HOME/.bun/bin:$PATH" bunx tsc --noEmit
PATH="$HOME/.bun/bin:$PATH" bun test src/types/assistant-character-profile.test.ts src/components/avatar/assistant-face-builder.test.ts src/assistant/seed-hatch-avatar.test.ts src/domains/onboarding/cast/use-background-hatch.test.ts
```

Focused test result:

```text
19 pass
0 fail
```

Assistant typecheck passed earlier:

```bash
cd "/Users/admin/Documents/New project 2/Worklin-ai/assistant"
PATH="$HOME/.bun/bin:$PATH" bunx tsc --noEmit
```

Diff whitespace check passed earlier:

```bash
cd "/Users/admin/Documents/New project 2/Worklin-ai"
git diff --check
```

Before committing, rerun the checks above because this handoff may be picked up after time has passed.

## Temporary Preview State

The user currently has this local preview open:

```text
http://127.0.0.1:41779/index.html
```

That page is a **temporary preview harness**, not the real Worklin app route.

Important:

- The preview was changed to static poster images for screenshot QA.
- This is why avatars look static when the user opens that preview page in a normal browser.
- The product component still uses MP4s via `PortraitAssetAvatar`.
- Real app animation should work when:
  - Worklin renders the selected profile,
  - `animationEnabled` is true,
  - reduced motion is not enabled.

If the user wants the temporary preview to animate too, change the temp preview HTML only, not product code, back to `<video autoplay muted loop playsinline>`.

## Visual QA Already Completed

Temporary visual QA confirmed:

- Six cards only.
- Names:
  - Spiky Spark
  - Tin Grin
  - Dr. Pinch
  - Sunny Square
  - Mystery Mutt
  - Orbit Wink
- Clicking Orbit Wink updates:
  - selected state to Orbit Wink
  - CTA to `Continue with Orbit Wink`
- Screenshot was generated at:

```text
/private/tmp/worklin-avatar-preview/worklin-avatar-onboarding.png
```

In-app browser route note:

- The real onboarding route redirected to login:

```text
/assistant/onboarding/prechat?preview=true -> /account/login?returnTo=...
```

- Do not bypass auth in product code just to preview it.

## How Avatars Should Look In Real Chat

`ChatAvatar` renders selected portrait avatars at chat scale:

- Default normal chat size: about `28px`.
- Empty state/greeting avatar can be about `40px`.
- It is a small circular character presence marker, not the large onboarding card.
- It should sit near the latest assistant response area.
- User messages are right-aligned bubbles.
- Assistant content is more of a left/main-column response stream rather than a matching bubble.
- The latest assistant avatar appears directly below/near the latest assistant response content, not pushed away by layout spacer.

Relevant files:

```text
apps/web/src/components/avatar/chat-avatar.tsx
apps/web/src/domains/chat/transcript/transcript.tsx
apps/web/src/domains/chat/transcript/latest-turn-row.tsx
apps/web/src/domains/chat/hooks/use-chat-empty-state.tsx
```

If the user asks "Can I see?", create a quick chat-scale visual mock or run the real app if auth/session is available. Since the temp preview is static, explain the distinction clearly.

## Push And Deploy Plan

From repo root:

```bash
cd "/Users/admin/Documents/New project 2/Worklin-ai"
git status --short
git diff --check
```

Run focused checks:

```bash
cd "/Users/admin/Documents/New project 2/Worklin-ai/apps/web"
PATH="$HOME/.bun/bin:$PATH" bunx tsc --noEmit
PATH="$HOME/.bun/bin:$PATH" bun test src/types/assistant-character-profile.test.ts src/components/avatar/assistant-face-builder.test.ts src/assistant/seed-hatch-avatar.test.ts src/domains/onboarding/cast/use-background-hatch.test.ts

cd "/Users/admin/Documents/New project 2/Worklin-ai/assistant"
PATH="$HOME/.bun/bin:$PATH" bunx tsc --noEmit
```

Commit:

```bash
cd "/Users/admin/Documents/New project 2/Worklin-ai"
git add apps/web assistant/src/prompts/templates/system-sections.ts WORKLIN_CONTEXT_HANDOFF.md
git commit -m "Add Worklin avatar picker to onboarding"
```

Push:

```bash
git push origin codex/worklin-runtime-railway
```

Deploy frontend:

```bash
PATH="$HOME/.bun/bin:$PATH" bunx vercel deploy --prod
```

This avatar/onboarding work is primarily frontend/static asset/profile behavior. It should not require a backend redeploy unless the current branch includes unrelated backend changes that have not yet been deployed.
## Vercel/Railway Context

Frontend target:

```text
https://worklin-ai.vercel.app
```

Backend/control-plane target:

```text
https://worklin-ai-production.up.railway.app
```

Previous backend health check had worked:

```bash
curl -i https://worklin-ai-production.up.railway.app/healthz
```

If deploying only this avatar UI change, focus on Vercel. If auth/backend is still broken, consult older deployment notes or inspect current Railway/Vercel env vars, but do not mix deployment debugging into the avatar PR unless necessary.

## Known Caveats

- The current temporary preview at `41779` may show static avatars because it uses posters.
- Actual product component uses MP4 video when reduced motion allows it.
- The real onboarding route may require auth/login, so a temporary preview or a logged-in session may be needed to inspect the UI.
- A wider integration test involving cast handoff previously hit an environment dependency issue around `@radix-ui/react-slot` from `packages/design-library`; do not delete features to work around that. Investigate package resolution if that test is needed.
- Commit should include the avatar MP4 and JPG files under `apps/web/public/images/avatars/`.

## Suggested Opening Message For New Codex Chat

Use this prompt:

```text
Read /Users/admin/Documents/New project 2/Worklin-ai/WORKLIN_CONTEXT_HANDOFF.md and AGENTS.md first.

Continue the Worklin avatar onboarding work. Verify the six-avatar picker, rerun focused checks, commit, push branch codex/worklin-runtime-railway, and deploy frontend to Vercel if checks pass. Do not delete or weaken features just to pass tests. Also help me preview how the selected animated avatar looks in a real chat/session, not only the static temporary onboarding preview.
```
